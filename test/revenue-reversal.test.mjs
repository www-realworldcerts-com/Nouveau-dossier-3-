import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Reversal rows are provider-backed too, so recording one binds its settlement
// evidence. Keep that chain file out of the repository.
process.env.EVIDENCE_CHAIN_PATH = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-chain-')),
    'evidence-chain.json'
);

import { mapPayPalWebhookToRevenueReversal } from '../src/paypal-event-mapper.mjs';
import {
    REVENUE_REVERSAL_WITHOUT_CAPTURE,
    applyRevenueReversal,
    findCaptureRecord,
    readLedgerRecords
} from '../src/real/ledger/reversals.mjs';
import { summarizeRevenueEvents } from '../src/real/revenue-verification.mjs';
import { writeJsonAtomic } from '../src/security/data-at-rest.mjs';

const PAYPAL_CAPTURE = '3C679366HH908993F';

function ledgerDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'reversals-'));
}

function captureRecord(overrides = {}) {
    return {
        event_id: 'WH-CAPTURE-1',
        amount: 75,
        currency: 'USD',
        occurred_at: '2026-01-03T16:00:00.000Z',
        source: 'paypal',
        status: 'VERIFIED',
        verification_proof: { type: 'psp_transaction_id', psp_id: PAYPAL_CAPTURE },
        metadata: { kind: 'client_to_owner', paypal_capture_id: PAYPAL_CAPTURE },
        ...overrides
    };
}

function refundEvent(overrides = {}) {
    return {
        id: 'WH-REFUND-1',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        create_time: '2026-02-01T10:00:00Z',
        resource: {
            id: 'REFUND-1',
            status: 'COMPLETED',
            amount: { value: '75.00', currency_code: 'USD' },
            links: [
                { rel: 'self', href: 'https://api.paypal.com/v2/payments/refunds/REFUND-1' },
                { rel: 'up', href: `https://api.paypal.com/v2/payments/captures/${PAYPAL_CAPTURE}` }
            ]
        },
        ...overrides
    };
}

test('maps a capture refund to the capture it takes money back from', () => {
    const reversal = mapPayPalWebhookToRevenueReversal(refundEvent());
    assert.ok(reversal);
    assert.equal(reversal.type, 'refunded');
    assert.equal(reversal.original_capture_id, PAYPAL_CAPTURE);
    assert.equal(reversal.amount, 75);
    assert.equal(reversal.currency, 'USD');
    assert.equal(reversal.externalId, 'REFUND_REFUND-1');
    assert.equal(reversal.metadata.paypal_refund_id, 'REFUND-1');
});

test('maps a capture reversal and a dispute to the original capture', () => {
    const reversed = mapPayPalWebhookToRevenueReversal({
        id: 'WH-REVERSED-1',
        event_type: 'PAYMENT.CAPTURE.REVERSED',
        create_time: '2026-02-02T10:00:00Z',
        resource: { id: PAYPAL_CAPTURE, status: 'REVERSED', amount: { value: '75.00', currency_code: 'USD' } }
    });
    assert.equal(reversed.type, 'reversed');
    assert.equal(reversed.original_capture_id, PAYPAL_CAPTURE);
    assert.equal(reversed.amount, 75);

    const disputed = mapPayPalWebhookToRevenueReversal({
        id: 'WH-DISPUTE-1',
        event_type: 'CUSTOMER.DISPUTE.CREATED',
        create_time: '2026-02-03T10:00:00Z',
        resource: {
            dispute_id: 'PP-D-123456',
            status: 'OPEN',
            reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
            disputed_transactions: [{ seller_transaction_id: PAYPAL_CAPTURE }]
        }
    });
    assert.equal(disputed.type, 'disputed');
    assert.equal(disputed.original_capture_id, PAYPAL_CAPTURE);
    assert.equal(disputed.amount, null, 'a dispute without a stated amount reverses the capture');
    assert.equal(disputed.metadata.paypal_dispute_id, 'PP-D-123456');
});

test('other events are not reversals', () => {
    assert.equal(
        mapPayPalWebhookToRevenueReversal({ id: 'WH-1', event_type: 'PAYMENT.CAPTURE.COMPLETED' }),
        null
    );
});

