import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { detectSilentFailures } from '../src/resilience/silent-failure.mjs';
import {
    openSettlementBlocks,
    readSettlementBlocks,
    recordSettlementBlock,
    recordSettlementSettled,
    settlementBlockLogPath
} from '../src/resilience/settlement-blocks.mjs';

const NOW = new Date('2026-11-22T10:00:00Z');
const DAY = 86400000;

function tempRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'settlement-block-'));
}

function cleanOptions(root, overrides = {}) {
    return {
        root,
        env: {},
        now: NOW,
        heartbeat: { status: 'ok', at: new Date(NOW.getTime() - 60000).toISOString(), ok: true },
        revenue: { last_activity_at: new Date(NOW.getTime() - DAY).toISOString(), sources: [] },
        procurement: [],
        fulfillment: [],
        silentCatches: { count: 0, samples: [] },
        auditLatest: new Date(NOW.getTime() - DAY).toISOString(),
        tickMonotony: { samples: 0, duplicate_rate: 0 },
        checkoutGate: null,
        ...overrides
    };
}

test('a refused settlement is written and read back as open', () => {
    const root = tempRoot();
    const at = new Date(NOW.getTime() - DAY).toISOString();

    const written = recordSettlementBlock(root, {
        revenue_event_id: 'rev-1',
        psp_transaction_id: 'PAYOUT-1',
        reason: 'gate_refused',
        error: 'psp_confirmation_missing',
        at
    }, {});

    assert.equal(written.recorded, true);
    assert.equal(settlementBlockLogPath(root, {}), written.path);

    const log = readSettlementBlocks(root, { env: {} });
    assert.equal(log.records.length, 1);
    assert.equal(log.records[0].outcome, 'blocked');
    const open = openSettlementBlocks(log.records);
    assert.equal(open.length, 1);
    assert.equal(open[0].revenue_event_id, 'rev-1');
});

test('a later settlement of the same revenue row closes the block', () => {
    const root = tempRoot();
    recordSettlementBlock(root, { revenue_event_id: 'rev-1', reason: 'gate_refused' }, {});
    recordSettlementSettled(root, { revenue_event_id: 'rev-1' }, {});

    const log = readSettlementBlocks(root, { env: {} });
    assert.equal(log.records.length, 2, 'both lines are kept as history');
    assert.deepEqual(openSettlementBlocks(log.records), []);
});

test('a settlement of a different revenue row does not close the block', () => {
    const root = tempRoot();
    recordSettlementBlock(root, { revenue_event_id: 'rev-1', reason: 'gate_refused' }, {});
    recordSettlementSettled(root, { revenue_event_id: 'rev-2' }, {});

    const open = openSettlementBlocks(readSettlementBlocks(root, { env: {} }).records);
    assert.equal(open.length, 1);
    assert.equal(open[0].revenue_event_id, 'rev-1');
});

test('a replayed block of the same row is one open block, not two', () => {
    const root = tempRoot();
    recordSettlementBlock(root, { revenue_event_id: 'rev-1', reason: 'gate_refused' }, {});
    recordSettlementBlock(root, { revenue_event_id: 'rev-1', reason: 'gate_refused' }, {});

    assert.equal(openSettlementBlocks(readSettlementBlocks(root, { env: {} }).records).length, 1);
});

test('a blocked settlement with no revenue row id is refused, never written anonymously', () => {
    const result = recordSettlementBlock(tempRoot(), { reason: 'gate_refused' }, {});

    assert.equal(result.recorded, false);
    assert.equal(result.reason, 'no_key');
});

test('an unwritable log is reported, not thrown into the webhook', () => {
    const root = tempRoot();
    const blocker = path.join(root, 'not-a-directory');
    fs.writeFileSync(blocker, 'x');

    const result = recordSettlementBlock(root, { revenue_event_id: 'rev-1' }, {
        SETTLEMENT_BLOCK_LOG: path.join(blocker, 'settlement-blocks.ndjson')
    });

    assert.equal(result.recorded, false, 'the refusal is reported, not thrown');
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0);
});

test('a settlement with no log writes nothing and creates no file', () => {
    const root = tempRoot();

    const result = recordSettlementSettled(root, { revenue_event_id: 'rev-1' }, {});

    assert.equal(result.recorded, false);
    assert.equal(result.reason, 'no_log');
    assert.equal(fs.existsSync(path.join(root, 'data', 'resilience', 'settlement-blocks.ndjson')), false);
});

test('a torn line in the log is skipped instead of failing the audit', () => {
    const root = tempRoot();
    recordSettlementBlock(root, { revenue_event_id: 'rev-1', reason: 'gate_refused' }, {});
    fs.appendFileSync(settlementBlockLogPath(root, {}), '{"revenue_event_id":"rev-2"');

    const log = readSettlementBlocks(root, { env: {} });
    assert.equal(log.records.length, 1);
    assert.equal(openSettlementBlocks(log.records).length, 1);
});

test('an unresolved block is a critical finding with the row and the reason', () => {
    const root = tempRoot();
    const at = new Date(NOW.getTime() - 6 * 3600000).toISOString();
    recordSettlementBlock(root, {
        revenue_event_id: 'rev-1',
        psp_transaction_id: 'PAYOUT-1',
        reason: 'self_issued_proof',
        error: null,
        webhook_event_id: 'WH-1',
        at
    }, {});

    const { findings, evidence } = detectSilentFailures(cleanOptions(root));

    const finding = findings.find(item => item.code === 'REVENUE_SETTLEMENT_BLOCKED');
    assert.ok(finding, 'a blocked settlement must be a finding');
    assert.equal(finding.severity, 'critical');
    assert.match(finding.detail, /rev-1/);
    const [block] = finding.evidence.blocks;
    assert.equal(block.revenue_event_id, 'rev-1');
    assert.equal(block.psp_transaction_id, 'PAYOUT-1');
    assert.equal(block.reason, 'self_issued_proof');
    assert.equal(block.age_hours, 6);
    assert.equal(evidence.settlement_blocks.open, 1);
});

test('a block closed by a later settlement is not a finding', () => {
    const root = tempRoot();
    recordSettlementBlock(root, { revenue_event_id: 'rev-1', reason: 'gate_refused' }, {});
    recordSettlementSettled(root, { revenue_event_id: 'rev-1' }, {});

    const { findings, evidence } = detectSilentFailures(cleanOptions(root));

    assert.equal(findings.some(item => item.code === 'REVENUE_SETTLEMENT_BLOCKED'), false);
    assert.equal(evidence.settlement_blocks.open, 0);
});

test('an absent log raises nothing', () => {
    const { findings } = detectSilentFailures(cleanOptions(tempRoot()));

    assert.equal(findings.some(item => item.code === 'REVENUE_SETTLEMENT_BLOCKED'), false);
});
