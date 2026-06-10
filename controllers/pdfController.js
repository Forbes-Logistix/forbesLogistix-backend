// SCAFFOLDING: this endpoint, the matching pdfRoutes, and utils/pdfGenerator
// are not currently called by any frontend form. They're kept in place for
// the planned full DOT driver application form (referenced on /apply: "Full
// DOT application is sent after we talk"). When that form is built, it
// posts here to receive a PDF-via-email. Until then this stack is dead
// code intentionally — pdfkit stays in package.json so the route works the
// moment the frontend wires up.

const pdfGenerator = require('../utils/pdfGenerator');
const { sendViaGraph } = require('../utils/graphMailer');
const { verifyTurnstile } = require('../utils/turnstile');

exports.sendPDF = async (req, res) => {
    try {
        const body = req.body;

        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return res.status(400).json({ message: 'Invalid form data.' });
        }

        // Honeypot — bots fill every field including hidden ones.
        if (body.honeypot) {
            return res.status(200).json({ message: 'OK' });
        }

        const { turnstileToken, ...formData } = body;

        const verify = await verifyTurnstile(turnstileToken, req.ip);
        if (!verify.ok) {
            return res.status(400).json({ message: 'Verification failed. Please try again.' });
        }

        if (!process.env.CLIENT_RECEIVER_EMAIL) {
            console.error('Missing CLIENT_RECEIVER_EMAIL in environment variables.');
            return res.status(500).json({ message: 'Server configuration error.' });
        }

        const pdfBuffer = await pdfGenerator(formData);

        await sendViaGraph({
            to: process.env.CLIENT_RECEIVER_EMAIL,
            subject: 'New Driver Application Submission',
            text: 'Attached is the latest driver application form.',
            attachments: [
                { filename: 'Application.pdf', content: pdfBuffer, contentType: 'application/pdf' },
            ],
        });

        return res.status(200).json({ message: 'PDF generated and email sent successfully.' });
    } catch (error) {
        console.error('Error sending PDF:', error);
        return res.status(500).json({ message: 'Failed to generate or send PDF.' });
    }
};
