import assert from 'node:assert/strict';
import test from 'node:test';

import { readBase44RevenueReversals } from '../src/base44-revenue.mjs';
import { detectSilentFailures, mergeRevenueReversals } from '../src/resilience/silent-failure.mjs';

const NOW = new Date('2026-11-22T10:00:00Z');
const DAY = 86400000;
const CAPTURE = '5O190127TN364715T';

const CFG = {
    entityName: 'RevenueEvent',
    defaultCurrency: 'USD',
    allowNonPositiveAmounts: false,
    fieldMap: {
        amount: 'amount',
        currency: 'currency',
        occurredAt: 'occurred_at',
        externalId: 'event_id',
        status: 'status',
        metadata: 'metadata'
    }
};

/** A Base44 client whose RevenueEvent.list serves these rows, newest first. */
function fakeBase44(rows) {
    const calls = [];
    return {
        calls,
        base44: {
            asServiceRole: {
                entities: {
                    RevenueEvent: {
                        list: async (order, limit, offset) => {
                            calls.push({ order, limit, offset });
                            return rows.slice(offset, offset + limit);
                        }
                    }
                }
            }
        }
    };
}

/** A negative Base44 row as `createBase44RevenueReversal` writes it. */
function base44Reversal(overrides = {}) {
    const capture = overrides.capture ?? CAPTURE;
    const type = overrides.type ?? 'refunded';
    return {
        id: overrides.id ?? 'rev-row-1',
        amount: overrides.amount ?? -19,
        currency: 'USD',
        occurred_at: overrides.occurred_at ?? new Date(NOW.getTime() - DAY).toISOString(),
        event_id: overrides.event_id ?? `${type}_${capture}`,
        // A reversal row is VERIFIED because its capture id is provider evidence.
        status: 'VERIFIED',
        metadata: {
            psp_transaction_id: capture,
            reversal_of: capture,
            reversal_type: type,
            paypal_refund_id: 'REF-1'
        }
    };
}

/** A capture row: revenue, but not a reversal. */
function base44Capture() {
    return {
        id: 'rev-row-capture',
        amount: 19,
        currency: 'USD',
        occurred_at: new Date(NOW.getTime() - 2 * DAY).toISOString(),
        event_id: 'CAPTURE-EVENT-1',
        status: 'VERIFIED',
        metadata: { paypal_capture_id: CAPTURE }
    };
}

function deliveredLine() {
    return {
        timestamp: new Date(NOW.getTime() - 2 * DAY).toISOString(),
        order_id: 'ORD-DELIVERED',
        product: 'CBE practice tests',
        status: 'DELIVERED',
        capture_id: CAPTURE
    };
}

function cleanOptions(overrides = {}) {
    return {
        now: NOW,
        heartbeat: { status: 'ok', at: new Date(NOW.getTime() - 60000).toISOString(), ok: true },
        revenue: { last_activity_at: new Date(NOW.getTime() - DAY).toISOString(), sources: [] },
        procurement: [],
        fulfillment: [],
        silentCatches: { count: 0, samples: [] },
        auditLatest: new Date(NOW.getTime() - DAY).toISOString(),
        tickMonotony: { samples: 0, duplicate_rate: 0 },
        ...overrides
    };
}

test('a Base44 reversal row is read in the shape the audit joins on', async () => {
    const { base44 } = fakeBase44([base44Reversal(), base44Capture()]);

    const read = await readBase44RevenueReversals(base44, CFG, { since: new Date(NOW.getTime() - 30 * DAY).toISOString() });

    assert.equal(read.records.length, 1, 'the capture row is not a reversal');
    assert.equal(read.truncated, false);
    const [entry] = read.records;
    assert.equal(entry.file, 'base44:rev-row-1');
    assert.equal(entry.source, 'base44');
    assert.equal(entry.record.reversal_of, CAPTURE);
    assert.equal(entry.record.status, 'refunded', 'status carries the reversal kind, not the ledger column');
    assert.equal(entry.record.ledger_status, 'VERIFIED');
    assert.equal(entry.record.amount, -19);
    assert.equal(entry.record.event_id, `refunded_${CAPTURE}`);
    assert.equal(entry.record.paypal_refund_id, 'REF-1');
});

