import assert from 'node:assert/strict';
import test from 'node:test';

import { reconcileCapturedPayment } from '../src/sales/capture-reconciliation.mjs';

const CATALOG = { version: '1', digest: 'sha256:abc123', bySlug: {} };

const QUOTE = {
    amount_cents: 1900,
    currency: 'USD',
    catalog_version: '1',
    catalog_digest: 'sha256:abc123'
};

function order({
    amount = '19.00',
    currency = 'USD',
    quoteId = 'q_capture',
    version = '1',
    digest = 'sha256:abc123',
    captures = null,
    customId = undefined,
    invoiceId = undefined
} = {}) {
    const money = amount === null ? undefined : { value: amount, currency_code: currency };
    const unit = {
        amount: money,
        custom_id: customId ?? (quoteId ? `course|q=${quoteId}|v=${version}` : undefined),
        invoice_id: invoiceId ?? (quoteId ? `q=${quoteId}|d=${digest}` : undefined),
        // A real capture response carries the settled capture rows; a bare
        // purchase unit is not proof that money moved.
        payments: { captures: captures ?? [{ id: 'CAP-1', status: 'COMPLETED', amount: money }] }
    };
    return { id: 'ORDER-1', status: 'COMPLETED', purchase_units: [unit] };
}

function attempt(overrides = {}) {
    return { quote_id: 'q_capture', quote: { ...QUOTE, ...overrides } };
}

test('a capture that matches the signed quote is ok', () => {
    const reconciliation = reconcileCapturedPayment({
        order: order(),
        attempt: attempt(),
        catalog: CATALOG
    });

    assert.equal(reconciliation.status, 'ok');
    assert.equal(reconciliation.reason, null);
    assert.deepEqual(reconciliation.reasons, []);
    assert.equal(reconciliation.delta_cents, 0);
    assert.deepEqual(reconciliation.captured, { value_cents: 1900, currency: 'USD' });
    assert.equal(reconciliation.quoted.value_cents, 1900);
    assert.equal(reconciliation.quote_id, 'q_capture');
    assert.equal(reconciliation.catalog_revision, 'ok');
});

test('an under-captured order is reported without changing any price', () => {
    const catalog = structuredClone(CATALOG);
    const before = structuredClone(catalog);

    const reconciliation = reconcileCapturedPayment({
        order: order({ amount: '0.01' }),
        attempt: attempt(),
        catalog
    });

    assert.equal(reconciliation.status, 'mismatch');
    assert.equal(reconciliation.reason, 'amount_mismatch');
    assert.deepEqual(reconciliation.reasons, ['amount_mismatch']);
    assert.equal(reconciliation.captured.value_cents, 1);
    assert.equal(reconciliation.quoted.value_cents, 1900);
    assert.equal(reconciliation.delta_cents, -1899);
    assert.deepEqual(catalog, before, 'the catalog is only read');
});

test('a captured currency that differs from the quote is a mismatch', () => {
    const reconciliation = reconcileCapturedPayment({
        order: order({ amount: '17.48', currency: 'EUR' }),
        attempt: attempt(),
        catalog: CATALOG
    });

    assert.equal(reconciliation.status, 'mismatch');
    assert.deepEqual(reconciliation.reasons, ['currency_mismatch', 'amount_mismatch']);
    assert.equal(reconciliation.catalog_revision, 'ok');
});

test('completed partial captures are compared as their settled total', () => {
    const reconciliation = reconcileCapturedPayment({
        order: order({
            amount: '19.00',
            captures: [
                { id: 'CAP-1', status: 'COMPLETED', amount: { value: '10.00', currency_code: 'USD' } },
                { id: 'CAP-2', status: 'COMPLETED', amount: { value: '9.00', currency_code: 'USD' } }
            ]
        }),
        attempt: attempt(),
        catalog: CATALOG
    });

    assert.equal(reconciliation.status, 'ok');
    assert.equal(reconciliation.captured.value_cents, 1900);
    assert.equal(reconciliation.capture_count, 2);
    assert.deepEqual(reconciliation.capture_ids, ['CAP-1', 'CAP-2']);
});

