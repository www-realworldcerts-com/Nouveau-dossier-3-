import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    assessLaunchReadiness,
    checkShopifyLaunchReadiness,
    LAUNCH_REQUIRED_SCOPES
} from '../src/sales/shopify-launch-readiness.mjs';
import { verifyPayPalPayoutAccount } from '../src/sales/paypal-payout-verification.mjs';
import { launchSettingsFromArgs, parseArgs } from '../src/sales/shopify-launch-settings.mjs';

const SHOP = 'realworldcerts-test.myshopify.com';
const TOKEN = 'shpat_testtoken123';
const ATTESTED_AT = new Date().toISOString();
const catalog = {
    file: '/tmp/course-catalog.json',
    currency: 'USD',
    fx: { USD: 1, MAD: 10, EUR: 0.92 },
    courses: [{
        slug: 'test-course',
        title: 'Test Course',
        status: 'active',
        price_cents: 1900
    }]
};
const products = [{ id: 42, handle: 'test-course', variants: [{ id: 7, price: '19.00' }] }];

function response(body, status = 200, url = null) {
    return {
        ok: status < 400,
        status,
        url,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
        json: async () => (typeof body === 'string' ? JSON.parse(body) : body)
    };
}

function readyInput(overrides = {}) {
    return {
        shop: { currency: 'USD', domain: 'www.realworldcerts.com' },
        scopes: [...LAUNCH_REQUIRED_SCOPES],
        storefront: { password_gate: 'off', final_url: 'https://www.realworldcerts.com' },
        products,
        collection: { id: 99 },
        collectionProductIds: [42],
        paymentGateways: [{ id: 1, name: 'shopify_payments' }],
        paymentsAccount: {
            activated: true,
            payoutSchedule: { interval: 'DAILY' },
            bankAccounts: { nodes: [{ id: 1 }] }
        },
        canary: { ok: true, mode: 'storefront_cart', http_status: 200 },
        market: {
            country_code: 'US',
            country_name: 'United States',
            currency: 'USD',
            tax_inclusive: false,
            tax_source: 'shop'
        },
        expectedDomain: 'realworldcerts.com',
        catalogCurrency: 'USD',
        storeCurrency: 'USD',
        marketCurrency: 'USD',
        fx: catalog.fx,
        selectedCourseIds: ['test-course'],
        ...overrides
    };
}

test('requests only the read scopes the gate calls', () => {
    assert.deepEqual(LAUNCH_REQUIRED_SCOPES, [
        'read_products',
        'read_publications',
        'read_payment_gateways',
        'read_shopify_payments_accounts',
        'read_markets'
    ]);
});

test('passes a shop whose buyer path is complete', () => {
    const result = assessLaunchReadiness(readyInput());
    assert.equal(result.ready, true);
    assert.deepEqual(result.blockers, []);
    assert.ok(result.checks.every(row => row.ok));
    assert.equal(result.checks.find(row => row.id === 'payouts').mode, 'shopify_payments');
});

test('accepts an explicit owner attestation for an external payout provider', () => {
    const result = assessLaunchReadiness(readyInput({
        paymentsAccount: null,
        paymentGateways: [{ id: 2, name: 'paypal' }],
        payoutAttestation: {
            provider: 'paypal',
            destination: 'owner@example.com',
            attested_by: 'Store Owner',
            attested_at: ATTESTED_AT
        }
    }));

    assert.equal(result.ready, true, result.blockers.join(' '));
    const payouts = result.checks.find(row => row.id === 'payouts');
    assert.equal(payouts.mode, 'external_attestation');
    assert.equal(payouts.provider, 'paypal');
    assert.equal(payouts.destination, '***@example.com');
    assert.ok(!JSON.stringify(result).includes('owner@example.com'));
});

