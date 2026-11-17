import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createPriceQuote,
    encodePayPalCustomId,
    encodePayPalInvoiceId,
    parsePayPalCustomId,
    parsePayPalInvoiceId,
    verifyPriceQuote
} from '../src/sales/price-quote.mjs';

const SECRET = 'quote-test-secret';
const NOW = new Date('2026-11-17T12:00:00Z');
const DIGEST = `sha256:${'a'.repeat(64)}`;

function quote(overrides = {}) {
    return createPriceQuote({
        productId: 'financial-risk-manager-test-bank',
        amountCents: 1900,
        currency: 'USD',
        catalogVersion: 1,
        catalogDigest: DIGEST,
        now: NOW,
        ...overrides
    }, SECRET);
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
