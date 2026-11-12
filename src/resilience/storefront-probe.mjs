/**
 * Storefront capability probe.
 *
 * The production domain can answer 200 while being a static HTML build with no
 * application runtime: no `_next` assets, no server routes, `/api/*` 404. That
 * is not "Vercel failing to bundle API routes"; it is the deployed directory
 * containing none. Payments cannot complete and webhooks cannot land.
 *
 * The probe is read-only: one GET for the homepage and one for a health route.
 */

const APP_RUNTIME_PATTERN = /__NEXT_DATA__|_next\/static|\/_next\//i;

/** The domain the business sells from; probed unless overridden. */
export const DEFAULT_STOREFRONT_URL = 'https://www.realworldcerts.com';

/** Explicit flag, then env override, then the production domain. */
export function resolveStorefrontUrl({ flag = null, env = process.env } = {}) {
    const value = String(flag || env.STOREFRONT_URL || DEFAULT_STOREFRONT_URL).trim();
    return value || DEFAULT_STOREFRONT_URL;
}

export async function probeStorefront(url, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
    if (!url) throw new Error('a storefront URL is required');
    let base;
    try {
        base = new URL(url);
    } catch {
        throw new Error(`invalid storefront URL: ${JSON.stringify(url)}`);
    }
    if (base.protocol !== 'http:' && base.protocol !== 'https:') {
        throw new Error(`invalid storefront URL protocol: ${base.protocol}`);
    }

    const startedAt = Date.now();
    let status = null;
    let html = '';
    let healthStatus = null;
    let error = null;
    try {
        const home = await fetchImpl(base.toString(), {
            method: 'GET',
            redirect: 'follow',
            signal: AbortSignal.timeout(timeoutMs)
        });
        status = home.status;
        html = typeof home.text === 'function' ? await home.text() : '';
        const health = await fetchImpl(new URL('/api/healthz', base).toString(), {
            method: 'GET',
            redirect: 'manual',
            signal: AbortSignal.timeout(timeoutMs)
        });
        healthStatus = health.status;
    } catch (cause) {
        error = cause.message;
    }

    const appRuntime = APP_RUNTIME_PATTERN.test(html);
    const apiAlive = Number.isFinite(healthStatus) && healthStatus !== 404 && healthStatus < 500;
    let verdict;
    if (error) verdict = 'unreachable';
    else if (status !== 200) verdict = 'http_error';
    else if (!appRuntime && !apiAlive) verdict = 'static_only';
    else if (!apiAlive) verdict = 'application_without_api';
    else verdict = 'application';

    return {
        url: base.toString(),
        status,
        health_status: healthStatus,
        verdict,
        ok: verdict === 'application',
        app_runtime: appRuntime,
        api_alive: apiAlive,
        checkout_link: /\/checkout/i.test(html),
        error,
        duration_ms: Date.now() - startedAt
    };
}

export function storefrontVerdictHint(verdict) {
    return {
        application: 'Application runtime and API route are reachable.',
        static_only: 'Static HTML build: no application runtime and no API route, so checkout/webhooks cannot work.',
        application_without_api: 'Application runtime present but the health API is missing.',
        http_error: 'The storefront did not return HTTP 200.',
        unreachable: 'No HTTP response from the storefront.'
    }[verdict] || 'Unknown verdict.';
}

export default probeStorefront;
