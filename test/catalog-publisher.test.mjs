import assert from 'node:assert/strict';
import test from 'node:test';

import { publishCatalogToShopify } from '../src/sales/catalog-publisher.mjs';

const settings = { domain: 'shop.myshopify.com', token: 'shpat_test', apiVersion: '2024-10' };
const catalog = {
    file: '/tmp/course-catalog.json',
    currency: 'USD',
    fx: { USD: 1, MAD: 10, EUR: 0.92 },
    courses: [{
        slug: 'test-course',
        title: 'Test Course',
        description: '<p>A course.</p>',
        category: 'Test',
        image: '/assets/test.svg',
        language: 'en',
        price_cents: 1900,
        status: 'active'
    }]
};

function response(body, status = 200) {
    return {
        ok: status < 400,
        status,
        text: async () => JSON.stringify(body),
        json: async () => body
    };
}

function shopifyFetch({ currency = 'USD', existing = [], onCreate } = {}) {
    return async (url, options = {}) => {
        const target = String(url);
        if (target.includes('/shop.json')) return response({ shop: { currency } });
        if (target.includes('/products.json') && (!options.method || options.method === 'GET')) {
            return response({ products: existing });
        }
        if (target.includes('/products.json') && options.method === 'POST') {
            onCreate?.(JSON.parse(options.body));
            return response({ product: { id: 42 } }, 201);
        }
        throw new Error(`unexpected fetch: ${target}`);
    };
}

test('publishes the canonical USD price into a USD store', async () => {
    let sent = null;
    const result = await publishCatalogToShopify({
        catalog,
        settings,
        storeCurrency: 'USD',
        fetchImpl: shopifyFetch({ onCreate: body => { sent = body; } })
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.store_currency, 'USD');
    assert.equal(result.created, 1);
    assert.equal(sent.product.variants[0].price, '19.00');
    assert.equal(sent.product.variants[0].sku, 'RWC-test-course');
    assert.equal(sent.product.handle, 'test-course');
});

test('converts the same canonical price into a MAD store', async () => {
    let sent = null;
    const result = await publishCatalogToShopify({
        catalog,
        settings,
        storeCurrency: 'MAD',
        fetchImpl: shopifyFetch({ onCreate: body => { sent = body; } })
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.store_currency, 'MAD');
    assert.equal(result.converted, true);
    assert.equal(sent.product.variants[0].price, '190.00');
});

test('dry-run reports the converted price without requiring a token or writing', async () => {
    const result = await publishCatalogToShopify({
        catalog,
        settings: { domain: '', token: '' },
        storeCurrency: 'EUR',
        dryRun: true
    });
    assert.equal(result.status, 'dry_run');
    assert.equal(result.total, 1);
    assert.equal(result.preview[0].price, 17.48);
    assert.equal(result.published, false);
});

test('a course absent from the canonical catalog blocks the publish', async () => {
    const result = await publishCatalogToShopify({
        catalog,
        courseIds: ['test-course', 'missing-course'],
        settings,
        storeCurrency: 'USD',
        fetchImpl: shopifyFetch()
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'courses_not_in_canonical_catalog');
    assert.deepEqual(result.missing, ['missing-course']);
});

test('an unsupported store currency blocks every write before the first product', async () => {
    const result = await publishCatalogToShopify({
        catalog,
        settings,
        storeCurrency: 'GBP',
        fetchImpl: shopifyFetch()
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'invalid_catalog_prices');
    assert.match(result.failed[0].error, /No FX rate for GBP/);
});

test('an existing product at the canonical price is unchanged', async () => {
    const result = await publishCatalogToShopify({
        catalog,
        settings,
        storeCurrency: 'USD',
        fetchImpl: shopifyFetch({
            existing: [{ id: 42, handle: 'test-course', variants: [{ id: 7, price: '19.00' }] }]
        })
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.unchanged, 1);
    assert.equal(result.created, 0);
});
