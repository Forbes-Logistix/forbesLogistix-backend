'use strict';
// Unit tests for the month-interval internals in controllers/pdfController.js
// — employment gap detection and the v6 residence-coverage mirror — against a
// FIXED nowMi so the suite never depends on the real clock.

const { test } = require('node:test');
const assert = require('node:assert');
const { internals } = require('./helpers/harness.js');

const { monthIndexOf, monthKeyOf, monthLabel, computeEmploymentGaps, computeResidenceGaps } = internals;

// Fixed "now": June 2026.
const NOW = 2026 * 12 + 5;

test('monthIndexOf parses YYYY-MM and rejects junk', () => {
    assert.strictEqual(monthIndexOf('2026-06'), NOW);
    assert.strictEqual(monthIndexOf(' 2026-06 '), NOW);
    assert.strictEqual(monthIndexOf('2026-13'), null);
    assert.strictEqual(monthIndexOf('2026-00'), null);
    assert.strictEqual(monthIndexOf('2026-6'), null);
    assert.strictEqual(monthIndexOf('Present'), null);
    assert.strictEqual(monthIndexOf(''), null);
    assert.strictEqual(monthIndexOf(null), null);
});

test('monthKeyOf and monthLabel round-trip', () => {
    assert.strictEqual(monthKeyOf(NOW), '2026-06');
    assert.strictEqual(monthKeyOf(monthIndexOf('2019-12')), '2019-12');
    assert.strictEqual(monthLabel(NOW), 'June 2026');
    assert.strictEqual(monthLabel(monthIndexOf('2020-01')), 'January 2020');
});

// ---------- employment gaps ----------

test('employment: continuous history has no gaps', () => {
    const gaps = computeEmploymentGaps(
        [
            { from: '2020-01', to: '2023-05' },
            { from: '2023-06', to: 'Present' },
        ],
        NOW
    );
    assert.deepStrictEqual(gaps, []);
});

test('employment: a single missing month is tolerated', () => {
    const gaps = computeEmploymentGaps(
        [
            { from: '2020-01', to: '2023-04' },
            { from: '2023-06', to: 'Present' },
        ],
        NOW
    );
    assert.deepStrictEqual(gaps, []);
});

test('employment: a 2-month hole is a gap with exact keys', () => {
    const gaps = computeEmploymentGaps(
        [
            { from: '2020-01', to: '2023-03' },
            { from: '2023-06', to: 'Present' },
        ],
        NOW
    );
    assert.deepStrictEqual(gaps, [{ from: '2023-04', to: '2023-05' }]);
});

test('employment: trailing gap runs to the current month', () => {
    const gaps = computeEmploymentGaps([{ from: '2020-01', to: '2026-03' }], NOW);
    assert.deepStrictEqual(gaps, [{ from: '2026-04', to: '2026-06' }]);
});

test('employment: latest job ending last month is not a trailing gap', () => {
    const gaps = computeEmploymentGaps([{ from: '2020-01', to: '2026-05' }], NOW);
    assert.deepStrictEqual(gaps, []);
});

test('employment: overlapping and back-to-back jobs merge', () => {
    const gaps = computeEmploymentGaps(
        [
            { from: '2022-01', to: '2024-06' },
            { from: '2023-01', to: '2025-01' },
            { from: '2025-02', to: 'Present' },
        ],
        NOW
    );
    assert.deepStrictEqual(gaps, []);
});

test('employment: current === true ends at now like "Present"', () => {
    const gaps = computeEmploymentGaps([{ from: '2020-01', to: '', current: true }], NOW);
    assert.deepStrictEqual(gaps, []);
});

test('employment: gaps entirely before the 10-year window are dropped', () => {
    const gaps = computeEmploymentGaps(
        [
            { from: '2010-01', to: '2012-01' },
            { from: '2014-01', to: 'Present' },
        ],
        NOW
    );
    // Hole 2012-02..2013-12 ends before 2016-06 (NOW-120) — dropped.
    assert.deepStrictEqual(gaps, []);
});

