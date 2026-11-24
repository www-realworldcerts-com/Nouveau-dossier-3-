import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startStub } from '../scripts/lib/http-stub.mjs';
import { EvidenceIntegrityChain } from '../src/real/evidence-integrity.mjs';
import { MoneyMovedGate } from '../src/real/money-moved-gate.mjs';

/**
 * The settlement daemon is exercised against an in-memory Base44 store and a
 * loopback HTTP stub; it never reaches PayPal, Base44 or any other network.
 * The money-moved gate's downstream checks (proof validator, evidence chain)
 * are stubbed because they are tested where they live, and the gate is called
 * with a positive amount here.
 *
 * Each rail in this repo's routing is a CSV rail for ordinary amounts, which
 * is exactly the path that used to be marked settled without paying.
 */
const stub = await startStub(() => ({ status: 200, body: { name: 'UNEXPECTED_PAYPAL_CALL' } }));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'settlement-daemon-'));
const storePath = path.join(tmp, 'base44-store.json');
const exportsDir = path.join(tmp, 'exports');
fs.mkdirSync(exportsDir, { recursive: true });
process.chdir(tmp);

Object.assign(process.env, {
    BASE44_OFFLINE: 'true',
    BASE44_OFFLINE_STORE_PATH: storePath,
    PAYPAL_API_BASE_URL: stub.url,
    PAYPAL_CLIENT_ID: 'stub-client-id',
    PAYPAL_CLIENT_SECRET: 'stub-client-secret',
    SWARM_LIVE: 'false',
    NO_PLATFORM_WALLET: 'true',
    ENABLE_IMMEDIATE_SETTLEMENT: 'false',
    MAX_SETTLEMENT_DELAY_HOURS: '24',
    SETTLEMENT_CHECK_INTERVAL_MS: '60000'
});

const daemon = await import('../auto_settlement_daemon.js');

// The money-moved gate's own checks are stubbed where they are tested; the
// evidence *agreement* check under test here lives in the revenue gate, which
// reads the block bound at ingest. Each store row gets a block that matches it,
// as ingest would have written, unless a test overrides one.
const savedGate = MoneyMovedGate.assertMoneyMoved;
const savedBlock = EvidenceIntegrityChain.fetchBlockForEvent;
MoneyMovedGate.assertMoneyMoved = async () => true;
const blockOverrides = new Map();
EvidenceIntegrityChain.fetchBlockForEvent = async eventId => {
    if (blockOverrides.has(eventId)) return blockOverrides.get(eventId);
    const record = readEvents().find(row => row.id === eventId);
    if (!record) return null;
    const proof = record.verification_proof;
    return {
        eventId,
        proof: {
            type: 'psp_transaction_id',
            psp_id: proof.psp_id,
            amount: Number(record.amount),
            currency: record.currency,
            timestamp: proof.timestamp
        }
    };
};

test.after(async () => {
    MoneyMovedGate.assertMoneyMoved = savedGate;
    EvidenceIntegrityChain.fetchBlockForEvent = savedBlock;
    await stub.close();
});

const BATCHING_WINDOW_HOURS = 24;

