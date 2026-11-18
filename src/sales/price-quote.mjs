import crypto from 'node:crypto';

/**
 * Short-lived, signed checkout price quote.
 *
 * The quote binds one product, canonical amount, currency, catalog version,
 * content-addressed catalog digest and the allowed PayPal return/cancel URLs to
 * an expiry. A checkout page must obtain a fresh quote immediately before
 * creating an ACP order; a cached page cannot omit the assertion, reuse an old
 * price after the catalog changes, or redirect a completed payment elsewhere.
 */

export const PRICE_QUOTE_VERSION = 1;
export const DEFAULT_PRICE_QUOTE_TTL_SECONDS = 300;
export const DEFAULT_PRICE_QUOTE_KEY_ID = 'primary';
const MAX_PRICE_QUOTE_TTL_SECONDS = 900;
const PAYPAL_CUSTOM_ID_LIMIT = 127;
const MAX_CATALOG_DIGEST_LENGTH = 96;
const MAX_KEY_ID_LENGTH = 64;
const QUOTE_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function normalizeKeyId(value, fallback = DEFAULT_PRICE_QUOTE_KEY_ID) {
    const keyId = String(value ?? '').trim();
    if (!keyId) return fallback;
    if (keyId.length > MAX_KEY_ID_LENGTH || !QUOTE_KEY_ID_PATTERN.test(keyId)) {
        throw new Error('Price quote key id is invalid');
    }
    return keyId;
}

/**
 * Resolve signing keys from the environment. The fulfillment access secret is
 * only a development convenience: outside NODE_ENV=development, a quote must
 * have its own secret so compromising fulfillment links cannot mint quotes.
 */
export function resolvePriceQuoteKeys(env = process.env) {
    const development = env?.NODE_ENV === 'development';
    const currentSecret = String(env?.PRICE_QUOTE_SECRET || '').trim()
        || (development ? String(env?.FULFILLMENT_ACCESS_SECRET || '').trim() : '');
    const previousSecret = String(env?.PRICE_QUOTE_PREVIOUS_SECRET || '').trim();
    const current = currentSecret ? {
        keyId: normalizeKeyId(env?.PRICE_QUOTE_KEY_ID),
        secret: currentSecret
    } : null;
    const previous = previousSecret ? {
        keyId: normalizeKeyId(env?.PRICE_QUOTE_PREVIOUS_KEY_ID, 'previous'),
        secret: previousSecret
    } : null;
    if (current && previous && current.keyId === previous.keyId) {
        throw new Error('Price quote current and previous key ids must differ');
    }
    return { current, previous };
}

function base64url(value) {
    return Buffer.from(value).toString('base64url');
}

