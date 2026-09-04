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
    'flatbed-southeast': 'Flatbed (Southeast)',
    'reefer-dallas': 'Reefer (Dallas)',
    // Owner-operators leased to our authority get driver-qualified with the
    // SAME 391.21 application (their DQ file is ours); the Part 376 equipment
    // lease is separate onboarding paperwork, not part of this form.
    'owner-operator-flatbed': 'Owner-Operator Flatbed (Southeast)',
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

// ---------- v6 shared constants ----------
// Keep in sync with forbes-frontend app/application/ApplicationClient.js —
// the state-code list, ZIP regex, endorsement code list, and the
// None-exclusivity rule must be identical in both repos (same convention as
// the gap logic). Change both or neither.
const OTHER_STATE = 'Other (non-US)';
const STATE_CODES = new Set([
    'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID',
    'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS',
    'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK',
    'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV',
    'WI', 'WY', 'DC', 'PR', OTHER_STATE,
]);
const ZIP_RE = /^\d{5}(-\d{4})?$/;
const ENDORSEMENT_CODES = new Set(['H', 'N', 'T', 'P', 'S', 'X', 'NONE']);
const USDOT_RE = /^\d{1,12}$/;

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
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
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

// ---------- v6 residence coverage ----------
// Mirrors the frontend's residence-coverage rule — change both or neither.
// The merged address intervals (the current address runs since -> now) must
// cover the last 36 months: any uncovered run of >= 2 whole months inside the
// [now-36 .. now] window blocks; a single missing month is tolerated
// (matching the employment-gap tolerance). Unlike employment, time before the
// earliest listed address IS a gap — the window itself must be covered.
// Coverage only: no per-gap explanations for addresses.
// Returns [{ from: "YYYY-MM", to: "YYYY-MM" }] for every uncovered run.
function computeResidenceGaps(addresses, nowMi) {
    const intervals = [];
    for (const a of addresses) {
        const start = monthIndexOf(a.from);
        if (start === null) continue;
        const isCurrent = /^present$/i.test(String(a.to ?? '').trim());
        const end = isCurrent ? nowMi : monthIndexOf(a.to);
        if (end === null || end < start) continue;
        intervals.push([start, end]);
    }
    intervals.sort((x, y) => x[0] - y[0]);
    const merged = [];
    for (const cur of intervals) {
        const prev = merged[merged.length - 1];
        if (prev && cur[0] <= prev[1] + 1) {
            if (cur[1] > prev[1]) prev[1] = cur[1];
        } else {
            merged.push(cur.slice());
        }
    }
    const windowStart = nowMi - 36;
    const gaps = [];
    let cursor = windowStart;
    const pushGap = (gapFrom, gapTo) => {
        if (gapTo - gapFrom + 1 < 2) return; // single missing month tolerated
        gaps.push({ from: monthKeyOf(gapFrom), to: monthKeyOf(gapTo) });
    };
    for (const [start, end] of merged) {
        if (end < windowStart) continue;
        if (cursor > nowMi) break;
        if (start > cursor) pushGap(cursor, Math.min(start - 1, nowMi));
        if (end + 1 > cursor) cursor = end + 1;
    }
    if (cursor <= nowMi) pushGap(cursor, nowMi);
    return gaps;
}

// Exposed for the gap-algorithm parity tests only; not used by any route.
exports._employmentGapInternals = {
    monthIndexOf,
    monthKeyOf,
    monthLabel,
    currentMonthIndex,
    computeEmploymentGaps,
    computeResidenceGaps,
};

