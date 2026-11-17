import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    loadRepriceRun,
    repriceShopifyCatalog,
    rollbackShopifyReprice
} from '../src/sales/shopify-reprice.mjs';

const settings = {
    domain: 'shop.myshopify.com',
    token: 'shpat_test',
    apiVersion: '2024-10'
};

const catalog = {
    file: '/tmp/course-catalog.json',
    currency: 'USD',
    fx: { USD: 1, MAD: 10, EUR: 0.92 },
    courses: [
        {
            slug: 'course-one',
            title: 'Course One',
            description: '<p>One.</p>',
            category: 'Test',
            language: 'en',
            price_cents: 1900,
            status: 'active'
        },
        {
            slug: 'course-two',
            title: 'Course Two',
            description: '<p>Two.</p>',
            category: 'Test',
            language: 'en',
            price_cents: 2900,
            status: 'active'
        }
    ]
};

function response(body, status = 200) {
    return {
        ok: status < 400,
        status,
        text: async () => JSON.stringify(body),
        json: async () => body
    };
}

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'shopify-reprice-'));
}

function fakeShopify({ products, failVariantId = null } = {}) {
    let state = structuredClone(products);
    const updates = [];
    const fetchImpl = async (url, options = {}) => {
        const target = String(url);
        if (target.includes('/shop.json')) return response({ shop: { currency: 'USD' } });
        if (target.includes('/products.json') && (!options.method || options.method === 'GET')) {
            return response({ products: structuredClone(state) });
        }
        const match = target.match(/\/variants\/(\d+)\.json$/);
        if (match && options.method === 'PUT') {
            const variantId = Number(match[1]);
            if (String(variantId) === String(failVariantId)) {
                return response({ errors: 'variant update failed' }, 500);
            }
            const body = JSON.parse(options.body);
            const price = body.variant.price;
            state = state.map(product => ({
                ...product,
                variants: product.variants.map(variant =>
                    String(variant.id) === String(variantId)
                        ? { ...variant, price }
                        : variant
                )
            }));
            updates.push({ variant_id: variantId, price });
            return response({ variant: { id: variantId, price } });
        }
        throw new Error(`unexpected fetch: ${target}`);
    };
    return {
        fetchImpl,
        updates,
        products: () => state
    };
}

function productsAt(firstPrice = '17.00', secondPrice = '27.00', status = 'active') {
    return [
        {
            id: 101,
            handle: 'course-one',
            status,
            variants: [{ id: 1001, price: firstPrice }]
        },
        {
            id: 102,
            handle: 'course-two',
            status,
            variants: [{ id: 1002, price: secondPrice }]
        }
    ];
}

test('dry-run reports active price changes without writing', async () => {
    const shop = fakeShopify({ products: productsAt() });
    const result = await repriceShopifyCatalog({
        catalog,
        settings,
        storeCurrency: 'USD',
        dryRun: true,
        fetchImpl: shop.fetchImpl
    });

    assert.equal(result.status, 'dry_run');
    assert.equal(result.ready, true);
    assert.equal(result.changed, 2);
    assert.equal(result.changes[0].from_price, '17.00');
    assert.equal(result.changes[0].to_price, '19.00');
    assert.equal(shop.updates.length, 0);
});

test('reprice snapshots, updates and verifies active prices', async () => {
    const dataDir = tempDir();
    const shop = fakeShopify({ products: productsAt() });
    const result = await repriceShopifyCatalog({
        catalog,
        settings,
        storeCurrency: 'USD',
        dataDir,
        fetchImpl: shop.fetchImpl
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.changed, 2);
    assert.equal(result.verification.ok, true);
    assert.equal(shop.updates.length, 2);
    assert.deepEqual(
        shop.products().map(product => product.variants[0].price),
        ['19.00', '29.00']
    );

    const saved = loadRepriceRun(dataDir, result.run_id);
    assert.equal(saved.kind, 'reprice');
    assert.equal(saved.snapshot.length, 2);
    assert.equal(saved.snapshot[0].from_price, '17.00');
    assert.equal(saved.snapshot[0].to_price, '19.00');
    assert.ok(fs.existsSync(path.join(dataDir, 'ShopifyRepriceRuns', `${result.run_id}.json`)));
});

test('a failed update restores every already-changed price', async () => {
    const dataDir = tempDir();
    const shop = fakeShopify({ products: productsAt(), failVariantId: 1002 });
    const result = await repriceShopifyCatalog({
        catalog,
        settings,
        storeCurrency: 'USD',
        dataDir,
        fetchImpl: shop.fetchImpl
    });

    assert.equal(result.status, 'rolled_back');
    assert.equal(result.reason, 'price_update_failed');
    assert.equal(result.rollback.ok, true);
    assert.equal(result.rollback.restored.length, 1);
    assert.equal(shop.products()[0].variants[0].price, '17.00');
    assert.equal(shop.products()[1].variants[0].price, '27.00');

    const saved = loadRepriceRun(dataDir, result.run_id);
    assert.equal(saved.status, 'rolled_back');
    assert.equal(saved.rollback.ok, true);
});

test('manual rollback restores a completed reprice run', async () => {
    const dataDir = tempDir();
    const shop = fakeShopify({ products: productsAt() });
    const result = await repriceShopifyCatalog({
        catalog,
        settings,
        storeCurrency: 'USD',
        dataDir,
        fetchImpl: shop.fetchImpl
    });
    assert.equal(result.status, 'ok');

    const rolledBack = await rollbackShopifyReprice({
        settings,
        dataDir,
        runId: result.run_id,
        fetchImpl: shop.fetchImpl
    });

    assert.equal(rolledBack.status, 'rolled_back');
    assert.equal(rolledBack.rollback.ok, true);
    assert.equal(rolledBack.rollback.restored.length, 2);
    assert.deepEqual(
        shop.products().map(product => product.variants[0].price),
        ['17.00', '27.00']
    );
});

test('draft products are blocked before any write', async () => {
    const dataDir = tempDir();
    const shop = fakeShopify({ products: productsAt('17.00', '27.00', 'draft') });
    const result = await repriceShopifyCatalog({
        catalog,
        settings,
        storeCurrency: 'USD',
        dataDir,
        fetchImpl: shop.fetchImpl
    });

    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'reprice_preflight_failed');
    assert.equal(result.errors.length, 2);
    assert.equal(result.errors[0].reason, 'product_not_active');
    assert.equal(shop.updates.length, 0);
});
