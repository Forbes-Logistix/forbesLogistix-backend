'use strict';
// Version-ladder regression: v5, v4, and legacy (no formVersion) payloads must
// keep passing with their original rules — the v6 gates must never leak
// backwards. Also proves the JSON attachment (item 7) rides along for ALL
// versions, not just v6.

const { test } = require('node:test');
const assert = require('node:assert');
const { post, sentMails, ym, makeV5Body, makeV4Body, makeLegacyBody } = require('./helpers/harness.js');

test('v5 payload with pre-v6 field shapes still passes', async () => {
    // makeV5Body deliberately carries values a v6 payload would reject:
    // free-text employer state, non-numeric zip, missing position, 2-char
    // reason, free-text endorsements, no restrictions, sinceYear-only address.
    const res = await post(makeV5Body());
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
});

test('v4 payload (free-text full name) still passes', async () => {
    const res = await post(makeV4Body());
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
});

test('legacy payload (no formVersion) still passes', async () => {
    const res = await post(makeLegacyBody());
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
});

test('legacy submission also gets the JSON attachment (item 7 is unversioned)', async () => {
    const before = sentMails.length;
    const res = await post(makeLegacyBody());
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(sentMails.length, before + 1);
    const mail = sentMails[sentMails.length - 1];
    assert.strictEqual(mail.attachments.length, 2);
    assert.strictEqual(mail.attachments[0].filename, 'DOT-Application-Webb.pdf');
    assert.strictEqual(mail.attachments[1].filename, 'DOT-Application-Webb.json');
    assert.strictEqual(mail.attachments[1].contentType, 'application/json');
    const parsed = JSON.parse(mail.attachments[1].content.toString('utf8'));
    assert.strictEqual(parsed.formVersion, 0);
    assert.strictEqual(parsed.personal.fullName, 'Marcus DeWayne Webb');
    assert.ok(parsed.submittedAtISO);
    assert.ok(parsed.submittedAtCT);
    assert.ok(parsed.submitterIp);
    assert.strictEqual('turnstileToken' in parsed, false);
    assert.strictEqual('honeypot' in parsed, false);
    // Pretty-printed, per the contract.
    assert.ok(mail.attachments[1].content.toString('utf8').startsWith('{\n  '));
});

test('v5 required rules are still enforced (ladder intact below v6)', async () => {
    const body = makeV5Body();
    body.personal.middleName = '';
    body.personal.noMiddleName = false;
    const res = await post(body);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.message, 'Middle name is required unless you confirm you have no middle name.');
});

test('v4 gap mirror is still enforced for v4 payloads', async () => {
    const body = makeV4Body();
    // Punch an unexplained 3-month hole between the two jobs: the older job
    // now ends 4 months before the current one starts (single months are
    // tolerated; 3 missing months are not).
    body.employment[1].to = ym(-34);
    const res = await post(body);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.message, 'Please explain the employment gap(s) shown on the Employment step.');
});
