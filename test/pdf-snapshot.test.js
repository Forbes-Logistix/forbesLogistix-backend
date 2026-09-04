'use strict';
// PDF snapshot: the fixed sample applicant (helpers/sampleApplication.js —
// fixed dates only, no clock anywhere) rendered through generatePDF, text
// extracted from the FlateDecode content streams, compared line-by-line to
// the committed snapshot.
//
// To regenerate after an INTENDED render change:
//   REGEN=1 npm test          (PowerShell: $env:REGEN='1'; npm test)
// then review the snapshot diff before committing.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const generatePDF = require('../utils/pdfGenerator.js');
const { extractPdfTextLines } = require('./helpers/pdfText.js');
const { sampleApplication } = require('./helpers/sampleApplication.js');

const SNAPSHOT_PATH = path.join(__dirname, '__snapshots__', 'sample-application.txt');

test('PDF text snapshot: fixed v6 sample applicant', async () => {
    const pdf = await generatePDF(sampleApplication());
    const lines = extractPdfTextLines(pdf);
    assert.ok(lines.length > 100, `suspiciously few text lines extracted (${lines.length})`);
    const actualText = lines.join('\n') + '\n';

    if (process.env.REGEN === '1') {
        fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
        fs.writeFileSync(SNAPSHOT_PATH, actualText, 'utf8');
        console.log(`Snapshot regenerated: ${SNAPSHOT_PATH} (${lines.length} lines)`);
        return;
    }

    assert.ok(
        fs.existsSync(SNAPSHOT_PATH),
        'Snapshot file missing — run with REGEN=1 to create it, then commit it.'
    );
    // \r\n-tolerant read: git's autocrlf may check the snapshot out with CRLF.
    const expectedLines = fs.readFileSync(SNAPSHOT_PATH, 'utf8').replace(/\r\n/g, '\n').split('\n');
    const actualLines = actualText.split('\n');
    const max = Math.max(actualLines.length, expectedLines.length);
    for (let i = 0; i < max; i++) {
        assert.strictEqual(
            actualLines[i],
            expectedLines[i],
            `PDF text differs from snapshot at line ${i + 1}`
        );
    }
});

test('PDF snapshot fixture exercises the v6 render paths', async () => {
    const pdf = await generatePDF(sampleApplication());
    const lines = extractPdfTextLines(pdf);
    const text = lines.join('\n');
    // Coverage header + most-recent-first ordering.
    assert.ok(text.includes('Employment history covers January 2016 – Present.'));
    const posSouthern = text.indexOf('Southern Steel Transport');
    const posWebb = text.indexOf('Webb Hauling LLC (self)');
    const posMagnolia = text.indexOf('Magnolia Carriers Inc');
    const posDelta = text.indexOf('Delta Freight Lines');
    assert.ok(posSouthern !== -1 && posSouthern < posWebb && posWebb < posMagnolia && posMagnolia < posDelta,
        'employment entries are not sorted most-recent-first');
    // Endorsements + restrictions.
    assert.ok(text.includes('H (Hazmat), X (Tank + Hazmat)'));
    assert.ok(text.includes('Restrictions (as shown on CDL)'));
    // Self-employment block.
    assert.ok(text.includes('USDOT 3456789'));
    assert.ok(text.includes('MC 987654'));
    assert.ok(text.includes('Authority status: Inactive'));
    assert.ok(text.includes('SafeRoad C/TPA Services'));
    assert.ok(text.includes('(601) 555-0177'));
    assert.ok(text.includes('Leased to another carrier during this period: Yes'));
    assert.ok(text.includes('add it as its own employer entry with the dates you were leased'));
    // Per-employer USDOT on a non-self-employed carrier.
    assert.ok(text.includes('Company USDOT number: 111222'));
    // Residence date ranges.
    assert.ok(text.includes('February 2024'));
    assert.ok(text.includes('July 2021 – January 2024'));
    // Never a bare placeholder for a v6-required value: show()'s placeholder
    // renders as its own extracted line (field values follow their label
    // line), so no line may consist solely of the "-" placeholder (or the
    // legacy "—" one).
    assert.ok(!lines.some((l) => l.trim() === '-' || l.trim() === '—'), 'unexpected "-" placeholder printed for a value');
});
