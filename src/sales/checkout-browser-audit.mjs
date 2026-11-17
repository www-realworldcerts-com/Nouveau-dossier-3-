import { shopifySettingsFromEnv } from './shopify.mjs';

/**
 * Browser-level checkout probe.
 *
 * The JSON audit proves that `/data/store-prices.json` is consistent. It cannot
 * prove that the `/buy` HTML and inline JavaScript buyers receive display the
 * same price or POST the amount/currency they display. This module loads the
 * exact page in a real browser, intercepts the checkout POST before it reaches
 * `/acp/v1/transactions`, and compares the rendered price and request body.
 *
 * It is read-only: the POST is fulfilled with an error response locally, so no
 * PayPal order is created and no money can move.
 */

const CHECKOUT_PRICE_PATH = '/data/store-prices.json';
const DEFAULT_TIMEOUT_MS = 30000;

function trimBase(value) {
    return String(value || '').trim().replace(/\/+$/, '');
}

export function resolveBuyUrl(settings = shopifySettingsFromEnv(), override = null) {
    if (override) return String(override);
    const base = trimBase(settings.storefrontUrl);
    return base ? `${base}/buy` : null;
}

export function resolveBuyOriginUrl(settings = shopifySettingsFromEnv(), override = null) {
    const raw = trimBase(override || settings.checkoutOriginUrl || '');
    if (!raw) return null;
    try {
        const parsed = new URL(raw);
        parsed.search = '';
        parsed.hash = '';
        if (parsed.pathname.endsWith(CHECKOUT_PRICE_PATH)) {
            parsed.pathname = parsed.pathname.slice(0, -CHECKOUT_PRICE_PATH.length) || '/';
        }
        if (!parsed.pathname.replace(/\/+$/, '').endsWith('/buy')) {
            parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/buy`;
        }
        return parsed.toString().replace(/\/+$/, '');
    } catch {
        let base = raw;
        if (base.endsWith(CHECKOUT_PRICE_PATH)) base = base.slice(0, -CHECKOUT_PRICE_PATH.length);
        if (base.endsWith('/buy')) return base;
        return `${base}/buy`;
    }
}

function withQuery(url, values) {
    try {
        const parsed = new URL(url);
        for (const [key, value] of Object.entries(values)) {
            if (value !== undefined && value !== null && value !== '') parsed.searchParams.set(key, String(value));
        }
        return parsed.toString();
    } catch {
        const query = Object.entries(values)
            .filter(([, value]) => value !== undefined && value !== null && value !== '')
            .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
            .join('&');
        if (!query) return url;
        return `${url}${url.includes('?') ? '&' : '?'}${query}`;
    }
}

function normalizeAmount(value) {
    const amount = Number(value);
    return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : null;
}

function normalizeCurrency(value) {
    const currency = String(value || '').trim().toUpperCase();
    return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

function money(amount, currency) {
    return {
        amount: amount === null ? null : amount / 100,
        currency: currency || null
    };
}

function displayPrice(route, expectedCents, expectedCurrency) {
    const displayedCents = normalizeAmount(route.displayed?.amount);
    const displayedCurrency = normalizeCurrency(route.displayed?.currency);
    return {
        amount: displayedCents === null ? null : displayedCents / 100,
        currency: displayedCurrency,
        matches: displayedCents === expectedCents && displayedCurrency === expectedCurrency
    };
}

function postedPrice(route, expectedCents, expectedCurrency) {
    const postedCents = normalizeAmount(route.posted?.amount ?? route.posted?.total ?? route.posted?.price);
    const postedCurrency = normalizeCurrency(route.posted?.currency ?? route.posted?.currency_code);
    return {
        amount: postedCents === null ? null : postedCents / 100,
        currency: postedCurrency,
        present: route.posted && (route.posted.amount !== undefined
            || route.posted.total !== undefined
            || route.posted.price !== undefined),
        matches: postedCents === expectedCents && postedCurrency === expectedCurrency
    };
}

async function loadPlaywright() {
    try {
        return await import('playwright');
    } catch (error) {
        throw new Error(`Playwright is unavailable; install playwright and its Chromium browser for the browser audit (${error.message})`);
    }
}

/**
 * Real-browser probe for one /buy URL. The route handler stops the checkout
 * request before it reaches the payment server, so this cannot create a PayPal
 * order or charge a buyer.
 */
export async function probeBuyPage({ url, productId, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const { chromium } = await loadPlaywright();
    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        let resolvePosted;
        const postedPromise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('checkout POST was not observed')), timeoutMs);
            resolvePosted = value => {
                clearTimeout(timer);
                resolve(value);
            };
        });

        await page.route('**/acp/v1/transactions', async route => {
            if (route.request().method() !== 'POST') return route.continue();
            let posted = null;
            try {
                posted = JSON.parse(route.request().postData() || '{}');
            } catch {
                posted = { parse_error: true };
            }
            await route.fulfill({
                status: 500,
                contentType: 'application/json',
                body: JSON.stringify({ ok: false, error: 'browser audit intercepted checkout; no order was created' })
            });
            resolvePosted(posted);
        });

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        await page.waitForFunction(
            id => {
                const select = document.getElementById('product');
                return Boolean(select && Array.from(select.options).some(option => option.value === id));
            },
            productId,
            { timeout: timeoutMs }
        );

        const displayed = await page.evaluate(id => {
            const select = document.getElementById('product');
            const option = select && Array.from(select.options).find(candidate => candidate.value === id);
            const text = option?.textContent || '';
            const match = text.match(/ —\s*([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]{3})\s*$/);
            return {
                text,
                amount: match ? Number(match[1]) : null,
                currency: match ? match[2].toUpperCase() : null
            };
        }, productId);

        await page.evaluate(id => {
            const select = document.getElementById('product');
            select.value = id;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            document.getElementById('checkout').requestSubmit();
        }, productId);

        const posted = await postedPromise;
        return { displayed, posted };
    } finally {
        await browser.close();
    }
}

export async function auditCheckoutBrowser({
    buyUrl,
    buyOriginUrl,
    productId,
    expectedAmount,
    expectedCurrency,
    probePage = probeBuyPage,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
} = {}) {
    const expectedCents = normalizeAmount(expectedAmount);
    const expectedCurrencyCode = normalizeCurrency(expectedCurrency);
    const unavailable = [];
    const checkedAt = new Date().toISOString();

    if (!buyUrl) unavailable.push('buy_url_missing');
    if (!buyOriginUrl) unavailable.push('buy_origin_url_missing: CHECKOUT_PRICE_ORIGIN_URL or --buy-origin-url is not configured');
    if (expectedCents === null) unavailable.push('expected_amount_invalid');
    if (!expectedCurrencyCode) unavailable.push('expected_currency_invalid');
    if (!productId) unavailable.push('product_id_missing');

    const canProbe = Boolean(buyUrl && productId && expectedCents !== null && expectedCurrencyCode);
    const routes = [];
    if (canProbe) {
        routes.push({ route: 'edge', url: buyUrl, cacheBust: false });
        routes.push({ route: 'edge_fresh', url: buyUrl, cacheBust: true });
        if (buyOriginUrl) routes.push({ route: 'origin', url: buyOriginUrl, cacheBust: true });
    }

    const results = [];
    for (const route of routes) {
        const url = withQuery(route.url, {
            product_id: productId,
            ...(route.cacheBust ? { _price_audit: nonce } : {})
        });
        try {
            const probed = await probePage({ url, productId, timeoutMs });
            const displayed = displayPrice(probed, expectedCents, expectedCurrencyCode);
            const posted = postedPrice(probed, expectedCents, expectedCurrencyCode);
            results.push({
                route: route.route,
                url,
                cache_bust: route.cacheBust,
                ok: displayed.matches && posted.matches && posted.present,
                displayed,
                posted,
                posted_body: probed.posted || null
            });
        } catch (error) {
            results.push({
                route: route.route,
                url,
                cache_bust: route.cacheBust,
                ok: false,
                error: error.message
            });
        }
    }

    const drift = [];
    for (const result of results) {
        if (result.error) {
            unavailable.push(`${result.route}_unavailable: ${result.error}`);
            continue;
        }
        const expected = money(expectedCents, expectedCurrencyCode);
        if (result.displayed.amount === null || result.displayed.currency === null) {
            drift.push({
                route: result.route,
                reason: 'displayed_price_missing',
                expected,
                displayed: result.displayed,
                posted: result.posted
            });
        } else if (!result.displayed.matches) {
            drift.push({
                route: result.route,
                reason: 'displayed_price_mismatch',
                expected,
                displayed: result.displayed,
                posted: result.posted
            });
        }
        if (!result.posted.present) {
            drift.push({
                route: result.route,
                reason: 'posted_amount_missing',
                expected,
                displayed: result.displayed,
                posted: result.posted
            });
        } else if (!result.posted.matches) {
            drift.push({
                route: result.route,
                reason: result.posted.currency !== expectedCurrencyCode
                    ? 'posted_currency_mismatch'
                    : 'posted_amount_mismatch',
                expected,
                displayed: result.displayed,
                posted: result.posted
            });
        }
    }

    const status = drift.length ? 'drift' : (unavailable.length ? 'unavailable' : 'ok');
    return {
        read_only: true,
        status,
        checked_at: checkedAt,
        product_id: productId || null,
        expected: money(expectedCents, expectedCurrencyCode),
        buy_url: buyUrl || null,
        buy_origin_url: buyOriginUrl || null,
        checked_routes: results.filter(result => !result.error).length,
        routes: results,
        stale_routes: [...new Set(drift.map(row => row.route))],
        drift,
        unavailable
    };
}

export default auditCheckoutBrowser;
