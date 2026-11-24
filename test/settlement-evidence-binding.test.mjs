import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    authorizeRevenueSettlement,
    createBase44RevenueEventIdempotent
} from '../src/base44-revenue.mjs';
import { EvidenceIntegrityChain } from '../src/real/evidence-integrity.mjs';
import { openSettlementBlocks, readSettlementBlocks } from '../src/resilience/settlement-blocks.mjs';

// Capture ids in the shape PayPal issues (17 uppercase alphanumerics).
const CAPTURE = '5O190127TN364715T';

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

/** The chain is a file, so each test gets its own and the repo stays clean. */
function useChain(t) {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'settlement-evidence-')), 'evidence-chain.json');
    const previous = process.env.EVIDENCE_CHAIN_PATH;
    process.env.EVIDENCE_CHAIN_PATH = file;
    t.after(() => {
        if (previous === undefined) delete process.env.EVIDENCE_CHAIN_PATH;
        else process.env.EVIDENCE_CHAIN_PATH = previous;
    });
    return {
        file,
        blocks: () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [])
    };
}

/** The block log is where an unsettleable capture has to become visible. */
function useBlockLog(t) {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'settlement-blocks-')), 'settlement-blocks.ndjson');
    const previous = process.env.SETTLEMENT_BLOCK_LOG;
    process.env.SETTLEMENT_BLOCK_LOG = file;
    t.after(() => {
        if (previous === undefined) delete process.env.SETTLEMENT_BLOCK_LOG;
        else process.env.SETTLEMENT_BLOCK_LOG = previous;
    });
    return { file };
}

/** What the webhook mapper hands the ledger for a completed capture. */
function captureEvent(overrides = {}) {
    return {
        amount: 19,
        currency: 'USD',
        occurredAt: '2026-11-23T09:00:00.000Z',
        source: 'paypal',
        externalId: `WH-${CAPTURE}`,
        status: 'VERIFIED',
        metadata: { paypal_capture_id: CAPTURE, psp_transaction_id: CAPTURE },
        ...overrides
    };
}

function fakeBase44({ createdId = 'rev-new-1', row = null } = {}) {
    return {
        asServiceRole: {
            entities: {
                RevenueEvent: {
                    filter: async () => (row ? [row] : []),
                    create: async data => ({ id: createdId, ...data }),
                    update: async (id, patch) => ({ id, ...patch })
                }
            }
        }
    };
}

function revenueRow({ id = 'rev-1', amount = 19, metadata = { paypal_capture_id: CAPTURE } } = {}) {
    return {
        id,
        created_date: '2026-11-23T09:00:00.000Z',
        amount,
        currency: 'USD',
        occurred_at: '2026-11-23T09:00:00.000Z',
        event_id: `WH-${CAPTURE}`,
        status: 'VERIFIED',
        metadata
    };
}

test('recording a capture binds the evidence its settlement will be checked against', async t => {
    const chain = useChain(t);
    const blockLog = useBlockLog(t);

    const result = await createBase44RevenueEventIdempotent(fakeBase44(), CFG, captureEvent(), { dryRun: false });

    assert.equal(result.id, 'rev-new-1');
    assert.equal(result.deduped, undefined);
    assert.equal(result.evidence.bound, true, 'the capture write binds its own evidence');
    assert.equal(result.evidence.psp_id, CAPTURE);

    const blocks = chain.blocks();
    assert.equal(blocks.length, 1, 'one block, written at ingest');
    assert.equal(blocks[0].eventId, 'rev-new-1');
    assert.equal(blocks[0].proof.type, 'psp_transaction_id');
    assert.equal(blocks[0].proof.psp_id, CAPTURE);
    assert.equal(blocks[0].proof.amount, 19);
    assert.equal(blocks[0].proof.currency, 'USD');
    assert.equal(blocks[0].hash, EvidenceIntegrityChain.calculateBlockHash(blocks[0]));
    assert.equal(fs.existsSync(blockLog.file), false, 'a bound capture raises no incident');
});

