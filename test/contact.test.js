'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { postContact, sentMails } = require('./helpers/harness.js');

// SAFETY: the harness stubs sendViaGraph and verifyTurnstile before the
// controller is loaded, so nothing here can send real mail.

process.env.CONTACT_RECEIVER_EMAIL = process.env.CONTACT_RECEIVER_EMAIL || 'inbox@example.test';

const validBody = () => ({
    name: 'Dana Shipper',
    email: 'dana@example.test',
    message: 'Do you run flatbed out of Jackson to Birmingham weekly?',
    contactConsent: true,
    acceptTerms: true,
});

test('contact: valid submission sends one email', async () => {
    const before = sentMails.length;
    const res = await postContact(validBody());
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.message, 'Message sent successfully.');
    assert.equal(sentMails.length, before + 1);
    const mail = sentMails[sentMails.length - 1];
    assert.equal(mail.replyTo, 'dana@example.test');
    assert.match(mail.text, /Name: Dana Shipper/);
});

test('contact: honeypot short-circuits with 200 and sends nothing', async () => {
    const before = sentMails.length;
    const body = validBody();
    body.honeypot = 'https://spam.example';
    const res = await postContact(body);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.message, 'OK');
    assert.equal(sentMails.length, before);
});

test('contact: honeypot wins even when the rest of the body is invalid', async () => {
    // A bot that fills the trap but omits required fields still gets the
    // fake success, not a 400 that would tell it which check it tripped.
    const before = sentMails.length;
    const res = await postContact({ honeypot: 'x' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.message, 'OK');
    assert.equal(sentMails.length, before);
});

test('contact: empty honeypot string is treated as not filled', async () => {
    const before = sentMails.length;
    const body = validBody();
    body.honeypot = '';
    const res = await postContact(body);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.message, 'Message sent successfully.');
    assert.equal(sentMails.length, before + 1);
});

test('contact: missing required fields still 400', async () => {
    const before = sentMails.length;
    const res = await postContact({ name: 'x', email: 'x@example.test' });
    assert.equal(res.statusCode, 400);
    assert.equal(sentMails.length, before);
});
