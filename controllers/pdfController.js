// POST /api/send-pdf — the full DOT driver qualification application
// (49 CFR 391.21), submitted from forbeslogistix.com/application (a hidden,
// noindexed page the owner texts to drivers after the callback).
//
// The structured payload is validated here, rendered to PDF by
// utils/pdfGenerator.js, and emailed to recruiting. The applicant's SSN is
// NEVER accepted by this endpoint — it is collected by phone and written
// onto the printed PDF by the owner (see the OFFICE USE block in the PDF).

const pdfGenerator = require('../utils/pdfGenerator');
const { sendViaGraph } = require('../utils/graphMailer');
const { verifyTurnstile } = require('../utils/turnstile');

// Recipient: dedicated env override, else the recruiting alias. Deliberately
// NOT CLIENT_RECEIVER_EMAIL — that legacy variable predates this feature and
// its Vercel value is unverified.
const APPLICATION_RECEIVER_EMAIL =
    process.env.APPLICATION_RECEIVER_EMAIL || 'recruiting@forbeslogistix.com';

const POSITIONS = {
    'flatbed-southeast': 'Flatbed — Southeast',
    'reefer-dallas': 'Reefer — Dallas',
    // Owner-operators leased to our authority get driver-qualified with the
    // SAME 391.21 application (their DQ file is ours); the Part 376 equipment
    // lease is separate onboarding paperwork, not part of this form.
    'owner-operator-flatbed': 'Owner-Operator — Flatbed (Southeast)',
};

// ---------- validation helpers ----------
const isStr = (v) => typeof v === 'string';
const str = (v, max) => (isStr(v) && v.trim() !== '' && v.trim().length <= max ? v.trim() : null);
const optStr = (v, max) => (v === undefined || v === null || v === '' ? '' : str(v, max));
const isDateStr = (v) => isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isMonthStr = (v) => {
    // Trim before testing — month inputs falling back to text (or restored
    // drafts) can carry padding the frontend's monthIndex() tolerates.
    if (!isStr(v)) return false;
    const s = v.trim();
    return /^\d{4}-\d{2}$/.test(s) || /^present$/i.test(s);
};
const isUsPhone = (raw) => {
    const digits = String(raw ?? '').replace(/\D/g, '');
    return digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
};
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- v4 employment-gap detection ----------
// Mirrors forbes-frontend/app/lib/employmentHistory.js — change both or neither.
const MONTH_KEY_RE = /^\d{4}-\d{2}$/;
// mi("YYYY-MM") = year*12 + (month-1). Returns null for unparseable input.
const monthIndexOf = (v) => {
    if (!isStr(v) || !MONTH_KEY_RE.test(v.trim())) return null;
    const s = v.trim();
    const m = Number(s.slice(5, 7));
    if (m < 1 || m > 12) return null;
    return Number(s.slice(0, 4)) * 12 + (m - 1);
};
const monthKeyOf = (mi) =>
    `${String(Math.floor(mi / 12)).padStart(4, '0')}-${String((mi % 12) + 1).padStart(2, '0')}`;
const currentMonthIndex = () => {
    const d = new Date();
    return d.getFullYear() * 12 + d.getMonth();
};
const MONTH_NAMES = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const monthLabel = (mi) => `${MONTH_NAMES[((mi % 12) + 12) % 12]} ${Math.floor(mi / 12)}`;

