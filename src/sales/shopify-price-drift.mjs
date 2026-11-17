import { loadCourseCatalog } from './course-catalog.mjs';
import { validateVariantPrices } from './shopify-activation.mjs';
import { getShopCurrency, listProducts, shopifySettingsFromEnv } from './shopify.mjs';

/**
 * Read-only price-drift audit.
 *
 * Compares three independently produced price views:
 *   - the canonical catalog (`config/course-catalog.json`, USD cents);
 *   - the public checkout payload served at `/data/store-prices.json`;
 *   - live Shopify product/variant prices in the store currency.
 *
 * This module only performs GET requests. It never creates, updates or
 * activates a product, and it never changes a price.
 */

const CHECKOUT_PATH = '/data/store-prices.json';

function normalizeCurrency(value) {
    return String(value || '').trim().toUpperCase();
}

function normalizeCheckoutPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Checkout payload must be a JSON object');
    }
    const currency = normalizeCurrency(payload.currency);
    if (!currency) throw new Error('Checkout payload is missing its currency');
    if (!payload.prices || typeof payload.prices !== 'object' || Array.isArray(payload.prices)) {
        throw new Error('Checkout payload is missing its prices object');
    }
    return { currency, prices: payload.prices };
}

async function fetchCheckoutPayload(url, fetchImpl, timeoutMs) {
    if (!url) throw new Error('No checkout payload URL was provided');
    let response;
    try {
        response = await fetchImpl(url, {
            method: 'GET',
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(timeoutMs)
        });
    } catch (error) {
        throw new Error(`Checkout payload request failed: ${error.message}`);
    }
    const text = await response.text();
    if (!response.ok) {
        throw new Error(`Checkout payload HTTP ${response.status}: ${String(text || '').slice(0, 300)}`);
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new Error('Checkout payload is not valid JSON');
    }
}

function checkoutDrift(catalog, payload) {
    const drift = [];
    const expectedCurrency = normalizeCurrency(catalog.currency);
    if (payload.currency !== expectedCurrency) {
        drift.push({
            source: 'checkout',
            reason: 'currency_mismatch',
            expected: expectedCurrency,
            actual: payload.currency
        });
    }

    const seen = new Set();
    for (const course of catalog.courses) {
        seen.add(course.slug);
        const raw = payload.prices[course.slug];
        const actual = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
        if (!Number.isFinite(actual)) {
            drift.push({
                source: 'checkout',
                course_id: course.slug,
                reason: 'missing_checkout_price',
                expected: {
                    amount: course.price_cents / 100,
                    currency: expectedCurrency
                },
                actual: null
            });
            continue;
        }
        const actualCents = Math.round(actual * 100);
        if (actualCents !== course.price_cents) {
            drift.push({
                source: 'checkout',
                course_id: course.slug,
                reason: 'price_mismatch',
                expected: {
                    amount: course.price_cents / 100,
                    currency: expectedCurrency
                },
                actual: {
                    amount: actual,
                    currency: payload.currency
                }
            });
        }
    }

    for (const slug of Object.keys(payload.prices)) {
        if (!seen.has(slug)) {
            const amount = Number(payload.prices[slug]);
            drift.push({
                source: 'checkout',
                course_id: slug,
                reason: 'unknown_checkout_course',
                expected: null,
                actual: {
                    amount: Number.isFinite(amount) ? amount : null,
                    currency: payload.currency
                }
            });
        }
    }

    return drift;
}

function shopifyDrift(catalog, products, storeCurrency) {
    const drift = [];
    const byHandle = new Map();
    for (const product of products) {
        const handle = String(product?.handle || '').trim();
        if (handle && !byHandle.has(handle)) byHandle.set(handle, product);
    }

    const selectedProducts = [];
    for (const course of catalog.courses) {
        const handle = course.shopify_handle || course.slug;
        const product = byHandle.get(handle);
        if (!product) {
            drift.push({
                source: 'shopify',
                course_id: course.slug,
                handle,
                reason: 'product_missing',
                expected: {
                    amount: course.price_cents / 100,
                    currency: normalizeCurrency(catalog.currency)
                },
                actual: null
            });
            continue;
        }
        selectedProducts.push({ course, product });
    }

    const validation = validateVariantPrices(selectedProducts, {
        storeCurrency,
        fx: catalog.fx
    });
    for (const mismatch of validation.mismatches) {
        const course = catalog.bySlug[mismatch.course_id];
        const product = selectedProducts.find(row => row.course.slug === mismatch.course_id)?.product;
        drift.push({
            source: 'shopify',
            course_id: mismatch.course_id,
            handle: course?.shopify_handle || course?.slug || null,
            product_id: mismatch.product_id ?? product?.id ?? null,
            variant_id: mismatch.variant_id ?? null,
            reason: mismatch.reason,
            ...(mismatch.source ? { detail_source: mismatch.source } : {}),
            ...(mismatch.expected !== undefined ? { expected: mismatch.expected } : {}),
            ...(mismatch.actual !== undefined ? { actual: mismatch.actual } : {}),
            ...(mismatch.currency ? { currency: mismatch.currency } : {}),
            ...(mismatch.expected === undefined && course
                ? { expected: { amount: course.price_cents / 100, currency: normalizeCurrency(catalog.currency) } }
                : {}),
            ...(mismatch.error ? { error: mismatch.error } : {})
        });
    }

    return {
        drift,
        checked_products: selectedProducts.length,
        checked_variants: validation.checked_variants,
        store_currency: validation.store_currency
    };
}