// ---------- office JSON whitelist ----------
// The office-facing JSON attachment is assembled ONLY from these known,
// validated keys — never by spreading raw request sub-objects — so junk or
// unexpected keys in a payload can never ride along to the office inbox.
// The key lists cover every field the PDF generator reads (all form
// versions), so the office can still regenerate the PDF from the JSON.
const pickKnown = (src, keys) => {
    const out = {};
    if (!src || typeof src !== 'object') return out;
    for (const k of keys) {
        if (src[k] !== undefined) out[k] = src[k];
    }
    return out;
};
const CURRENT_ADDRESS_KEYS = ['street', 'city', 'state', 'zip', 'since', 'sinceYear'];
const PREV_ADDRESS_KEYS = ['street', 'city', 'state', 'zip', 'from', 'to'];
const LICENSE_KEYS = [
    'state', 'number', 'class', 'expiration', 'endorsements', 'endorsementCodes',
    'restrictions', 'everDeniedRevokedSuspended', 'deniedExplanation',
];
const ADDITIONAL_LICENSE_KEYS = ['state', 'number', 'class', 'expiration'];
const EXPERIENCE_KEYS = ['equipmentType', 'years', 'approxMiles'];
const ACCIDENT_KEYS = ['date', 'description', 'fatalities', 'injuries'];
const VIOLATION_KEYS = ['date', 'offense', 'state', 'penalty'];
// Every employment key across legacy/v4/v5/v6 (cityState is the legacy
// combined city/state field; usdotNumber/mcNumber/authorityStatus/tpaName/
// tpaPhone/leasedDuringPeriod are the v4-v6 self-employment block).
const EMPLOYMENT_KEYS = [
    'employer', 'street', 'cityState', 'city', 'state', 'zip', 'phone',
    'from', 'to', 'current', 'position', 'reasonForLeaving', 'fmcsrSubject',
    'safetySensitive', 'selfEmployed', 'usdotNumber', 'mcNumber',
    'authorityStatus', 'tpaName', 'tpaPhone', 'leasedDuringPeriod',
];

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
        // formVersion 5 replaced the single free-text full name with
        // structured first/middle/last fields (plus a no-middle-name
        // attestation); fullName is derived server-side from the parts.
        // v4 payloads (cached bundles from the v4 release day) and legacy
        // payloads keep the fullName field and today's rules exactly.
        const isV5 = Number(body.formVersion) >= 5;
        // formVersion 6 added residence date coverage, endorsement checkboxes
        // + required restrictions, per-employer position/state-code/ZIP rules,
        // and the structured self-employment block. As with v4/v5, older
        // payloads keep their rules byte-identical.
        const isV6 = Number(body.formVersion) >= 6;

        // ---------- position ----------
        const positionLabel = POSITIONS[body.position];
        if (!positionLabel) return bad(res, 'Please select the position you are applying for.');

        // ---------- personal ----------
        const p = body.personal || {};
        let fullName;
        let firstName = '';
        let middleName = '';
        let lastName = '';
        let noMiddleName = false;
        if (isV5) {
            firstName = str(p.firstName, 60);
            lastName = str(p.lastName, 60);
            if (!firstName || !lastName) return bad(res, 'First and last name are required.');
            noMiddleName = p.noMiddleName === true;
            if (noMiddleName) {
                // The UI clears and disables the middle-name field when the
                // box is checked; a populated value here means the payload is
                // inconsistent, not that the driver has a middle name.
                if (String(p.middleName ?? '').trim() !== '') {
                    return bad(res, 'Middle name must be left blank when you confirm you have no middle name.');
                }
                middleName = '';
            } else {
                middleName = str(p.middleName, 60);
                if (!middleName) {
                    return bad(res, 'Middle name is required unless you confirm you have no middle name.');
                }
            }
            fullName = [firstName, middleName, lastName].filter(Boolean).join(' ');
        } else {
            fullName = str(p.fullName, 120);
            if (!fullName) return bad(res, 'Full legal name is required.');
        }
        if (!isUsPhone(p.phone)) return bad(res, 'A valid US phone number is required.');
        const email = optStr(p.email, 254);
        if (email && !EMAIL_REGEX.test(email)) return bad(res, 'Email address is invalid.');
        if (!isDateStr(p.dob)) return bad(res, 'Date of birth is required.');
        const ca = p.currentAddress || {};
        if (!str(ca.street, 200) || !str(ca.city, 100) || !str(ca.state, 40) || !str(ca.zip, 12)) {
            return bad(res, 'Complete current address is required.');
        }
        // Cap mirrored with the frontend's Add-address button (max 12 on both
        // sides — change both or neither), so a UI-valid list is never
        // silently truncated here.
        const prevAddresses = Array.isArray(p.previousAddresses) ? p.previousAddresses.slice(0, 12) : [];
        for (const a of prevAddresses) {
            if (!str(a.street, 200) || !str(a.city, 100) || !str(a.state, 40) || !str(a.zip, 12)) {
                return bad(res, 'Each previous address must be complete.');
            }
        }
        if (isV6) {
            // v6 residence dates: "since" (YYYY-MM) replaced the year-only
            // sinceYear on the current address; previous addresses carry
            // from/to months. ("Present" is not accepted here — the current
            // address is the only open-ended one.)
            if (monthIndexOf(ca.since) === null) {
                return bad(res, 'The month you moved to your current address is required.');
            }
            // Future months: one month ahead is tolerated (same client-clock
            // skew allowance as the gap/coverage mirrors); anything beyond
            // that is rejected. The blocking sentence must stay byte-identical
            // to the frontend's — change both or neither.
            const futureMiLimit = currentMonthIndex() + 1;
            if (monthIndexOf(ca.since) > futureMiLimit) {
                return bad(res, "Address dates can't be in the future.");
            }
            for (const a of prevAddresses) {
                if (monthIndexOf(a.from) === null || monthIndexOf(a.to) === null) {
                    return bad(res, 'Each previous address needs the months you lived there (from and to).');
                }
                if (monthIndexOf(a.from) > futureMiLimit || monthIndexOf(a.to) > futureMiLimit) {
                    return bad(res, "Address dates can't be in the future.");
                }
                // Server-only backstop (the frontend already blocks inverted
                // ranges before submit): To must not precede From.
                if (monthIndexOf(a.to) < monthIndexOf(a.from)) {
                    return bad(res, 'Each address needs real months, and From must come before To.');
                }
            }
            // Coverage mirror (same one-month client-clock tolerance as the
            // employment-gap mirror): reject only when the addresses fail to
            // cover the window for BOTH the server's current month and the
            // previous one. The blocking sentence must stay byte-identical to
            // the frontend's — change both or neither.
            const addrEntries = [
                { from: ca.since, to: 'Present' },
                ...prevAddresses.map((a) => ({ from: a.from, to: a.to })),
            ];
            const nowMiAddr = currentMonthIndex();
            const addrGaps = computeResidenceGaps(addrEntries, nowMiAddr);
            if (addrGaps.length && computeResidenceGaps(addrEntries, nowMiAddr - 1).length) {
                const g = addrGaps[0];
                return bad(
                    res,
                    `Your addresses need to cover the last 3 years. Add the address you lived at during ${monthLabel(monthIndexOf(g.from))} – ${monthLabel(monthIndexOf(g.to))}.`
                );
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
        if (isV6) {
            // v6 endorsements: checkbox codes replaced the free-text field.
            // "NONE" is mutually exclusive with every other code — the None-
            // exclusivity rule is mirrored in the frontend; change both or
            // neither.
            const codes = Array.isArray(lic.endorsementCodes) ? lic.endorsementCodes : [];
            if (
                !codes.length ||
                !codes.every((c) => ENDORSEMENT_CODES.has(c)) ||
                new Set(codes).size !== codes.length
            ) {
                return bad(res, 'Please select your CDL endorsements, or "None".');
            }
            if (codes.includes('NONE') && codes.length > 1) {
                return bad(res, '"None" cannot be combined with other endorsements.');
            }
            if (!str(lic.restrictions, 80)) {
                return bad(res, "CDL restrictions are required. Enter them as shown on your license, or 'None'.");
            }
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
            if (isV6) {
                // v6: state is a select storing a 2-letter code (or the
                // literal "Other (non-US)"), the ZIP gets a real format rule,
                // and position/reason firm up from rendered-only to required.
                const stateVal = String(e.state ?? '').trim();
                if (!STATE_CODES.has(stateVal)) {
                    return bad(res, "Please select each employer's state from the list.");
                }
                if (stateVal === OTHER_STATE) {
                    // Non-US employer: any non-empty postal code up to 12 chars
                    // (already enforced by the v4 zip check above).
                } else if (!ZIP_RE.test(String(e.zip ?? '').trim())) {
                    return bad(res, 'Each employer ZIP code must look like 12345 or 12345-6789.');
                }
                if (!str(e.position, 100)) {
                    return bad(res, 'Each employer needs the position you held.');
                }
                if (String(e.reasonForLeaving ?? '').trim().length < 3) {
                    return bad(res, 'Each reason for leaving needs at least 3 characters.');
                }
                const usdotVal = String(e.usdotNumber ?? '').trim();
                if (e.selfEmployed === true) {
                    // Structured self-employment block (v6).
                    if (!USDOT_RE.test(usdotVal)) {
                        return bad(res, "Your company's USDOT number is required for each self-employed period (digits only, 12 max).");
                    }
                    if (String(e.mcNumber ?? '').trim().length > 12) {
                        return bad(res, 'MC number must be 12 characters or fewer.');
                    }
                    if (!['active', 'inactive', 'revoked'].includes(e.authorityStatus)) {
                        return bad(res, 'Please select the authority status for each self-employed period.');
                    }
                    if (e.leasedDuringPeriod !== true && e.leasedDuringPeriod !== false) {
                        return bad(res, 'Please answer whether you were leased to another motor carrier during each self-employed period.');
                    }
                    // tpaName (required iff safetySensitive) is enforced by
                    // the v4 block above; v6 adds the C/TPA phone.
                    if (e.safetySensitive === true && !isUsPhone(e.tpaPhone)) {
                        return bad(res, 'Self-employed entries with DOT drug & alcohol testing need a valid US phone number for the consortium/TPA.');
                    }
                } else if (usdotVal !== '' && !USDOT_RE.test(usdotVal)) {
                    // Optional per-employer USDOT (shown when the FMCSR box is
                    // checked in the UI; accepted regardless here).
                    return bad(res, 'Company USDOT numbers must be digits only (12 max).');
                }
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
            // The generator keys most human-facing date formatting (and the
            // no-middle-name annotation) off formVersion >= 5. Legacy
            // (no-version) renders are byte-identical to what shipped before;
            // v4 renders differ ONLY in month-name spelling on gap lines and
            // the attestation label (fmtMonth is full-month for all versions
            // by design — spelled-out months everywhere).
            formVersion: Number(body.formVersion) || 0,
            position: body.position,
            personal: isV5
                ? { ...p, firstName, middleName, lastName, noMiddleName, fullName, email, previousAddresses: prevAddresses }
                : { ...p, fullName, email, previousAddresses: prevAddresses },
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

        // Office-facing JSON twin of the PDF (ALL form versions),
        // pretty-printed so the office can regenerate the PDF or export to
        // the background-check vendor. Assembled from an explicit whitelist
        // of validated fields per section — never by spreading raw request
        // sub-objects — so it can never contain the turnstile token, the
        // honeypot, raw request internals, or any unexpected payload keys.
        const officeApplication = {
            formVersion: application.formVersion,
            position: body.position,
            personal: {
                ...(isV5 ? { firstName, middleName, lastName, noMiddleName } : {}),
                fullName,
                phone: p.phone,
                email,
                dob: p.dob,
                currentAddress: pickKnown(ca, CURRENT_ADDRESS_KEYS),
                previousAddresses: prevAddresses.map((a) => pickKnown(a, PREV_ADDRESS_KEYS)),
            },
            license: pickKnown(lic, LICENSE_KEYS),
            additionalLicenses: additionalLicenses.map((l) => pickKnown(l, ADDITIONAL_LICENSE_KEYS)),
            experience: experience.map((e) => pickKnown(e, EXPERIENCE_KEYS)),
            accidents: accidents.map((a) => pickKnown(a, ACCIDENT_KEYS)),
            violations: violations.map((v) => pickKnown(v, VIOLATION_KEYS)),
            employment: employment.map((e) => pickKnown(e, EMPLOYMENT_KEYS)),
            employmentGaps,
            historyComplete: application.historyComplete,
            gapsExplanation: application.gapsExplanation,
            consents: application.consents,
            certification: application.certification,
            submittedAtISO,
            submittedAtCT,
            submitterIp,
        };
        const applicationJson = Buffer.from(JSON.stringify(officeApplication, null, 2), 'utf8');

        // v5 has the real last name; v4/legacy fall back to the last token of
        // the free-text full name, exactly as before.
        const fileLastName =
            (isV5 ? lastName : fullName.split(/\s+/).pop()).replace(/[^A-Za-z0-9-]/g, '') || 'Driver';
        await sendViaGraph({
            to: APPLICATION_RECEIVER_EMAIL,
            subject: `DOT Driver Application - ${positionLabel} - ${fullName}`,
            text:
                `A full DOT driver qualification application was submitted at forbeslogistix.com/application.\n\n` +
                `Name: ${fullName}\n` +
                `Phone: ${p.phone}\n` +
                `Position: ${positionLabel}\n` +
                `Submitted: ${submittedAtCT} (${submittedAtISO})\n\n` +
                `Consents signed electronically (all printed in the attached PDF):\n` +
                `- FCRA background report authorization${fcra.freeCopy === true ? ' (FREE COPY REQUESTED: send the driver a copy of any report you obtain)' : ''}\n` +
                `- PSP disclosure & authorization (FMCSA-mandated form)\n` +
                `- Drug & alcohol history release; self-report answer: ${da.selfReport === true ? 'YES (see explanation in PDF; return-to-duty documentation required)' : 'No'}\n` +
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
                    filename: `DOT-Application-${fileLastName}.pdf`,
                    content: pdfBuffer,
                    contentType: 'application/pdf',
                },
                {
                    filename: `DOT-Application-${fileLastName}.json`,
                    content: applicationJson,
                    contentType: 'application/json',
                },
            ],
        });

        return res.status(200).json({ message: 'Application received.' });
    } catch (error) {
        console.error('Error sending application PDF:', error);
        return res.status(500).json({ message: 'Failed to submit application. Please call (601) 300-5529.' });
    }
};