// Returns [{ from, to }] (YYYY-MM keys, from = first missing month, to = last)
// for every employment gap that needs an explanation:
//   - entries become month intervals; current === true (or to === "Present")
//     ends at the current month; unparseable entries are ignored
//   - intervals are sorted and merged when overlapping or adjacent
//     (concurrent/back-to-back jobs are not gaps)
//   - a gap between merged intervals counts only when it spans >= 2 whole
//     missing months (a single missing month is tolerated, matching the FMCSA
//     sample form's "in excess of one month")
//   - a trailing gap counts when the latest interval ends more than 1 month
//     before the current month (latestEnd+1 .. currentMonth)
//   - gaps are clipped to the 10-year (120-month) window: dropped when they
//     end before it, start-truncated when they begin before it; anything
//     before the earliest listed employment is not a gap (covered by the
//     historyComplete attestation instead)
function computeEmploymentGaps(employment, nowMi) {
    const intervals = [];
    for (const e of employment) {
        const start = monthIndexOf(e.from);
        if (start === null) continue;
        const isCurrent = e.current === true || /^present$/i.test(String(e.to ?? '').trim());
        const end = isCurrent ? nowMi : monthIndexOf(e.to);
        if (end === null || end < start) continue;
        intervals.push([start, end]);
    }
    if (!intervals.length) return [];
    intervals.sort((a, b) => a[0] - b[0]);
    const merged = [intervals[0].slice()];
    for (let i = 1; i < intervals.length; i++) {
        const prev = merged[merged.length - 1];
        const cur = intervals[i];
        if (cur[0] <= prev[1] + 1) {
            if (cur[1] > prev[1]) prev[1] = cur[1];
        } else {
            merged.push(cur.slice());
        }
    }
    const windowStart = nowMi - 120;
    const gaps = [];
    const pushGap = (gapFrom, gapTo) => {
        if (gapTo - gapFrom + 1 < 2) return; // single missing month tolerated
        if (gapTo < windowStart) return; // ends before the 10-year window
        gaps.push({ from: monthKeyOf(Math.max(gapFrom, windowStart)), to: monthKeyOf(gapTo) });
    };
    for (let i = 1; i < merged.length; i++) {
        pushGap(merged[i - 1][1] + 1, merged[i][0] - 1);
    }
    const latestEnd = merged[merged.length - 1][1];
    if (nowMi - latestEnd > 1) {
        pushGap(latestEnd + 1, nowMi);
    }
    return gaps;
}

// Exposed for the gap-algorithm parity tests only; not used by any route.
exports._employmentGapInternals = { monthIndexOf, monthKeyOf, computeEmploymentGaps };

function bad(res, message) {
    return res.status(400).json({ message });
}

