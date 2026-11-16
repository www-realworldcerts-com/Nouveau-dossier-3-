import fs from 'node:fs';
import path from 'node:path';

import {
    adminGraphql,
    adminRequest,
    checkStorefrontGate,
    listProducts,
    redactToken,
    storefrontGraphql
} from './shopify.mjs';
import { loadCourseCatalog, priceInCurrency } from './course-catalog.mjs';
import { verifyPayPalPayoutAccount } from './paypal-payout-verification.mjs';

/**
 * Launch readiness is deliberately stricter than the self-setup audit.
 *
 * A shop can have products and a valid token while still being unable to take
 * money. This gate fails closed on the buyer path: scopes, currency, password
 * protection, payment provider, payouts, primary domain, collection membership
 * and a real Storefront checkout URL.
 */

export const LAUNCH_REQUIRED_SCOPES = [
    'read_products',
    'read_publications',
    'read_payment_gateways',
    'read_shopify_payments_accounts'
];

export function normalizeHost(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '')
        .replace(/^www\./, '');
}

function loadPayoutAttestation(settings) {
    if (settings.payoutAttestation && typeof settings.payoutAttestation === 'object') {
        return { value: settings.payoutAttestation, source: 'secret_store', error: null };
    }
    if (!settings.payoutAttestationFile) return { value: null, source: null, error: null };
    try {
        const file = path.resolve(String(settings.payoutAttestationFile));
        const stat = fs.statSync(file);
        if (!stat.isFile()) {
            throw new Error('attestation path is not a regular file');
        }
        if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
            return {
                value: null,
                source: 'file',
                error: `payout_attestation_permissions:${(stat.mode & 0o777).toString(8)}`
            };
        }
        return {
            value: JSON.parse(fs.readFileSync(file, 'utf8')),
            source: 'file',
            error: null
        };
    } catch (error) {
        return {
            value: null,
            source: 'file',
            error: `payout_attestation_unreadable:${error.message}`
        };
    }
}

function check(id, ok, reason, detail = {}) {
    return { id, ok: Boolean(ok), reason: ok ? null : reason, ...detail };
}

function gatewaySlug(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function maskPayoutDestination(value) {
    const destination = String(value || '').trim();
    if (!destination) return '***';
    const at = destination.lastIndexOf('@');
    if (at > 0 && at < destination.length - 1) {
        return `***@${destination.slice(at + 1)}`;
    }
    if (destination.length <= 4) return '***';
    return `${destination.slice(0, 2)}***${destination.slice(-2)}`;
}

function externalGatewayNames(paymentGateways) {
    return (Array.isArray(paymentGateways) ? paymentGateways : [])
        .map(gateway => String(gateway?.name || gateway?.service_name || '').trim())
        .filter(name => name && !gatewaySlug(name).includes('shopifypayments'));
}

const PAYOUT_ATTESTATION_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const PAYOUT_ATTESTATION_FUTURE_SKEW_MS = 5 * 60 * 1000;

function validatePayoutAttestation(attestation, externalGateways) {
    if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) {
        return { ok: false, reason: 'payout_attestation_required' };
    }

    const provider = String(attestation.provider || '').trim().toLowerCase();
    const destination = String(attestation.destination || '').trim();
    const attestedBy = String(attestation.attested_by || '').trim();
    const attestedAt = String(attestation.attested_at || '').trim();
    const missing = [
        !provider && 'provider',
        !destination && 'destination',
        !attestedBy && 'attested_by',
        !attestedAt && 'attested_at'
    ].filter(Boolean);
    if (missing.length) {
        return { ok: false, reason: 'payout_attestation_invalid', missing };
    }
    const attestedTime = Date.parse(attestedAt);
    if (Number.isNaN(attestedTime)) {
        return { ok: false, reason: 'payout_attestation_invalid', field: 'attested_at' };
    }
    const age = Date.now() - attestedTime;
    if (age > PAYOUT_ATTESTATION_MAX_AGE_MS) {
        return { ok: false, reason: 'payout_attestation_stale', attested_at: attestedAt };
    }
    if (age < -PAYOUT_ATTESTATION_FUTURE_SKEW_MS) {
        return { ok: false, reason: 'payout_attestation_future', attested_at: attestedAt };
    }

    const providerSlug = gatewaySlug(provider);
    const matchesGateway = externalGateways.some(name => {
        const nameSlug = gatewaySlug(name);
        return nameSlug.includes(providerSlug) || providerSlug.includes(nameSlug);
    });
    if (!matchesGateway) {
        return { ok: false, reason: 'payout_attestation_provider_mismatch', provider };
    }

    return { ok: true, provider, destination, attested_by: attestedBy, attested_at: attestedAt };
}