test('employment: a gap straddling the window start is truncated to it', () => {
    const gaps = computeEmploymentGaps(
        [
            { from: '2010-01', to: '2015-01' },
            { from: '2017-01', to: 'Present' },
        ],
        NOW
    );
    // Hole 2015-02..2016-12; window starts 2016-06 (NOW-120).
    assert.deepStrictEqual(gaps, [{ from: '2016-06', to: '2016-12' }]);
});

test('employment: unparseable and inverted entries are ignored', () => {
    const gaps = computeEmploymentGaps(
        [
            { from: 'about 2019', to: '2020-01' },
            { from: '2023-05', to: '2021-01' },
            { from: '2020-01', to: 'Present' },
        ],
        NOW
    );
    assert.deepStrictEqual(gaps, []);
});

// ---------- v6 residence coverage ----------

test('residence: current address covering the window passes', () => {
    const gaps = computeResidenceGaps([{ from: '2022-01', to: 'Present' }], NOW);
    assert.deepStrictEqual(gaps, []);
});

test('residence: current address starting exactly at the window start passes', () => {
    const gaps = computeResidenceGaps([{ from: monthKeyOf(NOW - 36), to: 'Present' }], NOW);
    assert.deepStrictEqual(gaps, []);
});

test('residence: a short current address alone leaves a leading gap', () => {
    const gaps = computeResidenceGaps([{ from: '2025-09', to: 'Present' }], NOW);
    // Window 2023-06..2026-06; uncovered 2023-06..2025-08.
    assert.deepStrictEqual(gaps, [{ from: '2023-06', to: '2025-08' }]);
});

test('residence: a previous address filling the window passes', () => {
    const gaps = computeResidenceGaps(
        [
            { from: '2025-09', to: 'Present' },
            { from: '2020-01', to: '2025-08' },
        ],
        NOW
    );
    assert.deepStrictEqual(gaps, []);
});

test('residence: a single missing month between addresses is tolerated', () => {
    const gaps = computeResidenceGaps(
        [
            { from: '2025-09', to: 'Present' },
            { from: '2020-01', to: '2025-07' },
        ],
        NOW
    );
    assert.deepStrictEqual(gaps, []);
});

test('residence: a 2-month hole between addresses blocks', () => {
    const gaps = computeResidenceGaps(
        [
            { from: '2025-09', to: 'Present' },
            { from: '2020-01', to: '2025-06' },
        ],
        NOW
    );
    assert.deepStrictEqual(gaps, [{ from: '2025-07', to: '2025-08' }]);
});

test('residence: no parseable addresses = the whole window is one gap', () => {
    const gaps = computeResidenceGaps([{ from: 'junk', to: 'Present' }], NOW);
    assert.deepStrictEqual(gaps, [{ from: monthKeyOf(NOW - 36), to: monthKeyOf(NOW) }]);
});

test('residence: a hole straddling the window start counts only inside it', () => {
    // Old address ends 2023-04, current starts 2023-07: hole 2023-05..2023-06,
    // window starts 2023-06 — only ONE missing month inside the window, so it
    // is tolerated.
    const gaps = computeResidenceGaps(
        [
            { from: '2023-07', to: 'Present' },
            { from: '2019-01', to: '2023-04' },
        ],
        NOW
    );
    assert.deepStrictEqual(gaps, []);
});

test('residence: inverted previous-address interval is ignored (leaves gap)', () => {
    const gaps = computeResidenceGaps(
        [
            { from: '2025-09', to: 'Present' },
            { from: '2025-08', to: '2020-01' },
        ],
        NOW
    );
    assert.deepStrictEqual(gaps, [{ from: '2023-06', to: '2025-08' }]);
});

test('residence: overlapping addresses merge', () => {
    const gaps = computeResidenceGaps(
        [
            { from: '2024-01', to: 'Present' },
            { from: '2021-01', to: '2024-06' },
        ],
        NOW
    );
    assert.deepStrictEqual(gaps, []);
});
