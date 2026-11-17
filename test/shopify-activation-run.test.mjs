import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { activateCatalog } from '../src/sales/shopify-activation.mjs';
import {
    acquireActivationLock,
    activationLockPath,
    activationRunPath,
    latestActivationRun,
    loadActivationRun,
    releaseActivationLock,
    saveActivationRun
} from '../src/sales/shopify-activation-run.mjs';

const catalog = {
    file: '/tmp/course-catalog.json',
    currency: 'USD',
    fx: { USD: 1 },
    courses: [
        { slug: 'course-a', title: 'Course A', status: 'active', price_cents: 1900 },
        { slug: 'course-b', title: 'Course B', status: 'active', price_cents: 1900 }
    ]
};

const settings = {
    domain: 'realworldcerts-test.myshopify.com',
    token: 'shpat_testtoken123',
    apiVersion: '2024-10',
    storefrontUrl: 'https://www.realworldcerts.com',
    storefrontToken: 'public-storefront-token',
    expectedDomain: 'realworldcerts.com',
    canaryCourse: 'course-a',
    canaryAddress1: '1 Test Street',
    canaryCity: 'New York',
    canaryProvinceCode: 'NY',
    canaryPostalCode: '10001'
};

function response(body, status = 200, url = null) {
    return {
        ok: status < 400,
        status,
        url,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
        json: async () => (typeof body === 'string' ? JSON.parse(body) : body)
    };
}

function productIdFromGid(gid) {
    return Number(String(gid || '').split('/').pop());
}

