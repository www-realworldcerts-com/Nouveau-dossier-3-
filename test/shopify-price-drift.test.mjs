import assert from 'node:assert/strict';
import test from 'node:test';

import { auditShopifyPriceDrift } from '../src/sales/shopify-price-drift.mjs';

const catalog = {
    file: '/tmp/course-catalog.json',
    currency: 'USD',
    fx: { USD: 1, MAD: 10, EUR: 0.92 },
    courses: [
        {
            slug: 'course-one',
            title: 'Course One',
            price_cents: 1900,
            status: 'active'
        },
        {
            slug: 'course-two',
            title: 'Course Two',
            price_cents: 2900,
            status: 'active'
        }
    ],
    bySlug: {
        'course-one': { slug: 'course-one', title: 'Course One', price_cents: 1900 },
        'course-two': { slug: 'course-two', title: 'Course Two', price_cents: 2900 }
    }
};

const settings = {
    domain: 'shop.myshopify.com',
    token: 'shpat_test',
    apiVersion: '2024-10',
    storefrontUrl: 'https://store.example'
};

function response(body, status = 200) {
    return {
        ok: status < 400,
        status,
        text: async () => JSON.stringify(body)
    };
}

function product(slug, price, { id = 1, variantId = 10, currency = 'USD' } = {}) {
    return {
        id,
        handle: slug,
        title: slug,
        status: 'active',
        variants: [{
            id: variantId,
            price: String(price),
            presentment_prices: [{ price: { amount: String(price), currencyCode: currency } }]
        }]
    };
}

function fakeFetch({ products, shopCurrency = 'USD', checkout = null, methods = [] } = {}) {
    return async (url, options = {}) => {
        methods.push({ url: String(url), method: options.method || 'GET' });
        if (String(url).endsWith('/shop.json')) return response({ shop: { currency: shopCurrency } });
        if (String(url).includes('/products.json')) return response({ products });
        if (String(url).includes('/data/store-prices.json') && checkout) return response(checkout);
        return response({ error: 'not found' }, 404);
    };
}

test('matching catalog, checkout and Shopify prices produce an ok audit', async () => {
    const methods = [];
    const report = await auditShopifyPriceDrift({
        catalog,
        settings,
        checkoutPayload: { currency: 'USD', prices: { 'course-one': 19, 'course-two': 29 } },
        fetchImpl: fakeFetch({
            products: [product('course-one', 19, { id: 1, variantId: 10 }), product('course-two', 29, { id: 2, variantId: 20 })],
            methods
        })
    });

    assert.equal(report.status, 'ok');
    assert.deepEqual(report.drift, []);
    assert.equal(report.checked.catalog_courses, 2);
    assert.equal(report.checked.checkout_prices, 2);
    assert.equal(report.checked.shopify_products, 2);
    assert.equal(report.checked.shopify_variants, 2);
    assert.equal(report.store_currency, 'USD');
    assert.equal(report.finding, null);
    assert.ok(methods.length >= 2);
    assert.ok(methods.every(call => call.method === 'GET'), 'the audit only reads');
});

test('checkout and Shopify divergences each raise a high-severity finding', async () => {
    const report = await auditShopifyPriceDrift({
        catalog,
        settings,
        checkoutPayload: { currency: 'USD', prices: { 'course-one': 18, 'course-two': 29 } },
        fetchImpl: fakeFetch({
            products: [product('course-one', 21, { id: 1, variantId: 10 }), product('course-two', 29, { id: 2, variantId: 20 })]
        })
    });

    assert.equal(report.status, 'drift');
    assert.equal(report.drift.length, 3);
    assert.ok(report.drift.some(row => row.source === 'checkout' && row.reason === 'price_mismatch'));
    assert.ok(report.drift.some(row => row.source === 'shopify' && row.reason === 'price_mismatch' && row.detail_source === 'variant_price'));
    assert.ok(report.drift.some(row => row.source === 'shopify' && row.reason === 'price_mismatch' && row.detail_source === 'presentment_price'));
    assert.equal(report.finding.code, 'SHOPIFY_PRICE_DRIFT');
    assert.equal(report.finding.severity, 'high');
    assert.equal(report.finding.evidence.drift_count, 3);
});

test('missing products and extra checkout courses are drift', async () => {
    const report = await auditShopifyPriceDrift({
        catalog,
        settings,
        checkoutPayload: {
            currency: 'USD',
            prices: { 'course-one': 19, 'course-two': 29, 'stale-course': 5 }
        },
        fetchImpl: fakeFetch({ products: [product('course-one', 19)] })
    });

    assert.equal(report.status, 'drift');
    assert.ok(report.drift.some(row => row.reason === 'unknown_checkout_course' && row.course_id === 'stale-course'));
    assert.ok(report.drift.some(row => row.reason === 'product_missing' && row.course_id === 'course-two'));
});

test('converted Shopify prices are compared in the store currency', async () => {
    const report = await auditShopifyPriceDrift({
        catalog,
        settings,
        checkoutPayload: { currency: 'USD', prices: { 'course-one': 19, 'course-two': 29 } },
        fetchImpl: fakeFetch({
            shopCurrency: 'MAD',
            products: [
                product('course-one', 190, { id: 1, variantId: 10, currency: 'MAD' }),
                product('course-two', 280, { id: 2, variantId: 20, currency: 'MAD' })
            ]
        })
    });

    assert.equal(report.store_currency, 'MAD');
    assert.equal(report.status, 'drift');
    assert.ok(report.drift.some(row => row.source === 'shopify' && row.course_id === 'course-two' && row.reason === 'price_mismatch'));
    assert.ok(!report.drift.some(row => row.source === 'shopify' && row.course_id === 'course-one'));
});

test('a missing Shopify credential is reported as unchecked, not clean', async () => {
    const report = await auditShopifyPriceDrift({
        catalog,
        settings: { ...settings, token: '', storefrontUrl: '' },
        checkoutPayload: { currency: 'USD', prices: { 'course-one': 19, 'course-two': 29 } }
    });

    assert.equal(report.status, 'unavailable');
    assert.match(report.unavailable.join('; '), /missing_shopify_admin_credentials/);
    assert.equal(report.finding.code, 'SHOPIFY_PRICE_DRIFT_UNCHECKED');
    assert.equal(report.finding.severity, 'medium');
});

test('the audit can read the checkout payload from its URL', async () => {
    const report = await auditShopifyPriceDrift({
        catalog,
        settings,
        fetchImpl: fakeFetch({
            products: [product('course-one', 19), product('course-two', 29)],
            checkout: { currency: 'USD', prices: { 'course-one': 19, 'course-two': 29 } }
        })
    });

    assert.equal(report.status, 'ok');
    assert.equal(report.checkout.url, 'https://store.example/data/store-prices.json');
    assert.equal(report.checkout.count, 2);
});
