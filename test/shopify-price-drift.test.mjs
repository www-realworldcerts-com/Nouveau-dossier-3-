import assert from 'node:assert/strict';
import test from 'node:test';

import { auditShopifyPriceDrift } from '../src/sales/shopify-price-drift.mjs';
import { catalogRevisionDigest } from '../src/sales/course-catalog.mjs';

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
        headers: headers === undefined ? { 'x-vercel-cache': 'MISS' } : headers,
        text: async () => JSON.stringify(body)
    };
}

function rawResponse(body, status = 200, headers = undefined) {
    return {
        ok: status < 400,
        status,
        headers,
        text: async () => String(body)
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

function emptyDnsError() {
    const error = new Error('no DNS records');
    error.code = 'ENODATA';
    return error;
}

function fakeDns({
    cname = {},
    addresses = {
        'store.example': ['203.0.113.10'],
        'origin.example': ['198.51.100.20']
    }
} = {}) {
    return {
        async resolveCname(host) {
            const records = cname[host];
            if (records === undefined) throw emptyDnsError();
            return records;
        },
        async resolve4(host) {
            const records = addresses[host];
            if (records === undefined) throw emptyDnsError();
            return records;
        },
        async resolve6() {
            return [];
        }
    };
}

function fakeOriginRequest(fetchImpl, calls = []) {
    return async (url, { address, headers } = {}) => {
        calls.push({ url, address, headers });
        return fetchImpl(url, { method: 'GET', headers, redirect: 'manual' });
    };
}

function quoteResponse(url, overrides = {}, quoteCatalog = catalog) {
    const parsed = new URL(url);
    const productId = parsed.searchParams.get('product_id');
    const course = quoteCatalog.bySlug?.[productId];
    if (!course) return response({ error: 'unknown product' }, 404);
    return response({
        ok: true,
        quote: `synthetic.${productId}`,
        key_id: 'primary',
        quote_id: `q_synthetic_${productId}`,
        product_id: productId,
        amount: { value: (Number(course.price_cents) / 100).toFixed(2), currency: 'USD' },
        currency: 'USD',
        catalog_version: String(quoteCatalog.version ?? 1),
        catalog_digest: quoteCatalog.digest || catalogRevisionDigest(quoteCatalog),
        return_url: new URL('/buy/success', parsed.origin).toString(),
        cancel_url: new URL('/buy/cancel', parsed.origin).toString(),
        expires_at: new Date(Date.now() + 300_000).toISOString(),
        ...overrides
    });
}

function fakeFetch({ products, shopCurrency = 'USD', checkout = null, checkoutHandler = null, quoteHandler = null, quoteCatalog = catalog, methods = [] } = {}) {
    return async (url, options = {}) => {
        methods.push({ url: String(url), method: options.method || 'GET', headers: options.headers || {}, redirect: options.redirect });
        if (String(url).endsWith('/shop.json')) return response({ shop: { currency: shopCurrency } });
        if (String(url).includes('/products.json')) return response({ products });
        if (String(url).includes('/acp/v1/price-quote')) {
            if (quoteHandler) return quoteHandler(String(url), options);
            return quoteResponse(String(url), {}, quoteCatalog);
        }
        if (String(url).includes('/data/store-prices.json')) {
            if (checkoutHandler) return checkoutHandler(String(url), options);
            if (checkout) return response(checkout);
        }
        return response({ error: 'not found' }, 404);
    };
}

test('matching catalog, checkout, quotes and Shopify prices produce an ok audit', async () => {
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
    assert.match(report.catalog_digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(report.checked.checkout_prices, 2);
    assert.equal(report.checked.quote_products, 2);
    assert.equal(report.quote.checked_products, 2);
    assert.equal(report.checked.shopify_products, 2);
    assert.equal(report.checked.shopify_variants, 2);
    assert.equal(report.store_currency, 'USD');
    assert.equal(report.finding, null);
    assert.ok(methods.length >= 2);
    assert.ok(methods.every(call => call.method === 'GET'), 'the audit only reads');
});

test('the quote audit checks every product and reports a wrong quoted amount', async () => {
    const methods = [];
    const report = await auditShopifyPriceDrift({
        catalog,
        settings,
        checkoutPayload: { currency: 'USD', prices: { 'course-one': 19, 'course-two': 29 } },
        fetchImpl: fakeFetch({
            products: healthyShopify,
            methods,
            quoteHandler: url => quoteResponse(url, new URL(url).searchParams.get('product_id') === 'course-one'
                ? { amount: { value: '18.00', currency: 'USD' } }
                : {})
        })
    });

    const quoteCalls = methods.filter(call => call.url.includes('/acp/v1/price-quote'));
    assert.equal(quoteCalls.length, 2);
    assert.equal(report.quote.url, 'https://store.example/acp/v1/price-quote');
    assert.equal(report.quote.checked_products, 2);
    assert.equal(report.quote.drift_products, 1);
    assert.equal(report.status, 'drift');
    assert.equal(report.drift.length, 1);
    assert.equal(report.drift[0].course_id, 'course-one');
    assert.ok(report.drift[0].sources.includes('quote'));
    assert.ok(report.drift[0].reasons.includes('quote:quote_amount'));
    assert.equal(report.finding.code, 'SHOPIFY_PRICE_DRIFT');
});

test('quote contract mismatches make the audit unchecked instead of green', async () => {
    const report = await auditShopifyPriceDrift({
        catalog,
        settings,
        checkoutPayload: { currency: 'USD', prices: { 'course-one': 19, 'course-two': 29 } },
        fetchImpl: fakeFetch({
            products: healthyShopify,
            quoteHandler: url => new URL(url).searchParams.get('product_id') === 'course-one'
                ? quoteResponse(url, {
                    amount: { value: '19.00', currency: 'EUR' },
                    currency: 'EUR',
                    catalog_digest: 'sha256:not-the-catalog',
                    expires_at: new Date(Date.now() - 1000).toISOString(),
                    return_url: 'https://evil.example/buy/success',
                    cancel_url: 'https://evil.example/buy/cancel'
                })
                : quoteResponse(url)
        })
    });

    assert.equal(report.status, 'unavailable');
    assert.equal(report.quote.checked_products, 1);
    assert.equal(report.quote.unchecked_products, 1);
    assert.ok(report.quote.unchecked_issues >= 5);
    assert.ok(report.unchecked.some(row => row.reason === 'quote_currency_mismatch'));
    assert.ok(report.unchecked.some(row => row.reason === 'quote_catalog_digest_mismatch'));
    assert.ok(report.unchecked.some(row => row.reason === 'quote_expired'));
    assert.ok(report.unchecked.some(row => row.reason === 'quote_redirect_mismatch'));
    assert.equal(report.finding.code, 'SHOPIFY_PRICE_DRIFT_UNCHECKED');
});

test('an unavailable quote endpoint makes the audit unchecked', async () => {
    const report = await auditShopifyPriceDrift({
        catalog,
        settings,
        checkoutPayload: { currency: 'USD', prices: { 'course-one': 19, 'course-two': 29 } },
        fetchImpl: fakeFetch({
            products: healthyShopify,
            quoteHandler: () => response({ error: 'quote service unavailable' }, 503)
        })
    });

    assert.equal(report.status, 'unavailable');
    assert.equal(report.quote.failed_products, 2);
    assert.match(report.unavailable.join('; '), /quote_unavailable/);
    assert.equal(report.finding.code, 'SHOPIFY_PRICE_DRIFT_UNCHECKED');
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
    const noFxCatalog = { ...catalog, fx: { USD: 1 } };
    const report = await auditShopifyPriceDrift({
        catalog: noFxCatalog,
        settings,
        checkoutPayload: { currency: 'USD', prices: { 'course-one': 19, 'course-two': 29 } },
        fetchImpl: fakeFetch({
            quoteCatalog: noFxCatalog,
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
    const fetchImpl = fakeFetch({
        products: [product('course-one', 19), product('course-two', 29)],
        checkout: { currency: 'USD', prices: { 'course-one': 19, 'course-two': 29 } }
    });
    const report = await auditShopifyPriceDrift({
        catalog,
        settings: { ...settings, checkoutOriginUrl: 'https://origin.example/data/store-prices.json' },
        dnsResolver: fakeDns(),
        fetchImpl,
        originRequestImpl: fakeOriginRequest(fetchImpl)
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
    const fetchImpl = fakeFetch({
        products: [product('course-one', 19), product('course-two', 29)],
        methods,
        checkoutHandler: url => {
            if (url.startsWith('https://origin.example/')) return response(fresh);
            const parsed = new URL(url);
            return response(parsed.searchParams.has('_price_audit')
                ? fresh
                : { currency: 'USD', prices: { 'course-one': 18, 'course-two': 29 } });
        }
    });
    const report = await auditShopifyPriceDrift({
        catalog,
        settings: { ...settings, checkoutOriginUrl: 'https://origin.example/data/store-prices.json' },
        dnsResolver: fakeDns(),
        fetchImpl,
        originRequestImpl: fakeOriginRequest(fetchImpl)
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
    const fetchImpl = fakeFetch({
        products: [product('course-one', 19), product('course-two', 29)],
        checkoutHandler: url => response(url.startsWith('https://origin.example/')
            ? { currency: 'USD', prices: { 'course-one': 18, 'course-two': 29 } }
            : fresh)
    });
    const report = await auditShopifyPriceDrift({
        catalog,
        settings: { ...settings, checkoutOriginUrl: 'https://origin.example/data/store-prices.json' },
        dnsResolver: fakeDns(),
        fetchImpl,
        originRequestImpl: fakeOriginRequest(fetchImpl)
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

const freshCheckout = { currency: 'USD', prices: { 'course-one': 19, 'course-two': 29 } };
const healthyShopify = [product('course-one', 19), product('course-two', 29)];

function originAudit(originUrl, checkoutHandler = null, extra = {}) {
    const { dnsResolver = fakeDns(), originRequestImpl, ...fetchOptions } = extra;
    const fetchImpl = fakeFetch({
        products: healthyShopify,
        checkoutHandler: checkoutHandler || (() => response(freshCheckout)),
        ...fetchOptions
    });
    return auditShopifyPriceDrift({
        catalog,
        settings: { ...settings, checkoutOriginUrl: originUrl },
        dnsResolver,
        fetchImpl,
        originRequestImpl: originRequestImpl || fakeOriginRequest(fetchImpl)
    });
}

for (const [name, originUrl, reason] of [
    ['a non-HTTPS origin is unverified', 'http://origin.example', /checkout_origin_insecure/],
    ['a malformed origin is unverified', 'not a url', /checkout_origin_invalid/],
    ['the CDN host cannot be used as the origin', 'https://store.example/data/store-prices.json', /checkout_origin_not_distinct/],
    ['a www alias of the CDN is the same origin', 'https://www.store.example/data/store-prices.json', /checkout_origin_not_distinct/],
    ['a private origin is unverified', 'https://127.0.0.1/data/store-prices.json', /checkout_origin_invalid/]
]) {
    test(name, async () => {
        const report = await originAudit(originUrl);
        assert.equal(report.status, 'unavailable');
        assert.deepEqual(report.drift, []);
        assert.match(report.unavailable.join('; '), reason);
        assert.equal(report.checkout.origin_validation.ok, false);
        assert.equal(report.checkout.origin.ok, false);
        assert.equal(report.finding.code, 'SHOPIFY_PRICE_DRIFT_UNCHECKED');
    });
}

for (const [name, handler, reason] of [
    ['a protection challenge is unchecked', url => url.startsWith('https://origin.example/')
        ? response({ error: 'auth' }, 401)
        : response(freshCheckout), /origin_protected/],
    ['an authentication header is unchecked', url => url.startsWith('https://origin.example/')
        ? rawResponse(JSON.stringify(freshCheckout), 200, { 'www-authenticate': 'Basic realm="preview"' })
        : response(freshCheckout), /origin_protected/],
    ['an SSO login page is unchecked', url => url.startsWith('https://origin.example/')
        ? rawResponse('<!doctype html><html><body>Vercel Authentication: Sign in</body></html>', 200, { 'content-type': 'text/html' })
        : response(freshCheckout), /origin_sso/],
    ['a redirect to SSO is unchecked', url => url.startsWith('https://origin.example/')
        ? response({}, 302, { location: 'https://vercel.com/sso-api' })
        : response(freshCheckout), /origin_redirected/],
    ['a CDN cache hit is not a direct origin', url => url.startsWith('https://origin.example/')
        ? response(freshCheckout, 200, { 'x-vercel-cache': 'HIT' })
        : response(freshCheckout), /origin_cache_hit/]
]) {
    test(name, async () => {
        const report = await originAudit('https://origin.example', handler);
        assert.equal(report.status, 'unavailable');
        assert.deepEqual(report.drift, []);
        assert.match(report.unavailable.join('; '), reason);
        assert.equal(report.checkout.origin.ok, false);
        assert.equal(report.finding.code, 'SHOPIFY_PRICE_DRIFT_UNCHECKED');
    });
}

test('an injected checkout payload cannot hide an invalid configured origin', async () => {
    const report = await auditShopifyPriceDrift({
        catalog,
        settings: { ...settings, checkoutOriginUrl: 'http://origin.example' },
        checkoutPayload: freshCheckout,
        fetchImpl: fakeFetch({ products: healthyShopify })
    });

    assert.equal(report.status, 'unavailable');
    assert.match(report.unavailable.join('; '), /checkout_origin_insecure/);
    assert.equal(report.finding.code, 'SHOPIFY_PRICE_DRIFT_UNCHECKED');
});

test('an injected checkout payload cannot bypass the DNS proof', async () => {
    const report = await auditShopifyPriceDrift({
        catalog,
        settings: { ...settings, checkoutOriginUrl: 'https://origin.example' },
        checkoutPayload: freshCheckout,
        dnsResolver: fakeDns({ addresses: { 'store.example': ['203.0.113.10'] } }),
        fetchImpl: fakeFetch({ products: healthyShopify })
    });

    assert.equal(report.status, 'unavailable');
    assert.match(report.unavailable.join('; '), /checkout_origin_dns_unverified/);
    assert.equal(report.checkout.origin_validation.ok, false);
    assert.equal(report.finding.code, 'SHOPIFY_PRICE_DRIFT_UNCHECKED');
});

test('a valid direct origin is fetched without redirects and can be distinguished from the edge', async () => {
    const methods = [];
    const report = await originAudit('https://origin.example', null, { methods });

    assert.equal(report.status, 'ok');
    assert.equal(report.checkout.origin_validation.ok, true);
    assert.equal(report.checkout.origin_validation.origin_host, 'origin.example');
    assert.equal(report.checkout.origin_validation.cdn_host, 'store.example');
    assert.equal(report.checkout.origin_validation.origin_cname, null);
    assert.deepEqual(report.checkout.origin_validation.origin_addresses, ['198.51.100.20']);
    assert.deepEqual(report.checkout.origin_validation.cdn_addresses, ['203.0.113.10']);
    const originCall = methods.find(call => call.url.startsWith('https://origin.example/data/store-prices.json'));
    assert.ok(originCall);
    assert.equal(originCall.redirect, 'manual');
});

test('a cache-busted edge response that still reports a cache hit leaves freshness unchecked', async () => {
    const report = await originAudit('https://origin.example', url => {
        const parsed = new URL(url);
        if (parsed.hostname === 'store.example' && parsed.searchParams.has('_price_audit')) {
            return response(freshCheckout, 200, { 'x-vercel-cache': 'HIT' });
        }
        return response(freshCheckout);
    });

    assert.equal(report.status, 'unavailable');
    assert.match(report.unavailable.join('; '), /checkout_fresh_unverified: edge_fresh_cache_hit/);
    assert.equal(report.checkout.edge_fresh.ok, true);
    assert.equal(report.checkout.edge_fresh.freshness.ok, false);
    assert.equal(report.checkout.edge.stale_vs_fresh, undefined);
    assert.equal(report.finding.code, 'SHOPIFY_PRICE_DRIFT_UNCHECKED');
});

test('a cache-busted edge response with no cache-miss evidence leaves freshness unchecked', async () => {
    const report = await originAudit('https://origin.example', url => {
        const parsed = new URL(url);
        if (parsed.hostname === 'store.example' && parsed.searchParams.has('_price_audit')) {
            return response(freshCheckout, 200, {});
        }
        return response(freshCheckout);
    });

    assert.equal(report.status, 'unavailable');
    assert.match(report.unavailable.join('; '), /checkout_fresh_unverified: edge_fresh_unverified/);
    assert.equal(report.checkout.edge_fresh.freshness.ok, false);
    assert.equal(report.finding.code, 'SHOPIFY_PRICE_DRIFT_UNCHECKED');
});

test('a non-zero Age makes the cache-busted edge read unchecked even when it says MISS', async () => {
    const report = await originAudit('https://origin.example', url => {
        const parsed = new URL(url);
        if (parsed.hostname === 'store.example' && parsed.searchParams.has('_price_audit')) {
            return response(freshCheckout, 200, { 'x-vercel-cache': 'MISS', age: '12' });
        }
        return response(freshCheckout);
    });

    assert.equal(report.status, 'unavailable');
    assert.match(report.unavailable.join('; '), /edge_fresh_cache_hit: Age is 12/);
    assert.equal(report.checkout.edge_fresh.freshness.ok, false);
});

test('an explicit Cloudflare cache miss proves edge freshness', async () => {
    const report = await originAudit('https://origin.example', url => {
        const parsed = new URL(url);
        if (parsed.hostname === 'store.example' && parsed.searchParams.has('_price_audit')) {
            return response(freshCheckout, 200, { 'cf-cache-status': 'MISS' });
        }
        return response(freshCheckout);
    });

    assert.equal(report.status, 'ok');
    assert.equal(report.checkout.edge_fresh.freshness.ok, true);
    assert.equal(report.checkout.edge_fresh.freshness.evidence.header, 'cf-cache-status');
});

test('the verified origin address is pinned into the request and is not resolved again', async () => {
    const dnsResolver = fakeDns();
    let originLookups = 0;
    const resolve4 = dnsResolver.resolve4;
    dnsResolver.resolve4 = async host => {
        if (host === 'origin.example') {
            originLookups += 1;
            return originLookups === 1 ? ['198.51.100.20'] : ['10.0.0.7'];
        }
        return resolve4(host);
    };
    const requests = [];
    const report = await originAudit('https://origin.example', null, {
        dnsResolver,
        originRequestImpl: async (url, { address } = {}) => {
            requests.push({ url, address });
            return response(freshCheckout);
        }
    });

    assert.equal(report.status, 'ok');
    assert.equal(originLookups, 1);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].address, '198.51.100.20');
    assert.match(requests[0].url, /_price_audit=/);
});

for (const [name, address, reason] of [
    ['an origin resolving to a private IPv4 address is unchecked', '10.0.0.7', /checkout_origin_private_address/],
    ['an origin resolving to loopback is unchecked', '127.0.0.1', /checkout_origin_private_address/],
    ['an origin resolving to a private IPv6 address is unchecked', 'fd00::1', /checkout_origin_private_address/],
    ['an origin resolving to a mapped loopback address is unchecked', '::ffff:127.0.0.1', /checkout_origin_private_address/],
    ['an origin resolving to a hex-mapped loopback address is unchecked', '::ffff:7f00:1', /checkout_origin_private_address/]
]) {
    test(name, async () => {
        const methods = [];
        const report = await originAudit('https://origin.example', null, {
            dnsResolver: fakeDns({
                addresses: { 'store.example': ['203.0.113.10'], 'origin.example': [address] }
            }),
            methods
        });

        assert.equal(report.status, 'unavailable');
        assert.deepEqual(report.drift, []);
        assert.match(report.unavailable.join('; '), reason);
        assert.equal(report.checkout.origin.ok, false);
        assert.equal(report.finding.code, 'SHOPIFY_PRICE_DRIFT_UNCHECKED');
        assert.ok(!methods.some(call => call.url.startsWith('https://origin.example/')), 'the private origin is never fetched');
    });
}

test('a buyer-facing CDN resolving to a private address is unchecked', async () => {
    const methods = [];
    const report = await originAudit('https://origin.example', null, {
        dnsResolver: fakeDns({
            addresses: { 'store.example': ['192.168.1.10'], 'origin.example': ['198.51.100.20'] }
        }),
        methods
    });

    assert.equal(report.status, 'unavailable');
    assert.match(report.unavailable.join('; '), /checkout_origin_dns_unverified/);
    assert.equal(report.checkout.origin.ok, false);
    assert.ok(!methods.some(call => call.url.startsWith('https://origin.example/')), 'the origin is never fetched');
});

for (const [name, dnsResolver, reason] of [
    ['an alternate hostname sharing the CDN CNAME target is unchecked', fakeDns({
        cname: { 'store.example': ['edge.cdn.example'], 'alternate-cdn.example': ['edge.cdn.example'] },
        addresses: { 'store.example': ['203.0.113.10'], 'alternate-cdn.example': ['198.51.100.20'] }
    }), /checkout_origin_shared_cdn/],
    ['an alternate hostname sharing the CDN address is unchecked', fakeDns({
        addresses: { 'store.example': ['203.0.113.10'], 'alternate-cdn.example': ['203.0.113.10'] }
    }), /checkout_origin_shared_cdn/],
    ['an unresolvable origin is unchecked', fakeDns({
        addresses: { 'store.example': ['203.0.113.10'] }
    }), /checkout_origin_dns_unverified/],
    ['an unresolvable CDN is unchecked', fakeDns({
        addresses: { 'origin.example': ['198.51.100.20'] }
    }), /checkout_origin_dns_unverified/],
    ['a DNS failure is unchecked', {
        async resolveCname() { throw emptyDnsError(); },
        async resolve4() {
            const error = new Error('temporary DNS failure');
            error.code = 'EAI_AGAIN';
            throw error;
        },
        async resolve6() { throw emptyDnsError(); }
    }, /checkout_origin_dns_unverified/]
]) {
    test(name, async () => {
        const methods = [];
        const report = await originAudit('https://alternate-cdn.example', null, { dnsResolver, methods });
        assert.equal(report.status, 'unavailable');
        assert.deepEqual(report.drift, []);
        assert.match(report.unavailable.join('; '), reason);
        assert.equal(report.checkout.origin_validation.ok, false);
        assert.equal(report.checkout.origin.ok, false);
        assert.equal(report.finding.code, 'SHOPIFY_PRICE_DRIFT_UNCHECKED');
        assert.ok(!methods.some(call => call.url.startsWith('https://alternate-cdn.example/')), 'the untrusted origin is never fetched');
    });
}
