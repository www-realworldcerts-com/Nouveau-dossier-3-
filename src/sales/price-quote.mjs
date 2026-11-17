import crypto from 'node:crypto';

/**
 * Short-lived, signed checkout price quote.
 *
 * The quote binds one product, canonical amount, currency, catalog version and
 * content-addressed catalog digest to an expiry. A checkout page must obtain a
 * fresh quote immediately before creating an ACP order; a cached page cannot
 * omit the assertion or reuse an old price after the catalog changes.
 */

export const PRICE_QUOTE_VERSION = 1;
export const DEFAULT_PRICE_QUOTE_TTL_SECONDS = 300;
const MAX_PRICE_QUOTE_TTL_SECONDS = 900;
const PAYPAL_CUSTOM_ID_LIMIT = 127;
const MAX_CATALOG_DIGEST_LENGTH = 96;

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

export function createPriceQuote({
    productId,
    amountCents,
    currency,
    catalogVersion,
    catalogDigest,
    quoteId = `q_${crypto.randomBytes(6).toString('hex')}`,
    now = new Date(),
    ttlSeconds = DEFAULT_PRICE_QUOTE_TTL_SECONDS
}, secret) {
    if (!secret) throw new Error('Missing PRICE_QUOTE_SECRET');
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

    const issuedAt = Math.floor(new Date(now).getTime() / 1000);
    const ttl = quoteTtl(ttlSeconds);
    const quote = {
        v: PRICE_QUOTE_VERSION,
        qid: String(quoteId),
        p: product,
        a: amount,
        c: currencyCode,
        cv: String(catalogVersion),
        cd: digest,
        iat: issuedAt,
        exp: issuedAt + ttl
    };
    const payload = base64url(JSON.stringify(quote));
    return {
        token: `${payload}.${sign(payload, secret)}`,
        quote,
        quote_id: quote.qid,
        catalog_digest: digest,
        expires_at: new Date(quote.exp * 1000).toISOString()
    };
}

export function verifyPriceQuote(token, secret, { now = new Date() } = {}) {
    if (!secret) return { ok: false, reason: 'QUOTE_SECRET_MISSING' };
    const parts = String(token || '').split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'MALFORMED_QUOTE' };
    if (!safeEqual(parts[1], sign(parts[0], secret))) return { ok: false, reason: 'INVALID_QUOTE_SIGNATURE' };

    let quote;
    try {
        quote = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    } catch {
        return { ok: false, reason: 'INVALID_QUOTE_PAYLOAD' };
    }
    if (!quote || quote.v !== PRICE_QUOTE_VERSION
        || !quote.qid || !quote.p || !Number.isInteger(quote.a) || quote.a <= 0
        || !/^[A-Z]{3}$/.test(String(quote.c || '')) || !quote.cv
        || !quote.cd || String(quote.cd).length > MAX_CATALOG_DIGEST_LENGTH
        || !Number.isFinite(Number(quote.exp)) || !Number.isFinite(Number(quote.iat))) {
        return { ok: false, reason: 'INVALID_QUOTE_PAYLOAD' };
    }
    const nowSeconds = Math.floor(new Date(now).getTime() / 1000);
    if (Number(quote.exp) <= nowSeconds) return { ok: false, reason: 'EXPIRED_QUOTE', quote };
    if (Number(quote.iat) > nowSeconds + 60) return { ok: false, reason: 'INVALID_QUOTE_PAYLOAD', quote };

    return {
        ok: true,
        quote,
        quote_id: String(quote.qid),
        catalog_digest: String(quote.cd),
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