test('a reversal older than the audit window is not returned', async () => {
    const old = base44Reversal({ occurred_at: new Date(NOW.getTime() - 60 * DAY).toISOString() });
    const { base44 } = fakeBase44([old]);

    const read = await readBase44RevenueReversals(base44, CFG, { since: new Date(NOW.getTime() - 30 * DAY).toISOString() });

    assert.equal(read.records.length, 0);
});

test('hitting the row cap is reported, not silently truncated', async () => {
    const { base44 } = fakeBase44([base44Reversal({ id: 'r1' }), base44Reversal({ id: 'r2' }), base44Reversal({ id: 'r3' })]);

    const read = await readBase44RevenueReversals(base44, CFG, { maxRows: 2 });

    assert.equal(read.truncated, true);
    assert.equal(read.scanned, 2);
});

test('the same reversal seen in both ledgers is counted once, production first', () => {
    const base44 = {
        directory: 'base44:RevenueEvent',
        records: [{ file: 'base44:rev-row-1', source: 'base44', record: { event_id: `refunded_${CAPTURE}`, reversal_of: CAPTURE, status: 'refunded', amount: -19 } }]
    };
    const local = {
        directory: '/tmp/ledger',
        records: [
            { file: 'reversal_refund_1.json', record: { event_id: `refunded_${CAPTURE}`, reversal_of: CAPTURE, status: 'refunded', amount: -19 } },
            { file: 'reversal_dispute_2.json', record: { event_id: `disputed_${CAPTURE}`, reversal_of: CAPTURE, status: 'disputed', amount: -19 } }
        ]
    };

    const merged = mergeRevenueReversals([base44, local], { base44: { status: 'ok' } });

    assert.equal(merged.records.length, 2, 'the duplicated refund is one row, the dispute is kept');
    assert.equal(merged.records[0].source, 'base44', 'the production row wins over the local copy');
    assert.equal(merged.directory, 'base44:RevenueEvent + /tmp/ledger');
    assert.equal(merged.base44.status, 'ok');
});

test('a Base44-only reversal on a delivered order is the finding', async () => {
    const { base44 } = fakeBase44([base44Reversal()]);
    const read = await readBase44RevenueReversals(base44, CFG);
    const reversals = mergeRevenueReversals([read], {
        base44: { status: 'ok', scanned: read.scanned, reversals: read.records.length, truncated: read.truncated }
    });

    const { findings, evidence } = detectSilentFailures(cleanOptions({
        fulfillment: [deliveredLine()],
        reversals
    }));

    const finding = findings.find(item => item.code === 'REVENUE_REVERSED_AFTER_FULFILLMENT');
    assert.ok(finding, 'a reversal the local ledger never saw must still raise the finding');
    const [order] = finding.evidence.orders;
    assert.equal(order.order_id, 'ORD-DELIVERED');
    assert.equal(order.capture_id, CAPTURE);
    assert.equal(order.reversal_type, 'refunded');
    assert.equal(finding.evidence.base44.status, 'ok');
    assert.equal(evidence.reversals.base44.status, 'ok');
    assert.equal(evidence.reversals.scanned, 1);
});

test('an unavailable Base44 read is visible in the evidence beside a local finding', () => {
    const local = {
        directory: '/tmp/ledger',
        records: [{ file: 'reversal_x.json', record: { event_id: `refunded_${CAPTURE}`, reversal_of: CAPTURE, status: 'refunded', amount: -19, occurred_at: new Date(NOW.getTime() - DAY).toISOString() } }]
    };
    const reversals = mergeRevenueReversals([local], {
        base44: { status: 'unavailable', reason: 'missing_base44_credentials', missing: ['BASE44_APP_ID'] }
    });

    const { findings, evidence } = detectSilentFailures(cleanOptions({
        fulfillment: [deliveredLine()],
        reversals
    }));

    assert.ok(findings.some(item => item.code === 'REVENUE_REVERSED_AFTER_FULFILLMENT'));
    assert.equal(evidence.reversals.base44.reason, 'missing_base44_credentials');
});
