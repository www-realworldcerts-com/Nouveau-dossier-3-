import assert from 'node:assert/strict';
import test from 'node:test';

import { createBase44RevenueReversal, getRevenueConfigFromEnv } from '../src/base44-revenue.mjs';
import { REVENUE_REVERSAL_WITHOUT_CAPTURE } from '../src/real/ledger/reversals.mjs';

const CAPTURE_ID = '3C679366HH908993F';
const MISSING_CAPTURE_ID = '2GG279541U471931P';
const REFUND_ID = '8AB12345CD678901E';

const cfg = getRevenueConfigFromEnv();

function captureRow(overrides = {}) {
    return {
        id: 'row_capture_1',
        event_id: 'WH-CAPTURE-1',
        amount: 30,
        currency: 'USD',
        occurred_at: '2026-02-01T10:00:00.000Z',
        metadata: { kind: 'client_to_owner', paypal_capture_id: CAPTURE_ID },
        ...overrides
    };
}

function reversal({ captureId = CAPTURE_ID, amount = 30, type = 'refunded' } = {}) {
    return {
        type,
        amount,
        currency: 'USD',
        occurredAt: '2026-02-10T09:00:00.000Z',
        source: 'paypal',
        externalId: `REFUND_${REFUND_ID}`,
        original_capture_id: captureId,
        metadata: { paypal_refund_id: REFUND_ID, paypal_event_type: 'PAYMENT.CAPTURE.REFUNDED' }
    };
}

function stubBase44({ rows = [captureRow()], existing = [] } = {}) {
    const created = [];
    const base44 = {
        asServiceRole: {
            entities: {
                RevenueEvent: {
                    list: async (_sort, limit = 250, offset = 0) => rows.slice(offset, offset + limit),
                    filter: async () => existing,
                    create: async (data) => {
                        created.push(data);
                        return { id: `row_reversal_${created.length}`, ...data };
                    }
                }
            }
        }
    };
    return { base44, created };
}

test('a refund writes a negative VERIFIED row keyed to the original capture', async () => {
    const { base44, created } = stubBase44();

    const report = await createBase44RevenueReversal(base44, cfg, reversal());

    assert.equal(report.applied, true);
    assert.equal(report.reason, 'reversed');
    assert.equal(report.capture_event_id, 'WH-CAPTURE-1');
    assert.equal(report.reversal_event_id, `REFUND_${REFUND_ID}`);

    assert.equal(created.length, 1);
    const row = created[0];
    assert.equal(row.amount, -30);
    assert.equal(row.currency, 'USD');
    assert.equal(row.event_id, `REFUND_${REFUND_ID}`);
    assert.equal(row.status, 'VERIFIED');
    assert.equal(row.metadata.reversal_of, CAPTURE_ID);
    assert.equal(row.metadata.reversal_type, 'refunded');
    assert.equal(row.metadata.psp_transaction_id, CAPTURE_ID);
    assert.equal(row.metadata.paypal_refund_id, REFUND_ID);
    assert.equal(row.metadata.verification.verified, true);
});

test('a partial refund reverses only the refunded amount and a dispute reverses the capture', async () => {
    const partial = stubBase44();
    await createBase44RevenueReversal(partial.base44, cfg, reversal({ amount: 12 }));
    assert.equal(partial.created[0].amount, -12);

    const dispute = stubBase44();
    await createBase44RevenueReversal(dispute.base44, cfg, reversal({ amount: null, type: 'disputed' }));
    assert.equal(dispute.created[0].amount, -30, 'no stated amount reverses the captured amount');
    assert.equal(dispute.created[0].metadata.reversal_type, 'disputed');
});

test('a capture row in Base44 is found by its capture id, not only by event id', async () => {
    const { base44, created } = stubBase44({
        rows: [captureRow({ id: 'row_other', event_id: 'WH-OTHER' })]
    });

    const report = await createBase44RevenueReversal(base44, cfg, reversal());
    assert.equal(report.applied, true);
    assert.equal(created.length, 1);
});

test('a replay does not write the reversal twice', async () => {
    const { base44, created } = stubBase44({ existing: [{ id: 'row_existing' }] });

    const report = await createBase44RevenueReversal(base44, cfg, reversal());

    assert.equal(report.applied, false);
    assert.equal(report.reason, 'already_reversed');
    assert.equal(created.length, 0);
});

test('a reversal whose capture row is missing from Base44 is a critical finding, not a write', async () => {
    const { base44, created } = stubBase44();

    const report = await createBase44RevenueReversal(base44, cfg, reversal({ captureId: MISSING_CAPTURE_ID }));

    assert.equal(report.applied, false);
    assert.equal(report.reason, 'capture_not_found');
    assert.equal(report.finding.code, REVENUE_REVERSAL_WITHOUT_CAPTURE);
    assert.equal(report.finding.severity, 'critical');
    assert.equal(report.finding.evidence.capture_id, MISSING_CAPTURE_ID);
    assert.equal(report.finding.evidence.amount, 30);
    assert.match(report.finding.detail, /Base44 RevenueEvent ledger/);
    assert.equal(created.length, 0);
});

test('an already-written reversal row is never mistaken for the capture it reverses', async () => {
    const { base44, created } = stubBase44({
        rows: [
            captureRow({
                id: 'row_prior_reversal',
                event_id: `REFUND_${REFUND_ID}`,
                amount: -30,
                metadata: { reversal_of: CAPTURE_ID, psp_transaction_id: CAPTURE_ID }
            })
        ]
    });

    const report = await createBase44RevenueReversal(base44, cfg, reversal());

    assert.equal(report.applied, false);
    assert.equal(report.finding.code, REVENUE_REVERSAL_WITHOUT_CAPTURE);
    assert.equal(created.length, 0);
});
