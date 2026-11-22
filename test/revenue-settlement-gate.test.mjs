import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { authorizeRevenueSettlement } from '../src/base44-revenue.mjs';
import { EvidenceIntegrityChain } from '../src/real/evidence-integrity.mjs';
import { RedressEngine } from '../src/resilience/redress.mjs';

// Capture ids in the shape PayPal issues (17 uppercase alphanumerics).
const CAPTURE = '5O190127TN364715T';
const OTHER_CAPTURE = '5O190127TN364715X';

const CFG = {
    entityName: 'RevenueEvent',
    defaultCurrency: 'USD',
    allowNonPositiveAmounts: false,
    fieldMap: {
        amount: 'amount',
        currency: 'currency',
        occurredAt: 'occurred_at',
        source: 'source',
        externalId: 'event_id',
        status: 'status',
        payoutBatchId: 'payout_batch_id',
        eventHash: 'event_hash',
        missionId: 'mission_id',
        missionTitle: 'mission_title',
        agentIds: 'agent_ids',
        metadata: 'metadata'
    }
};

function revenueRow({ metadata = {}, status = 'VERIFIED', amount = 19 } = {}) {
    return {
        id: 'rev-1',
        created_date: '2026-11-20T10:00:00.000Z',
        amount,
        currency: 'USD',
        occurred_at: '2026-11-20T09:59:00.000Z',
        event_id: 'WH-EVENT-0001',
        status,
        metadata
    };
}

function fakeBase44(row) {
    const updates = [];
    return {
        updates,
        base44: {
            asServiceRole: {
                entities: {
                    RevenueEvent: {
                        filter: async () => (row ? [row] : []),
                        update: async (id, patch) => {
                            updates.push({ id, patch });
                            return { id, ...patch };
                        }
                    }
                }
            }
        }
    };
}

/** The chain is a filesystem concern, tested where it lives. */
function stubChain(t) {
    const saved = {
        fetch: EvidenceIntegrityChain.fetchBlockForEvent,
        add: EvidenceIntegrityChain.addBlock,
        assert: EvidenceIntegrityChain.assertEventBound,
        allowed: RedressEngine.prototype.isSettlementAllowed
    };
    const blocks = [];
    EvidenceIntegrityChain.fetchBlockForEvent = async () => null;
    EvidenceIntegrityChain.addBlock = async (eventId, proof) => {
        blocks.push({ eventId, proof });
        return { eventId, proof };
    };
    EvidenceIntegrityChain.assertEventBound = async () => true;
    RedressEngine.prototype.isSettlementAllowed = () => true;
    t.after(() => {
        EvidenceIntegrityChain.fetchBlockForEvent = saved.fetch;
        EvidenceIntegrityChain.addBlock = saved.add;
        EvidenceIntegrityChain.assertEventBound = saved.assert;
        RedressEngine.prototype.isSettlementAllowed = saved.allowed;
    });
    return blocks;
}

/** A registry that has received verified webhooks for these ids. */
function useRegistry(t, ids) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revenue-settlement-'));
    const file = path.join(dir, 'verified-webhooks.ndjson');
    fs.writeFileSync(
        file,
        ids.map(id => JSON.stringify({ provider: 'paypal', psp_id: id })).join('\n') + '\n',
        'utf8'
    );
    const previous = process.env.PSP_WEBHOOK_REGISTRY_FILE;
    process.env.PSP_WEBHOOK_REGISTRY_FILE = file;
    t.after(() => {
        if (previous === undefined) delete process.env.PSP_WEBHOOK_REGISTRY_FILE;
        else process.env.PSP_WEBHOOK_REGISTRY_FILE = previous;
    });
}

test('a row whose only proof is self-issued is refused before the gate', async t => {
    const blocks = stubChain(t);
    const { base44, updates } = fakeBase44(revenueRow({
        metadata: {
            verification_proof: {
                type: 'autonomous_execution',
                psp_id: 'PROOF_1767462283250',
                amount: 19,
                currency: 'USD'
            }
        }
    }));

    const result = await authorizeRevenueSettlement(base44, CFG, { revenueEventId: 'rev-1' });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'self_issued_proof');
    assert.equal(result.psp_id, 'PROOF_1767462283250');
    assert.deepEqual(updates, [], 'nothing may be written for an unproven row');
    assert.deepEqual(blocks, [], 'no evidence block is bound to an unproven row');
});

test('a row with no provider id at all is refused', async t => {
    stubChain(t);
    const { base44, updates } = fakeBase44(revenueRow({ metadata: {} }));

    const result = await authorizeRevenueSettlement(base44, CFG, { revenueEventId: 'rev-1' });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_provider_transaction_id');
    assert.deepEqual(updates, []);
});

test('a provider-backed row that a verified webhook named is approved and chain-bound', async t => {
    const blocks = stubChain(t);
    useRegistry(t, [CAPTURE]);
    const { base44 } = fakeBase44(revenueRow({ metadata: { paypal_capture_id: CAPTURE } }));

    const result = await authorizeRevenueSettlement(base44, CFG, { revenueEventId: 'rev-1' });

    assert.equal(result.ok, true);
    assert.equal(result.provider, 'paypal');
    assert.equal(result.psp_id, CAPTURE);
    assert.equal(result.evidence, 'paypal_capture_id');
    assert.equal(blocks.length, 1, 'the settlement proof is bound to the row');
    assert.equal(blocks[0].eventId, 'rev-1');
    assert.equal(blocks[0].proof.psp_id, CAPTURE);
    assert.equal(blocks[0].proof.amount, 19);
    assert.equal(blocks[0].proof.currency, 'USD');
});

test('a provider-shaped id no verified webhook named is refused by the gate', async t => {
    stubChain(t);
    useRegistry(t, [CAPTURE]);
    const { base44, updates } = fakeBase44(revenueRow({ metadata: { paypal_capture_id: OTHER_CAPTURE } }));

    const result = await authorizeRevenueSettlement(base44, CFG, { revenueEventId: 'rev-1' });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'gate_refused');
    assert.match(result.error, /psp_confirmation_missing/);
    assert.deepEqual(updates, []);
});

test('a Base44 client that throws is reported as a refusal, not an exception', async t => {
    stubChain(t);
    const base44 = {
        get asServiceRole() {
            throw new Error('base44_unavailable');
        }
    };

    const result = await authorizeRevenueSettlement(base44, CFG, { revenueEventId: 'rev-1' });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'gate_error');
    assert.match(result.error, /base44_unavailable/);
});

test('a missing revenue row is refused instead of authorised', async t => {
    stubChain(t);
    const { base44, updates } = fakeBase44(null);

    const result = await authorizeRevenueSettlement(base44, CFG, { revenueEventId: 'rev-missing' });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'revenue_event_not_found');
    assert.deepEqual(updates, []);
});