function multiShop({
    statuses = ['draft', 'draft'],
    published = [true, true],
    failStatusFor = null,
    failCollection = false
} = {}) {
    const state = {
        products: [
            { id: 42, handle: 'course-a', status: statuses[0], variants: [{ id: 7, price: '19.00' }] },
            { id: 43, handle: 'course-b', status: statuses[1], variants: [{ id: 8, price: '19.00' }] }
        ],
        publications: new Map([[42, published[0]], [43, published[1]]]),
        collects: [],
        failStatusFor,
        failedStatusIds: new Set(),
        failCollection,
        storefrontCalls: 0
    };

    const fetchImpl = async (url, options = {}) => {
        const target = String(url);
        if (target.includes('/shop.json')) {
            return response({ shop: { currency: 'USD', domain: 'www.realworldcerts.com' } });
        }
        if (target.includes('/access_scopes.json')) {
            return response({
                access_scopes: [
                    'read_products',
                    'read_publications',
                    'read_payment_gateways',
                    'read_shopify_payments_accounts',
                    'read_markets'
                ].map(handle => ({ handle }))
            });
        }
        if (target.includes('/products/') && options.method === 'PUT') {
            const id = Number(target.match(/\/products\/(\d+)\.json/)?.[1]);
            if (state.failStatusFor === id && !state.failedStatusIds.has(id)) {
                state.failedStatusIds.add(id);
                return response('activation failed', 500);
            }
            const body = JSON.parse(options.body);
            const product = state.products.find(row => row.id === id);
            product.status = body.product.status;
            return response({ product: { id, status: product.status } });
        }
        if (target.includes('/products.json')) {
            return response({ products: state.products });
        }
        if (target.includes('/custom_collections.json')) {
            return response({ custom_collections: [{ id: 99, handle: 'courses' }] });
        }
        if (target.includes('/collects.json') && options.method === 'POST') {
            if (state.failCollection) return response('collection failed', 500);
            const body = JSON.parse(options.body);
            if (!state.collects.includes(body.collect.product_id)) {
                state.collects.push(body.collect.product_id);
            }
            return response({ collect: body.collect }, 201);
        }
        if (target.includes('/collects.json')) {
            return response({
                collects: state.collects.map((productId, index) => ({
                    id: index + 1,
                    product_id: productId
                }))
            });
        }
        if (target.includes('/payment_gateways.json')) {
            return response({
                payment_gateways: [{ id: 1, name: 'shopify_payments', disabled: false }]
            });
        }
        if (target.includes('/admin/api/') && target.includes('/graphql.json')) {
            const body = options.body ? JSON.parse(options.body) : {};
            const query = String(body.query || '');
            if (query.includes('LaunchMarketContext')) {
                return response({
                    data: {
                        shop: { currencyCode: 'USD', taxesIncluded: false, taxShipping: false },
                        primaryMarket: {
                            id: 'gid://shopify/Market/1',
                            name: 'Primary',
                            currencySettings: {
                                baseCurrency: { currencyCode: 'USD' },
                                localCurrencies: false
                            },
                            regions: { nodes: [{ code: 'US', name: 'United States' }] }
                        }
                    }
                });
            }
            if (query.includes('LaunchPublications')) {
                return response({
                    data: {
                        publications: {
                            nodes: [{
                                id: 'gid://shopify/Publication/123',
                                catalog: { title: 'Online Store' }
                            }]
                        }
                    }
                });
            }
            if (query.includes('LaunchPublishProduct')) {
                state.publications.set(productIdFromGid(body.variables.id), true);
                return response({ data: { publishablePublish: { userErrors: [] } } });
            }
            if (query.includes('LaunchUnpublishProduct')) {
                state.publications.set(productIdFromGid(body.variables.id), false);
                return response({ data: { publishableUnpublish: { userErrors: [] } } });
            }
            if (query.includes('LaunchProductPublication')) {
                return response({
                    data: {
                        product: {
                            publishedOnPublication: state.publications.get(
                                productIdFromGid(body.variables.id)
                            ) === true
                        }
                    }
                });
            }
            return response({
                data: {
                    shopifyPaymentsAccount: {
                        activated: true,
                        payoutSchedule: { interval: 'DAILY' },
                        bankAccounts: { nodes: [{ id: 1 }] }
                    }
                }
            });
        }
        if (target.includes('/api/') && target.includes('/graphql.json')) {
            state.storefrontCalls += 1;
            const body = options.body ? JSON.parse(options.body) : {};
            const query = String(body.query || '');
            if (query.includes('LaunchCanaryVariant')) {
                return response({
                    data: {
                        productVariant: {
                            id: 'gid://shopify/ProductVariant/7',
                            availableForSale: true,
                            currentlyNotInStock: false,
                            quantityAvailable: 5,
                            requiresShipping: false,
                            price: { amount: '19.00', currencyCode: 'USD' },
                            product: { title: 'Course A', handle: 'course-a' }
                        }
                    }
                });
            }
            return response({
                data: {
                    cartCreate: {
                        cart: {
                            id: 'gid://shopify/Cart/1',
                            checkoutUrl: 'https://checkout.shopify.com/canary',
                            cost: {
                                subtotalAmount: { amount: '19.00', currencyCode: 'USD' },
                                totalAmount: { amount: '19.00', currencyCode: 'USD' },
                                totalTaxAmount: { amount: '0.00', currencyCode: 'USD' }
                            },
                            deliveryGroups: { nodes: [] }
                        },
                        userErrors: []
                    }
                }
            });
        }
        if (target.includes('checkout.shopify.com')) return response('<html>checkout</html>', 200, target);
        if (target.includes('realworldcerts.com')) {
            return response('<html><body>catalog</body></html>', 200, 'https://www.realworldcerts.com/');
        }
        return response({}, 404);
    };

    return { state, fetchImpl };
}

function temporaryDataDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'shopify-activation-run-'));
}

function cleanup(directory) {
    fs.rmSync(directory, { recursive: true, force: true });
}

test('activation lock is exclusive and released by its owner', () => {
    const dataDir = temporaryDataDir();
    try {
        const first = acquireActivationLock({ dataDir, runId: 'run-one', domain: settings.domain });
        assert.equal(first.ok, true);

        const blocked = acquireActivationLock({ dataDir, runId: 'run-two', domain: settings.domain });
        assert.equal(blocked.ok, false);
        assert.equal(blocked.reason, 'activation_locked');
        assert.equal(blocked.lock.run_id, 'run-one');

        assert.equal(releaseActivationLock(first), true);
        const third = acquireActivationLock({ dataDir, runId: 'run-three', domain: settings.domain });
        assert.equal(third.ok, true);
        releaseActivationLock(third);
        assert.equal(fs.existsSync(activationLockPath(dataDir)), false);
    } finally {
        cleanup(dataDir);
    }
});