export function assessLaunchReadiness({
    shop = null,
    scopes = null,
    storefront = null,
    products = [],
    collection = null,
    collectionProductIds = [],
    paymentGateways = null,
    paymentsAccount = null,
    payoutAttestation = null,
    payoutAttestationError = null,
    payoutAttestationSource = null,
    paypalVerification = null,
    canary = null,
    expectedDomain = null,
    catalogCurrency = 'USD',
    storeCurrency = null,
    fx = null,
    selectedCourseIds = []
} = {}) {
    const checks = [];
    const blockers = [];
    const warnings = [];

    const selected = new Set(selectedCourseIds);
    const selectedProducts = selected.size
        ? products.filter(product => selected.has(product.handle))
        : products;
    const selectedCount = selectedProducts.length;

    if (!shop) {
        checks.push(check('shop', false, 'shop_unreachable'));
    } else {
        checks.push(check('shop', true, null, { currency: shop.currency || null }));
    }

    if (Array.isArray(scopes)) {
        const missing = LAUNCH_REQUIRED_SCOPES.filter(scope => !scopes.includes(scope));
        checks.push(check('scopes', missing.length === 0, missing.length ? `missing_scopes:${missing.join('|')}` : null, { missing }));
    } else {
        checks.push(check('scopes', false, 'scopes_unverified'));
    }

    const store = String(storeCurrency || shop?.currency || '').toUpperCase();
    if (!store) {
        checks.push(check('currency', false, 'currency_unavailable'));
    } else if (store !== catalogCurrency) {
        try {
            const conversion = priceInCurrency({ slug: 'reference', price_cents: 1900 }, store, fx);
            warnings.push(`currency_conversion:${catalogCurrency}->${store}@${conversion.rate}`);
            checks.push(check('currency', true, null, { store, catalog: catalogCurrency, conversion }));
        } catch (error) {
            checks.push(check('currency', false, `unsupported_currency:${store}`, { store, catalog: catalogCurrency }));
        }
    } else {
        checks.push(check('currency', true, null, { store, catalog: catalogCurrency, conversion: null }));
    }

    const gate = storefront?.password_gate || 'unknown';
    checks.push(check(
        'password_protection',
        gate === 'off',
        gate === 'on' ? 'password_protection_on' : gate === 'unknown' ? 'password_protection_unknown' : null,
        { gate }
    ));

    if (Array.isArray(paymentGateways)) {
        checks.push(check(
            'payments',
            paymentGateways.length > 0,
            paymentGateways.length ? null : 'no_payment_provider',
            { count: paymentGateways.length }
        ));
    } else {
        checks.push(check('payments', false, 'payments_unverified'));
    }

    const bankAccounts = paymentsAccount?.bankAccounts?.nodes || paymentsAccount?.bankAccounts || [];
    const externalGateways = externalGatewayNames(paymentGateways);
    const shopifyPayoutsReady = paymentsAccount?.activated === true
        && Array.isArray(bankAccounts)
        && bankAccounts.length > 0;

    if (shopifyPayoutsReady) {
        checks.push(check('payouts', true, null, {
            mode: 'shopify_payments',
            interval: paymentsAccount.payoutSchedule?.interval || null,
            bank_accounts: bankAccounts.length
        }));
    } else {
        const attestation = validatePayoutAttestation(payoutAttestation, externalGateways);
        if (attestation.ok) {
            const paypalProvider = gatewaySlug(attestation.provider).includes('paypal');
            const verification = paypalProvider ? paypalVerification : null;
            if (verification?.checked && !verification.ok) {
                checks.push(check('payouts', false, verification.reason || 'paypal_account_unverified', {
                    mode: 'external_attestation',
                    provider: attestation.provider,
                    destination: maskPayoutDestination(attestation.destination),
                    attestation_source: payoutAttestationSource || null,
                    paypal_verified: false,
                    ...(verification.status ? { status: verification.status } : {}),
                    ...(verification.error ? { error: verification.error } : {})
                }));
            } else {
                if (verification?.skipped) warnings.push('paypal_account_check_skipped');
                checks.push(check('payouts', true, null, {
                    mode: 'external_attestation',
                    provider: attestation.provider,
                    destination: maskPayoutDestination(attestation.destination),
                    attested_by: attestation.attested_by,
                    attested_at: attestation.attested_at,
                    attestation_source: payoutAttestationSource || null,
                    ...(paypalProvider
                        ? {
                            paypal_verified: verification?.checked === true,
                            ...(verification?.reason ? { paypal_verification: verification.reason } : {})
                        }
                        : {})
                }));
            }
        } else {
            let reason = attestation.reason;
            if (payoutAttestationError) {
                reason = payoutAttestationError.startsWith('payout_attestation_permissions')
                    ? 'payout_attestation_permissions'
                    : 'payout_attestation_unreadable';
            } else if (attestation.reason === 'payout_attestation_required' && !externalGateways.length) {
                if (!paymentsAccount) reason = 'payouts_unverified';
                else if (paymentsAccount.activated !== true) reason = 'payouts_not_activated';
                else reason = 'payouts_no_bank_account';
            }
            checks.push(check('payouts', false, reason, {
                external_gateways: externalGateways.slice(0, 10),
                attestation_source: payoutAttestationSource || null,
                ...(payoutAttestationError ? { error: payoutAttestationError } : {})
            }));
        }
    }

    const expected = normalizeHost(expectedDomain);
    const actual = normalizeHost(shop?.domain || '');
    const storefrontHost = normalizeHost(storefront?.final_url || storefront?.url || '');
    const domainMatches = Boolean(expected) && (actual === expected || storefrontHost === expected);
    checks.push(check(
        'domain',
        domainMatches,
        !expected ? 'domain_unverified' : `domain_mismatch:${expected}`,
        { expected, shop: actual || null, storefront: storefrontHost || null }
    ));

    if (!collection) {
        checks.push(check('collection_membership', false, 'collection_missing'));
    } else if (selectedProducts.length === 0) {
        checks.push(check('collection_membership', false, 'no_selected_products'));
    } else {
        const memberIds = new Set(collectionProductIds.map(value => String(value)));
        const missing = selectedProducts
            .filter(product => !memberIds.has(String(product.id)))
            .map(product => product.handle);
        checks.push(check(
            'collection_membership',
            missing.length === 0,
            missing.length ? `collection_missing_products:${missing.length}` : null,
            { selected: selectedCount, members: memberIds.size, missing: missing.slice(0, 20) }
        ));
    }

    if (canary?.skipped) {
        warnings.push('canary_checkout_skipped_dry_run');
    }
    checks.push(check(
        'canary_checkout',
        canary?.ok === true,
        canary?.ok ? null : `canary_checkout_failed:${canary?.reason || 'unknown'}`,
        canary || {}
    ));

    for (const row of checks) {
        if (!row.ok && row.reason) blockers.push(row.reason);
    }

    return {
        ready: blockers.length === 0,
        blockers: [...new Set(blockers)],
        warnings,
        checks,
        selected_count: selectedCount,
        product_count: products.length,
        currency: { catalog: catalogCurrency, store: store || null }
    };
}