test('external payouts require a complete attestation that matches the configured provider', () => {
    const base = {
        paymentsAccount: null,
        paymentGateways: [{ id: 2, name: 'paypal' }]
    };
    const missing = assessLaunchReadiness(readyInput(base));
    assert.ok(missing.blockers.includes('payout_attestation_required'));

    const mismatch = assessLaunchReadiness(readyInput({
        ...base,
        payoutAttestation: {
            provider: 'stripe',
            destination: 'acct_123456789',
            attested_by: 'Store Owner',
            attested_at: ATTESTED_AT
        }
    }));
    assert.ok(mismatch.blockers.includes('payout_attestation_provider_mismatch'));

    const invalid = assessLaunchReadiness(readyInput({
        ...base,
        payoutAttestation: {
            provider: 'paypal',
            destination: 'owner@example.com',
            attested_by: 'Store Owner',
            attested_at: 'not-a-date'
        }
    }));
    assert.ok(invalid.blockers.includes('payout_attestation_invalid'));

    const incomplete = assessLaunchReadiness(readyInput({
        ...base,
        payoutAttestation: { provider: 'paypal', destination: 'owner@example.com' }
    }));
    assert.ok(incomplete.blockers.includes('payout_attestation_invalid'));
});

test('rejects stale and future external payout attestations', () => {
    const base = {
        paymentsAccount: null,
        paymentGateways: [{ id: 2, name: 'paypal' }]
    };
    const stale = assessLaunchReadiness(readyInput({
        ...base,
        payoutAttestation: {
            provider: 'paypal',
            destination: 'owner@example.com',
            attested_by: 'Store Owner',
            attested_at: new Date(Date.now() - 366 * 24 * 60 * 60 * 1000).toISOString()
        }
    }));
    assert.ok(stale.blockers.includes('payout_attestation_stale'));

    const future = assessLaunchReadiness(readyInput({
        ...base,
        payoutAttestation: {
            provider: 'paypal',
            destination: 'owner@example.com',
            attested_by: 'Store Owner',
            attested_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        }
    }));
    assert.ok(future.blockers.includes('payout_attestation_future'));
});

test('fails closed on each launch blocker', () => {
    const cases = [
        ['missing payment scope', { scopes: ['read_products'] }, /missing_scopes/],
        ['password gate', { storefront: { password_gate: 'on' } }, /password_protection_on/],
        ['unknown gate', { storefront: { password_gate: 'unknown' } }, /password_protection_unknown/],
        ['no payment gateway', { paymentGateways: [] }, /no_payment_provider/],
        ['unverified payments', { paymentGateways: null }, /payments_unverified/],
        ['payouts missing', { paymentsAccount: null }, /payouts_unverified/],
        ['payouts inactive', { paymentsAccount: { activated: false, bankAccounts: { nodes: [] } } }, /payouts_not_activated/],
        ['no payout bank', { paymentsAccount: { activated: true, bankAccounts: { nodes: [] } } }, /payouts_no_bank_account/],
        ['wrong domain', {
            shop: { currency: 'USD', domain: 'other.myshopify.com' },
            storefront: { password_gate: 'off', final_url: 'https://other.myshopify.com/' }
        }, /domain_mismatch/],
        ['collection missing product', { collectionProductIds: [] }, /collection_missing_products/],
        ['no collection', { collection: null }, /collection_missing/],
        ['canary failed', { canary: { ok: false, reason: 'missing_storefront_token' } }, /missing_storefront_token/]
    ];
    for (const [name, overrides, reason] of cases) {
        const result = assessLaunchReadiness(readyInput(overrides));
        assert.equal(result.ready, false, name);
        assert.match(result.blockers.join(' '), reason, name);
    }
});

function money(amount, currency = 'USD') {
    return { amount: String(amount), currencyCode: currency };
}