test('a replayed capture reuses the block instead of chaining a second one', async t => {
    const chain = useChain(t);
    const event = captureEvent();

    await createBase44RevenueEventIdempotent(fakeBase44({ createdId: 'rev-1' }), CFG, event, { dryRun: false });
    // The row is already there, so the replay takes the dedupe path.
    const replay = await createBase44RevenueEventIdempotent(
        fakeBase44({ row: revenueRow({ id: 'rev-1' }) }),
        CFG,
        event,
        { dryRun: false }
    );

    assert.equal(replay.deduped, true);
    assert.equal(replay.evidence.bound, true);
    assert.equal(chain.blocks().length, 1, 'the chain grows once per capture, not once per replay');
});

test('a capture whose evidence cannot be bound is recorded, reported and refused at payout', async t => {
    const chain = useChain(t);
    const blockLog = useBlockLog(t);
    const saved = EvidenceIntegrityChain.addBlock;
    EvidenceIntegrityChain.addBlock = async () => {
        throw new Error('chain volume is read-only');
    };
    t.after(() => {
        EvidenceIntegrityChain.addBlock = saved;
    });

    const result = await createBase44RevenueEventIdempotent(
        fakeBase44({ createdId: 'rev-unbound-1' }),
        CFG,
        captureEvent({ externalId: 'WH-UNBOUND' }),
        { dryRun: false }
    );

    // The money did move, so the capture is kept; what is missing is its proof.
    assert.equal(result.id, 'rev-unbound-1');
    assert.equal(result.evidence.bound, false);
    assert.equal(result.evidence.reason, 'evidence_chain_write_failed');
    assert.equal(result.evidence.psp_id, CAPTURE);
    assert.match(result.evidence.error, /chain volume is read-only/);
    assert.deepEqual(chain.blocks(), [], 'nothing was written');

    // stderr is dropped on a serverless host, so the failure must also be in the
    // log the audit reads back.
    const log = readSettlementBlocks(process.cwd(), { env: process.env });
    assert.equal(log.path, blockLog.file);
    assert.equal(log.records.length, 1, 'the unsettleable capture is an incident, not a log line nobody reads');
    const [line] = log.records;
    assert.equal(line.outcome, 'evidence_unbound');
    assert.equal(line.key, 'rev-unbound-1');
    assert.equal(line.revenue_event_id, 'rev-unbound-1');
    assert.equal(line.psp_transaction_id, CAPTURE);
    assert.equal(line.reason, 'evidence_chain_write_failed');
    assert.equal(line.source, 'revenue_ingest');
    assert.equal(openSettlementBlocks(log.records).length, 1, 'the audit sees it as still open');

    const settlement = await authorizeRevenueSettlement(
        fakeBase44({ row: revenueRow({ id: 'rev-unbound-1' }) }),
        CFG,
        { revenueEventId: 'rev-unbound-1' }
    );
    assert.equal(settlement.ok, false);
    assert.equal(settlement.reason, 'settlement_evidence_missing');
    assert.equal(settlement.psp_id, CAPTURE, 'the refusal names the capture it could not check');
    assert.deepEqual(chain.blocks(), [], 'payout must not invent the block it did not find');
});

test('evidence bound at ingest that disagrees with the row is refused, not overwritten', async t => {
    const chain = useChain(t);
    await createBase44RevenueEventIdempotent(fakeBase44({ createdId: 'rev-1' }), CFG, captureEvent(), { dryRun: false });

    const settlement = await authorizeRevenueSettlement(
        fakeBase44({ row: revenueRow({ amount: 25 }) }),
        CFG,
        { revenueEventId: 'rev-1' }
    );

    assert.equal(settlement.ok, false);
    assert.equal(settlement.reason, 'settlement_evidence_mismatch');
    assert.match(settlement.detail, /bound evidence .* 19 USD does not match .* 25 USD/);
    assert.equal(chain.blocks().length, 1, 'the bound block is left exactly as written');
});