export async function readCoursesCollection(settings, { fetchImpl }) {
    const payload = await adminRequest(settings, 'GET', 'custom_collections.json?handle=courses&limit=1', { fetchImpl });
    const collection = payload?.custom_collections?.[0] || null;
    if (!collection) return { collection: null, productIds: [] };

    const productIds = [];
    let sinceId = null;
    for (let page = 0; page < 20; page += 1) {
        const query = `collects.json?collection_id=${collection.id}&limit=250${sinceId ? `&since_id=${sinceId}` : ''}`;
        const batch = await adminRequest(settings, 'GET', query, { fetchImpl });
        const rows = batch?.collects || [];
        for (const row of rows) productIds.push(row.product_id);
        if (rows.length < 250) break;
        sinceId = rows[rows.length - 1].id;
    }
    return { collection, productIds };
}

async function readPaymentGateways(settings, { fetchImpl }) {
    const payload = await adminRequest(settings, 'GET', 'payment_gateways.json?disabled=false', { fetchImpl });
    return Array.isArray(payload?.payment_gateways)
        ? payload.payment_gateways.filter(gateway => gateway.disabled !== true)
        : [];
}

async function readPayouts(settings, { fetchImpl }) {
    const data = await adminGraphql(settings, `query LaunchPayouts {
        shopifyPaymentsAccount {
            activated
            payoutSchedule { interval }
            bankAccounts(first: 1) { nodes { id } }
        }
    }`, { fetchImpl });
    return data?.shopifyPaymentsAccount || null;
}

