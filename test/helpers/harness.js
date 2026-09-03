'use strict';
// Controller test harness. SAFETY: the Graph mailer (and Turnstile verifier)
// are stubbed on the SHARED module exports BEFORE the controller is required,
// so the controller's destructured imports capture the stubs — no test can
// ever send real mail or hit Cloudflare. Never require the controller in a
// test file except through this harness.

const graphMailer = require('../../utils/graphMailer.js');
const turnstile = require('../../utils/turnstile.js');

const sentMails = [];
graphMailer.sendViaGraph = async (msg) => {
    sentMails.push(msg);
};
turnstile.verifyTurnstile = async () => ({ ok: true, skipped: true });

// Loaded AFTER the stubs above — order matters.
const controller = require('../../controllers/pdfController.js');

const { monthIndexOf, monthKeyOf, monthLabel, currentMonthIndex, computeEmploymentGaps, computeResidenceGaps } =
    controller._employmentGapInternals;

// "YYYY-MM" key at an offset (in months) from the real current month — the
// controller validates gap/coverage rules against the live clock, so payload
// fixtures are built relative to it.
const ym = (offset) => monthKeyOf(currentMonthIndex() + offset);

function makeRes() {
    return {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        },
    };
}

async function post(body) {
    const res = makeRes();
    await controller.sendPDF({ body, ip: '203.0.113.5' }, res);
    return res;
}

// ---------- payload builders (fresh object per call) ----------

const CONSENTS = () => ({
    electronicRecords: true,
    fcra: { authorized: true, signature: 'Marcus DeWayne Webb', freeCopy: false },
    psp: { signature: 'Marcus DeWayne Webb' },
    drugAlcohol: { signature: 'Marcus DeWayne Webb', selfReport: false },
    clearinghouseAck: true,
});

// Valid v6 payload: two employers covering ~7.5 years with no gap, current
// address covering the 3-year residence window.
function makeV6Body() {
    return {
        formVersion: 6,
        position: 'flatbed-southeast',
        turnstileToken: 'test-token',
        personal: {
            firstName: 'Marcus',
            middleName: 'DeWayne',
            lastName: 'Webb',
            noMiddleName: false,
            phone: '(601) 555-0142',
            email: 'marcus.webb@example.com',
            dob: '1985-03-04',
            currentAddress: { street: '12 Pine Street', city: 'Jackson', state: 'MS', zip: '39209', since: ym(-40) },
            previousAddresses: [],
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
        experience: [{ equipmentType: 'Flatbed 48/53 ft', years: '5', approxMiles: '500,000' }],
        accidents: [],
        violations: [],
        employment: [
            {
                employer: 'Southern Steel Transport',
                street: '400 Mill Ave',
                city: 'Jackson',
                state: 'MS',
                zip: '39201',
                phone: '6015550109',
                from: ym(-30),
                to: 'Present',
                current: true,
                position: 'Flatbed driver',
                reasonForLeaving: 'Still employed',
                fmcsrSubject: true,
                safetySensitive: true,
            },
            {
                employer: 'Delta Freight Lines',
                street: '77 Levee Rd',
                city: 'Memphis',
                state: 'TN',
                zip: '38103',
                phone: '9015550100',
                from: ym(-90),
                to: ym(-30),
                position: 'OTR flatbed driver',
                reasonForLeaving: 'Moved home',
                fmcsrSubject: true,
                safetySensitive: true,
            },
        ],
        employmentGaps: [],
        historyComplete: true,
        consents: CONSENTS(),
        certification: { signature: 'Marcus DeWayne Webb', esignConsent: true },
    };
}

// A valid v6 self-employment entry (splice into employment where needed).
function makeSelfEmployedEntry(from, to) {
    return {
        employer: 'Webb Hauling LLC (self)',
        street: '12 Pine Street',
        city: 'Jackson',
        state: 'MS',
        zip: '39209',
        phone: '6015550142',
        from,
        to,
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
        leasedDuringPeriod: false,
    };
}

// Valid v5 payload — pre-v6 shape (free-text endorsements, sinceYear,
// free-text employer state, no restrictions) must keep passing untouched.
function makeV5Body() {
    const body = makeV6Body();
    body.formVersion = 5;
    body.personal.currentAddress = {
        street: '12 Pine Street',
        city: 'Jackson',
        state: 'Mississippi',
        zip: '39209',
        sinceYear: '2019',
    };
    body.license = {
        state: 'MS',
        number: 'MS8675309',
        class: 'A',
        expiration: '2027-05-01',
        endorsements: 'Tanker (N), Hazmat (H)',
        everDeniedRevokedSuspended: false,
    };
    for (const e of body.employment) {
        e.state = 'Texas'; // v5 allowed free-text state
        e.zip = 'ABC123'; // and any non-empty zip
        delete e.position; // position was rendered-only pre-v6
        e.reasonForLeaving = 'ok'; // under 3 chars was fine pre-v6
    }
    return body;
}

// Valid v4 payload — free-text full name.
function makeV4Body() {
    const body = makeV5Body();
    body.formVersion = 4;
    body.personal = {
        fullName: 'Marcus DeWayne Webb',
        phone: '(601) 555-0142',
        email: 'marcus.webb@example.com',
        dob: '1985-03-04',
        currentAddress: body.personal.currentAddress,
        previousAddresses: [],
    };
    return body;
}

// Valid legacy payload — no formVersion at all.
function makeLegacyBody() {
    return {
        position: 'flatbed-southeast',
        turnstileToken: 'test-token',
        personal: {
            fullName: 'Marcus DeWayne Webb',
            phone: '(601) 555-0142',
            email: '',
            dob: '1985-03-04',
            currentAddress: { street: '12 Pine Street', city: 'Jackson', state: 'MS', zip: '39209', sinceYear: '2019' },
            previousAddresses: [],
        },
        license: {
            state: 'MS',
            number: 'MS8675309',
            class: 'A',
            expiration: '2027-05-01',
            endorsements: '',
            everDeniedRevokedSuspended: false,
        },
        additionalLicenses: [],
        experience: [{ equipmentType: 'Flatbed', years: '5' }],
        accidents: [],
        violations: [],
        employment: [
            {
                employer: 'Delta Freight Lines',
                street: '77 Levee Rd',
                cityState: 'Memphis, TN',
                phone: '9015550100',
                from: '2019-01',
                to: 'Present',
                reasonForLeaving: 'ok',
            },
        ],
        gapsExplanation: 'None.',
        consents: CONSENTS(),
        certification: { signature: 'Marcus DeWayne Webb', esignConsent: true },
    };
}

module.exports = {
    post,
    sentMails,
    ym,
    makeV6Body,
    makeSelfEmployedEntry,
    makeV5Body,
    makeV4Body,
    makeLegacyBody,
    internals: { monthIndexOf, monthKeyOf, monthLabel, currentMonthIndex, computeEmploymentGaps, computeResidenceGaps },
};