test('a lock left by a dead process is reclaimed', () => {
    const dataDir = temporaryDataDir();
    try {
        fs.mkdirSync(path.dirname(activationLockPath(dataDir)), { recursive: true });
        fs.writeFileSync(activationLockPath(dataDir), JSON.stringify({
            run_id: 'crashed-run',
            pid: 2147483647,
            hostname: os.hostname(),
            started_at: new Date().toISOString()
        }));

        const lock = acquireActivationLock({
            dataDir,
            runId: 'recovery-run',
            domain: settings.domain
        });
        assert.equal(lock.ok, true);
        assert.equal(lock.run_id, 'recovery-run');
        releaseActivationLock(lock);
    } finally {
        cleanup(dataDir);
    }
});

test('activation run reports are durable and discover the latest in-progress run', () => {
    const dataDir = temporaryDataDir();
    try {
        const started = '2026-11-16T10:00:00.000Z';
        const first = saveActivationRun(dataDir, {
            run_id: 'run-old',
            status: 'in_progress',
            phase: 'preflight',
            started_at: started
        });
        assert.equal(first, activationRunPath(dataDir, 'run-old'));
        assert.equal(loadActivationRun(dataDir, 'run-old').run_id, 'run-old');
        assert.equal(latestActivationRun(dataDir, { inProgressOnly: true }).run_id, 'run-old');

        saveActivationRun(dataDir, {
            run_id: 'run-old',
            status: 'ok',
            phase: 'completed',
            started_at: started,
            completed_at: '2026-11-16T10:05:00.000Z'
        });
        assert.equal(latestActivationRun(dataDir, { inProgressOnly: true }), null);
        assert.equal(latestActivationRun(dataDir).status, 'ok');
    } finally {
        cleanup(dataDir);
    }
});

test('dry-run reports the activation plan without writing to Shopify', async () => {
    const dataDir = temporaryDataDir();
    try {
        const { state, fetchImpl } = multiShop({
            statuses: ['draft', 'draft'],
            published: [false, false]
        });
        const result = await activateCatalog({
            catalog,
            courseIds: ['course-a', 'course-b'],
            settings,
            fetchImpl,
            dataDir,
            dryRun: true
        });

        assert.equal(result.status, 'dry_run');
        assert.equal(result.dry_run, true);
        assert.equal(result.ready, false);
        assert.equal(result.products.length, 2);
        assert.deepEqual(result.activation_actions, ['course-a', 'course-b']);
        assert.deepEqual(result.publication_actions, ['course-a', 'course-b']);
        assert.deepEqual(result.collection_actions, ['course-a', 'course-b']);
        assert.equal(result.price_check.ok, true);
        assert.equal(result.publication.action_count, 2);
        assert.equal(result.collection.addition_count, 2);
        assert.ok(result.blockers.includes('collection_missing_products:2'));
        assert.ok(result.warnings.includes('canary_checkout_skipped_dry_run'));

        assert.deepEqual(state.products.map(product => product.status), ['draft', 'draft']);
        assert.deepEqual([...state.publications.values()], [false, false]);
        assert.deepEqual(state.collects, []);
        assert.equal(state.storefrontCalls, 0);
        assert.equal(fs.existsSync(activationLockPath(dataDir)), false);
        assert.equal(fs.existsSync(path.join(dataDir, 'ShopifyActivationRuns')), false);
    } finally {
        cleanup(dataDir);
    }
});

test('dry-run is ready when the plan requires no writes', async () => {
    const { state, fetchImpl } = multiShop({
        statuses: ['draft', 'draft'],
        published: [true, true]
    });
    state.collects.push(42, 43);

    const result = await activateCatalog({
        catalog,
        courseIds: ['course-a', 'course-b'],
        settings,
        fetchImpl,
        dryRun: true
    });

    assert.equal(result.status, 'dry_run');
    assert.equal(result.ready, true);
    assert.deepEqual(result.blockers, []);
    assert.deepEqual(result.publication_actions, []);
    assert.deepEqual(result.collection_actions, []);
    assert.equal(state.storefrontCalls, 0);
    assert.deepEqual(state.products.map(product => product.status), ['draft', 'draft']);
});