test('mixed capture currencies cannot be summed and are unchecked', () => {
    const reconciliation = reconcileCapturedPayment({
        order: order({
            captures: [
                { id: 'CAP-1', status: 'COMPLETED', amount: { value: '10.00', currency_code: 'USD' } },
                { id: 'CAP-2', status: 'COMPLETED', amount: { value: '9.00', currency_code: 'EUR' } }
            ]
        }),
        attempt: attempt(),
        catalog: CATALOG
    });

    assert.equal(reconciliation.status, 'unchecked');
    assert.equal(reconciliation.reason, 'mixed_capture_currency');
    assert.equal(reconciliation.quoted.value_cents, 1900, 'the quote is still reported');
});

test('a missing attempt record is unchecked, never ok', () => {
    const reconciliation = reconcileCapturedPayment({ order: order(), attempt: null, catalog: CATALOG });

    assert.equal(reconciliation.status, 'unchecked');
    assert.equal(reconciliation.reason, 'quote_record_unavailable');
    assert.equal(reconciliation.quoted, null);
    assert.equal(reconciliation.catalog_revision, 'unchecked');
});

test('an attempt record without quote facts is unchecked', () => {
    const reconciliation = reconcileCapturedPayment({
        order: order(),
        attempt: { quote_id: 'q_capture', order: { id: 'ORDER-1' }, quote: null },
        catalog: CATALOG
    });

    assert.equal(reconciliation.status, 'unchecked');
    assert.equal(reconciliation.reason, 'quote_record_incomplete');
});

test('conflicting quote ids between custom_id and invoice_id are unchecked', () => {
    const reconciliation = reconcileCapturedPayment({
        order: order({ quoteId: 'q_custom', invoiceId: 'q=q_invoice|d=sha256:abc123' }),
        attempt: { quote_id: 'q_custom', quote: QUOTE },
        catalog: CATALOG
    });

    assert.equal(reconciliation.status, 'unchecked');
    assert.equal(reconciliation.reason, 'quote_id_conflict');
});

test('an order without quote metadata is unchecked', () => {
    const reconciliation = reconcileCapturedPayment({ order: order({ quoteId: null }), attempt: null, catalog: CATALOG });

    assert.equal(reconciliation.status, 'unchecked');
    assert.equal(reconciliation.reason, 'quote_reference_missing');
});

test('an order whose capture has not completed is unchecked, not compared', () => {
    const reconciliation = reconcileCapturedPayment({
        order: order({
            captures: [{ id: 'CAP-1', status: 'PENDING', amount: { value: '19.00', currency_code: 'USD' } }]
        }),
        attempt: attempt(),
        catalog: CATALOG
    });

    assert.equal(reconciliation.status, 'unchecked');
    assert.equal(reconciliation.reason, 'capture_not_settled');
    assert.equal(reconciliation.captured.value_cents, null);
    assert.equal(reconciliation.quoted.value_cents, 1900, 'the quote is still reported');
});

test('a capture without an amount is unchecked', () => {
    const reconciliation = reconcileCapturedPayment({
        order: order({ amount: null }),
        attempt: attempt(),
        catalog: CATALOG
    });

    assert.equal(reconciliation.status, 'unchecked');
    assert.equal(reconciliation.reason, 'missing_captured_amount');
});

test('a catalog change after the order is reported separately from the amount', () => {
    const reconciliation = reconcileCapturedPayment({
        order: order(),
        attempt: attempt(),
        catalog: { ...CATALOG, digest: 'sha256:newer', version: '2' }
    });

    assert.equal(reconciliation.status, 'ok', 'an accurate capture is still accurate');
    assert.equal(reconciliation.catalog_revision, 'mismatch');
    assert.equal(reconciliation.catalog_revision_reason, 'catalog_revision_changed');
    assert.equal(reconciliation.quoted.catalog_digest, 'sha256:abc123');
    assert.equal(reconciliation.catalog_digest_current, 'sha256:newer');
});

test('an unreadable catalog leaves the revision unchecked, not clean', () => {
    const reconciliation = reconcileCapturedPayment({
        order: order(),
        attempt: attempt(),
        catalog: null,
        catalogError: 'course-catalog.json is unreadable'
    });

    assert.equal(reconciliation.status, 'ok');
    assert.equal(reconciliation.catalog_revision, 'unchecked');
    assert.equal(reconciliation.catalog_revision_reason, 'course-catalog.json is unreadable');
});
