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

function response(body, status = 200, headers = undefined) {
    return {
        ok: status < 400,
        status,
        headers,
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

function fakeFetch({ products, shopCurrency = 'USD', checkout = null, checkoutHandler = null, methods = [] } = {}) {
    return async (url, options = {}) => {
        methods.push({ url: String(url), method: options.method || 'GET', headers: options.headers || {} });
        if (String(url).endsWith('/shop.json')) return response({ shop: { currency: shopCurrency } });
        if (String(url).includes('/products.json')) return response({ products });
        if (String(url).includes('/data/store-prices.json')) {
            if (checkoutHandler) return checkoutHandler(String(url), options);
            if (checkout) return response(checkout);
        }
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
    assert.equal(report.affected_courses, 0);
    assert.deepEqual(report.drift, []);
    assert.deepEqual(report.unchecked, []);
    assert.equal(report.checked.catalog_courses, 2);
    assert.equal(report.checked.checkout_prices, 2);
    assert.equal(report.checked.shopify_products, 2);
    assert.equal(report.checked.shopify_variants, 2);
    assert.equal(report.store_currency, 'USD');
    assert.equal(report.finding, null);
    assert.ok(methods.length >= 2);
    assert.ok(methods.every(call => call.method === 'GET'), 'the audit only reads');
});

test('real checkout and Shopify price differences are grouped by course', async () => {
    const report = await auditShopifyPriceDrift({
        catalog,
        settings,
        checkoutPayload: { currency: 'USD', prices: { 'course-one': 18, 'course-two': 29 } },
        fetchImpl: fakeFetch({
            products: [product('course-one', 21, { id: 1, variantId: 10 }), product('course-two', 29, { id: 2, variantId: 20 })]
        })
    });

    assert.equal(report.status, 'drift');
    assert.equal(report.affected_courses, 1);
    assert.equal(report.drift.length, 1);
    const course = report.drift[0];
    assert.equal(course.course_id, 'course-one');
    assert.deepEqual(course.sources, ['checkout', 'shopify']);
    assert.ok(course.reasons.includes('checkout:price_mismatch'));
    assert.ok(course.reasons.includes('shopify:variant_price'));
    assert.ok(course.reasons.includes('shopify:presentment_price'));
    assert.equal(course.reasons.length, 3);
    assert.equal(course.observations.length, 3);
    assert.equal(report.finding.code, 'SHOPIFY_PRICE_DRIFT');
    assert.equal(report.finding.severity, 'high');
    assert.equal(report.finding.evidence.affected_courses, 1);
    assert.match(report.finding.detail, /1 course/);
});

test('missing products and extra checkout courses are unchecked, not drift', async () => {
    const report = await auditShopifyPriceDrift({
        catalog,
        settings,
        checkoutPayload: {
            currency: 'USD',
            prices: { 'course-one': 19, 'course-two': 29, 'stale-course': 5 }
        },
        fetchImpl: fakeFetch({ products: [product('course-one', 19)] })
    });

    assert.equal(report.status, 'unavailable');
    assert.equal(report.affected_courses, 0);
    assert.deepEqual(report.drift, []);
    assert.ok(report.unchecked.some(row => row.reason === 'unknown_checkout_course' && row.course_id === 'stale-course'));
    assert.ok(report.unchecked.some(row => row.reason === 'product_missing' && row.course_id === 'course-two'));
    assert.equal(report.finding.code, 'SHOPIFY_PRICE_DRIFT_UNCHECKED');
    assert.equal(report.finding.severity, 'medium');
    assert.match(report.finding.detail, /unknown_checkout_course/);
    assert.match(report.finding.detail, /product_missing/);
});

test('converted Shopify prices produce one grouped divergence', async () => {
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
    assert.equal(report.affected_courses, 1);
    assert.equal(report.drift[0].course_id, 'course-two');
    assert.ok(report.drift[0].reasons.includes('shopify:variant_price'));
    assert.ok(report.drift[0].reasons.includes('shopify:presentment_price'));
});

test('a missing FX rate is unchecked instead of high-severity drift', async () => {
    const report = await auditShopifyPriceDrift({
        catalog: { ...catalog, fx: { USD: 1 } },
        settings,
        checkoutPayload: { currency: 'USD', prices: { 'course-one': 19, 'course-two': 29 } },
        fetchImpl: fakeFetch({
            shopCurrency: 'MAD',
            products: [
                product('course-one', 190, { id: 1, variantId: 10, currency: 'MAD' }),
                product('course-two', 290, { id: 2, variantId: 20, currency: 'MAD' })
            ]
        })
    });

    assert.equal(report.status, 'unavailable');
    assert.deepEqual(report.drift, []);
    assert.equal(report.affected_courses, 0);
    assert.equal(report.unchecked.length, 2);
    assert.ok(report.unchecked.every(row => row.reason === 'price_unavailable'));
    assert.equal(report.finding.code, 'SHOPIFY_PRICE_DRIFT_UNCHECKED');
    assert.equal(report.finding.severity, 'medium');
    assert.match(report.finding.detail, /price_unavailable/);
});

test('an unreadable checkout source is unchecked, not clean or high-severity drift', async () => {
    const report = await auditShopifyPriceDrift({
        catalog,
        settings,
        fetchImpl: fakeFetch({
            products: [product('course-one', 19), product('course-two', 29)]
        })
    });

    assert.equal(report.status, 'unavailable');
    assert.deepEqual(report.drift, []);
    assert.match(report.unavailable.join('; '), /checkout_unavailable/);
    assert.equal(report.finding.code, 'SHOPIFY_PRICE_DRIFT_UNCHECKED');
    assert.equal(report.finding.severity, 'medium');
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

test('the audit can read the exact checkout route from edge and origin', async () => {
    const report = await auditShopifyPriceDrift({
        catalog,
        settings: { ...settings, checkoutOriginUrl: 'https://origin.example/data/store-prices.json' },
        fetchImpl: fakeFetch({
            products: [product('course-one', 19), product('course-two', 29)],
            checkout: { currency: 'USD', prices: { 'course-one': 19, 'course-two': 29 } }
        })
    });

    assert.equal(report.status, 'ok');
    assert.equal(report.checkout.url, 'https://store.example/data/store-prices.json');
    assert.equal(report.checkout.origin_url, 'https://origin.example/data/store-prices.json');
    assert.equal(report.checkout.count, 2);
    assert.equal(report.checked.checkout_routes, 3);
    assert.equal(report.checkout.edge.ok, true);
    assert.equal(report.checkout.edge.cache_bust, false);
    assert.equal(report.checkout.edge_fresh.cache_bust, true);
    assert.equal(report.checkout.origin.cache_bust, true);
    assert.equal(report.checkout.origin.url.includes('_price_audit='), true);
});

test('a stale edge payload is drift even when the cache-busted edge and origin are fresh', async () => {
    const methods = [];
    const fresh = { currency: 'USD', prices: { 'course-one': 19, 'course-two': 29 } };
    const report = await auditShopifyPriceDrift({
        catalog,
        settings: { ...settings, checkoutOriginUrl: 'https://origin.example/data/store-prices.json' },
        fetchImpl: fakeFetch({
            products: [product('course-one', 19), product('course-two', 29)],
            methods,
            checkoutHandler: url => {
                if (url.startsWith('https://origin.example/')) return response(fresh);
                const parsed = new URL(url);
                return response(parsed.searchParams.has('_price_audit')
                    ? fresh
                    : { currency: 'USD', prices: { 'course-one': 18, 'course-two': 29 } });
            }
        })
    });

    assert.equal(report.status, 'drift');
    assert.equal(report.checkout.edge.stale_vs_fresh, true);
    assert.equal(report.checkout.edge.differs_from_origin, true);
    assert.equal(report.checkout.fresh_matches_origin, true);
    assert.equal(report.drift.length, 1);
    assert.equal(report.drift[0].course_id, 'course-one');
    assert.ok(report.drift[0].observations.some(row => row.route === 'edge'));
    assert.equal(report.finding.code, 'SHOPIFY_PRICE_DRIFT');

    const edge = methods.find(call => call.url === 'https://store.example/data/store-prices.json');
    const edgeFresh = methods.find(call => call.url.startsWith('https://store.example/data/store-prices.json?') && call.url.includes('_price_audit='));
    const origin = methods.find(call => call.url.startsWith('https://origin.example/data/store-prices.json') && call.url.includes('_price_audit='));
    assert.ok(edge, 'the buyer-facing edge route is fetched without a cache buster');
    assert.ok(edgeFresh, 'the same edge route is fetched with a cache buster');
    assert.ok(origin, 'the origin route is fetched with a cache buster');
    assert.equal(edge.headers['cache-control'], undefined);
    assert.equal(edgeFresh.headers['cache-control'], 'no-cache');
    assert.equal(origin.headers['cache-control'], 'no-cache');
});

test('a stale origin payload is drift even when the edge is fresh', async () => {
    const fresh = { currency: 'USD', prices: { 'course-one': 19, 'course-two': 29 } };
    const report = await auditShopifyPriceDrift({
        catalog,
        settings: { ...settings, checkoutOriginUrl: 'https://origin.example/data/store-prices.json' },
        fetchImpl: fakeFetch({
            products: [product('course-one', 19), product('course-two', 29)],
            checkoutHandler: url => response(url.startsWith('https://origin.example/')
                ? { currency: 'USD', prices: { 'course-one': 18, 'course-two': 29 } }
                : fresh)
        })
    });

    assert.equal(report.status, 'drift');
    assert.equal(report.checkout.edge.stale_vs_fresh, false);
    assert.equal(report.checkout.edge.differs_from_origin, true);
    assert.equal(report.checkout.origin.differs_from_fresh, true);
    assert.equal(report.checkout.fresh_matches_origin, false);
    assert.equal(report.drift[0].course_id, 'course-one');
    assert.ok(report.drift[0].observations.some(row => row.route === 'origin'));
});

test('a missing checkout origin fails closed instead of accepting the edge alone', async () => {
    const report = await auditShopifyPriceDrift({
        catalog,
        settings,
        fetchImpl: fakeFetch({
            products: [product('course-one', 19), product('course-two', 29)],
            checkout: { currency: 'USD', prices: { 'course-one': 19, 'course-two': 29 } }
        })
    });

    assert.equal(report.status, 'unavailable');
    assert.deepEqual(report.drift, []);
    assert.match(report.unavailable.join('; '), /checkout_origin_unavailable/);
    assert.equal(report.finding.code, 'SHOPIFY_PRICE_DRIFT_UNCHECKED');
    assert.equal(report.finding.severity, 'medium');
});
