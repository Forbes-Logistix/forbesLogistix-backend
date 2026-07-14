// Generates the Driver Qualification Application PDF (49 CFR 391.21) from
// the structured payload validated by controllers/pdfController.js.
//
// DELIBERATE OMISSION: the applicant's Social Security Number is never
// collected online. The PDF prints a blank OFFICE-USE line for it — the
// owner collects it by phone and writes it in. Do not add an SSN field.

const PDFDocument = require('pdfkit');

// Carrier identity block — 391.21(b)(1) requires the application to show
// the name and address of the employing motor carrier.
const CARRIER = {
    name: 'Forbes Logistix, LLC',
    address: '3180 Utica Ave, Jackson, MS 39209',
    identifiers: 'USDOT 4361817  ·  MC 1706978',
};

const POSITION_LABELS = {
    'flatbed-southeast': 'Company Flatbed Driver — Southeast',
    'reefer-dallas': 'Company Reefer Driver — Dedicated Dallas Outbound',
};

// Strip control characters; pdfkit renders anything else safely as text.
const clean = (v) =>
    String(v ?? '')
        .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
        .trim();

const show = (v) => (clean(v) === '' ? '—' : clean(v));
const yn = (v) => (v === true ? 'Yes' : v === false ? 'No' : '—');

module.exports = function generatePDF(app) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
            const buffers = [];
            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => resolve(Buffer.concat(buffers)));

            const line = () => {
                doc.moveDown(0.4);
                doc.moveTo(doc.page.margins.left, doc.y)
                    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
                    .lineWidth(0.5)
                    .strokeColor('#999999')
                    .stroke();
                doc.moveDown(0.4);
            };

            const section = (title) => {
                doc.moveDown(0.6);
                doc.font('Helvetica-Bold').fontSize(12).fillColor('#000000').text(title.toUpperCase());
                doc.moveDown(0.2);
                doc.font('Helvetica').fontSize(10).fillColor('#111111');
            };

            const field = (label, value) => {
                doc.font('Helvetica-Bold').text(`${label}: `, { continued: true });
                doc.font('Helvetica').text(show(value));
            };

            // ---------- Header ----------
            doc.font('Helvetica-Bold').fontSize(16).text('DRIVER QUALIFICATION APPLICATION', { align: 'center' });
            doc.moveDown(0.2);
            doc.font('Helvetica').fontSize(9).fillColor('#333333').text(
                `${CARRIER.name}  ·  ${CARRIER.address}  ·  ${CARRIER.identifiers}`,
                { align: 'center' }
            );
            doc.fontSize(9).text('Application per 49 CFR 391.21 — submitted electronically via forbeslogistix.com/application', {
                align: 'center',
            });
            doc.fillColor('#111111');
            line();

            // ---------- Position ----------
            section('Position Applied For');
            doc.text(POSITION_LABELS[app.position] || show(app.position));

            // ---------- Personal ----------
            const p = app.personal || {};
            section('Applicant');
            field('Full legal name', p.fullName);
            field('Phone', p.phone);
            field('Email', p.email || '— (not provided)');
            field('Date of birth', p.dob);

            doc.moveDown(0.5);
            doc.font('Helvetica-Bold').fontSize(10).fillColor('#7a0000')
                .text('OFFICE USE — collected by phone, never online:');
            doc.font('Helvetica').fontSize(11).fillColor('#000000')
                .text('Social Security Number:  ____________________________');
            doc.fontSize(10).fillColor('#111111');

            doc.moveDown(0.5);
            const ca = p.currentAddress || {};
            field('Current address', `${show(ca.street)}, ${show(ca.city)}, ${show(ca.state)} ${show(ca.zip)}`);
            field('At this address since (year)', ca.sinceYear);
            const prevAddrs = Array.isArray(p.previousAddresses) ? p.previousAddresses : [];
            if (prevAddrs.length) {
                doc.moveDown(0.3);
                doc.font('Helvetica-Bold').text('Previous addresses (last 3 years):');
                doc.font('Helvetica');
                prevAddrs.forEach((a, i) => {
                    doc.text(`  ${i + 1}. ${show(a.street)}, ${show(a.city)}, ${show(a.state)} ${show(a.zip)}`);
                });
            }

            // ---------- License ----------
            const lic = app.license || {};
            section('Commercial Driver’s License');
            field('Issuing state', lic.state);
            field('License number', lic.number);
            field('Class', lic.class);
            field('Expiration date', lic.expiration);
            field('Endorsements', lic.endorsements || 'None listed');
            field('License ever denied, suspended, or revoked', yn(lic.everDeniedRevokedSuspended));
            if (lic.everDeniedRevokedSuspended) {
                field('Explanation', lic.deniedExplanation);
            }

            // ---------- Experience ----------
            section('Driving Experience');
            const exp = Array.isArray(app.experience) ? app.experience : [];
            exp.forEach((e, i) => {
                doc.text(
                    `  ${i + 1}. ${show(e.equipmentType)} — ${show(e.years)} year(s), approx. ${show(e.approxMiles)} miles`
                );
            });

            // ---------- Accidents ----------
            section('Accident Record — Past 3 Years');
            const acc = Array.isArray(app.accidents) ? app.accidents : [];
            if (!acc.length) {
                doc.text('Applicant reports NO accidents in the past 3 years.');
            } else {
                acc.forEach((a, i) => {
                    doc.text(
                        `  ${i + 1}. ${show(a.date)} — ${show(a.description)}  (fatalities: ${show(a.fatalities)}, injuries: ${show(a.injuries)})`
                    );
                });
            }

            // ---------- Violations ----------
            section('Traffic Convictions & Forfeitures — Past 3 Years');
            const vio = Array.isArray(app.violations) ? app.violations : [];
            if (!vio.length) {
                doc.text('Applicant reports NO convictions or forfeitures in the past 3 years.');
            } else {
                vio.forEach((v, i) => {
                    doc.text(`  ${i + 1}. ${show(v.date)} — ${show(v.offense)} (${show(v.state)}) — penalty: ${show(v.penalty)}`);
                });
            }

            // ---------- Employment ----------
            section('Employment History (3 years; 10 years for CDL positions)');
            const emp = Array.isArray(app.employment) ? app.employment : [];
            emp.forEach((e, i) => {
                doc.font('Helvetica-Bold').text(`  ${i + 1}. ${show(e.employer)}  (${show(e.from)} – ${show(e.to)})`);
                doc.font('Helvetica');
                doc.text(`      Position: ${show(e.position)}  ·  Phone: ${show(e.phone)}  ·  ${show(e.cityState)}`);
                doc.text(`      Reason for leaving: ${show(e.reasonForLeaving)}`);
                doc.text(
                    `      Subject to FMCSRs: ${yn(e.fmcsrSubject)}  ·  Safety-sensitive / DOT drug & alcohol testing: ${yn(e.safetySensitive)}`
                );
                doc.moveDown(0.3);
            });
            if (clean(app.gapsExplanation)) {
                field('Employment gaps explained', app.gapsExplanation);
            }

            // ---------- Certification ----------
            const cert = app.certification || {};
            section('Certification & Electronic Signature');
            doc.text(
                'This certifies that this application was completed by me, and that all entries on it and information in it are true and complete to the best of my knowledge.'
            );
            doc.moveDown(0.5);
            field('Electronic signature (typed full legal name)', cert.signature);
            field('E-signature consent', cert.esignConsent ? 'Agreed — typed name constitutes electronic signature' : '—');
            field('Signed (Central Time)', app.submittedAtCT);
            field('Signed (UTC)', app.submittedAtISO);
            field('Submitted from IP', app.submitterIp);
            doc.moveDown(1.2);
            doc.text('Reviewed by (Forbes Logistix): ______________________________     Date: ________________');

            doc.end();
        } catch (err) {
            console.error('Error generating PDF:', err);
            reject(err);
        }
    });
};