function hoursAgo(hours) {
    return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

// The daemon only settles revenue that has waited out the batching window, so
// the default fixture is already due: 48 h old, well past the 24 h window.
function revenueEvent(id, amount, overrides = {}) {
    const now = hoursAgo(48);
    return {
        id,
        amount,
        currency: 'USD',
        status: 'VERIFIED',
        settled: false,
        paid_out: false,
        created_at: now,
        created_date: now,
        verification_proof: {
            type: 'paypal_capture',
            psp_id: '5O190127TN364715T',
            amount,
            currency: 'USD',
            timestamp: now
        },
        ...overrides
    };
}

function writeEvents(events) {
    fs.writeFileSync(storePath, JSON.stringify({ entities: { RevenueEvent: { records: events } } }));
}

function readEvents(entityName = 'RevenueEvent') {
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    return store.entities[entityName].records;
}

function exportFiles() {
    return fs.readdirSync(exportsDir).sort();
}

function csvText() {
    return exportFiles().map(name => fs.readFileSync(path.join(exportsDir, name), 'utf8')).join('\n');
}

test('a CSV rail exports for payment without marking the revenue settled', async () => {
    writeEvents([revenueEvent('evt-csv-1', 19)]);

    await daemon.performSettlementCycle();

    const [record] = readEvents();
    assert.equal(record.status, 'export_ready', 'an exported row is not a payment');
    assert.equal(record.settled, false, 'a CSV that may never be uploaded must not claim settlement');
    assert.equal(record.paid_out, false);
    assert.equal(typeof record.exported_at, 'string');
    assert.equal(record.settled_at, undefined);
    assert.match(record.payout_batch_id, /^BATCH_PAYONEER_[0-9a-f]{24}$/);

    const files = exportFiles();
    assert.deepEqual(files, [`payoneer_${record.payout_batch_id}.csv`]);
    assert.match(csvText(), /evt-csv-1/);

    assert.equal(daemon.getDaemonHealth().totalSettled, 0, 'exported money is not settled money');
    assert.equal(stub.hits.length, 0, 'the CSV rails never call a provider');
});

test('a negative reversal row is never settled or exported', async () => {
    fs.rmSync(exportsDir, { recursive: true, force: true });
    fs.mkdirSync(exportsDir, { recursive: true });
    writeEvents([
        revenueEvent('evt-pos-1', 19),
        revenueEvent('evt-rev-1', -19)
    ]);

    await daemon.performSettlementCycle();

    const records = readEvents();
    const reversal = records.find(record => record.id === 'evt-rev-1');
    const positive = records.find(record => record.id === 'evt-pos-1');

    assert.equal(reversal.settled, false);
    assert.equal(reversal.status, 'VERIFIED');
    assert.equal(reversal.payout_batch_id, undefined, 'a reversal must not enter a payout batch');
    assert.doesNotMatch(csvText(), /evt-rev-1/);

    assert.equal(positive.status, 'export_ready');
    assert.match(csvText(), /evt-pos-1/);
});

test('the batch id is derived from the batch, so a retry reproduces it', async () => {
    const events = [{ id: 'a' }, { id: 'b' }];
    const first = daemon.computeBatchId('PAYPAL', events);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(daemon.computeBatchId('PAYPAL', [...events].reverse()), first, 'order must not matter');
    assert.equal(daemon.computeBatchId('PAYPAL', [{ id: 'a' }]), daemon.computeBatchId('PAYPAL', [{ id: 'a' }]));
    assert.notEqual(daemon.computeBatchId('PAYPAL', [{ id: 'a' }]), first);
    assert.notEqual(daemon.computeBatchId('BANK_WIRE', events), first, 'rails are distinct batches');
    assert.match(first, /^BATCH_PAYPAL_[0-9a-f]{24}$/);
});

test('a retried cycle reuses the batch id instead of creating a second payout', async () => {
    fs.rmSync(exportsDir, { recursive: true, force: true });
    fs.mkdirSync(exportsDir, { recursive: true });
    writeEvents([revenueEvent('evt-retry-1', 19)]);

    await daemon.performSettlementCycle();
    const firstId = readEvents()[0].payout_batch_id;
    const firstFiles = exportFiles();

    // The mark is lost (crash between export and update) and the event is
    // picked up again: the same batch id must come back.
    writeEvents([revenueEvent('evt-retry-1', 19)]);
    await daemon.performSettlementCycle();

    assert.equal(readEvents()[0].payout_batch_id, firstId);
    assert.deepEqual(exportFiles(), firstFiles, 'no second export under a new batch id');
});

test('the batching window settles aged revenue and leaves fresh events alone', async () => {
    fs.rmSync(exportsDir, { recursive: true, force: true });
    fs.mkdirSync(exportsDir, { recursive: true });

    const aged = hoursAgo(BATCHING_WINDOW_HOURS + 1);
    const fresh = new Date().toISOString();
    writeEvents([
        revenueEvent('evt-aged-1', 19, { created_at: aged, created_date: aged }),
        revenueEvent('evt-fresh-1', 19, { created_at: fresh, created_date: fresh })
    ]);

    await daemon.performSettlementCycle();

    const records = readEvents();
    const agedRecord = records.find(record => record.id === 'evt-aged-1');
    const freshRecord = records.find(record => record.id === 'evt-fresh-1');

    assert.equal(agedRecord.status, 'export_ready', 'revenue past the window must be picked up');
    assert.match(csvText(), /evt-aged-1/);

    assert.equal(freshRecord.status, 'VERIFIED', 'revenue inside the window waits for a later cycle');
    assert.equal(freshRecord.settled, false);
    assert.equal(freshRecord.payout_batch_id, undefined, 'a fresh event must not enter a batch');
    assert.doesNotMatch(csvText(), /evt-fresh-1/);
});

test('a block that disagrees with the row is refused before the payout', async () => {
    fs.rmSync(exportsDir, { recursive: true, force: true });
    fs.mkdirSync(exportsDir, { recursive: true });
    writeEvents([revenueEvent('evt-mismatch-1', 19)]);
    // Ingest bound a block for 25 against a row that says 19. The daemon used to
    // pay this: its gate only checked that *a* block existed.
    blockOverrides.set('evt-mismatch-1', {
        eventId: 'evt-mismatch-1',
        proof: {
            type: 'psp_transaction_id',
            psp_id: '5O190127TN364715T',
            amount: 25,
            currency: 'USD',
            timestamp: hoursAgo(48)
        }
    });

    const errorsBefore = daemon.getDaemonHealth().errorCount;
    await daemon.performSettlementCycle();

    const [record] = readEvents();
    assert.equal(record.status, 'VERIFIED', 'a row whose evidence disagrees is not exported');
    assert.equal(record.settled, false);
    assert.equal(record.payout_batch_id, undefined, 'it must not enter a payout batch');
    assert.deepEqual(exportFiles(), [], 'no payout instruction is written');
    assert.equal(stub.hits.length, 0);
    assert.ok(
        daemon.getDaemonHealth().errorCount > errorsBefore,
        'the refusal is reported instead of silently skipping the row'
    );
});

test('the emergency stop latches and refuses every later payout', async () => {
    fs.rmSync(exportsDir, { recursive: true, force: true });
    fs.mkdirSync(exportsDir, { recursive: true });
    writeEvents([revenueEvent('evt-stopped-1', 19)]);

    daemon.emergencyStop();

    const health = daemon.getDaemonHealth();
    assert.equal(health.emergencyStopped, true);
    assert.equal(health.running, false);

    await daemon.performSettlementCycle();
    await daemon.performSettlementCycle();

    assert.equal(await daemon.triggerManualSettlement(), false, 'manual trigger must respect the stop');

    const [record] = readEvents();
    assert.equal(record.settled, false);
    assert.equal(record.status, 'VERIFIED', 'the stopped cycle must not touch the event');
    assert.deepEqual(exportFiles(), [], 'the stopped daemon writes no payout instruction');
    assert.equal(stub.hits.length, 0);
});