function buildFinding(report) {
    if (report.status === 'drift') {
        const preview = report.drift.slice(0, 3).map(row =>
            `${row.source}:${row.course_id || 'catalog'} ${row.reason}`
        ).join('; ');
        const suffix = report.drift.length > 3 ? ` (+${report.drift.length - 3} more)` : '';
        return {
            code: 'SHOPIFY_PRICE_DRIFT',
            severity: 'high',
            detail: `${report.drift.length} price divergence(s) between the catalog, checkout and Shopify: ${preview}${suffix}`,
            evidence: {
                checked_at: report.checked_at,
                catalog_file: report.catalog_file,
                store_currency: report.store_currency,
                checkout_url: report.checkout.url,
                checked: report.checked,
                drift_count: report.drift.length,
                drift: report.drift,
                unavailable: report.unavailable
            }
        };
    }
    if (report.status === 'unavailable') {
        return {
            code: 'SHOPIFY_PRICE_DRIFT_UNCHECKED',
            severity: 'medium',
            detail: `Price drift could not be checked: ${report.unavailable.join('; ')}`,
            evidence: {
                checked_at: report.checked_at,
                catalog_file: report.catalog_file,
                store_currency: report.store_currency,
                checkout_url: report.checkout.url,
                checked: report.checked,
                unavailable: report.unavailable
            }
        };
    }
    return null;
}

export function resolveCheckoutUrl(settings = shopifySettingsFromEnv(), override = null) {
    if (override) return String(override);
    const base = String(settings.storefrontUrl || '').replace(/\/+$/, '');
    return base ? `${base}${CHECKOUT_PATH}` : null;
}

export async function auditShopifyPriceDrift({
    catalog,
    catalogFile,
    settings = shopifySettingsFromEnv(),
    checkoutPayload,
    checkoutUrl = resolveCheckoutUrl(settings),
    fetchImpl = globalThis.fetch,
    timeoutMs = 15000
} = {}) {
    const canonical = catalog || loadCourseCatalog(catalogFile);
    const unavailable = [];
    let checkout = { url: checkoutUrl || null, currency: null, count: 0 };
    let payload = null;

    if (checkoutPayload !== undefined && checkoutPayload !== null) {
        payload = normalizeCheckoutPayload(checkoutPayload);
    } else {
        try {
            payload = normalizeCheckoutPayload(await fetchCheckoutPayload(checkoutUrl, fetchImpl, timeoutMs));
        } catch (error) {
            unavailable.push(`checkout_unavailable: ${error.message}`);
        }
    }
    if (payload) {
        checkout = {
            url: checkout.url,
            currency: payload.currency,
            count: Object.keys(payload.prices).length
        };
    }

    const drift = payload ? checkoutDrift(canonical, payload) : [];
    let shopify = {
        checked_products: 0,
        checked_variants: 0,
        store_currency: null
    };

    if (!settings.domain || !settings.token) {
        unavailable.push('missing_shopify_admin_credentials');
    } else {
        try {
            const storeCurrency = await getShopCurrency(settings, { fetchImpl });
            const products = await listProducts(settings, { fetchImpl });
            const checked = shopifyDrift(canonical, products, storeCurrency);
            drift.push(...checked.drift);
            shopify = {
                checked_products: checked.checked_products,
                checked_variants: checked.checked_variants,
                store_currency: checked.store_currency
            };
        } catch (error) {
            unavailable.push(`shopify_unavailable: ${error.message}`);
        }
    }

    const status = drift.length ? 'drift' : (unavailable.length ? 'unavailable' : 'ok');
    const report = {
        read_only: true,
        status,
        checked_at: new Date().toISOString(),
        catalog_file: canonical.file || catalogFile || null,
        catalog_currency: normalizeCurrency(canonical.currency),
        store_currency: shopify.store_currency,
        checkout,
        checked: {
            catalog_courses: canonical.courses.length,
            checkout_prices: checkout.count,
            shopify_products: shopify.checked_products,
            shopify_variants: shopify.checked_variants
        },
        drift,
        unavailable
    };
    return {
        ...report,
        finding: buildFinding(report)
    };
}
