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
 * Only a comparable amount that differs is price drift. Missing FX rates,
 * missing listings, currency gaps and unreadable sources are reported as
 * unchecked, never as a high-severity divergence. Drift is grouped by course so
 * a variant and its presentment price do not become duplicate findings.
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

function withCacheBuster(url, nonce) {
    try {
        const parsed = new URL(url);
        parsed.searchParams.set('_price_audit', nonce);
        return parsed.toString();
    } catch {
        return `${url}${url.includes('?') ? '&' : '?'}_price_audit=${encodeURIComponent(nonce)}`;
    }
}

function headerValue(headers, name) {
    if (!headers) return null;
    if (typeof headers.get === 'function') return headers.get(name);
    const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name);
    return key ? headers[key] : null;
}

function cacheSummary(headers) {
    const summary = {};
    for (const [key, name] of Object.entries({
        age: 'age',
        cache_control: 'cache-control',
        etag: 'etag',
        x_vercel_cache: 'x-vercel-cache',
        x_cache: 'x-cache',
        via: 'via'
    })) {
        const value = headerValue(headers, name);
        if (value !== null && value !== undefined && value !== '') summary[key] = String(value);
    }
    return summary;
}

async function readCheckoutView(name, url, { fetchImpl, timeoutMs, cacheBust, nonce }) {
    if (!url) {
        return {
            name,
            ok: false,
            requested_url: null,
            url: null,
            cache_bust: Boolean(cacheBust),
            skipped: true,
            error: 'No checkout payload URL was provided'
        };
    }
    const requestUrl = cacheBust ? withCacheBuster(url, nonce) : url;
    try {
        const response = await fetchImpl(requestUrl, {
            method: 'GET',
            headers: {
                accept: 'application/json',
                ...(cacheBust ? { 'cache-control': 'no-cache' } : {})
            },
            signal: AbortSignal.timeout(timeoutMs)
        });
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${String(text || '').slice(0, 300)}`);
        }
        let raw;
        try {
            raw = JSON.parse(text);
        } catch {
            throw new Error('response is not valid JSON');
        }
        const payload = normalizeCheckoutPayload(raw);
        return {
            name,
            ok: true,
            requested_url: url,
            url: requestUrl,
            cache_bust: Boolean(cacheBust),
            http_status: response.status,
            currency: payload.currency,
            count: Object.keys(payload.prices).length,
            cache: cacheSummary(response.headers),
            payload
        };
    } catch (error) {
        return {
            name,
            ok: false,
            requested_url: url,
            url: requestUrl,
            cache_bust: Boolean(cacheBust),
            error: error.message
        };
    }
}

function checkoutDrift(catalog, payload, route = 'checkout') {
    const routeFields = route === 'checkout' ? {} : { route };
    const detailSource = route === 'checkout' ? 'checkout_price' : `${route}_price`;
    const drift = [];
    const unchecked = [];
    const expectedCurrency = normalizeCurrency(catalog.currency);
    if (payload.currency !== expectedCurrency) {
        unchecked.push({
            source: 'checkout',
            ...routeFields,
            reason: 'currency_mismatch',
            expected: expectedCurrency,
            actual: payload.currency
        });
        return { drift, unchecked };
    }

    const seen = new Set();
    for (const course of catalog.courses) {
        seen.add(course.slug);
        const raw = payload.prices[course.slug];
        const actual = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
        if (!Number.isFinite(actual)) {
            unchecked.push({
                source: 'checkout',
                ...routeFields,
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
                ...routeFields,
                course_id: course.slug,
                reason: 'price_mismatch',
                detail_source: detailSource,
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
            unchecked.push({
                source: 'checkout',
                ...routeFields,
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

    return { drift, unchecked };
}

function shopifyDrift(catalog, products, storeCurrency) {
    const drift = [];
    const unchecked = [];
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
            unchecked.push({
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
        const expectedAmount = Number(mismatch.expected);
        const actualAmount = Number(mismatch.actual);
        const amountMismatch = mismatch.reason === 'price_mismatch'
            && Number.isFinite(expectedAmount)
            && Number.isFinite(actualAmount);
        const row = {
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
            ...(mismatch.error ? { error: mismatch.error } : {})
        };

        if (amountMismatch) {
            drift.push({
                ...row,
                expected: {
                    amount: expectedAmount,
                    currency: mismatch.currency || normalizeCurrency(catalog.currency)
                },
                actual: {
                    amount: actualAmount,
                    currency: mismatch.currency || normalizeCurrency(catalog.currency)
                }
            });
        } else {
            unchecked.push(row);
        }
    }

    return {
        drift,
        unchecked,
        checked_products: selectedProducts.length,
        checked_variants: validation.checked_variants,
        store_currency: validation.store_currency
    };
}

function payloadFingerprint(payload) {
    if (!payload) return null;
    const prices = Object.keys(payload.prices)
        .sort()
        .map(slug => `${slug}=${String(payload.prices[slug])}`)
        .join('&');
    return `${payload.currency}|${prices}`;
}

function summarizeView(view) {
    if (!view) return null;
    const summary = {
        name: view.name,
        requested_url: view.requested_url || view.url || null,
        url: view.url || null,
        ok: Boolean(view.ok),
        cache_bust: Boolean(view.cache_bust)
    };
    if (view.skipped) summary.skipped = true;
    if (view.http_status !== undefined) summary.http_status = view.http_status;
    if (view.currency) summary.currency = view.currency;
    if (view.ok) summary.count = view.count;
    if (view.cache && Object.keys(view.cache).length) summary.cache = view.cache;
    if (view.error) summary.error = view.error;
    return summary;
}

function groupDrift(observations) {
    const groups = new Map();
    for (const observation of observations) {
        const courseId = observation.course_id;
        if (!groups.has(courseId)) {
            groups.set(courseId, {
                course_id: courseId,
                handle: observation.handle || null,
                product_id: observation.product_id ?? null,
                sources: [],
                reasons: [],
                observations: []
            });
        }
        const group = groups.get(courseId);
        if (!group.handle && observation.handle) group.handle = observation.handle;
        if (observation.source && !group.sources.includes(observation.source)) {
            group.sources.push(observation.source);
        }
        const detail = observation.source === 'checkout'
            ? observation.reason
            : (observation.detail_source || observation.reason);
        const reason = `${observation.source}:${detail}`;
        if (!group.reasons.includes(reason)) group.reasons.push(reason);
        group.observations.push(observation);
        if (group.product_id === null && observation.product_id !== undefined) {
            group.product_id = observation.product_id;
        }
    }
    return [...groups.values()].sort((a, b) => String(a.course_id).localeCompare(String(b.course_id)));
}

function uncheckedReasons(report) {
    const reasons = [...(report.unavailable || [])];
    for (const row of report.unchecked || []) {
        reasons.push(`${row.source}:${row.course_id || 'catalog'} ${row.reason}`);
    }
    return reasons;
}

function buildFinding(report) {
    if (report.status === 'drift') {
        const affected = report.affected_courses;
        const preview = report.drift.slice(0, 3).map(row =>
            `${row.course_id} (${row.reasons.join(', ')})`
        ).join('; ');
        const suffix = report.drift.length > 3 ? ` (+${report.drift.length - 3} more)` : '';
        return {
            code: 'SHOPIFY_PRICE_DRIFT',
            severity: 'high',
            detail: `${affected} course(s) with a real price divergence between the catalog, edge/origin checkout and Shopify: ${preview}${suffix}`,
            evidence: {
                checked_at: report.checked_at,
                catalog_file: report.catalog_file,
                store_currency: report.store_currency,
                checkout_url: report.checkout.url,
                checkout: report.checkout,
                checked: report.checked,
                affected_courses: affected,
                drift: report.drift,
                unchecked: report.unchecked,
                unavailable: report.unavailable
            }
        };
    }
    if (report.status === 'unavailable') {
        const reasons = uncheckedReasons(report);
        return {
            code: 'SHOPIFY_PRICE_DRIFT_UNCHECKED',
            severity: 'medium',
            detail: `Price drift could not be fully checked: ${reasons.join('; ') || 'no reason was reported'}`,
            evidence: {
                checked_at: report.checked_at,
                catalog_file: report.catalog_file,
                store_currency: report.store_currency,
                checkout_url: report.checkout.url,
                checkout: report.checkout,
                checked: report.checked,
                unchecked: report.unchecked,
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

export function resolveCheckoutOriginUrl(settings = shopifySettingsFromEnv(), override = null) {
    const raw = String(override || settings.checkoutOriginUrl || '').trim();
    if (!raw) return null;
    const base = raw.replace(/\/+$/, '');
    return base.endsWith(CHECKOUT_PATH) ? base : `${base}${CHECKOUT_PATH}`;
}

export async function auditShopifyPriceDrift({
    catalog,
    catalogFile,
    settings = shopifySettingsFromEnv(),
    checkoutPayload,
    checkoutUrl = resolveCheckoutUrl(settings),
    checkoutOriginUrl = resolveCheckoutOriginUrl(settings),
    fetchImpl = globalThis.fetch,
    timeoutMs = 15000
} = {}) {
    const canonical = catalog || loadCourseCatalog(catalogFile);
    const unavailable = [];
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const views = [];
    let checkout = {
        url: checkoutUrl || null,
        origin_url: checkoutOriginUrl || null,
        currency: null,
        count: 0,
        edge: null,
        edge_fresh: null,
        origin: null,
        routes: []
    };

    if (checkoutPayload !== undefined && checkoutPayload !== null) {
        const payload = normalizeCheckoutPayload(checkoutPayload);
        views.push({
            name: 'checkout',
            ok: true,
            requested_url: checkoutUrl || null,
            url: checkoutUrl || null,
            cache_bust: false,
            currency: payload.currency,
            count: Object.keys(payload.prices).length,
            payload,
            injected: true
        });
    } else if (!checkoutUrl) {
        unavailable.push('checkout_unavailable: No checkout payload URL was provided');
    } else {
        const requests = [
            readCheckoutView('edge', checkoutUrl, {
                fetchImpl,
                timeoutMs,
                cacheBust: false,
                nonce
            }),
            readCheckoutView('edge_fresh', checkoutUrl, {
                fetchImpl,
                timeoutMs,
                cacheBust: true,
                nonce
            })
        ];
        if (checkoutOriginUrl) {
            requests.push(readCheckoutView('origin', checkoutOriginUrl, {
                fetchImpl,
                timeoutMs,
                cacheBust: true,
                nonce
            }));
        } else {
            unavailable.push('checkout_origin_unavailable: CHECKOUT_PRICE_ORIGIN_URL is not configured');
        }
        views.push(...await Promise.all(requests));
    }

    const edge = views.find(view => view.name === 'edge');
    const edgeFresh = views.find(view => view.name === 'edge_fresh');
    const origin = views.find(view => view.name === 'origin');
    const readable = views.filter(view => view.ok);
    const primary = edge?.ok ? edge : (edgeFresh?.ok ? edgeFresh : (origin?.ok ? origin : (readable[0] || null)));

    const failureName = view => view.name === 'edge'
        ? 'checkout_unavailable'
        : (view.name === 'edge_fresh' ? 'checkout_fresh_unavailable' : 'checkout_origin_unavailable');
    for (const view of views) {
        if (!view.ok && !view.skipped) unavailable.push(`${failureName(view)}: ${view.error}`);
    }

    checkout = {
        url: checkoutUrl || null,
        origin_url: checkoutOriginUrl || null,
        currency: primary?.currency || null,
        count: primary?.count || 0,
        edge: summarizeView(edge),
        edge_fresh: summarizeView(edgeFresh),
        origin: summarizeView(origin),
        routes: views.filter(view => view.name === 'checkout' || view.name === 'edge' || view.name === 'edge_fresh' || view.name === 'origin').map(view => view.name)
    };
    if (checkoutPayload !== undefined && checkoutPayload !== null) {
        checkout.edge = summarizeView(views[0]);
    }
    if (edge?.ok && edgeFresh?.ok) {
        const edgeDiffers = payloadFingerprint(edge.payload) !== payloadFingerprint(edgeFresh.payload);
        checkout.edge.stale = edgeDiffers;
        checkout.edge.stale_vs_fresh = edgeDiffers;
    }
    if (edge?.ok && origin?.ok) {
        checkout.edge.differs_from_origin = payloadFingerprint(edge.payload) !== payloadFingerprint(origin.payload);
    }
    if (edgeFresh?.ok && origin?.ok) {
        const originDiffers = payloadFingerprint(edgeFresh.payload) !== payloadFingerprint(origin.payload);
        checkout.origin.differs_from_fresh = originDiffers;
        checkout.fresh_matches_origin = !originDiffers;
    }

    const checkoutResult = { drift: [], unchecked: [] };
    const compared = new Set();
    for (const view of readable) {
        const fingerprint = payloadFingerprint(view.payload);
        if (compared.has(fingerprint)) continue;
        compared.add(fingerprint);
        const result = checkoutDrift(canonical, view.payload, view.name);
        checkoutResult.drift.push(...result.drift);
        checkoutResult.unchecked.push(...result.unchecked);
    }
    let shopify = {
        checked_products: 0,
        checked_variants: 0,
        store_currency: null
    };
    let shopifyResult = { drift: [], unchecked: [] };

    if (!settings.domain || !settings.token) {
        unavailable.push('missing_shopify_admin_credentials');
    } else {
        try {
            const storeCurrency = await getShopCurrency(settings, { fetchImpl });
            const products = await listProducts(settings, { fetchImpl });
            shopifyResult = shopifyDrift(canonical, products, storeCurrency);
            shopify = {
                checked_products: shopifyResult.checked_products,
                checked_variants: shopifyResult.checked_variants,
                store_currency: shopifyResult.store_currency
            };
        } catch (error) {
            unavailable.push(`shopify_unavailable: ${error.message}`);
        }
    }

    const drift = groupDrift([...checkoutResult.drift, ...shopifyResult.drift]);
    const unchecked = [...checkoutResult.unchecked, ...shopifyResult.unchecked];
    const status = drift.length
        ? 'drift'
        : ((unavailable.length || unchecked.length) ? 'unavailable' : 'ok');
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
            checkout_routes: checkout.routes.length,
            shopify_products: shopify.checked_products,
            shopify_variants: shopify.checked_variants
        },
        affected_courses: drift.length,
        drift,
        unchecked,
        unavailable
    };
    return {
        ...report,
        finding: buildFinding(report)
    };
}