exports.sendPDF = async (req, res) => {
    try {
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return bad(res, 'Invalid form data.');
        }

        // Bots fill every field. The hidden honeypot must stay empty.
        if (body.honeypot) {
            return res.status(200).json({ message: 'OK' });
        }

        const verify = await verifyTurnstile(body.turnstileToken, req.ip);
        if (!verify.ok) {
            return bad(res, 'Verification failed. Please try again.');
        }

        // formVersion 4 added the DOT-completeness fields (per-employer
        // city/state/zip/phone, self-employment + C/TPA, structured gap
        // explanations, the history-complete attestation, required miles).
        // Older payloads (no formVersion) keep the legacy rules exactly, so a
        // driver mid-application on a cached bundle is not stranded.
        const isV4 = Number(body.formVersion) >= 4;

        // ---------- position ----------
        const positionLabel = POSITIONS[body.position];
        if (!positionLabel) return bad(res, 'Please select the position you are applying for.');

        // ---------- personal ----------
        const p = body.personal || {};
        const fullName = str(p.fullName, 120);
        if (!fullName) return bad(res, 'Full legal name is required.');
        if (!isUsPhone(p.phone)) return bad(res, 'A valid US phone number is required.');
        const email = optStr(p.email, 254);
        if (email && !EMAIL_REGEX.test(email)) return bad(res, 'Email address is invalid.');
        if (!isDateStr(p.dob)) return bad(res, 'Date of birth is required.');
        const ca = p.currentAddress || {};
        if (!str(ca.street, 200) || !str(ca.city, 100) || !str(ca.state, 40) || !str(ca.zip, 12)) {
            return bad(res, 'Complete current address is required.');
        }
        const prevAddresses = Array.isArray(p.previousAddresses) ? p.previousAddresses.slice(0, 6) : [];
        for (const a of prevAddresses) {
            if (!str(a.street, 200) || !str(a.city, 100) || !str(a.state, 40) || !str(a.zip, 12)) {
                return bad(res, 'Each previous address must be complete.');
            }
        }

        // ---------- license ----------
        const lic = body.license || {};
        if (!str(lic.state, 40)) return bad(res, 'CDL issuing state is required.');
        if (!str(lic.number, 40)) return bad(res, 'CDL number is required.');
        if (!str(lic.class, 10)) return bad(res, 'CDL class is required.');
        if (!isDateStr(lic.expiration)) return bad(res, 'CDL expiration date is required.');
        const everDenied = lic.everDeniedRevokedSuspended === true;
        if (everDenied && !str(lic.deniedExplanation, 600)) {
            return bad(res, 'Please explain the license denial/suspension/revocation.');
        }
        // 391.21(b)(5): EACH unexpired license/permit — optional extras list.
        const additionalLicenses = Array.isArray(body.additionalLicenses)
            ? body.additionalLicenses.slice(0, 4)
            : [];
        for (const l of additionalLicenses) {
            if (!str(l.state, 40) || !str(l.number, 40) || !isDateStr(l.expiration)) {
                return bad(res, 'Each additional license needs a state, number, and expiration date.');
            }
        }

        // ---------- experience ----------
        const experience = Array.isArray(body.experience) ? body.experience.slice(0, 8) : [];
        if (!experience.length) return bad(res, 'At least one driving-experience entry is required.');
        for (const e of experience) {
            if (isV4) {
                // approxMiles: digits (commas allowed), > 0, raw length <= 12.
                const rawMiles = String(e.approxMiles ?? '').trim();
                const milesDigits = rawMiles.replace(/,/g, '');
                if (
                    !str(e.equipmentType, 80) ||
                    !str(String(e.years ?? ''), 10) ||
                    rawMiles.length > 12 ||
                    !/^\d+$/.test(milesDigits) ||
                    !(Number(milesDigits) > 0)
                ) {
                    return bad(res, 'Each experience entry needs an equipment type, years, and approximate miles.');
                }
            } else if (!str(e.equipmentType, 80) || !str(String(e.years ?? ''), 10)) {
                return bad(res, 'Each experience entry needs an equipment type and years.');
            }
        }

        // ---------- accidents / violations ----------
        const accidents = Array.isArray(body.accidents) ? body.accidents.slice(0, 12) : [];
        for (const a of accidents) {
            if (!str(a.date, 20) || !str(a.description, 600)) {
                return bad(res, 'Each accident entry needs a date and description.');
            }
        }
        const violations = Array.isArray(body.violations) ? body.violations.slice(0, 12) : [];
        for (const v of violations) {
            if (!str(v.date, 20) || !str(v.offense, 300)) {
                return bad(res, 'Each violation entry needs a date and offense.');
            }
        }

        // ---------- employment ----------
        const employment = Array.isArray(body.employment) ? body.employment.slice(0, 15) : [];
        if (!employment.length) return bad(res, 'At least one employer is required (past 3 years; 10 for CDL jobs).');
        for (const e of employment) {
            // 391.21(b)(10)(i)/(b)(11) require employer name AND address —
            // street is required, not just city/state.
            const baseOk =
                str(e.employer, 150) &&
                str(e.street, 200) &&
                isMonthStr(e.from) &&
                isMonthStr(e.to) &&
                str(e.reasonForLeaving, 300);
            if (isV4) {
                // v4 splits the address into city/state/zip and makes the employer phone mandatory — a carrier addition under 391.21(c) (matches FMCSA's model form; used in practice to run 391.23 investigations), not a reg-mandated field.
                if (
                    !baseOk ||
                    !str(e.city, 100) ||
                    !str(e.state, 40) ||
                    !str(e.zip, 12) ||
                    !isUsPhone(e.phone)
                ) {
                    return bad(res, 'Each employer needs a name, street address, city, state, ZIP, phone, from/to dates, and a reason for leaving.');
                }
                // v4 date sanity: From must be a real YYYY-MM ("Present" is
                // only valid for To), and a month-valued To cannot precede
                // From. Legacy payloads keep the looser isMonthStr rule.
                const fromMi = monthIndexOf(e.from);
                const toIsPresent = /^present$/i.test(String(e.to).trim());
                const toMi = toIsPresent ? null : monthIndexOf(e.to);
                if (fromMi === null || (!toIsPresent && (toMi === null || toMi < fromMi))) {
                    return bad(res, "Each employer's dates must be real months, and From must come before To.");
                }
                // Self-employed + DOT-testing periods: the random-pool
                // consortium/TPA stands in as the "previous employer" for the
                // drug & alcohol history check.
                if (e.selfEmployed === true && e.safetySensitive === true && !str(e.tpaName, 150)) {
                    return bad(res, 'Self-employed entries with DOT drug & alcohol testing need the consortium/TPA that ran your random testing pool.');
                }
                // tpaName renders on the PDF whenever selfEmployed is true
                // (even without DOT testing), so cap its length unconditionally.
                if (optStr(e.tpaName, 150) === null) {
                    return bad(res, 'Consortium/TPA name must be 150 characters or fewer.');
                }
                if (optStr(e.usdotNumber, 20) === null) {
                    return bad(res, 'USDOT number must be 20 characters or fewer.');
                }
            } else if (!baseOk) {
                return bad(res, 'Each employer needs a name, street address, from/to dates, and a reason for leaving.');
            }
        }

        // ---------- v4 employment completeness ----------
        let employmentGaps = [];
        if (isV4) {
            const nowMi = currentMonthIndex();

            // Gap mirror: recompute the gaps the frontend must have shown and
            // require a valid explanation for every one of them. Extra
            // provided gaps beyond the computed set are kept for the PDF but
            // not required.
            const providedGaps = Array.isArray(body.employmentGaps) ? body.employmentGaps.slice(0, 24) : [];
            for (const g of providedGaps) {
                if (!g || typeof g !== 'object') continue;
                const from = monthIndexOf(g.from) !== null ? g.from.trim() : null;
                const to = monthIndexOf(g.to) !== null ? g.to.trim() : null;
                const explanation = str(g.explanation, 300);
                if (from && to && explanation) {
                    employmentGaps.push({ from, to, explanation });
                }
            }
            const providedKeys = new Set(employmentGaps.map((g) => `${g.from}|${g.to}`));
            // One-month client-clock tolerance: the frontend computed its gap
            // set against the DRIVER's local month, and near a month boundary
            // the server's UTC month runs a few hours ahead of a US-timezone
            // driver's. Accept the payload when it fully covers the gap set
            // for either the server's current month or the previous one;
            // reject only when both sets are uncovered.
            const coversGapsFor = (mi) =>
                computeEmploymentGaps(employment, mi).every((g) => providedKeys.has(`${g.from}|${g.to}`));
            if (!coversGapsFor(nowMi) && !coversGapsFor(nowMi - 1)) {
                return bad(res, 'Please explain the employment gap(s) shown on the Employment step.');
            }

            // Experience-vs-history cross-check: more claimed driving years
            // than the history covers (with <10 years listed) means CMV jobs
            // are missing from the 10-year employment history.
            let earliestFrom = null;
            for (const e of employment) {
                const mi = monthIndexOf(e.from);
                if (mi !== null && (earliestFrom === null || mi < earliestFrom)) earliestFrom = mi;
            }
            if (earliestFrom !== null) {
                const coverageYears = (nowMi - earliestFrom) / 12;
                let maxYears = null;
                for (const e of experience) {
                    const y = parseFloat(String(e.years).replace(/[^0-9.]/g, ''));
                    // Values over 60 aren't a plausible years figure (likely a
                    // year like "2015" or a mileage) — treat as unparseable.
                    if (!Number.isNaN(y) && y <= 60 && (maxYears === null || y > maxYears)) maxYears = y;
                }
                if (coverageYears < 10 && maxYears !== null && maxYears > coverageYears + 1) {
                    return bad(
                        res,
                        `Your Driving Experience lists ${maxYears} years, but your employment history only goes back to ${monthLabel(earliestFrom)}. Add the earlier driving jobs, or correct the years on the Driving Experience step.`
                    );
                }
            }

            if (body.historyComplete !== true) {
                return bad(res, 'Please confirm your employment history is complete.');
            }
        }

        // ---------- background-check consents ----------
        // Each consent is a distinct signed artifact required BEFORE any check
        // is ordered: E-SIGN electronic-records consent (49 CFR 390.32(d) /
        // 15 U.S.C. 7001(c)), FCRA standalone disclosure + authorization
        // (15 U.S.C. 1681b(b)(2)), the FMCSA-mandated PSP form (49 U.S.C.
        // 31150(b)(2)), the drug & alcohol history release (49 CFR 40.25 /
        // 391.23(e)/(f)), and the Clearinghouse query acknowledgment (the
        // operative full-query consent happens INSIDE the Clearinghouse portal
        // per 49 CFR 382.703(b) — the form can only acknowledge/instruct).
        // Full texts live in utils/pdfGenerator.js and must stay in sync with
        // the frontend's ApplicationClient.js.
        const con = body.consents || {};
        if (con.electronicRecords !== true) {
            return bad(res, 'Please consent to electronic records and signatures.');
        }
        const fcra = con.fcra || {};
        const fcraSignature = str(fcra.signature, 120);
        if (fcra.authorized !== true || !fcraSignature) {
            return bad(res, 'Please sign the background report authorization.');
        }
        const psp = con.psp || {};
        const pspSignature = str(psp.signature, 120);
        if (!pspSignature) return bad(res, 'Please sign the PSP disclosure and authorization.');
        const da = con.drugAlcohol || {};
        const daSignature = str(da.signature, 120);
        if (!daSignature) return bad(res, 'Please sign the drug and alcohol history release.');
        if (da.selfReport !== true && da.selfReport !== false) {
            return bad(res, 'Please answer the drug and alcohol self-report question.');
        }
        if (da.selfReport === true && !str(da.selfReportExplanation, 600)) {
            return bad(res, 'Please explain your self-report answer.');
        }
        if (con.clearinghouseAck !== true) {
            return bad(res, 'Please acknowledge the Drug & Alcohol Clearinghouse query notice.');
        }

        // ---------- certification ----------
        const cert = body.certification || {};
        const signature = str(cert.signature, 120);
        if (!signature) return bad(res, 'Please type your full legal name as your electronic signature.');
        if (cert.esignConsent !== true) return bad(res, 'Please agree to sign electronically.');

        // ---------- assemble, render, send ----------
        const now = new Date();
        const submittedAtISO = now.toISOString();
        const submittedAtCT =
            now.toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' }) + ' CT';
        const submitterIp = req.ip || 'unknown';

        const application = {
            position: body.position,
            personal: { ...p, fullName, email, previousAddresses: prevAddresses },
            license: lic,
            additionalLicenses,
            experience,
            accidents,
            violations,
            employment,
            employmentGaps,
            historyComplete: body.historyComplete === true,
            // Legacy free-text gaps field (formVersion < 4); rendered only
            // when no structured employmentGaps are present.
            gapsExplanation: optStr(body.gapsExplanation, 600),
            consents: {
                electronicRecords: true,
                fcra: { authorized: true, signature: fcraSignature, freeCopy: fcra.freeCopy === true },
                psp: { signature: pspSignature },
                drugAlcohol: {
                    signature: daSignature,
                    selfReport: da.selfReport,
                    selfReportExplanation: optStr(da.selfReportExplanation, 600),
                    limitedQuery: da.limitedQuery === true,
                },
                clearinghouseAck: true,
            },
            certification: { signature, esignConsent: true },
            submittedAtISO,
            submittedAtCT,
            submitterIp,
        };

        const pdfBuffer = await pdfGenerator(application);

        const lastName = fullName.split(/\s+/).pop().replace(/[^A-Za-z0-9-]/g, '') || 'Driver';
        await sendViaGraph({
            to: APPLICATION_RECEIVER_EMAIL,
            subject: `DOT Driver Application — ${positionLabel} — ${fullName}`,
            text:
                `A full DOT driver qualification application was submitted at forbeslogistix.com/application.\n\n` +
                `Name: ${fullName}\n` +
                `Phone: ${p.phone}\n` +
                `Position: ${positionLabel}\n` +
                `Submitted: ${submittedAtCT} (${submittedAtISO})\n\n` +
                `Consents signed electronically (all printed in the attached PDF):\n` +
                `- FCRA background report authorization${fcra.freeCopy === true ? ' — FREE COPY REQUESTED: send the driver a copy of any report you obtain' : ''}\n` +
                `- PSP disclosure & authorization (FMCSA-mandated form)\n` +
                `- Drug & alcohol history release — self-report answer: ${da.selfReport === true ? 'YES (see explanation in PDF — return-to-duty documentation required)' : 'No'}\n` +
                `- Clearinghouse pre-employment query acknowledged${da.limitedQuery === true ? '; limited-query general consent also signed' : ''}\n\n` +
                `Before running checks:\n` +
                `1. SSN: never collected online. Take it by PHONE, write it in the OFFICE USE block on ` +
                `page 1, and have the driver sign the re-certification line there before first dispatch.\n` +
                `2. Clearinghouse: the full pre-employment query still needs the driver's electronic ` +
                `consent INSIDE clearinghouse.fmcsa.dot.gov (their application signature cannot substitute).\n` +
                `3. If a report leads you to reject: run the FCRA adverse-action steps (pre-adverse notice ` +
                `with a copy of the report + CFPB rights summary, wait ~5 business days, then the final ` +
                `notice). Your screening vendor can automate this.`,
            attachments: [
                {
                    filename: `DOT-Application-${lastName}.pdf`,
                    content: pdfBuffer,
                    contentType: 'application/pdf',
                },
            ],
        });

        return res.status(200).json({ message: 'Application received.' });
    } catch (error) {
        console.error('Error sending application PDF:', error);
        return res.status(500).json({ message: 'Failed to submit application. Please call (601) 300-5529.' });
    }
};