function launchFetch({
    storefrontToken = true,
    payments = true,
    payouts = true,
    paymentProvider = 'shopify_payments',
    paypalAccount = null,
    variant = {},
    cart = {},
    market = true,
    marketCurrency = 'USD',
    marketCountry = 'US',
    marketCountryName = 'United States',
    taxInclusive = false,
    marketTaxStrategy = null
} = {}) {
    return async (url, options = {}) => {
        const target = String(url);
        if (target.includes('/shop.json')) {
            return response({ shop: { name: 'RealWorldCerts', currency: 'USD', domain: 'www.realworldcerts.com' } });
        }
        if (target.includes('/v1/identity/oauth2/userinfo')) {
            return paypalAccount
                ? response({
                    email: paypalAccount.email || null,
                    payer_id: paypalAccount.payer_id || null,
                    user_id: paypalAccount.user_id || null
                })
                : response({}, 404);
        }
        if (target.includes('/access_scopes.json')) {
            return response({ access_scopes: LAUNCH_REQUIRED_SCOPES.map(handle => ({ handle })) });
        }
        if (target.includes('/products.json')) return response({ products });
        if (target.includes('/custom_collections.json')) {
            return response({ custom_collections: [{ id: 99, handle: 'courses' }] });
        }
        if (target.includes('/collects.json')) {
            return response({ collects: [{ id: 1, product_id: 42 }] });
        }
        if (target.includes('/payment_gateways.json')) {
            return payments
                ? response({ payment_gateways: [{ id: 1, name: paymentProvider }] })
                : response({ payment_gateways: [] });
        }
        if (target.includes('/admin/api/') && target.includes('/graphql.json')) {
            const body = options.body ? JSON.parse(options.body) : {};
            const query = String(body.query || '');
            if (query.includes('LaunchMarketContext')) {
                return response({
                    data: {
                        shop: {
                            currencyCode: marketCurrency,
                            taxesIncluded: taxInclusive,
                            taxShipping: false
                        },
                        primaryMarket: market
                            ? {
                                id: 'gid://shopify/Market/1',
                                name: 'Primary',
                                currencySettings: {
                                    baseCurrency: { currencyCode: marketCurrency },
                                    localCurrencies: false
                                },
                                regions: {
                                    nodes: [{ code: marketCountry, name: marketCountryName }]
                                },
                                ...(marketTaxStrategy
                                    ? { priceInclusions: { inclusiveTaxPricingStrategy: marketTaxStrategy } }
                                    : {})
                            }
                            : null
                    }
                });
            }
            return payouts
                ? response({
                    data: {
                        shopifyPaymentsAccount: {
                            activated: true,
                            payoutSchedule: { interval: 'DAILY' },
                            bankAccounts: { nodes: [{ id: 1 }] }
                        }
                    }
                })
                : response({ data: { shopifyPaymentsAccount: null } });
        }
        if (target.includes('/api/') && target.includes('/graphql.json')) {
            if (!storefrontToken) return response({}, 401);
            const body = options.body ? JSON.parse(options.body) : {};
            const query = String(body.query || '');
            if (query.includes('LaunchCanaryVariant')) {
                return response({
                    data: {
                        productVariant: {
                            id: 'gid://shopify/ProductVariant/7',
                            availableForSale: variant.availableForSale ?? true,
                            currentlyNotInStock: variant.currentlyNotInStock ?? false,
                            quantityAvailable: variant.quantityAvailable === undefined
                                ? 5
                                : variant.quantityAvailable,
                            requiresShipping: variant.requiresShipping ?? false,
                            price: variant.price || money('19.00', marketCurrency),
                            product: { title: 'Test Course', handle: 'test-course' }
                        }
                    }
                });
            }
            const deliveryOptions = cart.deliveryOptions || [];
            return response({
                data: {
                    cartCreate: {
                        cart: {
                            id: 'gid://shopify/Cart/1',
                            checkoutUrl: 'https://checkout.shopify.com/canary',
                            cost: {
                                subtotalAmount: cart.subtotal || money('19.00', marketCurrency),
                                totalAmount: cart.total || money('19.00', marketCurrency),
                                totalTaxAmount: cart.tax || money('0.00', marketCurrency)
                            },
                            deliveryGroups: {
                                nodes: deliveryOptions.length
                                    ? [{ deliveryOptions }]
                                    : []
                            }
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
}

function settings(overrides = {}) {
    return {
        domain: SHOP,
        token: TOKEN,
        apiVersion: '2024-10',
        storefrontUrl: 'https://www.realworldcerts.com',
        storefrontToken: 'public-storefront-token',
        expectedDomain: 'realworldcerts.com',
        canaryCourse: 'test-course',
        canaryAddress1: '1 Test Street',
        canaryCity: 'New York',
        canaryProvinceCode: 'NY',
        canaryPostalCode: '10001',
        ...overrides
    };
}

test('runs the full network gate and creates a canary checkout URL', async () => {
    const result = await checkShopifyLaunchReadiness(settings(), {
        catalog,
        fetchImpl: launchFetch()
    });
    assert.equal(result.ready, true, JSON.stringify(result.blockers));
    assert.equal(result.canary.mode, 'storefront_cart');
    assert.equal(result.canary.http_status, 200);
    assert.equal(result.canary.currency, 'USD');
    assert.equal(result.canary.address.country_code, 'US');
    assert.equal(result.canary.address.province_code, 'NY');
    assert.equal(result.canary.address.postal_code, '10001');
    assert.equal(result.collection.product_count, 1);
    assert.ok(result.checks.every(row => row.ok));
});

test('reports missing Storefront token instead of claiming canary success', async () => {
    const result = await checkShopifyLaunchReadiness(settings({ storefrontToken: '' }), {
        catalog,
        fetchImpl: launchFetch({ storefrontToken: false })
    });
    assert.equal(result.ready, false);
    assert.ok(result.blockers.includes('missing_storefront_token'));
});

test('canary blocks an unavailable or out-of-stock variant', async () => {
    const unavailable = await checkShopifyLaunchReadiness(settings(), {
        catalog,
        fetchImpl: launchFetch({ variant: { availableForSale: false } })
    });
    assert.ok(unavailable.blockers.includes('canary_variant_unavailable'));

    const outOfStock = await checkShopifyLaunchReadiness(settings(), {
        catalog,
        fetchImpl: launchFetch({ variant: { currentlyNotInStock: true } })
    });
    assert.ok(outOfStock.blockers.includes('canary_variant_out_of_stock'));

    const zeroInventory = await checkShopifyLaunchReadiness(settings(), {
        catalog,
        fetchImpl: launchFetch({ variant: { quantityAvailable: 0 } })
    });
    assert.ok(zeroInventory.blockers.includes('canary_variant_out_of_stock'));
});

test('canary requires a shipping option when the variant needs shipping', async () => {
    const noShipping = await checkShopifyLaunchReadiness(settings(), {
        catalog,
        fetchImpl: launchFetch({ variant: { requiresShipping: true } })
    });
    assert.ok(noShipping.blockers.includes('canary_shipping_unavailable'));

    const withShipping = await checkShopifyLaunchReadiness(settings(), {
        catalog,
        fetchImpl: launchFetch({
            variant: { requiresShipping: true },
            cart: {
                deliveryOptions: [{
                    handle: 'standard',
                    title: 'Standard',
                    deliveryMethodType: 'SHIPPING',
                    estimatedCost: money('4.00')
                }]
            }
        })
    });
    assert.equal(withShipping.ready, true, withShipping.blockers.join(' '));
    assert.equal(withShipping.canary.shipping.options, 1);
});

test('canary validates currency, tax and totals', async () => {
    const wrongCurrency = await checkShopifyLaunchReadiness(settings(), {
        catalog,
        fetchImpl: launchFetch({
            variant: { price: money('19.00', 'EUR') }
        })
    });
    assert.ok(wrongCurrency.blockers.includes('canary_currency_mismatch'));

    const missingTax = await checkShopifyLaunchReadiness(settings(), {
        catalog,
        fetchImpl: launchFetch({ cart: { tax: {} } })
    });
    assert.ok(missingTax.blockers.includes('canary_tax_missing'));

    const badSubtotal = await checkShopifyLaunchReadiness(settings(), {
        catalog,
        fetchImpl: launchFetch({ cart: { subtotal: money('20.00') } })
    });
    assert.ok(badSubtotal.blockers.includes('canary_subtotal_mismatch'));

    const badTotal = await checkShopifyLaunchReadiness(settings(), {
        catalog,
        fetchImpl: launchFetch({ cart: { total: money('18.00') } })
    });
    assert.ok(badTotal.blockers.includes('canary_total_mismatch'));
});

test('canary uses the primary market currency and requires a full address', async () => {
    const euro = await checkShopifyLaunchReadiness(settings(), {
        catalog,
        fetchImpl: launchFetch({
            marketCurrency: 'EUR',
            variant: { price: money('19.00', 'EUR') }
        })
    });
    assert.equal(euro.ready, true, euro.blockers.join(' '));
    assert.equal(euro.canary.currency, 'EUR');
    assert.equal(euro.market.currency, 'EUR');

    const incomplete = await checkShopifyLaunchReadiness(settings({ canaryProvinceCode: '' }), {
        catalog,
        fetchImpl: launchFetch()
    });
    assert.ok(incomplete.blockers.includes('canary_address_incomplete'));
    assert.deepEqual(incomplete.canary.missing, ['province']);
});

test('canary applies the primary market tax mode to the total check', async () => {
    const inclusive = await checkShopifyLaunchReadiness(settings(), {
        catalog,
        fetchImpl: launchFetch({
            taxInclusive: true,
            cart: { tax: money('1.00'), total: money('19.00') }
        })
    });
    assert.equal(inclusive.ready, true, inclusive.blockers.join(' '));
    assert.equal(inclusive.canary.tax_inclusive, true);

    const exclusive = await checkShopifyLaunchReadiness(settings(), {
        catalog,
        fetchImpl: launchFetch({
            cart: { tax: money('1.00'), total: money('19.00') }
        })
    });
    assert.ok(exclusive.blockers.includes('canary_total_mismatch'));
});

test('uses the market tax inclusion strategy when the API supports it', async () => {
    const result = await checkShopifyLaunchReadiness(settings({ apiVersion: '2026-10' }), {
        catalog,
        fetchImpl: launchFetch({
            marketTaxStrategy: 'INCLUDES_TAXES_IN_PRICE',
            cart: { tax: money('1.00'), total: money('19.00') }
        })
    });
    assert.equal(result.ready, true, result.blockers.join(' '));
    assert.equal(result.canary.tax_inclusive, true);
    assert.equal(result.canary.tax_source, 'market');
});

test('blocks when the primary market cannot be resolved', async () => {
    const result = await checkShopifyLaunchReadiness(settings(), {
        catalog,
        fetchImpl: launchFetch({ market: false })
    });
    assert.equal(result.ready, false);
    assert.ok(result.blockers.includes('primary_market_unavailable'));
});

test('reports payment and payout gaps as blockers', async () => {
    const noPayments = await checkShopifyLaunchReadiness(settings(), {
        catalog,
        fetchImpl: launchFetch({ payments: false })
    });
    assert.ok(noPayments.blockers.includes('no_payment_provider'));

    const noPayouts = await checkShopifyLaunchReadiness(settings(), {
        catalog,
        fetchImpl: launchFetch({ payouts: false })
    });
    assert.ok(noPayouts.blockers.includes('payouts_unverified'));
});

const LAUNCH_ENV = {
    SHOPIFY_STORE_DOMAIN: SHOP,
    SHOPIFY_ADMIN_TOKEN: TOKEN,
    SHOPIFY_STOREFRONT_URL: 'https://www.realworldcerts.com',
    SHOPIFY_STOREFRONT_ACCESS_TOKEN: 'public-storefront-token',
    SHOPIFY_PRIMARY_DOMAIN: 'realworldcerts.com',
    SHOPIFY_CANARY_COURSE: 'test-course',
    SHOPIFY_CANARY_ADDRESS1: '1 Test Street',
    SHOPIFY_CANARY_CITY: 'New York',
    SHOPIFY_CANARY_PROVINCE_CODE: 'NY',
    SHOPIFY_CANARY_POSTAL_CODE: '10001'
};
const PAYPAL_ATTESTATION = {
    provider: 'paypal',
    destination: 'owner@example.com',
    attested_by: 'Store Owner',
    attested_at: ATTESTED_AT
};

function attestationFixture(t, content, mode = 0o600) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shopify-attestation-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'payout-attestation.json');
    fs.writeFileSync(file, content, { mode });
    if (process.platform !== 'win32') fs.chmodSync(file, mode);
    return { dir, file };
}

test('loads SHOPIFY_PAYOUT_ATTESTATION_FILE through the gate', async (t) => {
    const { file } = attestationFixture(t, JSON.stringify(PAYPAL_ATTESTATION));
    const settings = launchSettingsFromArgs({}, {
        ...LAUNCH_ENV,
        SHOPIFY_PAYOUT_ATTESTATION_FILE: file
    });
    const result = await checkShopifyLaunchReadiness(settings, {
        catalog,
        fetchImpl: launchFetch({ payouts: false, paymentProvider: 'paypal' })
    });

    assert.equal(result.ready, true, result.blockers.join(' '));
    assert.equal(result.checks.find(row => row.id === 'payouts').mode, 'external_attestation');
});

test('loads --payout-attestation through the gate', async (t) => {
    const { file } = attestationFixture(t, JSON.stringify(PAYPAL_ATTESTATION));
    const flags = parseArgs(['--payout-attestation', file]);
    const settings = launchSettingsFromArgs(flags, LAUNCH_ENV);
    const result = await checkShopifyLaunchReadiness(settings, {
        catalog,
        fetchImpl: launchFetch({ payouts: false, paymentProvider: 'paypal' })
    });

    assert.equal(result.ready, true, result.blockers.join(' '));
    assert.equal(result.checks.find(row => row.id === 'payouts').mode, 'external_attestation');
});

test('rejects attestation files readable by group or others', async (t) => {
    const { file } = attestationFixture(t, JSON.stringify(PAYPAL_ATTESTATION), 0o644);
    const insecure = launchSettingsFromArgs({}, {
        ...LAUNCH_ENV,
        SHOPIFY_PAYOUT_ATTESTATION_FILE: file
    });
    const result = await checkShopifyLaunchReadiness(insecure, {
        catalog,
        fetchImpl: launchFetch({ payouts: false, paymentProvider: 'paypal' })
    });
    assert.equal(result.ready, false);
    assert.ok(result.blockers.includes('payout_attestation_permissions'));
});

test('missing or unreadable payout attestation files block as unreadable', async (t) => {
    const { dir, file } = attestationFixture(t, '{not json');
    const missing = launchSettingsFromArgs({}, {
        ...LAUNCH_ENV,
        SHOPIFY_PAYOUT_ATTESTATION_FILE: path.join(dir, 'missing.json')
    });
    const missingResult = await checkShopifyLaunchReadiness(missing, {
        catalog,
        fetchImpl: launchFetch({ payouts: false, paymentProvider: 'paypal' })
    });
    assert.ok(missingResult.blockers.includes('payout_attestation_unreadable'));

    const unreadable = launchSettingsFromArgs({}, {
        ...LAUNCH_ENV,
        SHOPIFY_PAYOUT_ATTESTATION_FILE: file
    });
    const unreadableResult = await checkShopifyLaunchReadiness(unreadable, {
        catalog,
        fetchImpl: launchFetch({ payouts: false, paymentProvider: 'paypal' })
    });
    assert.ok(unreadableResult.blockers.includes('payout_attestation_unreadable'));
});

test('PayPal account verification skips without credentials and checks configured credentials', async () => {
    const skipped = await verifyPayPalPayoutAccount({
        destination: 'owner@example.com',
        env: {},
        fetchImpl: async () => {
            throw new Error('network should not be reached without credentials');
        }
    });
    assert.equal(skipped.checked, false);
    assert.equal(skipped.skipped, true);

    const calls = [];
    const verified = await verifyPayPalPayoutAccount({
        destination: 'OWNER@example.com',
        env: {
            PAYPAL_CLIENT_ID: 'client-id',
            PAYPAL_CLIENT_SECRET: 'client-secret'
        },
        apiBaseUrl: 'https://api.paypal.test',
        fetchImpl: async (url) => {
            calls.push(String(url));
            if (String(url).includes('/v1/oauth2/token')) {
                return response({ access_token: 'test-token', expires_in: 3600 });
            }
            return response({ email: 'owner@example.com', payer_id: 'PAYER123' });
        }
    });
    assert.equal(verified.checked, true);
    assert.equal(verified.ok, true);
    assert.ok(calls[0].includes('/v1/oauth2/token'));
    assert.ok(calls[1].includes('/v1/identity/oauth2/userinfo'));
});

test('passes the network gate with a PayPal owner attestation and no Shopify Payments account', async () => {
    const result = await checkShopifyLaunchReadiness(settings({
        payoutAttestation: {
            provider: 'paypal',
            destination: 'owner@example.com',
            attested_by: 'Store Owner',
            attested_at: ATTESTED_AT
        }
    }), {
        catalog,
        fetchImpl: launchFetch({ payouts: false, paymentProvider: 'paypal' })
    });

    assert.equal(result.ready, true, result.blockers.join(' '));
    const payouts = result.checks.find(row => row.id === 'payouts');
    assert.equal(payouts.mode, 'external_attestation');
    assert.equal(payouts.attestation_source, 'secret_store');
});

test('verifies a PayPal attestation against the authenticated account', async () => {
    const result = await checkShopifyLaunchReadiness(settings({
        payoutAttestation: {
            provider: 'paypal',
            destination: 'owner@example.com',
            attested_by: 'Store Owner',
            attested_at: ATTESTED_AT
        },
        paypalAccessToken: 'test-paypal-token'
    }), {
        catalog,
        fetchImpl: launchFetch({
            payouts: false,
            paymentProvider: 'paypal',
            paypalAccount: { email: 'OWNER@example.com', payer_id: 'PAYER123' }
        }),
        paypalAccessToken: 'test-paypal-token',
        env: {}
    });

    assert.equal(result.ready, true, result.blockers.join(' '));
    const payouts = result.checks.find(row => row.id === 'payouts');
    assert.equal(payouts.paypal_verified, true);
});

test('blocks a PayPal attestation when the authenticated account differs', async () => {
    const result = await checkShopifyLaunchReadiness(settings({
        payoutAttestation: {
            provider: 'paypal',
            destination: 'owner@example.com',
            attested_by: 'Store Owner',
            attested_at: ATTESTED_AT
        }
    }), {
        catalog,
        fetchImpl: launchFetch({
            payouts: false,
            paymentProvider: 'paypal',
            paypalAccount: { email: 'other@example.com' }
        }),
        paypalAccessToken: 'test-paypal-token',
        env: {}
    });

    assert.equal(result.ready, false);
    assert.ok(result.blockers.includes('paypal_account_mismatch'));
});

test('blocks a configured PayPal check that cannot verify the account', async () => {
    const result = await checkShopifyLaunchReadiness(settings({
        payoutAttestation: {
            provider: 'paypal',
            destination: 'owner@example.com',
            attested_by: 'Store Owner',
            attested_at: ATTESTED_AT
        }
    }), {
        catalog,
        fetchImpl: launchFetch({ payouts: false, paymentProvider: 'paypal' }),
        paypalAccessToken: 'test-paypal-token',
        env: {}
    });

    assert.equal(result.ready, false);
    assert.ok(result.blockers.includes('paypal_account_unverified'));
});

test('blocks the network gate when PayPal has no owner attestation', async () => {
    const result = await checkShopifyLaunchReadiness(settings(), {
        catalog,
        fetchImpl: launchFetch({ payouts: false, paymentProvider: 'paypal' })
    });

    assert.equal(result.ready, false);
    assert.ok(result.blockers.includes('payout_attestation_required'));
});
