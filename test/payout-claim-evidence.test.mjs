import assert from 'node:assert/strict';
import test from 'node:test';

import {
    PAYOUT_EVIDENCE_FAILED,
    PAYOUT_EVIDENCE_SETTLED,
    PAYOUT_EVIDENCE_UNKNOWN,
    readPayoutClaimEvidence
} from '../src/financial/payout-claim-evidence.mjs';

/** A payout-item entity as the ledger returns it, filtered in memory. */
function fakeBase44(records, { throwOnRead = false } = {}) {
    return {
        asServiceRole: {
            entities: {
                PayoutItem: {
                    filter: async filter => {
                        if (throwOnRead) throw new Error('payout item read failed');
                        return records.filter(record =>
                            Object.entries(filter).every(([key, value]) => record[key] === value)
                        );
                    }
                }
            }
        }
    };
}

const batchId = 'BATCH_PAYONEER_0123456789abcdef01234567';

function claim(overrides = {}) {
    return { batch_id: batchId, rail: 'PAYONEER', revenue_event_ids: ['rev-1', 'rev-2'], amount: 38, currency: 'USD', ...overrides };
}

test('a payout item that succeeded for every row settles the claim', async () => {
    const base44 = fakeBase44([
        // One row under the provider's batch id, one under the daemon's own.
        { id: 'pi-1', batch_id: 'PAYPAL-BATCH-9', revenue_event_id: 'rev-1', status: 'success', transaction_id: 'TXN-1' },
        { id: 'pi-2', batch_id: batchId, revenue_event_id: 'rev-2', status: 'paid' }
    ]);

    const evidence = await readPayoutClaimEvidence(base44, claim());

    assert.equal(evidence.outcome, PAYOUT_EVIDENCE_SETTLED);
    assert.equal(evidence.provider_batch_id, 'PAYPAL-BATCH-9');
    assert.deepEqual(evidence.rows, [
        { id: 'rev-1', status: 'success' },
        { id: 'rev-2', status: 'paid' }
    ]);
});

test('a batch the provider recorded as failed is not money moved', async () => {
    const base44 = fakeBase44([
        { id: 'pi-1', batch_id: batchId, revenue_event_id: 'rev-1', status: 'failed' },
        { id: 'pi-2', batch_id: batchId, revenue_event_id: 'rev-2', status: 'denied' }
    ]);

    const evidence = await readPayoutClaimEvidence(base44, claim());
    assert.equal(evidence.outcome, PAYOUT_EVIDENCE_FAILED);
});

test('a failure recorded by another batch says nothing about this one', async () => {
    // An older payout for the same row failed. This claim's money may still be
    // on its way, so its rows must not be released for a second payment.
    const base44 = fakeBase44([
        { id: 'pi-old', batch_id: 'PAYPAL-BATCH-OLD', revenue_event_id: 'rev-1', status: 'failed' }
    ]);

    const evidence = await readPayoutClaimEvidence(base44, claim());
    assert.equal(evidence.outcome, PAYOUT_EVIDENCE_UNKNOWN);
});

test('partial or pending evidence is withheld, never guessed', async () => {
    const base44 = fakeBase44([
        { id: 'pi-1', batch_id: batchId, revenue_event_id: 'rev-1', status: 'success' },
        { id: 'pi-2', batch_id: batchId, revenue_event_id: 'rev-2', status: 'pending' }
    ]);

    const evidence = await readPayoutClaimEvidence(base44, claim());
    assert.equal(evidence.outcome, PAYOUT_EVIDENCE_UNKNOWN);
    assert.match(evidence.reason, /do not settle every row/);
});

test('no payout item for the batch cannot be checked', async () => {
    const evidence = await readPayoutClaimEvidence(fakeBase44([]), claim());
    assert.equal(evidence.outcome, PAYOUT_EVIDENCE_UNKNOWN);
    assert.match(evidence.reason, /no payout item/);
});

test('an unreadable payout ledger is unknown, not an empty one', async () => {
    const evidence = await readPayoutClaimEvidence(fakeBase44([], { throwOnRead: true }), claim());
    assert.equal(evidence.outcome, PAYOUT_EVIDENCE_UNKNOWN);
    assert.match(evidence.reason, /could not be read/);
});