function moneyValue(value) {
    const amount = Number(value?.amount);
    return {
        amount: Number.isFinite(amount) ? amount : null,
        currency: String(value?.currencyCode || '').toUpperCase()
    };
}

function sameCents(left, right) {
    return Number.isFinite(left) && Number.isFinite(right)
        && Math.round(left * 100) === Math.round(right * 100);
}

async function runCanaryCheckout(settings, {
    domain,
    expectedDomain,
    product,
    storeCurrency,
    fetchImpl
}) {
    if (!settings.storefrontToken) {
        return { ok: false, reason: 'missing_storefront_token', mode: 'none' };
    }
    const variantId = product?.variants?.[0]?.id;
    if (!variantId) return { ok: false, reason: 'canary_variant_missing', mode: 'storefront_cart' };

    const variantGid = `gid://shopify/ProductVariant/${variantId}`;
    let variant;
    try {
        const data = await storefrontGraphql(settings, `query LaunchCanaryVariant($id: ID!) {
            productVariant(id: $id) {
                id
                availableForSale
                currentlyNotInStock
                quantityAvailable
                requiresShipping
                price { amount currencyCode }
                product { title handle }
            }
        }`, {
            variables: { id: variantGid },
            fetchImpl
        });
        variant = data?.productVariant;
    } catch (error) {
        return {
            ok: false,
            reason: `canary_variant_check_failed:${String(error.message || error).slice(0, 200)}`,
            mode: 'storefront_cart'
        };
    }
    if (!variant) {
        return { ok: false, reason: 'canary_variant_missing', mode: 'storefront_cart' };
    }
    if (variant.availableForSale !== true) {
        return {
            ok: false,
            reason: 'canary_variant_unavailable',
            mode: 'storefront_cart',
            available_for_sale: false
        };
    }
    if (variant.currentlyNotInStock === true) {
        return {
            ok: false,
            reason: 'canary_variant_out_of_stock',
            mode: 'storefront_cart',
            available_for_sale: true,
            currently_not_in_stock: true
        };
    }
    const quantityAvailable = Number.isInteger(variant.quantityAvailable)
        ? variant.quantityAvailable
        : null;
    if (quantityAvailable !== null && quantityAvailable < 1) {
        return {
            ok: false,
            reason: 'canary_variant_out_of_stock',
            mode: 'storefront_cart',
            available_for_sale: true,
            quantity_available: quantityAvailable
        };
    }
    const variantPrice = moneyValue(variant.price);
    if (!Number.isFinite(variantPrice.amount) || !variantPrice.currency) {
        return { ok: false, reason: 'canary_price_missing', mode: 'storefront_cart' };
    }
    const expectedCurrency = String(storeCurrency || variantPrice.currency).toUpperCase();
    if (variantPrice.currency !== expectedCurrency) {
        return {
            ok: false,
            reason: 'canary_currency_mismatch',
            mode: 'storefront_cart',
            expected_currency: expectedCurrency,
            actual_currency: variantPrice.currency
        };
    }
    if (variant.requiresShipping !== true && variant.requiresShipping !== false) {
        return { ok: false, reason: 'canary_shipping_unverified', mode: 'storefront_cart' };
    }

    const countryCode = String(settings.canaryCountryCode || 'US').trim().toUpperCase();
    let data;
    try {
        data = await storefrontGraphql(settings, `mutation LaunchCanary($input: CartInput!) {
            cartCreate(input: $input) {
                cart {
                    id
                    checkoutUrl
                    cost {
                        subtotalAmount { amount currencyCode }
                        totalAmount { amount currencyCode }
                        totalTaxAmount { amount currencyCode }
                    }
                    deliveryGroups(first: 5) {
                        nodes {
                            deliveryOptions {
                                handle
                                title
                                deliveryMethodType
                                estimatedCost { amount currencyCode }
                            }
                        }
                    }
                }
                userErrors { field message }
            }
        }`, {
            variables: {
                input: {
                    lines: [{ merchandiseId: variantGid, quantity: 1 }],
                    buyerIdentity: { countryCode }
                }
            },
            fetchImpl
        });
    } catch (error) {
        return {
            ok: false,
            reason: `cart_create:${String(error.message || error).slice(0, 200)}`,
            mode: 'storefront_cart'
        };
    }

    const payload = data?.cartCreate;
    const userErrors = payload?.userErrors || [];
    if (userErrors.length) {
        return {
            ok: false,
            reason: `cart_create:${userErrors.map(error => error.message).join('; ').slice(0, 200)}`,
            mode: 'storefront_cart'
        };
    }
    const cart = payload?.cart;
    const checkoutUrl = cart?.checkoutUrl;
    if (!checkoutUrl) return { ok: false, reason: 'checkout_url_missing', mode: 'storefront_cart' };

    const subtotal = moneyValue(cart.cost?.subtotalAmount);
    const total = moneyValue(cart.cost?.totalAmount);
    const tax = moneyValue(cart.cost?.totalTaxAmount);
    if (subtotal.amount === null || !subtotal.currency) {
        return { ok: false, reason: 'canary_subtotal_missing', mode: 'storefront_cart' };
    }
    if (total.amount === null || !total.currency) {
        return { ok: false, reason: 'canary_total_missing', mode: 'storefront_cart' };
    }
    if (tax.amount === null || !tax.currency) {
        return { ok: false, reason: 'canary_tax_missing', mode: 'storefront_cart' };
    }
    for (const money of [subtotal, total, tax]) {
        if (money.currency !== expectedCurrency) {
            return {
                ok: false,
                reason: 'canary_currency_mismatch',
                mode: 'storefront_cart',
                expected_currency: expectedCurrency,
                actual_currency: money.currency
            };
        }
    }
    if (!sameCents(subtotal.amount, variantPrice.amount)) {
        return {
            ok: false,
            reason: 'canary_subtotal_mismatch',
            mode: 'storefront_cart',
            expected_subtotal: variantPrice.amount,
            actual_subtotal: subtotal.amount,
            currency: expectedCurrency
        };
    }
    if (tax.amount < 0 || total.amount < subtotal.amount + tax.amount) {
        return {
            ok: false,
            reason: 'canary_total_mismatch',
            mode: 'storefront_cart',
            subtotal: subtotal.amount,
            tax: tax.amount,
            total: total.amount,
            currency: expectedCurrency
        };
    }

    const deliveryOptions = (cart.deliveryGroups?.nodes || [])
        .flatMap(group => group?.deliveryOptions || [])
        .map(option => ({
            title: option?.title || null,
            handle: option?.handle || null,
            method: option?.deliveryMethodType || null,
            cost: moneyValue(option?.estimatedCost)
        }))
        .filter(option => option.cost.amount !== null && option.cost.currency);
    if (variant.requiresShipping === true && deliveryOptions.length === 0) {
        return {
            ok: false,
            reason: 'canary_shipping_unavailable',
            mode: 'storefront_cart',
            country_code: countryCode,
            requires_shipping: true,
            shipping_options: 0
        };
    }
    if (deliveryOptions.some(option => option.cost.currency !== expectedCurrency)) {
        return {
            ok: false,
            reason: 'canary_currency_mismatch',
            mode: 'storefront_cart',
            expected_currency: expectedCurrency,
            actual_currency: deliveryOptions.find(option => option.cost.currency !== expectedCurrency)?.cost.currency || null
        };
    }

    let response;
    try {
        response = await fetchImpl(checkoutUrl, {
            method: 'GET',
            redirect: 'manual',
            signal: AbortSignal.timeout(15000)
        });
    } catch (error) {
        return { ok: false, reason: `checkout_unreachable:${error.message}`, mode: 'storefront_cart' };
    }
    let checkoutHost;
    try {
        checkoutHost = normalizeHost(new URL(checkoutUrl).hostname);
    } catch {
        return { ok: false, reason: 'checkout_url_invalid', mode: 'storefront_cart' };
    }
    const allowedHost = checkoutHost === normalizeHost(domain)
        || checkoutHost.endsWith('.shopify.com')
        || checkoutHost.endsWith('.myshopify.com')
        || checkoutHost === normalizeHost(expectedDomain);
    const httpOk = response.status >= 200 && response.status < 400;
    return {
        ok: httpOk && allowedHost,
        reason: !allowedHost ? 'checkout_host_mismatch' : `checkout_http_${response.status}`,
        mode: 'storefront_cart',
        http_status: response.status,
        checkout_host: checkoutHost,
        country_code: countryCode,
        available_for_sale: true,
        currently_not_in_stock: variant.currentlyNotInStock === true,
        quantity_available: quantityAvailable,
        requires_shipping: variant.requiresShipping,
        currency: expectedCurrency,
        subtotal,
        tax,
        total,
        shipping: {
            required: variant.requiresShipping,
            options: deliveryOptions.length,
            cheapest: deliveryOptions.length
                ? deliveryOptions.reduce((left, right) =>
                    left.cost.amount <= right.cost.amount ? left : right)
                : null
        }
    };
}