test('a mid-run activation failure restores every status and publication state', async () => {
    const dataDir = temporaryDataDir();
    try {
        const { state, fetchImpl } = multiShop({ failStatusFor: 43 });
        const result = await activateCatalog({
            catalog,
            courseIds: ['course-a', 'course-b'],
            settings,
            fetchImpl,
            dataDir,
            now: () => new Date('2026-11-16T12:00:00.000Z')
        });

        assert.equal(result.status, 'blocked');
        assert.equal(result.reason, 'activation_partial');
        assert.equal(result.rollback.ok, true);
        assert.deepEqual(state.products.map(product => product.status), ['draft', 'draft']);
        assert.deepEqual([...state.publications.values()], [true, true]);
        assert.ok(result.rolled_back.includes(42));
        assert.ok(result.rolled_back.includes(43));

        const report = loadActivationRun(dataDir, result.run_id);
        assert.equal(report.status, 'blocked');
        assert.equal(report.phase, 'rolled_back');
        assert.equal(report.snapshot.length, 2);
        assert.equal(report.rollback.ok, true);
        assert.equal(fs.existsSync(activationLockPath(dataDir)), false);
    } finally {
        cleanup(dataDir);
    }
});

test('publication changes are reversed when activation fails before the canary', async () => {
    const dataDir = temporaryDataDir();
    try {
        const { state, fetchImpl } = multiShop({
            published: [false, false],
            failCollection: true
        });
        const result = await activateCatalog({
            catalog,
            courseIds: ['course-a', 'course-b'],
            settings,
            fetchImpl,
            dataDir
        });

        assert.equal(result.status, 'blocked');
        assert.equal(result.reason, 'collection_membership_failed');
        assert.deepEqual(state.products.map(product => product.status), ['draft', 'draft']);
        assert.deepEqual([...state.publications.values()], [false, false]);
        assert.equal(result.rollback.ok, true);
        assert.equal(fs.existsSync(activationLockPath(dataDir)), false);
    } finally {
        cleanup(dataDir);
    }
});

test('an interrupted run can resume from its persisted snapshot and report', async () => {
    const dataDir = temporaryDataDir();
    try {
        const runId = 'run-interrupted';
        saveActivationRun(dataDir, {
            run_id: runId,
            status: 'in_progress',
            phase: 'canary',
            domain: settings.domain,
            course_ids: ['course-a', 'course-b'],
            canary_course: 'course-a',
            started_at: '2026-11-16T12:00:00.000Z',
            publication: { id: 'gid://shopify/Publication/123', name: 'Online Store' },
            snapshot: [
                {
                    course_id: 'course-a',
                    product_id: 42,
                    status: 'draft',
                    online_store_published: true
                },
                {
                    course_id: 'course-b',
                    product_id: 43,
                    status: 'draft',
                    online_store_published: true
                }
            ],
            resume_count: 0
        });

        const { state, fetchImpl } = multiShop({ statuses: ['active', 'draft'] });
        const result = await activateCatalog({
            catalog,
            courseIds: null,
            settings,
            fetchImpl,
            dataDir,
            resumeRunId: runId
        });

        assert.equal(result.status, 'ok', JSON.stringify(result));
        assert.equal(result.run_id, runId);
        assert.equal(result.resumed, true);
        assert.equal(result.activated, 2);
        assert.deepEqual(state.products.map(product => product.status), ['active', 'active']);

        const report = loadActivationRun(dataDir, runId);
        assert.equal(report.status, 'ok');
        assert.equal(report.resume_count, 1);
        assert.equal(report.run_id, runId);
        assert.equal(report.phase, 'completed');
        assert.equal(fs.existsSync(activationLockPath(dataDir)), false);
    } finally {
        cleanup(dataDir);
    }
});
