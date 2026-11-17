import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    catalogRevisionDigest,
    loadCourseCatalog,
    priceInCurrency,
    productsFromCatalog,
    storefrontPricePayload
} from '../src/sales/course-catalog.mjs';
import { buildCatalog } from '../scripts/generate-course-catalog.mjs';

test('the canonical catalog is unique, explicit and USD-priced', () => {
    const catalog = loadCourseCatalog();
    assert.equal(catalog.courses.length, 298);
    assert.equal(new Set(catalog.courses.map(course => course.slug)).size, 298);
    assert.equal(catalog.currency, 'USD');
    assert.equal(catalog.fulfillmentCostCents, 200);
    assert.equal(catalog.courses.every(course => course.price_cents === 1900), true);
    assert.equal(catalog.bySlug['certified-blockchain-expert-cbe-preptest-2025'].title, 'Certified Blockchain Expert (CBE) preptest 2025');
});

test('checkout products and the public payload are projections of the same catalog', () => {
    const catalog = loadCourseCatalog();
    const products = productsFromCatalog();
    assert.equal(products.length, 298);
    assert.deepEqual(products.find(row => row.id === 'financial-risk-manager-test-bank'), {
        id: 'financial-risk-manager-test-bank',
        name: 'Financial Risk Manager Test Bank',
        price: 19,
        currency: 'USD',
        fulfillment_cost_cents: 200
    });
    assert.deepEqual(JSON.parse(fs.readFileSync('data/store-prices.json', 'utf8')), storefrontPricePayload());
    assert.equal(catalog.bySlug['financial-risk-manager-test-bank'].price_cents, 1900);
});

test('store prices are derived from USD cents through the catalog FX table', () => {
    const catalog = loadCourseCatalog();
    const course = catalog.bySlug['financial-risk-manager-test-bank'];
    assert.deepEqual(priceInCurrency(course, 'USD', catalog.fx), {
        amount: 19,
        currency: 'USD',
        converted: false,
        rate: 1
    });
    assert.equal(priceInCurrency(course, 'MAD', catalog.fx).amount, 190);
    assert.equal(priceInCurrency(course, 'EUR', catalog.fx).amount, 17.48);
    assert.throws(() => priceInCurrency(course, 'GBP', catalog.fx), /No FX rate for GBP/);
});

test('the catalog revision digest is content-addressed and stable across paths and ordering', () => {
    const fixture = {
        version: 1,
        currency: 'USD',
        fulfillmentCostCents: 200,
        fx: { USD: 1, MAD: 10 },
        courses: [
            { slug: 'course-one', title: 'One', price_cents: 1900, status: 'active' },
            { slug: 'course-two', title: 'Two', price_cents: 2900, status: 'active' }
        ]
    };
    const digest = catalogRevisionDigest(fixture);
    assert.match(digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(catalogRevisionDigest({ ...fixture, courses: [...fixture.courses].reverse() }), digest);
    assert.notEqual(catalogRevisionDigest({
        ...fixture,
        courses: [{ ...fixture.courses[0], price_cents: 2000 }, fixture.courses[1]]
    }), digest);
    assert.notEqual(catalogRevisionDigest({ ...fixture, version: 2 }), digest);
    assert.notEqual(catalogRevisionDigest({ ...fixture, fx: { USD: 1, MAD: 11 } }), digest);
    assert.equal(loadCourseCatalog().digest.startsWith('sha256:'), true);
});

test('the importer collapses duplicate rows and preserves an existing explicit price', () => {
    const built = buildCatalog({
        source: { items: [
            { slug: 'same', title: 'One' },
            { slug: 'same', title: 'Duplicate' },
            { slug: 'other', title: 'Other' }
        ] },
        existing: { courses: [{ slug: 'same', price_cents: 2500 }] },
        price: 19
    });
    assert.equal(built.courses.length, 2);
    assert.equal(built.duplicate_count, 1);
    assert.equal(built.courses.find(course => course.slug === 'same').price_cents, 2500);
    assert.equal(built.courses.find(course => course.slug === 'other').price_cents, 1900);
});

test('the catalog rejects duplicate slugs and invalid prices before publishing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-catalog-'));
    const file = path.join(dir, 'catalog.json');
    fs.writeFileSync(file, JSON.stringify({
        currency: 'USD',
        fx: { USD: 1 },
        courses: [
            { slug: 'same', title: 'One', price_cents: 1900 },
            { slug: 'same', title: 'Two', price_cents: 1900 }
        ]
    }));
    assert.throws(() => loadCourseCatalog(file), /Duplicate course slug/);

    fs.writeFileSync(file, JSON.stringify({
        currency: 'USD',
        fx: { USD: 1 },
        courses: [{ slug: 'bad', title: 'Bad', price_cents: 0 }]
    }));
    assert.throws(() => loadCourseCatalog(file), /invalid price_cents/);
});
