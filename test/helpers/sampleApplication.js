'use strict';
// Fixed sample applicant for the PDF snapshot test — the ASSEMBLED
// application object (the shape the controller hands to generatePDF),
// constructed directly so no real clock leaks in: generatePDF itself never
// reads the clock, so this renders byte-identically forever.
//
// Contents per the v6 contract: a current employer, one self-employed period
// with C/TPA, two earlier company carriers, one 2-month explained gap, and
// the historyComplete attestation — fixed dates only. Employment is
// deliberately NOT in most-recent-first order (the v6 sort is under test).

function sampleApplication() {
    return {
        formVersion: 6,
        position: 'flatbed-southeast',
        personal: {
            firstName: 'Marcus',
            middleName: 'DeWayne',
            lastName: 'Webb',
            noMiddleName: false,
            fullName: 'Marcus DeWayne Webb',
            phone: '(601) 555-0142',
            email: 'marcus.webb@example.com',
            dob: '1985-03-04',
            currentAddress: {
                street: '12 Pine Street',
                city: 'Jackson',
                state: 'MS',
                zip: '39209',
                since: '2024-02',
            },
            previousAddresses: [
                { street: '480 Delta Row', city: 'Greenville', state: 'MS', zip: '38701', from: '2021-07', to: '2024-01' },
            ],
        },
        license: {
            state: 'MS',
            number: 'MS8675309',
            class: 'A',
            expiration: '2027-05-01',
            endorsementCodes: ['H', 'X'],
            restrictions: 'None',
            everDeniedRevokedSuspended: false,
        },
        additionalLicenses: [],
        experience: [{ equipmentType: 'Flatbed 48/53 ft', years: '9', approxMiles: '900,000' }],
        accidents: [
            { date: '2024-11-02', description: 'Minor backing collision at shipper yard', fatalities: '0', injuries: '0' },
        ],
        violations: [],
        employment: [
            {
                employer: 'Delta Freight Lines',
                street: '77 Levee Rd',
                city: 'Memphis',
                state: 'TN',
                zip: '38103',
                phone: '9015550100',
                from: '2016-01',
                to: '2018-02',
                position: 'OTR flatbed driver',
                reasonForLeaving: 'Moved home to Mississippi',
                fmcsrSubject: true,
                safetySensitive: true,
                usdotNumber: '111222',
            },
            {
                employer: 'Webb Hauling LLC (self)',
                street: '12 Pine Street',
                city: 'Jackson',
                state: 'MS',
                zip: '39209',
                phone: '6015550142',
                from: '2020-06',
                to: '2022-12',
                position: 'Owner-operator',
                reasonForLeaving: 'Closed the business',
                fmcsrSubject: true,
                safetySensitive: true,
                selfEmployed: true,
                usdotNumber: '3456789',
                mcNumber: '987654',
                authorityStatus: 'inactive',
                tpaName: 'SafeRoad C/TPA Services',
                tpaPhone: '(601) 555-0177',
                leasedDuringPeriod: true,
            },
            {
                employer: 'Magnolia Carriers Inc',
                street: '9 Port St',
                city: 'Vicksburg',
                state: 'MS',
                zip: '39180',
                phone: '6015550188',
                from: '2018-03',
                to: '2020-03',
                position: 'Regional flatbed driver',
                reasonForLeaving: 'Laid off',
                fmcsrSubject: true,
                safetySensitive: true,
            },
            {
                employer: 'Southern Steel Transport',
                street: '400 Mill Ave',
                city: 'Jackson',
                state: 'MS',
                zip: '39201',
                phone: '6015550109',
                from: '2023-01',
                to: 'Present',
                current: true,
                position: 'Flatbed driver',
                reasonForLeaving: 'Still employed — seeking better home time',
                fmcsrSubject: true,
                safetySensitive: true,
            },
        ],
        employmentGaps: [
            { from: '2020-04', to: '2020-05', explanation: 'Out of work while setting up my own authority.' },
        ],
        historyComplete: true,
        gapsExplanation: '',
        consents: {
            electronicRecords: true,
            fcra: { authorized: true, signature: 'Marcus DeWayne Webb', freeCopy: true },
            psp: { signature: 'Marcus DeWayne Webb' },
            drugAlcohol: {
                signature: 'Marcus DeWayne Webb',
                selfReport: false,
                selfReportExplanation: '',
                limitedQuery: true,
            },
            clearinghouseAck: true,
        },
        certification: { signature: 'Marcus DeWayne Webb', esignConsent: true },
        submittedAtISO: '2026-08-15T14:30:00.000Z',
        submittedAtCT: 'Aug 15, 2026, 9:30 AM CT',
        submitterIp: '203.0.113.5',
    };
}

module.exports = { sampleApplication };
