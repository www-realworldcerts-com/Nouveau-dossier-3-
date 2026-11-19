/**
 * Per-client rate limit for the checkout order-create endpoint.
 *
 * One source must not be able to create PayPal orders without bound, so each
 * client address may only start a limited number of checkout attempts per
 * window. The state lives in this process: with several instances each allows
 * the same rate, which caps what one source can make one instance do rather
 * than a cluster-wide total.
 *
 * The default is deliberately generous. A client key is a network address, so
 * everyone behind one NAT, office or mobile carrier gateway shares a bucket, and
 * a tight limit would block buyers who did nothing wrong. The limit still turns
 * an unbounded loop into a bounded one, and `CHECKOUT_RATE_LIMIT_MAX` tunes it.
 */

const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_MAX = 60;
// Buckets are tiny, but their keys come from request data. Past this many live
// buckets the oldest one is dropped, so a caller cannot grow the map without end.
const MAX_TRACKED_CLIENTS = 10_000;

function positiveInt(value, fallback) {
    const text = typeof value === 'string' ? value.trim() : value;
    if (text === '' || text === undefined || text === null) return fallback;
    const number = Number(text);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

/**
 * `max: 0` disables the limit, which is useful when an edge already enforces
 * one. An invalid value falls back to the default rather than disabling it: a
 * typo must not silently remove the bound.
 */
export function createCheckoutRateLimiter({ windowMs, max, now = () => Date.now() } = {}) {
    const window = positiveInt(windowMs, DEFAULT_WINDOW_MS);
    const limit = positiveInt(max, DEFAULT_MAX);
    const buckets = new Map();

    function check(key) {
        if (limit <= 0) return { allowed: true, remaining: Infinity, retryAfterMs: 0 };
        const id = String(key || 'unknown');
        const current = now();
        const bucket = buckets.get(id);

        if (!bucket || current - bucket.startedAt >= window) {
            if (!bucket && buckets.size >= MAX_TRACKED_CLIENTS) {
                buckets.delete(buckets.keys().next().value);
            }
            buckets.set(id, { startedAt: current, used: 1 });
            return { allowed: true, remaining: limit - 1, retryAfterMs: 0 };
        }
        if (bucket.used >= limit) {
            return {
                allowed: false,
                remaining: 0,
                retryAfterMs: Math.max(1, window - (current - bucket.startedAt))
            };
        }
        bucket.used += 1;
        return { allowed: true, remaining: limit - bucket.used, retryAfterMs: 0 };
    }

    return {
        enabled: limit > 0,
        windowMs: window,
        max: limit,
        check,
        size: () => buckets.size,
        clear: () => buckets.clear()
    };
}

const PRIVATE_ADDRESS = /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

function normalizeAddress(value) {
    const text = String(value ?? '').trim().toLowerCase();
    if (!text) return null;
    const address = text
        .replace(/^\[([^\]]+)\](?::\d+)?$/, '$1') // [ipv6]:port
        .replace(/^([^:]+):\d+$/, '$1') // ipv4:port
        .replace(/^::ffff:/, ''); // ipv4-mapped ipv6
    return address || null;
}

/** Addresses a platform edge, sidecar or container network presents itself as. */
export function isLocalAddress(value) {
    const address = normalizeAddress(value);
    if (!address) return false;
    if (address === '::1' || address === '::') return true;
    if (PRIVATE_ADDRESS.test(address)) return true;
    if (/^f[cd][0-9a-f]{2}:/.test(address)) return true; // unique local
    if (/^fe[89ab][0-9a-f]:/.test(address)) return true; // link local
    return false;
}

/**
 * Identify the client a checkout request comes from.
 *
 * Forwarding headers are only read when the request already arrived through a
 * local address (a platform edge, reverse proxy or sidecar). A direct caller
 * cannot be trusted to report its own address, and reading the header anyway
 * would let it mint a fresh bucket per request and bypass the limit entirely.
 * With a trusted proxy the rightmost `X-Forwarded-For` entry is the address that
 * proxy saw, so a client-supplied list in front of it changes nothing.
 */
export function checkoutClientKey(req) {
    const socketAddress = normalizeAddress(req?.socket?.remoteAddress ?? req?.connection?.remoteAddress);
    const headers = req?.headers || {};
    if (socketAddress && !isLocalAddress(socketAddress)) return socketAddress;

    const realIp = normalizeAddress(headers['x-real-ip']);
    if (realIp) return realIp;

    const forwarded = String(headers['x-forwarded-for'] ?? '')
        .split(',')
        .map(normalizeAddress)
        .filter(Boolean);
    if (forwarded.length) return forwarded.at(-1);

    return socketAddress || 'unknown';
}
