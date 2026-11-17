import assert from 'node:assert/strict';
import test from 'node:test';

import { activateCatalog } from '../src/sales/shopify-activation.mjs';

const catalog = {
    file: '/tmp/course-catalog.json',
    currency: 'USD',
    fx: { USD: 1, EUR: 0.92 },
    courses: [{
        slug: 'test-course',
        title: 'Test Course',
        status: 'active',
        price_cents: 1900
    }]
};

const settings = {
    domain: 'realworldcerts-test.myshopify.com',
    token: 'shpat_testtoken123',
    apiVersion: '2024-10',
    storefrontUrl: 'https://www.realworldcerts.com',
    storefrontToken: 'public-storefront-token',
    expectedDomain: 'realworldcerts.com',
    canaryCourse: 'test-course',
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

function fakeShop({ payments = true, variantPrice = '19.00', variants = null, shopCurrency = 'USD', published = true, onlineStore = true, publishable = true } = {}) {
    const state = {
        status: 'draft',
        collects: [],
        published
    };
    const product = () => ({
        id: 42,
        handle: 'test-course',
        status: state.status,
        variants: variants || [{ id: 7, price: variantPrice }]
    });

    const fetchImpl = async (url, options = {}) => {
        const target = String(url);
        if (target.includes('/shop.json')) {
            return response({ shop: { currency: shopCurrency, domain: 'www.realworldcerts.com' } });
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
        if (target.includes('/products/42.json') && options.method === 'PUT') {
            const body = JSON.parse(options.body);
            state.status = body.product.status;
            return response({ product: { id: 42, status: state.status } });
        }
        if (target.includes('/products.json')) {
            return response({ products: [product()] });
        }
        if (target.includes('/custom_collections.json')) {
            return response({ custom_collections: [{ id: 99, handle: 'courses' }] });
        }
        if (target.includes('/collects.json') && options.method === 'POST') {
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
                payment_gateways: payments ? [{ id: 1, name: 'shopify_payments', disabled: false }] : []
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
                            nodes: onlineStore
                                ? [{ id: 'gid://shopify/Publication/123', name: 'Online Store', catalog: { title: 'Online Store' } }]
                                : [{ id: 'gid://shopify/Publication/456', name: 'Point of Sale', catalog: { title: 'Point of Sale' } }]
                        }
                    }
                });
            }
            if (query.includes('LaunchPublishProduct')) {
                return response({
                    data: {
                        publishablePublish: {
                            userErrors: publishable ? [] : [{ field: ['publicationId'], message: 'Product cannot be published' }]
                        }
                    }
                });
            }
            if (query.includes('LaunchProductPublication')) {
                return response({ data: { product: { publishedOnPublication: state.published } } });
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
                            product: { title: 'Test Course', handle: 'test-course' }
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

test('activates a canary first, then the catalog when the gate passes', async () => {
    const { state, fetchImpl } = fakeShop();
    const result = await activateCatalog({
        catalog,
        courseIds: ['test-course'],
        settings,
        fetchImpl
    });

    assert.equal(result.status, 'ok', JSON.stringify(result));
    assert.equal(result.activated, 1);
    assert.equal(result.readiness.ready, true);
    assert.equal(state.status, 'active');
    assert.deepEqual(state.collects, [42]);
});

test('blocks activation when a selected variant price is stale', async () => {
    const { state, fetchImpl } = fakeShop({ variantPrice: '20.00' });
    const result = await activateCatalog({
        catalog,
        courseIds: ['test-course'],
        settings,
        fetchImpl
    });

    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'variant_validation_failed');
    assert.equal(result.price_check.mismatches[0].reason, 'price_mismatch');
    assert.equal(result.price_check.mismatches[0].expected, '19.00');
    assert.equal(result.price_check.mismatches[0].actual, '20.00');
    assert.equal(result.price_check.mismatches[0].currency, 'USD');
    assert.equal(state.status, 'draft');
    assert.deepEqual(state.collects, []);
});