function sign(payload, secret) {
    return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function safeEqual(actual, expected) {
    const a = Buffer.from(String(actual || ''));
    const b = Buffer.from(String(expected || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function quoteTtl(ttlSeconds) {
    const value = Number(ttlSeconds);
    if (!Number.isFinite(value)) return DEFAULT_PRICE_QUOTE_TTL_SECONDS;
    return Math.min(MAX_PRICE_QUOTE_TTL_SECONDS, Math.max(30, Math.round(value)));
}

/**
 * Canonical absolute HTTPS redirect URL with no credentials, query or fragment.
 * The server additionally restricts the origin and /buy/success|/buy/cancel path
 * before issuing the quote.
 */
export function normalizeQuoteRedirectUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) throw new Error('Price quote redirect URL is required');
    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        throw new Error('Price quote redirect URL is invalid');
    }
    if (parsed.protocol !== 'https:') throw new Error('Price quote redirect URL must use HTTPS');
    if (parsed.username || parsed.password) throw new Error('Price quote redirect URL must not contain credentials');
    if (parsed.search || parsed.hash) throw new Error('Price quote redirect URL must not contain a query or fragment');
    return parsed.toString();
}

export function createPriceQuote({
    productId,
    amountCents,
    currency,
    catalogVersion,
    catalogDigest,
    returnUrl = null,
    cancelUrl = null,
    quoteId = `q_${crypto.randomBytes(6).toString('hex')}`,
    now = new Date(),
    ttlSeconds = DEFAULT_PRICE_QUOTE_TTL_SECONDS
}, secret, { keyId = DEFAULT_PRICE_QUOTE_KEY_ID } = {}) {
    if (!secret) throw new Error('Missing PRICE_QUOTE_SECRET');
    const signingKeyId = normalizeKeyId(keyId);
    const product = String(productId || '').trim();
    const currencyCode = String(currency || '').trim().toUpperCase();
    const amount = Number(amountCents);
    if (!product) throw new Error('Price quote requires a productId');
    if (!Number.isInteger(amount) || amount <= 0) throw new Error('Price quote requires a positive integer amountCents');
    if (!/^[A-Z]{3}$/.test(currencyCode)) throw new Error('Price quote requires a three-letter currency');
    if (catalogVersion === undefined || catalogVersion === null || String(catalogVersion) === '') {
        throw new Error('Price quote requires a catalogVersion');
    }
    const digest = String(catalogDigest || '').trim();
    if (!digest || digest.length > MAX_CATALOG_DIGEST_LENGTH) {
        throw new Error('Price quote requires a catalogDigest');
    }
    const redirectReturn = returnUrl ? normalizeQuoteRedirectUrl(returnUrl) : null;
    const redirectCancel = cancelUrl ? normalizeQuoteRedirectUrl(cancelUrl) : null;
    if (Boolean(redirectReturn) !== Boolean(redirectCancel)) {
        throw new Error('Price quote requires both returnUrl and cancelUrl');
    }

    const issuedAt = Math.floor(new Date(now).getTime() / 1000);
    const ttl = quoteTtl(ttlSeconds);
    const quote = {
        v: PRICE_QUOTE_VERSION,
        k: signingKeyId,
        qid: String(quoteId),
        p: product,
        a: amount,
        c: currencyCode,
        cv: String(catalogVersion),
        cd: digest,
        ...(redirectReturn ? { ru: redirectReturn, cu: redirectCancel } : {}),
        iat: issuedAt,
        exp: issuedAt + ttl
    };
    const payload = base64url(JSON.stringify(quote));
    return {
        token: `${payload}.${sign(payload, secret)}`,
        quote,
        key_id: signingKeyId,
        quote_id: quote.qid,
        catalog_digest: digest,
        return_url: redirectReturn,
        cancel_url: redirectCancel,
        expires_at: new Date(quote.exp * 1000).toISOString()
    };
}

function verificationKeys(secretOrKeys) {
    if (typeof secretOrKeys === 'string') {
        return {
            keys: secretOrKeys ? [{ keyId: null, secret: secretOrKeys }] : [],
            strictKeyIds: false
        };
    }
    const current = secretOrKeys?.current?.secret ? {
        keyId: normalizeKeyId(secretOrKeys.current.keyId),
        secret: String(secretOrKeys.current.secret)
    } : null;
    const previous = secretOrKeys?.previous?.secret ? {
        keyId: normalizeKeyId(secretOrKeys.previous.keyId, 'previous'),
        secret: String(secretOrKeys.previous.secret)
    } : null;
    return {
        keys: [current, previous].filter(Boolean),
        strictKeyIds: true
    };
}

export function verifyPriceQuote(token, secretOrKeys, { now = new Date() } = {}) {
    let keySet;
    try {
        keySet = verificationKeys(secretOrKeys);
    } catch {
        return { ok: false, reason: 'INVALID_QUOTE_KEY_CONFIG' };
    }
    if (keySet.keys.length === 0) return { ok: false, reason: 'QUOTE_SECRET_MISSING' };

    const parts = String(token || '').split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'MALFORMED_QUOTE' };

    // Verify the signature before parsing the payload. For a legacy token with
    // no key id, this also lets either the current or previous key validate it.
    const matchedKeys = keySet.keys.filter(key => safeEqual(parts[1], sign(parts[0], key.secret)));
    if (matchedKeys.length === 0) return { ok: false, reason: 'INVALID_QUOTE_SIGNATURE' };

    let quote;
    try {
        quote = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    } catch {
        return { ok: false, reason: 'INVALID_QUOTE_PAYLOAD' };
    }
    const hasKeyId = quote?.k !== undefined && quote?.k !== null;
    let requestedKeyId = null;
    if (hasKeyId) {
        if (typeof quote.k !== 'string' || !quote.k.trim()) {
            return { ok: false, reason: 'INVALID_QUOTE_PAYLOAD', quote };
        }
        try {
            requestedKeyId = normalizeKeyId(quote.k, null);
        } catch {
            return { ok: false, reason: 'INVALID_QUOTE_PAYLOAD', quote };
        }
        if (!requestedKeyId) return { ok: false, reason: 'INVALID_QUOTE_PAYLOAD', quote };
    }
    let signingKey = matchedKeys[0];
    if (keySet.strictKeyIds && requestedKeyId) {
        signingKey = matchedKeys.find(key => key.keyId === requestedKeyId) || null;
        if (!signingKey) return { ok: false, reason: 'UNKNOWN_QUOTE_KEY', quote };
    }

    if (!quote || quote.v !== PRICE_QUOTE_VERSION
        || !quote.qid || !quote.p || !Number.isInteger(quote.a) || quote.a <= 0
        || !/^[A-Z]{3}$/.test(String(quote.c || '')) || !quote.cv
        || !quote.cd || String(quote.cd).length > MAX_CATALOG_DIGEST_LENGTH
        || !Number.isFinite(Number(quote.exp)) || !Number.isFinite(Number(quote.iat))) {
        return { ok: false, reason: 'INVALID_QUOTE_PAYLOAD' };
    }
    const hasReturnUrl = quote.ru !== undefined && quote.ru !== null;
    const hasCancelUrl = quote.cu !== undefined && quote.cu !== null;
    if (hasReturnUrl !== hasCancelUrl) return { ok: false, reason: 'INVALID_QUOTE_PAYLOAD', quote };
    if (hasReturnUrl) {
        try {
            normalizeQuoteRedirectUrl(quote.ru);
            normalizeQuoteRedirectUrl(quote.cu);
        } catch {
            return { ok: false, reason: 'INVALID_QUOTE_PAYLOAD', quote };
        }
    }
    const nowSeconds = Math.floor(new Date(now).getTime() / 1000);
    if (Number(quote.exp) <= nowSeconds) return { ok: false, reason: 'EXPIRED_QUOTE', quote };
    if (Number(quote.iat) > nowSeconds + 60) return { ok: false, reason: 'INVALID_QUOTE_PAYLOAD', quote };

    return {
        ok: true,
        quote,
        key_id: requestedKeyId || signingKey.keyId || null,
        quote_id: String(quote.qid),
        catalog_digest: String(quote.cd),
        return_url: quote.ru ? String(quote.ru) : null,
        cancel_url: quote.cu ? String(quote.cu) : null,
        expires_at: new Date(Number(quote.exp) * 1000).toISOString()
    };
}

