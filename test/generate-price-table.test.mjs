import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    CATALOG_CANDIDATES,
    buildPriceTable,
    findCatalogPath,
    parseCatalog,
    renderCsv
} from '../scripts/generate-price-table.mjs';

test('the deployed site catalog schema is understood without hours or price fields', () => {
    const catalog = {
        items: [
            { title: 'Certified Blockchain Expert (CBE) preptest 2025', slug: 'certified-blockchain-expert', practiceTestCount: 562 },
            { title: 'Foundational Digital Skills', slug: 'foundational-digital-skills', lectureCount: 8 },
            { title: 'Professional Business Writing', slug: 'professional-business-writing' }
        ]
    };
    const { ready, review, total } = buildPriceTable(catalog);
    assert.equal(total, 3);
    const prices = Object.fromEntries(ready.map(row => [row.slug, row.price_mad]));
    assert.equal(prices['foundational-digital-skills'], '900.00');
    assert.equal(prices['professional-business-writing'], '2500.00');
    // "expert" is a premium-positioning keyword, so the rules engine hands it
    // to review instead of silently pricing it as a preptest.
    assert.match(review.find(row => row.slug === 'certified-blockchain-expert').reason, /expert/);
});

test('legacy price books and ndjson rows are accepted', () => {
    const book = parseCatalog({ courses: { 'pmp-exam-mastery': { mode: 'quote_required' } } });
    assert.equal(book[0].slug, 'pmp-exam-mastery');
    assert.equal(book[0].mode, 'quote_required');

    // The legacy `mode` field is normalised into a price_status by the builder.
    const legacy = buildPriceTable({ courses: { 'foundational-digital-skills': { mode: 'quote_required' } } });
    assert.deepEqual(legacy.ready, [{ slug: 'foundational-digital-skills', price_mad: '900.00' }]);

    const ndjson = [
        { course_id: 'crs_101', title: 'Concours Médecine — Prépa Intensive', tier: 'preptest', price_status: 'quote_required' },
        { course_id: 'crs_106', title: 'Priced Course', price_mad: 2500, price_status: 'priced' }
    ];
    const { ready, total } = buildPriceTable(ndjson);
    assert.equal(total, 2);
    assert.deepEqual(ready, [{ slug: 'crs_101', price_mad: '1500.00' }]);
});

test('marketing descriptions cannot downgrade a title-derived tier', () => {
    const { ready, review } = buildPriceTable({
        items: [
            {
                slug: 'acca-f5-performance-management-test',
                title: 'ACCA F5 Performance Management test',
                description: 'A foundation course for absolute beginners.'
            },
            {
                slug: 'everyday-workplace-skills',
                title: 'Everyday Workplace Skills',
                description: 'A professional certificate for career growth.'
            }
        ]
    });
    assert.equal(review.length, 0);
    const prices = Object.fromEntries(ready.map(row => [row.slug, row.price_mad]));
    // "test" in the title wins over "foundation" in the description.
    assert.equal(prices['acca-f5-performance-management-test'], '1500.00');
    // Description is used only when the title has no tier keyword.
    assert.equal(prices['everyday-workplace-skills'], '2500.00');
});

test('premium exception courses are routed to review, not guessed', () => {
    const { ready, review } = buildPriceTable({
        items: [
            { slug: 'acca-financial-reporting-advanced', title: 'ACCA Financial Reporting — Advanced', exam_board: 'ACCA' },
            { slug: 'pmp-exam-mastery', title: 'PMP Exam Mastery', exam_board: 'PMP' }
        ]
    });
    assert.equal(ready.length, 0);
    assert.equal(review.length, 2);
    assert.match(review.find(row => row.slug === 'acca-financial-reporting-advanced').reason, /premium exam board ACCA/);
    assert.match(review.find(row => row.slug === 'pmp-exam-mastery').reason, /premium exam board PMP/);
});

test('CSV rendering escapes reasons with commas', () => {
    const csv = renderCsv([{ slug: 'x', reason: 'a, b "c"' }], ['slug', 'reason']);
    assert.equal(csv, 'slug,reason\nx,"a, b ""c"""\n');
});

test('the CLI writes both CSVs from a catalog file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'price-table-'));
    const catalogPath = path.join(dir, 'catalog.json');
    fs.writeFileSync(catalogPath, JSON.stringify({
        items: [
            { slug: 'foundational-course', title: 'Foundational Course' },
            { slug: 'premium-acca', title: 'ACCA Advanced Mastery' }
        ]
    }));
    const out = path.join(dir, 'pricing-table.csv');
    const review = path.join(dir, 'manual-review.csv');

    const run = spawnSync(process.execPath, [
        'scripts/generate-price-table.mjs',
        '--catalog', catalogPath,
        '--out', out,
        '--review', review
    ], { cwd: process.cwd(), encoding: 'utf8' });

    assert.equal(run.status, 0, run.stderr);
    assert.match(fs.readFileSync(out, 'utf8'), /^slug,price_mad\nfoundational-course,900\.00\n$/);
    assert.match(fs.readFileSync(review, 'utf8'), /premium-acca/);

    const summary = JSON.parse(run.stdout.trim().split('\n').at(-1));
    assert.equal(summary.courses, 2);
    assert.equal(summary.priced, 1);
    assert.equal(summary.review, 1);
    assert.equal(summary.duplicates, 0);
});

test('catalog discovery covers the deployed repository layout', () => {
    assert.ok(CATALOG_CANDIDATES.includes('site/realworldcerts/data/catalog.json'));
    assert.equal(findCatalogPath({ explicit: 'some/catalog.json' }), 'some/catalog.json');
});
