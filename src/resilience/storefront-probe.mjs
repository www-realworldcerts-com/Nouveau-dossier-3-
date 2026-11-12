/**
 * Storefront capability probe.
 *
 * The production domain can answer 200 while being a static HTML build with no
 * application runtime: no `_next` assets, no server routes, `/api/*` 404. That
 * is not "Vercel failing to bundle API routes"; it is the deployed directory
 * containing none. Payments cannot complete and webhooks cannot land.
 *
 * Transport is separated from deployment state: a DNS blip or 503 edge error is
 * retried briefly and then classified `unreachable`, never as a static build.
 * Only a successful origin response can prove `static_only`.
 */

const APP_RUNTIME_PATTERN = /__NEXT_DATA__|_next\/static|\/_next\//i;

/** Upstream/edge statuses worth one retry; they do not prove a broken build. */
export const TRANSIENT_STATUSES = new Set([408, 429, 502, 503, 504]);

const TRANSIENT_CODES = [
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET'
];

/** The domain the business sells from; probed unless overridden. */
export const DEFAULT_STOREFRONT_URL = 'https://www.realworldcerts.com';

/** Explicit flag, then env override, then the production domain. */
export function resolveStorefrontUrl({ flag = null, env = process.env } = {}) {
    const value = String(flag || env.STOREFRONT_URL || DEFAULT_STOREFRONT_URL).trim();
    return value || DEFAULT_STOREFRONT_URL;
}

export function isTransientNetworkError(error) {
    if (!error) return false;
    const name = error.name || error.cause?.name;
    if (name === 'AbortError' || name === 'TimeoutError') return true;
    const code = error.cause?.code || error.code;
    if (code && TRANSIENT_CODES.includes(code)) return true;
    const message = String(error.message || '');
    if (message.includes('fetch failed')) return true;
    return TRANSIENT_CODES.some(candidate => message.includes(candidate));
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * GET with at most `retries` retries on transport errors and transient statuses.
 * Never retries a deterministic response such as a 200 or 404.
 */
export async function fetchWithRetry(url, {
    fetchImpl = globalThis.fetch,
    timeoutMs = 8000,
    retries = 2,
    retryDelayMs = 500,
    sleepImpl = defaultSleep,
    ...init
} = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            const response = await fetchImpl(url, {
                ...init,
                signal: AbortSignal.timeout(timeoutMs)
            });
            if (TRANSIENT_STATUSES.has(response.status) && attempt < retries) {
                lastError = new Error(`transient upstream status ${response.status}`);
                await sleepImpl(retryDelayMs * 2 ** attempt);
                continue;
            }
            return { ok: true, response, error: null, attempts: attempt + 1 };
        } catch (error) {
            lastError = error;
            if (isTransientNetworkError(error) && attempt < retries) {
                await sleepImpl(retryDelayMs * 2 ** attempt);
                continue;
            }
            return { ok: false, error, attempts: attempt + 1 };
        }
    }
    return { ok: false, error: lastError, attempts: retries + 1 };
}

function describeError(error) {
    if (!error) return 'unknown error';
    return error.cause?.code || error.code || error.message || String(error);
}

export async function probeStorefront(url, {
    fetchImpl = globalThis.fetch,
    timeoutMs = 8000,
    retries = 2,
    retryDelayMs = 500,
    sleepImpl = defaultSleep
} = {}) {
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
    const home = await fetchWithRetry(base.toString(), {
        fetchImpl, timeoutMs, retries, retryDelayMs, sleepImpl,
        method: 'GET',
        redirect: 'follow'
    });

    let status = null;
    let html = '';
    let error = null;
    let healthStatus = null;
    let healthError = null;
    let healthAttempts = 0;

    if (home.ok) {
        status = home.response.status;
        html = typeof home.response.text === 'function' ? await home.response.text() : '';
        if (status >= 200 && status < 400) {
            const health = await fetchWithRetry(new URL('/api/healthz', base).toString(), {
                fetchImpl, timeoutMs, retries, retryDelayMs, sleepImpl,
                method: 'GET',
                redirect: 'manual'
            });
            healthAttempts = health.attempts;
            if (health.ok) healthStatus = health.response.status;
            else healthError = describeError(health.error);
        }
    } else {
        error = describeError(home.error);
    }

    const appRuntime = APP_RUNTIME_PATTERN.test(html);
    const reachable = home.ok && status >= 200 && status < 400;
    const apiAlive = Number.isFinite(healthStatus) && healthStatus >= 200 && healthStatus < 400;
    let verdict;
    if (!home.ok) {
        verdict = 'unreachable';
    } else if (!reachable) {
        verdict = TRANSIENT_STATUSES.has(status) ? 'unreachable' : 'http_error';
    } else if (healthError) {
        // The origin answered but the API probe could not: not enough evidence
        // to claim a static build, and not a transactional success.
        verdict = 'unreachable';
    } else if (TRANSIENT_STATUSES.has(healthStatus)) {
        verdict = 'unreachable';
    } else if (!appRuntime && healthStatus === 404) {
        verdict = 'static_only';
    } else if (appRuntime && healthStatus === 404) {
        verdict = 'application_without_api';
    } else if (Number.isFinite(healthStatus) && healthStatus >= 400) {
        verdict = 'http_error';
    } else {
        verdict = 'application';
    }

    return {
        url: base.toString(),
        status,
        health_status: healthStatus,
        health_error: healthError,
        verdict,
        ok: verdict === 'application',
        app_runtime: appRuntime,
        api_alive: apiAlive,
        checkout_link: /\/checkout/i.test(html),
        error,
        attempts: home.attempts,
        health_attempts: healthAttempts,
        duration_ms: Date.now() - startedAt
    };
}

export function storefrontVerdictHint(verdict) {
    return {
        application: 'Application runtime and API route are reachable.',
        static_only: 'Static HTML build: no application runtime and no API route, so checkout/webhooks cannot work.',
        application_without_api: 'Application runtime present but the health API is missing.',
        http_error: 'The storefront answered with an unexpected HTTP status.',
        unreachable: 'No usable HTTP response after retries; reachability is unknown, not proven broken.'
    }[verdict] || 'Unknown verdict.';
}

export default probeStorefront;
