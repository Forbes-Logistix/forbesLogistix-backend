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
};

// ---------- validation helpers ----------
const isStr = (v) => typeof v === 'string';
const str = (v, max) => (isStr(v) && v.trim() !== '' && v.trim().length <= max ? v.trim() : null);
const optStr = (v, max) => (v === undefined || v === null || v === '' ? '' : str(v, max));
const isDateStr = (v) => isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isMonthStr = (v) => isStr(v) && (/^\d{4}-\d{2}$/.test(v) || /^present$/i.test(v));
const isUsPhone = (raw) => {
    const digits = String(raw ?? '').replace(/\D/g, '');
    return digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
};
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

        // ---------- experience ----------
        const experience = Array.isArray(body.experience) ? body.experience.slice(0, 8) : [];
        if (!experience.length) return bad(res, 'At least one driving-experience entry is required.');
        for (const e of experience) {
            if (!str(e.equipmentType, 80) || !str(String(e.years ?? ''), 10)) {
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
            if (!str(e.employer, 150) || !isMonthStr(e.from) || !isMonthStr(e.to) || !str(e.reasonForLeaving, 300)) {
                return bad(res, 'Each employer needs a name, from/to dates, and a reason for leaving.');
            }
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
            experience,
            accidents,
            violations,
            employment,
            gapsExplanation: optStr(body.gapsExplanation, 600),
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
                `The complete application is attached as a PDF. Reminder: collect the SSN by phone ` +
                `and write it in the OFFICE USE block — it is never collected online.`,
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