/**
 * Network-backed launch check. API failures become blockers instead of throws so
 * the CLI always returns the full checklist.
 */
export async function checkShopifyLaunchReadiness(settings, {
    catalog = loadCourseCatalog(),
    courseIds = null,
    fetchImpl = globalThis.fetch,
    dryRun = false,
    env = process.env,
    paypalAccessToken = null
} = {}) {
    const domain = String(settings.domain || '').trim().toLowerCase();
    const storefrontUrl = settings.storefrontUrl || 'https://www.realworldcerts.com';
    const catalogCourses = courseIds
        ? catalog.courses.filter(course => courseIds.includes(course.slug))
        : catalog.courses;
    const selectedCourseIds = catalogCourses.map(course => course.slug);
    const expectedDomain = settings.expectedDomain || new URL(storefrontUrl).hostname;
    const base = {
        generated_at: new Date().toISOString(),
        catalog_file: catalog.file,
        selected_count: selectedCourseIds.length,
        expected_domain: normalizeHost(expectedDomain)
    };

    if (!domain) {
        return {
            ...base,
            ready: false,
            blockers: ['invalid_shop_domain'],
            checks: [check('shop', false, 'invalid_shop_domain')],
            warnings: []
        };
    }
    if (!settings.token) {
        return {
            ...base,
            ready: false,
            blockers: ['missing_admin_token'],
            checks: [check('shop', false, 'missing_admin_token')],
            warnings: []
        };
    }

    const scoped = { ...settings, domain };
    let shop = null;
    let scopes = null;
    let products = [];
    let storefront = null;
    let collection = null;
    let collectionProductIds = [];
    let paymentGateways = null;
    let paymentsAccount = null;
    const errors = [];

    try {
        shop = (await adminRequest(scoped, 'GET', 'shop.json', { fetchImpl }))?.shop || null;
    } catch (error) {
        errors.push(`shop:${redactToken(error.message, settings.token)}`);
    }

    if (shop) {
        try {
            const payload = await adminRequest(scoped, 'GET', 'access_scopes.json', { fetchImpl });
            scopes = (payload?.access_scopes || []).map(row => row.handle).filter(Boolean);
        } catch (error) {
            errors.push(`scopes:${redactToken(error.message, settings.token)}`);
        }
        try {
            products = await listProducts(scoped, { fetchImpl });
        } catch (error) {
            errors.push(`products:${redactToken(error.message, settings.token)}`);
        }
        storefront = await checkStorefrontGate(scoped, { fetchImpl });
        try {
            const loaded = await readCoursesCollection(scoped, { fetchImpl });
            collection = loaded.collection;
            collectionProductIds = loaded.productIds;
        } catch (error) {
            errors.push(`collection:${redactToken(error.message, settings.token)}`);
        }
        try {
            paymentGateways = await readPaymentGateways(scoped, { fetchImpl });
        } catch (error) {
            errors.push(`payments:${redactToken(error.message, settings.token)}`);
        }
        try {
            paymentsAccount = await readPayouts(scoped, { fetchImpl });
        } catch (error) {
            errors.push(`payouts:${redactToken(error.message, settings.token)}`);
        }
    }

    const canaryCourse = catalogCourses.find(course => course.slug === (settings.canaryCourse || ''))
        || catalogCourses.find(course => String(course.status || 'active').toLowerCase() !== 'draft')
        || catalogCourses[0]
        || null;
    const canaryProduct = canaryCourse
        ? products.find(product => product.handle === canaryCourse.slug) || null
        : null;
    let canary = { ok: false, reason: 'canary_course_missing', mode: 'none' };
    if (dryRun) {
        canary = {
            ok: true,
            skipped: true,
            reason: 'canary_checkout_skipped_dry_run',
            mode: 'none'
        };
    } else if (canaryCourse && canaryProduct) {
        try {
            canary = await runCanaryCheckout(scoped, {
                domain,
                expectedDomain,
                product: canaryProduct,
                storeCurrency: shop?.currency || null,
                fetchImpl
            });
        } catch (error) {
            canary = { ok: false, reason: `canary_error:${redactToken(error.message, settings.storefrontToken)}`, mode: 'storefront_cart' };
        }
    } else if (canaryCourse && !canaryProduct) {
        canary = { ok: false, reason: 'canary_product_missing', mode: 'storefront_cart' };
    }

    const attestation = loadPayoutAttestation(settings);
    let paypalVerification = null;
    if (attestation.value && /paypal/i.test(String(attestation.value.provider || ''))) {
        try {
            paypalVerification = await verifyPayPalPayoutAccount({
                destination: attestation.value.destination,
                fetchImpl,
                env,
                accessToken: paypalAccessToken
            });
        } catch (error) {
            paypalVerification = {
                checked: true,
                ok: false,
                reason: 'paypal_account_unverified',
                error: redactToken(error.message, settings.token).slice(0, 200)
            };
        }
    }
    const assessment = assessLaunchReadiness({
        shop,
        scopes,
        storefront,
        products,
        collection,
        collectionProductIds,
        paymentGateways,
        paymentsAccount,
        payoutAttestation: attestation.value,
        payoutAttestationError: attestation.error,
        payoutAttestationSource: attestation.source,
        paypalVerification,
        canary,
        expectedDomain,
        catalogCurrency: catalog.currency,
        storeCurrency: shop?.currency || null,
        fx: catalog.fx,
        selectedCourseIds
    });

    return {
        ...base,
        ...assessment,
        storefront: storefront ? { ...storefront, expected_domain: normalizeHost(expectedDomain) } : null,
        collection: collection ? { id: collection.id, handle: collection.handle, product_count: collectionProductIds.length } : null,
        canary,
        warnings: [...assessment.warnings, ...errors.map(error => `api_error:${error}`)]
    };
}
