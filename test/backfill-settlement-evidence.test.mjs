import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    authorizeRevenueSettlement,
    getRevenueConfigFromEnv
} from '../src/base44-revenue.mjs';
import { EvidenceIntegrityChain } from '../src/real/evidence-integrity.mjs';
import { RedressEngine } from '../src/resilience/redress.mjs';
import { backfillSettlementEvidence } from '../scripts/backfill-settlement-evidence.mjs';

// Capture ids in the shape PayPal issues (17 uppercase alphanumerics).
const CAPTURE = '5O190127TN364715T';
const OTHER_CAPTURE = '2GG279541U471931P';

/** The chain is a file: each test gets its own, the repository stays clean. */
function useChain(t) {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-chain-')), 'evidence-chain.json');
    const previous = process.env.EVIDENCE_CHAIN_PATH;
    process.env.EVIDENCE_CHAIN_PATH = file;
    t.after(() => {
        if (previous === undefined) delete process.env.EVIDENCE_CHAIN_PATH;
        else process.env.EVIDENCE_CHAIN_PATH = previous;
    });
    return {
        blocks: () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [])
    };
}

/** The registry of webhooks PayPal actually verified. */
function useRegistry(t, ids) {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-registry-')), 'verified-webhooks.ndjson');
    fs.writeFileSync(file, ids.map(id => JSON.stringify({ provider: 'paypal', psp_id: id })).join('\n') + '\n', 'utf8');
    const previous = process.env.PSP_WEBHOOK_REGISTRY_FILE;
    process.env.PSP_WEBHOOK_REGISTRY_FILE = file;
    t.after(() => {
        if (previous === undefined) delete process.env.PSP_WEBHOOK_REGISTRY_FILE;
        else process.env.PSP_WEBHOOK_REGISTRY_FILE = previous;
    });
}

/** A production ledger row as the entity returns it. */
function revenueRow(overrides = {}) {
    return {
        id: 'rev-good',
        amount: 19,
        currency: 'USD',
        occurred_at: '2026-11-20T09:59:00.000Z',
        source: 'paypal',
        event_id: 'WH-EVENT-0001',
        status: 'VERIFIED',
        metadata: { paypal_capture_id: CAPTURE },
        ...overrides
    };
}

function fakeBase44(rows) {
    return {
        asServiceRole: {
            entities: {
                RevenueEvent: {
                    list: async (_sort, limit, offset) => rows.slice(offset, offset + limit),
                    filter: async (predicate = {}) => rows.filter(row => !predicate?.id || row.id === predicate.id)
                }
            }
        }
    };
}

function byId(report) {
    return Object.fromEntries(report.results.map(result => [result.id, result]));
}

test('a report run names what it would bind and writes nothing', async t => {
    const chain = useChain(t);
    useRegistry(t, [CAPTURE]);
    const base44 = fakeBase44([
        revenueRow(),
        revenueRow({ id: 'rev-unknown', metadata: { paypal_capture_id: OTHER_CAPTURE } }),
        revenueRow({
            id: 'rev-invented',
            metadata: { verification_proof: { type: 'autonomous_execution', psp_id: 'PROOF_1767462283250', amount: 19, currency: 'USD' } }
        }),
        revenueRow({ id: 'rev-settled', status: 'paid_out' }),
        revenueRow({ id: 'rev-reversal', amount: -19 })
    ]);

    const report = await backfillSettlementEvidence({ base44 });

    assert.deepEqual(chain.blocks(), [], 'a report run writes no evidence');
    assert.equal(report.applied, false);
    assert.equal(report.scanned, 5);
    assert.equal(report.summary.would_bind, 1);
    assert.equal(report.summary.bound, 0);
    assert.equal(report.summary.refused, 2);
    assert.equal(report.summary.skipped, 2);

    const results = byId(report);
    assert.equal(results['rev-good'].outcome, 'would_bind');
    assert.equal(results['rev-unknown'].reason, 'psp_id_not_named_by_verified_webhook');
    assert.equal(results['rev-invented'].reason, 'self_issued_proof');
    assert.equal(results['rev-settled'].reason, 'already_settled');
    assert.equal(results['rev-reversal'].reason, 'non_positive_amount');
});

test('applying binds only the rows a verified webhook named', async t => {
    const chain = useChain(t);
    useRegistry(t, [CAPTURE]);
    const base44 = fakeBase44([
        revenueRow(),
        revenueRow({ id: 'rev-unknown', metadata: { paypal_capture_id: OTHER_CAPTURE } })
    ]);

    const report = await backfillSettlementEvidence({ base44, apply: true });

    const blocks = chain.blocks();
    assert.deepEqual(blocks.map(block => block.eventId), ['rev-good'], 'the unnamed capture gets no block');
    assert.equal(blocks[0].proof.type, 'psp_transaction_id');
    assert.equal(blocks[0].proof.psp_id, CAPTURE);
    assert.equal(blocks[0].proof.amount, 19);
    assert.equal(blocks[0].proof.currency, 'USD');
    assert.equal(blocks[0].hash, EvidenceIntegrityChain.calculateBlockHash(blocks[0]));

    assert.equal(report.summary.bound, 1);
    assert.equal(report.summary.refused, 1);
    assert.equal(byId(report)['rev-unknown'].reason, 'psp_id_not_named_by_verified_webhook');
});

test('a second run finds its own work and changes nothing', async t => {
    const chain = useChain(t);
    useRegistry(t, [CAPTURE]);
    const base44 = fakeBase44([revenueRow()]);

    await backfillSettlementEvidence({ base44, apply: true });
    const again = await backfillSettlementEvidence({ base44, apply: true });

    assert.equal(again.summary.bound, 0);
    assert.equal(again.summary.already_bound, 1);
    assert.equal(chain.blocks().length, 1, 're-running must not chain a second block');
});

test('a block that disagrees with the row is refused, not overwritten', async t => {
    const chain = useChain(t);
    useRegistry(t, [CAPTURE]);
    const bound = await EvidenceIntegrityChain.addBlock('rev-good', {
        type: 'psp_transaction_id',
        psp_id: CAPTURE,
        amount: 99,
        currency: 'USD',
        timestamp: '2026-11-20T09:59:00.000Z'
    });

    const report = await backfillSettlementEvidence({ base44: fakeBase44([revenueRow()]), apply: true });

    assert.equal(report.summary.refused, 1);
    assert.equal(byId(report)['rev-good'].reason, 'evidence_mismatch');
    const [block] = chain.blocks();
    assert.equal(block.proof.amount, 99);
    assert.equal(block.hash, bound.hash, 'the existing block is left exactly as written');
    assert.equal(chain.blocks().length, 1);
});

test('a backfilled row settles through the gate that refused it', async t => {
    useChain(t);
    useRegistry(t, [CAPTURE]);
    const base44 = fakeBase44([revenueRow()]);
    const cfg = getRevenueConfigFromEnv();

    const refused = await authorizeRevenueSettlement(base44, cfg, { revenueEventId: 'rev-good' });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'settlement_evidence_missing');

    const report = await backfillSettlementEvidence({ base44, apply: true });
    assert.equal(report.summary.bound, 1);

    const allowed = RedressEngine.prototype.isSettlementAllowed;
    RedressEngine.prototype.isSettlementAllowed = () => true;
    t.after(() => {
        RedressEngine.prototype.isSettlementAllowed = allowed;
    });

    const settled = await authorizeRevenueSettlement(base44, cfg, { revenueEventId: 'rev-good' });
    assert.equal(settled.ok, true);
    assert.equal(settled.psp_id, CAPTURE);
});