/**
 * PayPal has no arbitrary metadata field on a purchase unit. Store the quote
 * identity with the product in `custom_id` and keep the legacy product-only
 * value parseable for orders created before quotes existed.
 */
export function encodePayPalCustomId({ productId, quoteId, catalogVersion }) {
    const product = String(productId || '').trim().replace(/\|/g, '_').slice(0, 80);
    const quote = String(quoteId || '').trim().replace(/\|/g, '_').slice(0, 24);
    const version = String(catalogVersion ?? '').trim().replace(/\|/g, '_').slice(0, 16);
    if (!product) return quote || version || null;
    if (!quote || !version) return product;
    const structured = `${product}|q=${quote}|v=${version}`;
    return structured.length <= PAYPAL_CUSTOM_ID_LIMIT ? structured : product;
}

export function encodePayPalInvoiceId({ quoteId, catalogDigest }) {
    const quote = String(quoteId || '').trim().replace(/\|/g, '_').slice(0, 24);
    const digest = String(catalogDigest || '').trim().replace(/\|/g, '_').slice(0, MAX_CATALOG_DIGEST_LENGTH);
    if (!quote || !digest) return null;
    const value = `q=${quote}|d=${digest}`;
    return value.length <= PAYPAL_CUSTOM_ID_LIMIT ? value : null;
}

export function parsePayPalInvoiceId(value) {
    const raw = String(value || '');
    let quoteId = null;
    let catalogDigest = null;
    for (const part of raw.split('|')) {
        if (part.startsWith('q=')) quoteId = part.slice(2) || null;
        if (part.startsWith('d=')) catalogDigest = part.slice(2) || null;
    }
    return { quoteId, catalogDigest };
}

export function parsePayPalCustomId(value) {
    const raw = String(value || '');
    const [product, ...parts] = raw.split('|');
    let quoteId = null;
    let catalogVersion = null;
    for (const part of parts) {
        if (part.startsWith('q=')) quoteId = part.slice(2) || null;
        if (part.startsWith('v=')) catalogVersion = part.slice(2) || null;
    }
    return {
        productId: product || null,
        quoteId,
        catalogVersion,
        structured: Boolean(quoteId || catalogVersion)
    };
}
