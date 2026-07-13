const { sendViaGraph } = require('../utils/graphMailer');
const { verifyTurnstile } = require('../utils/turnstile');

// Conservative caps. Quick Apply is a 3-field form; we don't need much room.
const MAX_NAME = 100;
const MAX_PHONE = 32;
const MAX_YEARS = 3; // numeric value as string, e.g. "0" .. "60"

// Lead recipient. Env var wins if set; otherwise the recruiting alias is used.
const LEAD_RECEIVER_EMAIL = process.env.LEAD_RECEIVER_EMAIL || 'recruiting@forbeslogistix.com';

// Optional hiring-campaign tag, whitelisted. Lets different landing pages
// (e.g. the Dallas reefer division) mark their leads so the inbox subject
// line sorts them at a glance. Absent/unknown values fall back to the
// default flatbed labeling — older clients don't send the field at all.
const POSITIONS = {
    'reefer-dallas': { tag: 'REEFER (Dallas)', label: 'Dedicated reefer — Dallas outbound' },
};
const DEFAULT_POSITION_LABEL = 'Flatbed (Southeast)';

// US-style phone digits-only check: 10 digits after stripping non-digits.
// Accept 11-digit when it starts with 1.
function isValidUsPhone(raw) {
    const digits = String(raw).replace(/\D/g, '');
    if (digits.length === 10) return true;
    if (digits.length === 11 && digits.startsWith('1')) return true;
    return false;
}

function formatPhone(raw) {
    let digits = String(raw).replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
    if (digits.length !== 10) return raw;
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

exports.sendLead = async (req, res) => {
    try {
        const {
            name,
            phone,
            years,
            applicantCert,
            smsConsent,
            honeypot,
            turnstileToken,
            position,
        } = req.body || {};

        // Bots fill every field. The hidden honeypot must stay empty.
        if (honeypot) {
            // Pretend success so the bot doesn't retry.
            return res.status(200).json({ message: 'OK' });
        }

        if (!name || !phone || years === undefined || years === null) {
            return res.status(400).json({ message: 'Name, phone, and years of experience are required.' });
        }

        if (applicantCert !== true) {
            return res.status(400).json({ message: 'Please confirm the applicant certification before submitting.' });
        }

        if (typeof name !== 'string' || typeof phone !== 'string') {
            return res.status(400).json({ message: 'Invalid field types.' });
        }

        const trimmedName = name.trim();
        const trimmedPhone = phone.trim();
        const yearsStr = String(years).trim();

        if (!trimmedName || !trimmedPhone || !yearsStr) {
            return res.status(400).json({ message: 'Name, phone, and years of experience are required.' });
        }

        if (trimmedName.length > MAX_NAME) {
            return res.status(400).json({ message: `Name must be ${MAX_NAME} characters or fewer.` });
        }
        if (trimmedPhone.length > MAX_PHONE) {
            return res.status(400).json({ message: `Phone must be ${MAX_PHONE} characters or fewer.` });
        }
        if (yearsStr.length > MAX_YEARS) {
            return res.status(400).json({ message: 'Years of experience is invalid.' });
        }

        if (!isValidUsPhone(trimmedPhone)) {
            return res.status(400).json({ message: 'Please provide a valid US phone number.' });
        }

        const yearsNum = Number(yearsStr);
        // Whole years only — Number.isInteger also covers NaN/Infinity.
        if (!Number.isInteger(yearsNum) || yearsNum < 0 || yearsNum > 60) {
            return res.status(400).json({ message: 'Please provide a valid years-of-experience number (whole years, 0-60).' });
        }

        const verify = await verifyTurnstile(turnstileToken, req.ip);
        if (!verify.ok) {
            return res.status(400).json({ message: 'Verification failed. Please try again.' });
        }

        const safe = (s) =>
            String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

        const prettyPhone = formatPhone(trimmedPhone);
        const smsConsentBool = smsConsent === true;
        const submittedAt = new Date().toISOString();
        const submitterIp = req.ip || 'unknown';
        // Fail-soft: unknown position values just get the default labeling.
        const pos = typeof position === 'string' ? POSITIONS[position.trim()] : undefined;
        const positionLabel = pos ? pos.label : DEFAULT_POSITION_LABEL;

        await sendViaGraph({
            to: LEAD_RECEIVER_EMAIL,
            subject: pos
                ? `New Driver Lead — ${pos.tag} — ${trimmedName}`
                : `New Driver Lead — ${trimmedName}`,
            text:
                `New driver lead submitted via the Quick Apply form on forbeslogistix.com.\n\n` +
                `Name: ${trimmedName}\n` +
                `Phone: ${prettyPhone}\n` +
                `Position: ${positionLabel}\n` +
                `Years of verifiable OTR experience: ${yearsNum}\n\n` +
                `--- Consent record ---\n` +
                `Applicant certification accepted: yes\n` +
                `Recruiting calls/SMS consent: ${smsConsentBool ? 'yes' : 'no'}\n` +
                `Submitted: ${submittedAt}\n` +
                `IP: ${submitterIp}\n`,
            html:
                `<p>New driver lead submitted via the Quick Apply form on forbeslogistix.com.</p>` +
                `<p><strong>Name:</strong> ${safe(trimmedName)}</p>` +
                `<p><strong>Phone:</strong> ${safe(prettyPhone)}</p>` +
                `<p><strong>Position:</strong> ${safe(positionLabel)}</p>` +
                `<p><strong>Years of verifiable OTR experience:</strong> ${yearsNum}</p>` +
                `<hr/>` +
                `<p><strong>Consent record</strong></p>` +
                `<ul>` +
                `<li>Applicant certification: <strong>yes</strong></li>` +
                `<li>Recruiting calls/SMS consent: <strong>${smsConsentBool ? 'yes' : 'no'}</strong></li>` +
                `<li>Submitted: ${safe(submittedAt)}</li>` +
                `<li>IP: ${safe(submitterIp)}</li>` +
                `</ul>`,
        });

        return res.status(200).json({ message: 'Lead received.' });
    } catch (error) {
        console.error('Error sending driver lead:', error);
        return res.status(500).json({ message: 'Failed to submit lead.' });
    }
};