test('a refund writes a negative event keyed to the capture and nets revenue to zero', () => {
    const dir = ledgerDir();
    writeJsonAtomic(path.join(dir, 'revenue_paypal.json'), captureRecord());

    const report = applyRevenueReversal({
        dir,
        reversal: mapPayPalWebhookToRevenueReversal(refundEvent()),
        apply: true,
        now: '2026-02-01T10:00:01.000Z'
    });

    assert.equal(report.applied, true);
    assert.equal(report.reason, 'reversed');
    assert.equal(report.capture_event_id, 'WH-CAPTURE-1');

    const saved = JSON.parse(fs.readFileSync(report.file, 'utf8'));
    assert.equal(saved.amount, -75);
    assert.equal(saved.currency, 'USD');
    assert.equal(saved.status, 'refunded');
    assert.equal(saved.reversal_of, PAYPAL_CAPTURE, 'the reversal is keyed to the original capture');
    assert.equal(saved.verification_proof.psp_id, PAYPAL_CAPTURE);
    assert.equal(saved.metadata.paypal_refund_id, 'REFUND-1');

    const records = readLedgerRecords(dir).records.map(({ record }) => record);
    const summary = summarizeRevenueEvents(records);
    assert.equal(summary.events, 2, 'the original capture stays on the ledger');
    assert.equal(summary.verified, 2);
    assert.deepEqual(
        summary.by_currency.map((row) => [row.currency, row.verified]),
        [['USD', 0]],
        'the refund nets the captured revenue to zero'
    );
});

test('a reversal with no matching capture reports a loud finding and writes nothing', () => {
    const dir = ledgerDir();
    writeJsonAtomic(path.join(dir, 'revenue_other.json'), captureRecord({ metadata: {}, verification_proof: null }));
    const before = fs.readdirSync(dir);

    const report = applyRevenueReversal({
        dir,
        reversal: mapPayPalWebhookToRevenueReversal(refundEvent()),
        apply: true
    });

    assert.equal(report.applied, false);
    assert.equal(report.reason, 'capture_not_found');
    assert.equal(report.finding.code, REVENUE_REVERSAL_WITHOUT_CAPTURE);
    assert.equal(report.finding.severity, 'critical');
    assert.equal(report.finding.evidence.capture_id, PAYPAL_CAPTURE);
    assert.equal(report.finding.evidence.reversal_event_id, 'REFUND_REFUND-1');
    assert.deepEqual(fs.readdirSync(dir), before, 'the unmatched reversal is never silently written');
});

test('replaying the same refund does not reverse the capture twice', () => {
    const dir = ledgerDir();
    writeJsonAtomic(path.join(dir, 'revenue_paypal.json'), captureRecord());
    const reversal = mapPayPalWebhookToRevenueReversal(refundEvent());

    applyRevenueReversal({ dir, reversal, apply: true });
    const second = applyRevenueReversal({ dir, reversal, apply: true });

    assert.equal(second.applied, false);
    assert.equal(second.reason, 'already_reversed');
    assert.equal(fs.readdirSync(dir).filter((file) => file.startsWith('reversal_')).length, 1);
});

test('a partial refund reverses only the refunded amount, and a dispute defaults to the capture amount', () => {
    const dir = ledgerDir();
    writeJsonAtomic(path.join(dir, 'revenue_paypal.json'), captureRecord());

    const partial = refundEvent({
        resource: {
            ...refundEvent().resource,
            id: 'REFUND-PARTIAL',
            amount: { value: '20.00', currency_code: 'USD' }
        }
    });
    const report = applyRevenueReversal({
        dir,
        reversal: mapPayPalWebhookToRevenueReversal(partial),
        apply: true
    });
    assert.equal(report.reversal.amount, -20);
    assert.equal(report.reversal.reversal_of, PAYPAL_CAPTURE);

    const records = readLedgerRecords(dir).records.map(({ record }) => record);
    assert.equal(summarizeRevenueEvents([records[0], records[1]]).by_currency[0].verified, 55);

    const dispute = mapPayPalWebhookToRevenueReversal({
        id: 'WH-DISPUTE-2',
        event_type: 'CUSTOMER.DISPUTE.CREATED',
        resource: {
            dispute_id: 'PP-D-654321',
            disputed_transactions: [{ seller_transaction_id: PAYPAL_CAPTURE }]
        }
    });
    const disputeReport = applyRevenueReversal({ dir, reversal: dispute, apply: true });
    assert.equal(disputeReport.reversal.amount, -75, 'no stated amount reverses the captured amount');

    const all = readLedgerRecords(dir).records.map(({ record }) => record);
    assert.equal(summarizeRevenueEvents(all).by_currency[0].verified, -20, 'both reversals land against the capture');
    assert.equal(findCaptureRecord(readLedgerRecords(dir).records, PAYPAL_CAPTURE).record.event_id, 'WH-CAPTURE-1');
});
