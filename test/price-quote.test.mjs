import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
    createPriceQuote,
    DEFAULT_PRICE_QUOTE_KEY_ID,
    encodePayPalCustomId,
    encodePayPalInvoiceId,
    parsePayPalCustomId,
    parsePayPalInvoiceId,
    resolvePriceQuoteKeys,
    verifyPriceQuote
} from '../src/sales/price-quote.mjs';

const SECRET = 'quote-test-secret';
const NOW = new Date('2026-11-17T12:00:00Z');
const DIGEST = `sha256:${'a'.repeat(64)}`;

function quote(overrides = {}, secret = SECRET, keyOptions = {}) {
    return createPriceQuote({
        productId: 'financial-risk-manager-test-bank',
        amountCents: 1900,
        currency: 'USD',
        catalogVersion: 1,
        catalogDigest: DIGEST,
        now: NOW,
        ...overrides
    }, secret, keyOptions);
}

test('price quotes are signed, scoped to a product and short-lived', () => {
    const created = quote({ ttlSeconds: 120 });
    const verified = verifyPriceQuote(created.token, SECRET, { now: NOW });
    assert.equal(verified.ok, true);
    assert.equal(verified.quote.p, 'financial-risk-manager-test-bank');
    assert.equal(verified.quote.a, 1900);
    assert.equal(verified.quote.c, 'USD');
    assert.equal(verified.quote.cv, '1');
    assert.equal(verified.quote.cd, DIGEST);
    assert.equal(created.catalog_digest, DIGEST);
    assert.equal(verified.quote.exp, Math.floor(NOW.getTime() / 1000) + 120);
    assert.equal(created.expires_at, new Date(verified.quote.exp * 1000).toISOString());
});

test('price quotes carry the signing key id and report the matched key', () => {
    const created = quote();
    assert.equal(created.key_id, DEFAULT_PRICE_QUOTE_KEY_ID);
    assert.equal(created.quote.k, DEFAULT_PRICE_QUOTE_KEY_ID);
    const verified = verifyPriceQuote(created.token, {
        current: { keyId: DEFAULT_PRICE_QUOTE_KEY_ID, secret: SECRET }
    }, { now: NOW });
    assert.equal(verified.ok, true);
    assert.equal(verified.key_id, DEFAULT_PRICE_QUOTE_KEY_ID);
});

test('quotes signed with the previous key verify during rotation', () => {
    const oldKeyId = '2026-11';
    const newKeyId = '2026-12';
    const oldSecret = 'old-quote-secret';
    const newSecret = 'new-quote-secret';
    const oldQuote = quote({}, oldSecret, { keyId: oldKeyId });
    const newQuote = quote({}, newSecret, { keyId: newKeyId });
    const keys = {
        current: { keyId: newKeyId, secret: newSecret },
        previous: { keyId: oldKeyId, secret: oldSecret }
    };

    const verifiedOld = verifyPriceQuote(oldQuote.token, keys, { now: NOW });
    const verifiedNew = verifyPriceQuote(newQuote.token, keys, { now: NOW });
    assert.equal(verifiedOld.ok, true);
    assert.equal(verifiedOld.key_id, oldKeyId);
    assert.equal(verifiedNew.ok, true);
    assert.equal(verifiedNew.key_id, newKeyId);
    assert.equal(verifyPriceQuote(oldQuote.token, { current: keys.current }, { now: NOW }).reason, 'INVALID_QUOTE_SIGNATURE');
    assert.equal(
        verifyPriceQuote(newQuote.token, { current: { keyId: oldKeyId, secret: newSecret } }, { now: NOW }).reason,
        'UNKNOWN_QUOTE_KEY'
    );
});

test('legacy quotes without a key id verify against the previous key', () => {
    const payload = JSON.parse(Buffer.from(quote().token.split('.')[0], 'base64url').toString('utf8'));
    delete payload.k;
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const token = `${encoded}.${crypto.createHmac('sha256', 'old-quote-secret').update(encoded).digest('base64url')}`;
    const verified = verifyPriceQuote(token, {
        current: { keyId: '2026-12', secret: 'new-quote-secret' },
        previous: { keyId: '2026-11', secret: 'old-quote-secret' }
    }, { now: NOW });

    assert.equal(verified.ok, true);
    assert.equal(verified.key_id, '2026-11');
});

test('price quotes expire and cannot be reused', () => {
    const created = quote({ ttlSeconds: 30 });
    const expired = verifyPriceQuote(created.token, SECRET, {
        now: new Date(NOW.getTime() + 31_000)
    });
    assert.equal(expired.ok, false);
    assert.equal(expired.reason, 'EXPIRED_QUOTE');
});

test('a changed payload or the wrong secret fails verification', () => {
    const created = quote();
    assert.equal(verifyPriceQuote(created.token, 'wrong-secret', { now: NOW }).reason, 'INVALID_QUOTE_SIGNATURE');
    const [payload, signature] = created.token.split('.');
    const tampered = `${payload.slice(0, -1)}${payload.endsWith('A') ? 'B' : 'A'}.${signature}`;
    assert.equal(verifyPriceQuote(tampered, SECRET, { now: NOW }).reason, 'INVALID_QUOTE_SIGNATURE');
    assert.equal(verifyPriceQuote('not-a-quote', SECRET, { now: NOW }).reason, 'MALFORMED_QUOTE');
    assert.equal(verifyPriceQuote(created.token, '', { now: NOW }).reason, 'QUOTE_SECRET_MISSING');
});

