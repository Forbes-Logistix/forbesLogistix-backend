'use strict';
// v6 validation matrix for POST /api/send-pdf, run through the stubbed-mailer
// controller harness (no real mail, no Turnstile). Every new v6 rule gets a
// reject case and, where meaningful, an accept case; the version-ladder
// regressions (v5/v4/legacy payloads keep passing) live in
// version-regression.test.js.

const { test } = require('node:test');
const assert = require('node:assert');
const {
    post,
    sentMails,
    ym,
    makeV6Body,
    makeSelfEmployedEntry,
    internals,
} = require('./helpers/harness.js');

const { monthLabel, monthIndexOf } = internals;

async function expect400(body, messageIncludes) {
    const res = await post(body);
    assert.strictEqual(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    if (messageIncludes) {
        assert.ok(
            res.body.message.includes(messageIncludes),
            `expected message to include "${messageIncludes}", got "${res.body.message}"`
        );
    }
    return res;
}

async function expect200(body) {
    const res = await post(body);
    assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    return res;
}

test('v6 baseline payload passes and sends PDF + JSON attachments', async () => {
    const before = sentMails.length;
    await expect200(makeV6Body());
    assert.strictEqual(sentMails.length, before + 1);
    const mail = sentMails[sentMails.length - 1];
    assert.strictEqual(mail.attachments.length, 2);
    assert.strictEqual(mail.attachments[0].filename, 'DOT-Application-Webb.pdf');
    assert.strictEqual(mail.attachments[0].contentType, 'application/pdf');
    assert.strictEqual(mail.attachments[1].filename, 'DOT-Application-Webb.json');
    assert.strictEqual(mail.attachments[1].contentType, 'application/json');
    const parsed = JSON.parse(mail.attachments[1].content.toString('utf8'));
    assert.strictEqual(parsed.formVersion, 6);
    assert.strictEqual(parsed.personal.lastName, 'Webb');
    assert.ok(parsed.submittedAtISO);
    assert.ok(parsed.submitterIp);
    assert.strictEqual('turnstileToken' in parsed, false);
    assert.strictEqual('honeypot' in parsed, false);
});

test('honeypot short-circuits with 200 and sends nothing', async () => {
    const before = sentMails.length;
    const body = makeV6Body();
    body.honeypot = 'gotcha';
    const res = await post(body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(sentMails.length, before);
});

// ---------- per-employer rules ----------

test('v6: employer position is required', async () => {
    const body = makeV6Body();
    delete body.employment[0].position;
    await expect400(body, 'position you held');
});

test('v6: reason for leaving under 3 chars blocks', async () => {
    const body = makeV6Body();
    body.employment[1].reasonForLeaving = 'ok';
    await expect400(body, 'at least 3 characters');
});

test('v6: employer state must come from the code list', async () => {
    const body = makeV6Body();
    body.employment[0].state = 'Texas';
    await expect400(body, "state from the list");
});

test('v6: employer ZIP must be 5 digits or ZIP+4', async () => {
    const body = makeV6Body();
    body.employment[0].zip = '1234';
    await expect400(body, '12345 or 12345-6789');
    body.employment[0].zip = '39201-1234';
    await expect200(body);
});

test('v6: "Other (non-US)" relaxes the ZIP to any non-empty <= 12 chars', async () => {
    const body = makeV6Body();
    body.employment[0].state = 'Other (non-US)';
    body.employment[0].zip = 'SW1A 1AA';
    await expect200(body);
    body.employment[0].zip = '   ';
    await expect400(body); // still required (v4 base rule)
    body.employment[0].zip = 'ABCDEFGHIJKLM'; // 13 chars
    await expect400(body);
});

test('v6: optional per-employer USDOT must be digits (12 max) when given', async () => {
    const body = makeV6Body();
    body.employment[0].usdotNumber = 'USDOT-123';
    await expect400(body, 'digits only');
    body.employment[0].usdotNumber = '1234567890123'; // 13 digits
    await expect400(body, 'digits only');
    body.employment[0].usdotNumber = '123456';
    await expect200(body);
});

// ---------- self-employment block ----------

test('v6: a fully-specified self-employed period passes', async () => {
    const body = makeV6Body();
    body.employment.push(makeSelfEmployedEntry(ym(-120), ym(-90)));
    await expect200(body);
});

test('v6: self-employed USDOT number is required (digits only)', async () => {
    const body = makeV6Body();
    const se = makeSelfEmployedEntry(ym(-120), ym(-90));
    se.usdotNumber = '';
    body.employment.push(se);
    await expect400(body, "Your company's USDOT number");
});

test('v6: self-employed MC number over 12 chars blocks', async () => {
    const body = makeV6Body();
    const se = makeSelfEmployedEntry(ym(-120), ym(-90));
    se.mcNumber = '1234567890123';
    body.employment.push(se);
    await expect400(body, 'MC number');
});

test('v6: authority status must be active/inactive/revoked', async () => {
    const body = makeV6Body();
    const se = makeSelfEmployedEntry(ym(-120), ym(-90));
    se.authorityStatus = 'sold';
    body.employment.push(se);
    await expect400(body, 'authority status');
    se.authorityStatus = undefined;
    await expect400(body, 'authority status');
    for (const ok of ['active', 'inactive', 'revoked']) {
        se.authorityStatus = ok;
        await expect200(body);
    }
});

test('v6: leased-to-another-carrier answer is required (both answers pass)', async () => {
    const body = makeV6Body();
    const se = makeSelfEmployedEntry(ym(-120), ym(-90));
    delete se.leasedDuringPeriod;
    body.employment.push(se);
    await expect400(body, 'leased to another motor carrier');
    se.leasedDuringPeriod = 'yes'; // string, not boolean
    await expect400(body, 'leased to another motor carrier');
    se.leasedDuringPeriod = true;
    await expect200(body);
    se.leasedDuringPeriod = false;
    await expect200(body);
});

test('v6: safety-sensitive self-employment needs a valid C/TPA phone', async () => {
    const body = makeV6Body();
    const se = makeSelfEmployedEntry(ym(-120), ym(-90));
    se.tpaPhone = '555-0177'; // 7 digits
    body.employment.push(se);
    await expect400(body, 'phone number for the consortium/TPA');
    se.tpaPhone = '';
    await expect400(body, 'phone number for the consortium/TPA');
    se.tpaPhone = '(601) 555-0177';
    await expect200(body);
});

test('v6: non-safety-sensitive self-employment does not need C/TPA phone', async () => {
    const body = makeV6Body();
    const se = makeSelfEmployedEntry(ym(-120), ym(-90));
    se.safetySensitive = false;
    se.tpaName = '';
    se.tpaPhone = '';
    body.employment.push(se);
    await expect200(body);
});

// ---------- CDL endorsements + restrictions ----------

test('v6: endorsementCodes must be a non-empty array of known codes', async () => {
    const body = makeV6Body();
    delete body.license.endorsementCodes;
    await expect400(body, 'endorsements');
    body.license.endorsementCodes = [];
    await expect400(body, 'endorsements');
    body.license.endorsementCodes = ['Q'];
    await expect400(body, 'endorsements');
    body.license.endorsementCodes = ['H', 'H'];
    await expect400(body, 'endorsements');
    body.license.endorsementCodes = ['H', 'N', 'T', 'P', 'S', 'X'];
    await expect200(body);
});

test('v6: "NONE" is mutually exclusive server-side', async () => {
    const body = makeV6Body();
    body.license.endorsementCodes = ['NONE', 'H'];
    await expect400(body, 'cannot be combined');
    body.license.endorsementCodes = ['NONE'];
    await expect200(body);
});

test('v6: restrictions are required and capped at 80 chars', async () => {
    const body = makeV6Body();
    delete body.license.restrictions;
    await expect400(body, 'restrictions');
    body.license.restrictions = '   ';
    await expect400(body, 'restrictions');
    body.license.restrictions = 'x'.repeat(81);
    await expect400(body, 'restrictions');
    body.license.restrictions = 'L - no air brakes';
    await expect200(body);
});

// ---------- residence dates + coverage ----------

test('v6: current-address "since" month is required and must parse', async () => {
    const body = makeV6Body();
    delete body.personal.currentAddress.since;
    await expect400(body, 'current address');
    body.personal.currentAddress.since = '2019'; // old year-only value
    await expect400(body, 'current address');
});

test('v6: previous addresses need from/to months', async () => {
    const body = makeV6Body();
    body.personal.previousAddresses = [
        { street: '480 Delta Row', city: 'Greenville', state: 'MS', zip: '38701' },
    ];
    await expect400(body, 'months you lived there');
});

test('v6: residence coverage blocks with the exact shared sentence', async () => {
    const body = makeV6Body();
    body.personal.currentAddress.since = ym(-10);
    const res = await expect400(body);
    // Gap: window start (now-36) .. the month before the move-in.
    const expected = `Your addresses need to cover the last 3 years — add the address you lived at during ${monthLabel(
        monthIndexOf(ym(-36))
    )} – ${monthLabel(monthIndexOf(ym(-11)))}.`;
    assert.strictEqual(res.body.message, expected);
});

test('v6: a previous address closing the hole passes coverage', async () => {
    const body = makeV6Body();
    body.personal.currentAddress.since = ym(-10);
    body.personal.previousAddresses = [
        { street: '480 Delta Row', city: 'Greenville', state: 'MS', zip: '38701', from: ym(-40), to: ym(-11) },
    ];
    await expect200(body);
});

test('v6: a single missing residence month is tolerated', async () => {
    const body = makeV6Body();
    body.personal.currentAddress.since = ym(-10);
    body.personal.previousAddresses = [
        // ends two months before the move-in => exactly one missing month
        { street: '480 Delta Row', city: 'Greenville', state: 'MS', zip: '38701', from: ym(-40), to: ym(-12) },
    ];
    await expect200(body);
});

// ---------- previous-address cap (mirrored with the frontend: 12) ----------

test('v6: a 7-address contiguous history passes (cap is 12, not 6)', async () => {
    const body = makeV6Body();
    body.personal.currentAddress.since = ym(-3);
    const mk = (from, to) => ({
        street: '480 Delta Row', city: 'Greenville', state: 'MS', zip: '38701', from, to,
    });
    // Seven contiguous previous addresses reaching back past the 36-month
    // window. Under the old slice(0, 6) the earliest one was silently
    // dropped, opening a coverage gap and blocking a UI-valid payload.
    body.personal.previousAddresses = [
        mk(ym(-8), ym(-4)),
        mk(ym(-13), ym(-9)),
        mk(ym(-18), ym(-14)),
        mk(ym(-23), ym(-19)),
        mk(ym(-28), ym(-24)),
        mk(ym(-33), ym(-29)),
        mk(ym(-40), ym(-34)),
    ];
    await expect200(body);
});

// ---------- future residence months ----------

test('v6: current-address "since" in the future blocks with the exact shared sentence', async () => {
    const body = makeV6Body();
    body.personal.currentAddress.since = ym(2);
    const res = await expect400(body);
    assert.strictEqual(res.body.message, "Address dates can't be in the future.");
});

test('v6: one month ahead is tolerated (client-clock skew)', async () => {
    const body = makeV6Body();
    body.personal.currentAddress.since = ym(1);
    body.personal.previousAddresses = [
        { street: '480 Delta Row', city: 'Greenville', state: 'MS', zip: '38701', from: ym(-40), to: ym(0) },
    ];
    await expect200(body);
});

test('v6: a future previous-address month blocks with the exact shared sentence', async () => {
    const body = makeV6Body();
    body.personal.previousAddresses = [
        { street: '480 Delta Row', city: 'Greenville', state: 'MS', zip: '38701', from: ym(-10), to: ym(2) },
    ];
    const res = await expect400(body);
    assert.strictEqual(res.body.message, "Address dates can't be in the future.");
});

// ---------- inverted previous-address range (server-only backstop) ----------

test('v6: previous address with To before From blocks', async () => {
    const body = makeV6Body();
    body.personal.previousAddresses = [
        { street: '480 Delta Row', city: 'Greenville', state: 'MS', zip: '38701', from: ym(-11), to: ym(-20) },
    ];
    const res = await expect400(body);
    assert.strictEqual(res.body.message, 'Each address needs real months, and From must come before To.');
});

// ---------- office JSON whitelist ----------

test('JSON attachment contains only whitelisted keys — junk payload keys are dropped', async () => {
    const body = makeV6Body();
    body.evilTop = 'x';
    body.personal.junk = 'x';
    body.personal.currentAddress.hax = 'x';
    body.personal.previousAddresses = [
        { street: '480 Delta Row', city: 'Greenville', state: 'MS', zip: '38701', from: ym(-45), to: ym(-41), junk: 'x' },
    ];
    body.license.evil = 'x';
    body.additionalLicenses = [
        { state: 'TN', number: 'TN123', class: 'A', expiration: '2027-01-15', dropTable: 'x' },
    ];
    body.experience[0].junk = 'x';
    body.accidents = [
        { date: '2024-11-02', description: 'Backed into dock', fatalities: '0', injuries: '0', sneaky: 'x' },
    ];
    body.violations = [
        { date: '2023-06-01', offense: 'Speeding 10 over', state: 'MS', penalty: '$150', sneaky: 'x' },
    ];
    body.employment[0].sneaky = 'x';

    const before = sentMails.length;
    await expect200(body);
    assert.strictEqual(sentMails.length, before + 1);
    const mail = sentMails[sentMails.length - 1];
    const parsed = JSON.parse(mail.attachments[1].content.toString('utf8'));

    assert.deepStrictEqual(
        Object.keys(parsed).sort(),
        [
            'accidents', 'additionalLicenses', 'certification', 'consents',
            'employment', 'employmentGaps', 'experience', 'formVersion',
            'gapsExplanation', 'historyComplete', 'license', 'personal',
            'position', 'submittedAtCT', 'submittedAtISO', 'submitterIp',
            'violations',
        ]
    );
    assert.deepStrictEqual(
        Object.keys(parsed.personal).sort(),
        ['currentAddress', 'dob', 'email', 'firstName', 'fullName', 'lastName',
            'middleName', 'noMiddleName', 'phone', 'previousAddresses'].sort()
    );
    assert.deepStrictEqual(
        Object.keys(parsed.personal.currentAddress).sort(),
        ['city', 'since', 'state', 'street', 'zip']
    );
    assert.deepStrictEqual(
        Object.keys(parsed.personal.previousAddresses[0]).sort(),
        ['city', 'from', 'state', 'street', 'to', 'zip']
    );
    assert.strictEqual('evil' in parsed.license, false);
    assert.deepStrictEqual(parsed.license.endorsementCodes, ['H', 'X']);
    assert.strictEqual(parsed.license.restrictions, 'None');
    assert.strictEqual('dropTable' in parsed.additionalLicenses[0], false);
    assert.strictEqual('junk' in parsed.experience[0], false);
    assert.strictEqual('sneaky' in parsed.accidents[0], false);
    assert.strictEqual('sneaky' in parsed.violations[0], false);
    assert.strictEqual('sneaky' in parsed.employment[0], false);
    // Known employment keys still ride along.
    assert.strictEqual(parsed.employment[0].employer, 'Southern Steel Transport');
    assert.strictEqual(parsed.employment[0].position, 'Flatbed driver');
});

// ---------- v4 cross-check still enforced on v6 ----------

test('v6: experience-vs-history cross-check still fires', async () => {
    const body = makeV6Body();
    body.experience[0].years = '20';
    const res = await expect400(body);
    assert.strictEqual(
        res.body.message,
        `Your Driving Experience lists 20 years, but your employment history only goes back to ${monthLabel(
            monthIndexOf(ym(-90))
        )}. Add the earlier driving jobs, or correct the years on the Driving Experience step.`
    );
});