test('blocks activation when a selected product has no usable variant', async () => {
    const missing = await activateCatalog({
        catalog,
        courseIds: ['test-course'],
        settings,
        fetchImpl: fakeShop({ variants: [] }).fetchImpl
    });
    assert.equal(missing.status, 'blocked');
    assert.equal(missing.price_check.mismatches[0].reason, 'missing_variant');

    const unusable = await activateCatalog({
        catalog,
        courseIds: ['test-course'],
        settings,
        fetchImpl: fakeShop({ variants: [{ id: null, price: '19.00' }] }).fetchImpl
    });
    assert.equal(unusable.status, 'blocked');
    assert.equal(unusable.price_check.mismatches[0].reason, 'unusable_variant');
});

test('blocks activation when a variant presentment lacks the store currency', async () => {
    const result = await activateCatalog({
        catalog,
        courseIds: ['test-course'],
        settings,
        storeCurrency: 'EUR',
        fetchImpl: fakeShop({
            variants: [{
                id: 7,
                price: '17.48',
                presentment_prices: [{ price: { amount: '19.00', currencyCode: 'USD' } }]
            }]
        }).fetchImpl
    });

    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'variant_validation_failed');
    assert.equal(result.price_check.mismatches[0].reason, 'currency_mismatch');
    assert.equal(result.price_check.mismatches[0].expected, 'EUR');
    assert.deepEqual(result.price_check.mismatches[0].actual, ['USD']);
});

test('blocks activation when the store currency has no canonical conversion', async () => {
    const result = await activateCatalog({
        catalog,
        courseIds: ['test-course'],
        settings,
        storeCurrency: 'GBP',
        fetchImpl: fakeShop().fetchImpl
    });

    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'variant_validation_failed');
    assert.equal(result.price_check.mismatches[0].reason, 'price_unavailable');
    assert.match(result.price_check.mismatches[0].error, /No FX rate for GBP/);
});

test('blocks activation when a selected product is not published to Online Store', async () => {
    const { state, fetchImpl } = fakeShop({ published: false });
    const result = await activateCatalog({
        catalog,
        courseIds: ['test-course'],
        settings,
        fetchImpl
    });

    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'products_not_published_to_online_store');
    assert.deepEqual(result.publication_check.unpublished, [
        { course_id: 'test-course', product_id: 42 }
    ]);
    assert.equal(state.status, 'draft');
    assert.deepEqual(result.rolled_back, [42]);
});

test('blocks activation when publishing a draft to Online Store fails', async () => {
    const { state, fetchImpl } = fakeShop({ publishable: false, published: false });
    const result = await activateCatalog({
        catalog,
        courseIds: ['test-course'],
        settings,
        fetchImpl
    });

    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'publication_set_failed');
    assert.equal(result.publication_check.failures[0].course_id, 'test-course');
    assert.equal(state.status, 'draft');
    assert.deepEqual(state.collects, []);
});

test('blocks activation when the Online Store publication is unavailable', async () => {
    const result = await activateCatalog({
        catalog,
        courseIds: ['test-course'],
        settings,
        fetchImpl: fakeShop({ onlineStore: false }).fetchImpl
    });

    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'online_store_publication_missing');
    assert.equal(result.publication_check.publication, null);
});

test('leaves the canary in draft when the gate blocks activation', async () => {
    const { state, fetchImpl } = fakeShop({ payments: false });
    const result = await activateCatalog({
        catalog,
        courseIds: ['test-course'],
        settings,
        fetchImpl
    });

    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'launch_not_ready');
    assert.ok(result.blockers.includes('no_payment_provider'));
    assert.equal(result.canary.reverted, true);
    assert.equal(state.status, 'draft');
});

test('does not activate a catalog course marked draft', async () => {
    const draftCatalog = {
        ...catalog,
        courses: [{ ...catalog.courses[0], status: 'draft' }]
    };
    const result = await activateCatalog({
        catalog: draftCatalog,
        courseIds: ['test-course'],
        settings,
        fetchImpl: async () => {
            throw new Error('network should not be reached');
        }
    });

    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'no_courses_selected');
});

test('refuses to activate before the first publish created products', async () => {
    const result = await activateCatalog({
        catalog,
        courseIds: ['test-course'],
        settings,
        fetchImpl: async () => response({ products: [] })
    });

    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'products_not_published');
    assert.deepEqual(result.missing, ['test-course']);
});
