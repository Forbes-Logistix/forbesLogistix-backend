// Generates the Driver Qualification Application PDF (49 CFR 391.21) from
// the structured payload validated by controllers/pdfController.js.
//
// DELIBERATE OMISSION: the applicant's Social Security Number is never
// collected online. The PDF prints an OFFICE-USE block — the owner collects
// the SSN by phone and writes it in (FMCSA guidance to 391.21, Q&A 1, permits
// entries recorded by another person when the applicant signs), and the
// applicant signs the printed re-certification line afterward. Do not add an
// SSN field.
//
// CONSENT PAGES: the disclosure/authorization texts below must stay in sync
// with the frontend's app/application/ApplicationClient.js. Page rules:
// the FCRA disclosure must be a standalone document (15 U.S.C. 1681b(b)(2)(A));
// the PSP form is FMCSA-mandated verbatim and "may NOT be included with other
// consent forms or any other language" and "cannot appear on the same page(s)
// as any other documentation" — never let another artifact share its pages.

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
    'owner-operator-flatbed': 'Owner-Operator — Flatbed (Southeast)',
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
                .text('SSN — collected by PHONE after submission, never online. OFFICE USE:');
            doc.font('Helvetica').fontSize(11).fillColor('#000000')
                .text('Social Security Number:  ______________________    Taken by phone by: ________________    Date: ____________');
            doc.font('Helvetica').fontSize(8).fillColor('#555555')
                .text('The SSN is a required application element (49 CFR 391.21(b)(2)) and is deliberately collected by phone, not online. FMCSA guidance to § 391.21 (Q&A 1) permits entries recorded by another person when the applicant signs the application. After the SSN is added, the applicant signs the re-certification below before first dispatch.');
            doc.moveDown(0.3);
            doc.font('Helvetica-Bold').fontSize(9).fillColor('#000000')
                .text('RE-CERTIFICATION (applicant signs after the SSN above has been added):');
            doc.font('Helvetica').fontSize(9)
                .text('This certifies that this application was completed by me, and that all entries on it and information in it are true and complete to the best of my knowledge.');
            doc.moveDown(0.3);
            doc.fontSize(10)
                .text('Applicant signature: ________________________________    Date: ____________');
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
            const addlLic = Array.isArray(app.additionalLicenses) ? app.additionalLicenses : [];
            if (addlLic.length) {
                doc.moveDown(0.3);
                doc.font('Helvetica-Bold').text('Other current licenses/permits:');
                doc.font('Helvetica');
                addlLic.forEach((l, i) => {
                    doc.text(`  ${i + 1}. ${show(l.state)} · ${show(l.number)} · Class ${show(l.class)} · expires ${show(l.expiration)}`);
                });
            } else {
                field('Other current licenses/permits', 'None');
            }
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
            section('Traffic Convictions & Bond/Collateral Forfeitures — Past 3 Years');
            const vio = Array.isArray(app.violations) ? app.violations : [];
            if (!vio.length) {
                doc.text('Applicant reports NO convictions or forfeitures in the past 3 years.');
            } else {
                vio.forEach((v, i) => {
                    doc.text(`  ${i + 1}. ${show(v.date)} — ${show(v.offense)} (${show(v.state)}) — penalty: ${show(v.penalty)}`);
                });
            }

            // ---------- 391.21(d) notice ----------
            section('Notice to Applicant — 49 CFR 391.21(d)');
            doc.fontSize(9).text(
                'Before you submitted this application, Forbes Logistix LLC (USDOT 4361817 / MC 1706978) informed you, ' +
                'as required by federal regulation, that the employment history you provide may be used, and your ' +
                'previous DOT-regulated employers will be contacted, for the purpose of investigating your safety ' +
                'performance history as required by 49 CFR 391.23(d) and (e), including your accident history and your ' +
                'alcohol and controlled substances testing history. Your rights under 49 CFR 391.23(i): (1) the right ' +
                'to review the safety performance history information provided to us by your previous employers; ' +
                '(2) the right to have errors in that information corrected by the previous employer, and to have that ' +
                'employer re-send the corrected information to us; (3) if you and the previous employer cannot agree on ' +
                'the accuracy of the information, the right to have a rebuttal statement attached to the disputed ' +
                'information. To review the information, submit a written request to us at any time, from the time you ' +
                'apply until 30 days after you are employed or notified that employment was denied. We will provide the ' +
                'information within 5 business days of your written request (or, if we have not yet received it from ' +
                'your previous employer, within 5 business days of receiving it). If you do not arrange to review the ' +
                'records within 30 days of us making them available, we may consider your review request waived. ' +
                'This notice was displayed to the applicant in writing before submission.'
            );
            doc.fontSize(10);

            // ---------- Employment ----------
            section('Employment History (3 years; 10 years for CDL positions)');
            const emp = Array.isArray(app.employment) ? app.employment : [];
            emp.forEach((e, i) => {
                doc.font('Helvetica-Bold').text(`  ${i + 1}. ${show(e.employer)}  (${show(e.from)} – ${show(e.to)})`);
                doc.font('Helvetica');
                doc.text(`      Address: ${show(e.street)}, ${show(e.cityState)}  ·  Phone: ${show(e.phone)}`);
                doc.text(`      Position: ${show(e.position)}`);
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

            // ================= DISCLOSURES & AUTHORIZATIONS =================
            // Separate signed artifacts furnished with the application
            // (49 CFR 391.21(c)). Each starts on its own page — see the page
            // rules in the header comment.
            const consents = app.consents || {};
            const signedName = clean(cert.signature);

            const docTitle = (t) => {
                doc.font('Helvetica-Bold').fontSize(13).fillColor('#000000').text(t, { align: 'center' });
                doc.moveDown(0.6);
                doc.font('Helvetica').fontSize(9).fillColor('#111111');
            };
            const para = (t) => {
                doc.font('Helvetica').fontSize(9).text(t);
                doc.moveDown(0.5);
            };
            const eSigned = (name) => {
                doc.moveDown(0.4);
                doc.font('Helvetica-Bold').fontSize(9)
                    .text(`Electronically signed (typed full legal name): ${show(name)}`);
                doc.font('Helvetica').fontSize(8).fillColor('#555555')
                    .text(`Signed ${show(app.submittedAtCT)} (${show(app.submittedAtISO)}) from IP ${show(app.submitterIp)} at forbeslogistix.com/application.`);
                doc.fontSize(9).fillColor('#111111');
            };

            // ----- FCRA disclosure: this page must contain ONLY the disclosure.
            // TODO(owner): once a screening vendor (CRA) is chosen, replace the
            // final sentence with the agency's name, address, phone, and website
            // (required for California applicants; best practice everywhere) —
            // and make the same edit in ApplicationClient.js.
            doc.addPage();
            docTitle('DISCLOSURE REGARDING BACKGROUND REPORTS');
            para(
                'Forbes Logistix LLC ("Forbes Logistix") may obtain one or more consumer reports about you for ' +
                'employment purposes, including deciding whether to hire or engage you as a driver and, if you are ' +
                'hired or engaged, for decisions about your continued employment or engagement to the extent permitted ' +
                'by law. The reports may include information about your criminal record history, your driving and ' +
                'motor vehicle records, and verification of your prior employment. The reports will be obtained ' +
                'through a consumer reporting agency. You may request the agency’s name, address, telephone number, ' +
                'and website from Forbes Logistix at any time by calling (601) 300-5529.'
            );

            // ----- Investigative consumer report disclosure (15 U.S.C. 1681d).
            doc.addPage();
            docTitle('INVESTIGATIVE CONSUMER REPORT DISCLOSURE');
            para(
                'Forbes Logistix LLC may also request an "investigative consumer report" about you — a background ' +
                'report that includes information about your character, general reputation, personal characteristics, ' +
                'or mode of living, obtained through personal interviews (for example, interviews with your previous ' +
                'employers about your safety performance history). You have the right to request, in writing within a ' +
                'reasonable time, additional disclosure about the nature and scope of any such investigation. A written ' +
                'summary of your rights under the Fair Credit Reporting Act, "A Summary of Your Rights Under the Fair ' +
                'Credit Reporting Act," is provided with this disclosure at: ' +
                'https://files.consumerfinance.gov/f/documents/bcfp_consumer-rights-summary_2018-09.pdf'
            );

            // ----- FCRA authorization (may accompany the disclosure per
            // 1681b(b)(2)(A)(ii); kept on its own page as the cleaner pattern).
            doc.addPage();
            docTitle('AUTHORIZATION OF BACKGROUND REPORTS');
            para(
                'I acknowledge that I have received and read the Disclosure Regarding Background Reports and the ' +
                'Investigative Consumer Report Disclosure from Forbes Logistix LLC. I authorize Forbes Logistix LLC to ' +
                'obtain consumer reports and investigative consumer reports about me in connection with my application ' +
                'and, to the extent permitted by applicable law, at any time during my employment or contract with ' +
                'Forbes Logistix LLC. I authorize state motor vehicle agencies, courts, my previous employers, and ' +
                'other information sources to furnish information about me to Forbes Logistix LLC and its consumer ' +
                'reporting agency for these reports. I understand that typing my full legal name constitutes my ' +
                'electronic signature.'
            );
            para(
                `[${consents.fcra && consents.fcra.freeCopy ? 'X' : ' '}] Free copy requested — the applicant ` +
                'checked the box to receive a free copy of any consumer report or investigative consumer report ' +
                'obtained about them. (California, Minnesota, and Oklahoma applicants have this right by law; Forbes ' +
                'Logistix extends it to all applicants. California applicants: a copy will be sent within 3 business ' +
                'days of Forbes Logistix receiving the report.)'
            );
            eSigned(consents.fcra && consents.fcra.signature);

            // ----- PSP: FMCSA-mandated language, verbatim and standalone.
            // Source: psp.fmcsa.dot.gov Disclosure and Authorization Form
            // (LAST UPDATED 2/11/2016), with "Forbes Logistix LLC" in the two
            // Prospective Employer blanks as the PSP FAQ directs. Do not edit,
            // trim, or let any other artifact share these pages.
            doc.addPage();
            doc.font('Helvetica-Bold').fontSize(8).text(
                'THE BELOW DISCLOSURE AND AUTHORIZATION LANGUAGE IS FOR MANDATORY USE BY ALL ACCOUNT HOLDERS',
                { align: 'center' }
            );
            doc.moveDown(0.5);
            doc.font('Helvetica-Bold').fontSize(12).text('IMPORTANT DISCLOSURE', { align: 'center' });
            doc.font('Helvetica-Bold').fontSize(11).text('REGARDING BACKGROUND REPORTS FROM THE PSP Online Service', { align: 'center' });
            doc.moveDown(0.6);
            doc.font('Helvetica').fontSize(9);
            para(
                'In connection with your application for employment with Forbes Logistix LLC ("Prospective Employer"), ' +
                'Prospective Employer, its employees, agents or contractors may obtain one or more reports regarding ' +
                'your driving, and safety inspection history from the Federal Motor Carrier Safety Administration (FMCSA).'
            );
            para(
                'When the application for employment is submitted in person, if the Prospective Employer uses any ' +
                'information it obtains from FMCSA in a decision to not hire you or to make any other adverse ' +
                'employment decision regarding you, the Prospective Employer will provide you with a copy of the report ' +
                'upon which its decision was based and a written summary of your rights under the Fair Credit Reporting ' +
                'Act before taking any final adverse action. If any final adverse action is taken against you based ' +
                'upon your driving history or safety report, the Prospective Employer will notify you that the action ' +
                'has been taken and that the action was based in part or in whole on this report.'
            );
            para(
                'When the application for employment is submitted by mail, telephone, computer, or other similar means, ' +
                'if the Prospective Employer uses any information it obtains from FMCSA in a decision to not hire you ' +
                'or to make any other adverse employment decision regarding you, the Prospective Employer must provide ' +
                'you within three business days of taking adverse action oral, written or electronic notification: that ' +
                'adverse action has been taken based in whole or in part on information obtained from FMCSA; the name, ' +
                'address, and the toll free telephone number of FMCSA; that the FMCSA did not make the decision to take ' +
                'the adverse action and is unable to provide you the specific reasons why the adverse action was taken; ' +
                'and that you may, upon providing proper identification, request a free copy of the report and may ' +
                'dispute with the FMCSA the accuracy or completeness of any information or report. If you request a ' +
                'copy of a driver record from the Prospective Employer who procured the report, then, within 3 business ' +
                'days of receiving your request, together with proper identification, the Prospective Employer must ' +
                'send or provide to you a copy of your report and a summary of your rights under the Fair Credit ' +
                'Reporting Act.'
            );
            para(
                'Neither the Prospective Employer nor the FMCSA contractor supplying the crash and safety information ' +
                'has the capability to correct any safety data that appears to be incorrect. You may challenge the ' +
                'accuracy of the data by submitting a request to https://dataqs.fmcsa.dot.gov. If you challenge crash ' +
                'or inspection information reported by a State, FMCSA cannot change or correct this data. Your request ' +
                'will be forwarded by the DataQs system to the appropriate State for adjudication.'
            );
            para(
                'Any crash or inspection in which you were involved will display on your PSP report. Since the PSP ' +
                'report does not report, or assign, or imply fault, it will include all Commercial Motor Vehicle (CMV) ' +
                'crashes where you were a driver or co-driver and where those crashes were reported to FMCSA, ' +
                'regardless of fault. Similarly, all inspections, with or without violations, appear on the PSP report. ' +
                'State citations associated with Federal Motor Carrier Safety Regulations (FMCSR) violations that have ' +
                'been adjudicated by a court of law will also appear, and remain, on a PSP report.'
            );
            para('The Prospective Employer cannot obtain background reports from FMCSA without your authorization.');
            doc.font('Helvetica-Bold').fontSize(11).text('AUTHORIZATION', { align: 'center' });
            doc.moveDown(0.5);
            doc.font('Helvetica').fontSize(9);
            para('If you agree that the Prospective Employer may obtain such background reports, please read the following and sign below:');
            para(
                'I authorize Forbes Logistix LLC ("Prospective Employer") to access the FMCSA Pre-Employment Screening ' +
                'Program (PSP) system to seek information regarding my commercial driving safety record and information ' +
                'regarding my safety inspection history. I understand that I am authorizing the release of safety ' +
                'performance information including crash data from the previous five (5) years and inspection history ' +
                'from the previous three (3) years. I understand and acknowledge that this release of information may ' +
                'assist the Prospective Employer to make a determination regarding my suitability as an employee.'
            );
            para(
                'I further understand that neither the Prospective Employer nor the FMCSA contractor supplying the ' +
                'crash and safety information has the capability to correct any safety data that appears to be ' +
                'incorrect. I understand I may challenge the accuracy of the data by submitting a request to ' +
                'https://dataqs.fmcsa.dot.gov. If I challenge crash or inspection information reported by a State, ' +
                'FMCSA cannot change or correct this data. I understand my request will be forwarded by the DataQs ' +
                'system to the appropriate State for adjudication.'
            );
            para(
                'I understand that any crash or inspection in which I was involved will display on my PSP report. ' +
                'Since the PSP report does not report, or assign, or imply fault, I acknowledge it will include all ' +
                'CMV crashes where I was a driver or co-driver and where those crashes were reported to FMCSA, ' +
                'regardless of fault. Similarly, I understand all inspections, with or without violations, will appear ' +
                'on my PSP report, and State citations associated with FMCSR violations that have been adjudicated by ' +
                'a court of law will also appear, and remain, on my PSP report.'
            );
            para(
                'I have read the above Disclosure Regarding Background Reports provided to me by Prospective Employer ' +
                'and I understand that if I sign this Disclosure and Authorization, Prospective Employer may obtain a ' +
                'report of my crash and inspection history. I hereby authorize Prospective Employer and its employees, ' +
                'authorized agents, and/or affiliates to obtain the information authorized above.'
            );
            doc.font('Helvetica').fontSize(9)
                .text(`Date: ${show(app.submittedAtCT)}        Signature (electronic): ${show(consents.psp && consents.psp.signature)}`);
            doc.text(`Name (Please Print): ${show(consents.psp && consents.psp.signature)}`);
            doc.moveDown(0.6);
            doc.fontSize(8).fillColor('#555555');
            para(
                'NOTICE: This form is made available to monthly account holders by NIC on behalf of the U.S. Department ' +
                'of Transportation, Federal Motor Carrier Safety Administration (FMCSA). Account holders are required ' +
                'by federal law to obtain an Applicant’s written or electronic consent prior to accessing the ' +
                'Applicant’s PSP report. Further, account holders are required by FMCSA to use the language contained ' +
                'in this Disclosure and Authorization form to obtain an Applicant’s consent. The language must be used ' +
                'in whole, exactly as provided. Further, the language on this form must exist as one stand-alone ' +
                'document. The language may NOT be included with other consent forms or any other language.'
            );
            para('NOTICE: The prospective employment concept referenced in this form contemplates the definition of "employee" contained at 49 C.F.R. 383.5.');
            doc.text('LAST UPDATED 2/11/2016');
            doc.fontSize(9).fillColor('#111111');

            // ----- Drug & alcohol history release (40.321(b) specific consent)
            // + the 40.25(j) self-report. Employers enumerated by name so the
            // consent is "particular, explicitly identified" — not blanket.
            doc.addPage();
            docTitle('AUTHORIZATION TO RELEASE DRUG AND ALCOHOL TESTING INFORMATION (49 CFR 40.25 / 391.23(e))');
            const employerNames = emp.map((e, i) => `${i + 1}. ${show(e.employer)}`).join('   ');
            para(
                'I authorize each previous employer identified in the Employment History section of this application ' +
                `— specifically: ${employerNames || '—'} — that employed me in a safety-sensitive function subject ` +
                'to DOT drug and alcohol testing during the three (3) years before the date of this application to ' +
                'release directly to Forbes Logistix LLC (USDOT 4361817, 3180 Utica Ave, Jackson, MS 39209), and I ' +
                'authorize Forbes Logistix LLC to obtain, the following information from my DOT drug and alcohol ' +
                'testing records: (1) alcohol test results of 0.04 or greater; (2) verified positive controlled ' +
                'substances test results; (3) refusals to be tested, including verified adulterated or substituted ' +
                'test results; (4) any other violations of DOT drug and alcohol testing regulations, including whether ' +
                'I violated the prohibitions of 49 CFR part 382 or failed to undertake or complete a rehabilitation ' +
                'program prescribed by a substance abuse professional; and (5) documentation of my completion of DOT ' +
                'return-to-duty requirements, including follow-up tests and any follow-up testing plan. This is a ' +
                'specific consent under 49 CFR 40.321(b), limited to the employers identified above, the information ' +
                'listed above, and Forbes Logistix LLC as recipient; it is effective as of the date of my electronic ' +
                'signature and expires when the hiring decision on this application is made. I understand that if I do ' +
                'not provide this consent, federal regulations prohibit Forbes Logistix LLC from permitting me to ' +
                'operate a commercial motor vehicle for Forbes Logistix LLC (49 CFR 40.25(a); 391.23(f)(1)).'
            );
            doc.fontSize(8).fillColor('#555555');
            para(
                'Note: for previous employers regulated by FMCSA, drug and alcohol history is obtained through the ' +
                'FMCSA Drug & Alcohol Clearinghouse (49 CFR 391.23(e)(4)); this release supports direct requests to ' +
                'employers regulated by other DOT agencies and retrieval of any follow-up testing plan.'
            );
            doc.fontSize(9).fillColor('#111111');
            const daCon = consents.drugAlcohol || {};
            doc.font('Helvetica-Bold').text('SELF-REPORT (49 CFR 40.25(j)):', { continued: true });
            doc.font('Helvetica').text(
                ' In the past three (3) years, have you tested positive, or refused to test, on any pre-employment ' +
                'drug or alcohol test administered by an employer to which you applied for, but did not obtain, DOT ' +
                'safety-sensitive work?'
            );
            doc.moveDown(0.2);
            doc.font('Helvetica-Bold').text(`Applicant’s answer: ${daCon.selfReport === true ? 'YES' : 'NO'}`);
            if (daCon.selfReport === true) {
                doc.font('Helvetica').text(`Explanation: ${show(daCon.selfReportExplanation)}`);
                doc.font('Helvetica').fontSize(8).fillColor('#7a0000')
                    .text('A YES answer requires documentation of successful completion of DOT return-to-duty requirements before any safety-sensitive work.');
                doc.fontSize(9).fillColor('#111111');
            }
            eSigned(daCon.signature);

            // ----- Clearinghouse notice + acknowledgment (+ optional
            // limited-query general consent, adopted by the same signature).
            doc.addPage();
            docTitle('FMCSA DRUG & ALCOHOL CLEARINGHOUSE — PRE-EMPLOYMENT QUERY NOTICE');
            para(
                'Federal regulations (49 CFR 382.701(a)) require Forbes Logistix LLC to conduct a full pre-employment ' +
                'query of the FMCSA Drug and Alcohol Clearinghouse before the applicant may perform safety-sensitive ' +
                'functions, including driving a commercial motor vehicle. Consent to a full query cannot be given on ' +
                'this application — federal rules require the driver to grant it electronically inside the ' +
                'Clearinghouse itself (49 CFR 382.703). The driver must be registered at clearinghouse.fmcsa.dot.gov ' +
                'and approve the consent request from Forbes Logistix LLC. If consent is not granted in the ' +
                'Clearinghouse, federal regulations prohibit Forbes Logistix LLC from permitting the driver to operate ' +
                'a commercial motor vehicle (49 CFR 391.23(f)(2); 382.703(c)).'
            );
            doc.font('Helvetica-Bold').text(
                '[X] ACKNOWLEDGED — the applicant confirmed: "I understand that Forbes Logistix LLC will conduct a ' +
                'full query of my FMCSA Drug and Alcohol Clearinghouse record, and that I must be registered in the ' +
                'Clearinghouse and grant consent electronically within the Clearinghouse before I can be permitted to drive."'
            );
            doc.moveDown(0.6);
            doc.font('Helvetica-Bold').fontSize(10).text('GENERAL CONSENT FOR LIMITED QUERIES (OPTIONAL)');
            doc.moveDown(0.3);
            doc.font('Helvetica').fontSize(9);
            para(
                'I consent to Forbes Logistix LLC (USDOT 4361817) conducting limited queries of the FMCSA Drug and ' +
                'Alcohol Clearinghouse to determine whether drug or alcohol violation information about me exists in ' +
                'the Clearinghouse. This consent covers all limited queries, including the annual query required by ' +
                '49 CFR 382.701(b), conducted while I am employed by or under contract to Forbes Logistix LLC, and ' +
                'remains in effect for the duration of that relationship unless I withdraw it in writing. I understand ' +
                'that a limited query does not release the contents of my Clearinghouse record; that if a limited query ' +
                'shows information exists, I must provide specific consent electronically within the Clearinghouse so ' +
                'Forbes Logistix LLC can conduct a full query within 24 hours; and that if I do not provide that ' +
                'consent, I must be removed from safety-sensitive functions, including driving a commercial motor ' +
                'vehicle, until the full query is completed and confirms my record contains no prohibitions ' +
                '(49 CFR 382.701(b); 382.703(c)).'
            );
            doc.font('Helvetica-Bold').text(
                daCon.limitedQuery
                    ? '[X] GIVEN — the applicant checked the limited-query general consent box; it is adopted by the signature below.'
                    : '[ ] NOT GIVEN — the applicant did not check the optional limited-query consent box.'
            );
            eSigned(daCon.signature);

            // ----- E-SIGN consent record + state law notices.
            doc.addPage();
            docTitle('CONSENT TO ELECTRONIC RECORDS AND SIGNATURES');
            para(
                'The applicant consented to complete, sign, and receive this driver qualification application and ' +
                'related hiring documents electronically, and confirmed the ability to access documents on their ' +
                'device (a phone or computer with a current web browser and PDF viewing capability). The applicant may ' +
                'request a free paper copy of any document, or withdraw this consent, by contacting Forbes Logistix ' +
                'LLC at (601) 300-5529 or recruiting@forbeslogistix.com; withdrawing consent will not affect documents ' +
                'already signed, but future documents would then be provided on paper. The applicant’s typed full ' +
                'legal name serves as their legal signature (49 CFR 390.32; 15 U.S.C. 7001(c)).'
            );
            doc.font('Helvetica-Bold').text('[X] CONSENTED at the start of the application, before any signature was collected.');
            eSigned(signedName);
            doc.moveDown(1);
            docTitle('STATE LAW NOTICES');
            para(
                'CALIFORNIA APPLICANTS: Under the California Investigative Consumer Reporting Agencies Act, you may ' +
                'view the file the consumer reporting agency keeps on you during normal business hours and obtain a ' +
                'copy of your report. The nature and scope of the investigation is: verification of criminal record ' +
                'history, driving records, and prior employment for driver hiring. The agency’s name, address, ' +
                'telephone number, and privacy-practices website are available from Forbes Logistix LLC at ' +
                '(601) 300-5529. A summary of your rights under California Civil Code section 1786.22 is available ' +
                'from the agency on request.'
            );
            para(
                'NEW YORK APPLICANTS: Upon request, you will be informed whether a consumer report was requested about ' +
                'you, and given the name and address of the agency that furnished it. If a report contains criminal ' +
                'conviction information, you will receive a copy of Article 23-A of the New York Correction Law.'
            );
            para(
                'WASHINGTON APPLICANTS: You have the right to request from the consumer reporting agency a written ' +
                'summary of your rights and remedies under the Washington Fair Credit Reporting Act (RCW 19.182).'
            );
            para(
                'MINNESOTA AND OKLAHOMA APPLICANTS: Check the box on the Authorization of Background Reports screen ' +
                'to receive a free copy of your report.'
            );

            doc.end();
        } catch (err) {
            console.error('Error generating PDF:', err);
            reject(err);
        }
    });
};