test('a quote cannot be created without a catalog digest', () => {
    assert.throws(() => quote({ catalogDigest: '' }), /catalogDigest/);
});

test('quote key configuration separates current and previous keys and only falls back in development', () => {
    const production = resolvePriceQuoteKeys({
        NODE_ENV: 'production',
        FULFILLMENT_ACCESS_SECRET: 'fulfillment-secret'
    });
    assert.equal(production.current, null);
    assert.equal(production.previous, null);

    const development = resolvePriceQuoteKeys({
        NODE_ENV: 'development',
        FULFILLMENT_ACCESS_SECRET: 'fulfillment-secret'
    });
    assert.deepEqual(development.current, {
        keyId: DEFAULT_PRICE_QUOTE_KEY_ID,
        secret: 'fulfillment-secret'
    });

    const rotating = resolvePriceQuoteKeys({
        NODE_ENV: 'production',
        PRICE_QUOTE_KEY_ID: '2026-12',
        PRICE_QUOTE_SECRET: 'new-quote-secret',
        PRICE_QUOTE_PREVIOUS_KEY_ID: '2026-11',
        PRICE_QUOTE_PREVIOUS_SECRET: 'old-quote-secret'
    });
    assert.deepEqual(rotating.current, { keyId: '2026-12', secret: 'new-quote-secret' });
    assert.deepEqual(rotating.previous, { keyId: '2026-11', secret: 'old-quote-secret' });

    assert.throws(() => resolvePriceQuoteKeys({
        NODE_ENV: 'production',
        PRICE_QUOTE_KEY_ID: 'same-key',
        PRICE_QUOTE_SECRET: 'new-quote-secret',
        PRICE_QUOTE_PREVIOUS_KEY_ID: 'same-key',
        PRICE_QUOTE_PREVIOUS_SECRET: 'old-quote-secret'
    }), /must differ/);
});

test('invalid key ids are rejected when creating a quote', () => {
    assert.throws(() => quote({}, SECRET, { keyId: 'not a key' }), /key id/);
});

test('a quote binds the accepted return and cancel URLs', () => {
    const created = quote({
        returnUrl: 'https://www.realworldcerts.com/buy/success',
        cancelUrl: 'https://www.realworldcerts.com/buy/cancel'
    });
    assert.equal(created.return_url, 'https://www.realworldcerts.com/buy/success');
    assert.equal(created.cancel_url, 'https://www.realworldcerts.com/buy/cancel');
    const verified = verifyPriceQuote(created.token, SECRET, { now: NOW });
    assert.equal(verified.ok, true);
    assert.equal(verified.quote.ru, 'https://www.realworldcerts.com/buy/success');
    assert.equal(verified.quote.cu, 'https://www.realworldcerts.com/buy/cancel');
    assert.equal(verified.return_url, created.return_url);
    assert.equal(verified.cancel_url, created.cancel_url);
});

test('quote redirect URLs must be complete, HTTPS and free of credentials, queries and fragments', () => {
    assert.throws(() => quote({ returnUrl: 'https://www.realworldcerts.com/buy/success' }), /both returnUrl and cancelUrl/);
    assert.throws(() => quote({
        returnUrl: 'http://www.realworldcerts.com/buy/success',
        cancelUrl: 'https://www.realworldcerts.com/buy/cancel'
    }), /must use HTTPS/);
    assert.throws(() => quote({
        returnUrl: 'https://user:pass@www.realworldcerts.com/buy/success',
        cancelUrl: 'https://www.realworldcerts.com/buy/cancel'
    }), /must not contain credentials/);
    assert.throws(() => quote({
        returnUrl: 'https://www.realworldcerts.com/buy/success?next=https://evil.example',
        cancelUrl: 'https://www.realworldcerts.com/buy/cancel'
    }), /must not contain a query or fragment/);
});

test('PayPal invoice metadata carries the catalog digest and quote id', () => {
    const encoded = encodePayPalInvoiceId({ quoteId: 'q_abc123', catalogDigest: DIGEST });
    assert.equal(encoded, `q=q_abc123|d=${DIGEST}`);
    assert.deepEqual(parsePayPalInvoiceId(encoded), {
        quoteId: 'q_abc123',
        catalogDigest: DIGEST
    });
    assert.deepEqual(parsePayPalInvoiceId('acp_reference'), {
        quoteId: null,
        catalogDigest: null
    });
});

test('PayPal custom IDs carry the quote and catalog version while keeping the product parseable', () => {
    const encoded = encodePayPalCustomId({
        productId: 'financial-risk-manager-test-bank',
        quoteId: 'q_abc123',
        catalogVersion: 7
    });
    assert.equal(encoded, 'financial-risk-manager-test-bank|q=q_abc123|v=7');
    assert.deepEqual(parsePayPalCustomId(encoded), {
        productId: 'financial-risk-manager-test-bank',
        quoteId: 'q_abc123',
        catalogVersion: '7',
        structured: true
    });
    assert.deepEqual(parsePayPalCustomId('legacy-course'), {
        productId: 'legacy-course',
        quoteId: null,
        catalogVersion: null,
        structured: false
    });
});
