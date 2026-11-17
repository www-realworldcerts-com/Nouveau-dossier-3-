import assert from 'node:assert/strict';
import test from 'node:test';

import {
    auditCheckoutBrowser,
    resolveBuyOriginUrl,
    resolveBuyUrl
} from '../src/sales/checkout-browser-audit.mjs';

const expected = {
    productId: 'course-one',
    expectedAmount: 19,
    expectedCurrency: 'USD'
};

const base = {
    buyUrl: 'https://store.example/buy',
    buyOriginUrl: 'https://origin.example/buy',
    ...expected
};

function page(displayed, posted) {
    return {
        displayed: { text: `Course One — ${displayed.amount.toFixed(2)} ${displayed.currency}`, ...displayed },
        posted
    };
}

test('the browser audit checks the displayed and POSTed price on edge, fresh edge and origin', async () => {
    const calls = [];
    const report = await auditCheckoutBrowser({
        ...base,
        probePage: async ({ url }) => {
            calls.push(url);
            return page({ amount: 19, currency: 'USD' }, { product_id: 'course-one', amount: 19, currency: 'USD' });
        }
    });

    assert.equal(report.status, 'ok');
    assert.equal(report.checked_routes, 3);
    assert.deepEqual(report.drift, []);
    assert.deepEqual(report.stale_routes, []);
    assert.equal(calls.some(url => url === 'https://store.example/buy?product_id=course-one'), true);
    assert.equal(calls.some(url => url.includes('_price_audit=') && url.startsWith('https://store.example/buy?')), true);
    assert.equal(calls.some(url => url.includes('_price_audit=') && url.startsWith('https://origin.example/buy?')), true);
});

test('a stale edge page is drift even when the fresh edge and origin are correct', async () => {
    const report = await auditCheckoutBrowser({
        ...base,
        probePage: async ({ url }) => {
            const stale = url.startsWith('https://store.example/buy?') && !url.includes('_price_audit=');
            return page(
                { amount: stale ? 18 : 19, currency: 'USD' },
                { product_id: 'course-one', amount: stale ? 18 : 19, currency: 'USD' }
            );
        }
    });

    assert.equal(report.status, 'drift');
    assert.deepEqual(report.stale_routes, ['edge']);
    assert.ok(report.drift.some(row => row.route === 'edge' && row.reason === 'displayed_price_mismatch'));
    assert.ok(report.drift.some(row => row.route === 'edge' && row.reason === 'posted_amount_mismatch'));
});

test('a page that displays the right price but omits the POSTed amount is drift', async () => {
    const report = await auditCheckoutBrowser({
        ...base,
        probePage: async ({ url }) => {
            const stale = url.startsWith('https://store.example/buy?') && !url.includes('_price_audit=');
            return page(
                { amount: 19, currency: 'USD' },
                stale
                    ? { product_id: 'course-one', reference: 'RWC-TEST' }
                    : { product_id: 'course-one', amount: 19, currency: 'USD' }
            );
        }
    });

    assert.equal(report.status, 'drift');
    assert.deepEqual(report.stale_routes, ['edge']);
    assert.ok(report.drift.some(row => row.route === 'edge' && row.reason === 'posted_amount_missing'));
});

test('a wrong POSTed currency is reported separately', async () => {
    const report = await auditCheckoutBrowser({
        ...base,
        probePage: async ({ url }) => {
            const origin = url.startsWith('https://origin.example/');
            return page(
                { amount: 19, currency: 'USD' },
                { product_id: 'course-one', amount: 19, currency: origin ? 'EUR' : 'USD' }
            );
        }
    });

    assert.equal(report.status, 'drift');
    assert.deepEqual(report.stale_routes, ['origin']);
    assert.ok(report.drift.some(row => row.route === 'origin' && row.reason === 'posted_currency_mismatch'));
});

test('a missing origin cannot produce a clean browser audit', async () => {
    const calls = [];
    const report = await auditCheckoutBrowser({
        ...base,
        buyOriginUrl: null,
        probePage: async ({ url }) => {
            calls.push(url);
            return page({ amount: 19, currency: 'USD' }, { product_id: 'course-one', amount: 19, currency: 'USD' });
        }
    });

    assert.equal(report.status, 'unavailable');
    assert.ok(report.unavailable.some(reason => reason.startsWith('buy_origin_url_missing')));
    assert.equal(calls.length, 2);
});

test('a browser failure is unchecked, never a clean result', async () => {
    const report = await auditCheckoutBrowser({
        ...base,
        probePage: async ({ url }) => {
            if (url.startsWith('https://origin.example/')) throw new Error('browser launch failed');
            return page({ amount: 19, currency: 'USD' }, { product_id: 'course-one', amount: 19, currency: 'USD' });
        }
    });

    assert.equal(report.status, 'unavailable');
    assert.ok(report.unavailable.some(reason => reason.startsWith('origin_unavailable')));
});

test('an invalid expected price is unavailable without probing', async () => {
    let called = false;
    const report = await auditCheckoutBrowser({
        ...base,
        expectedAmount: 0,
        probePage: async () => {
            called = true;
            return page({ amount: 19, currency: 'USD' }, { product_id: 'course-one', amount: 19, currency: 'USD' });
        }
    });

    assert.equal(report.status, 'unavailable');
    assert.equal(called, false);
    assert.ok(report.unavailable.includes('expected_amount_invalid'));
});

test('buy URLs derive from the storefront and price-origin settings', () => {
    assert.equal(resolveBuyUrl({ storefrontUrl: 'https://store.example/' }), 'https://store.example/buy');
    assert.equal(
        resolveBuyOriginUrl({ checkoutOriginUrl: 'https://origin.example/data/store-prices.json' }),
        'https://origin.example/buy'
    );
    assert.equal(resolveBuyOriginUrl({ checkoutOriginUrl: 'https://origin.example' }), 'https://origin.example/buy');
    assert.equal(resolveBuyOriginUrl({ checkoutOriginUrl: '' }), null);
});
