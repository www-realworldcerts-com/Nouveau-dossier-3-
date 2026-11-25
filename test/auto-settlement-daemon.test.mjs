import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { latchEmergencyStop } from '../src/financial/settlement-emergency-stop.mjs';

import { startStub } from '../scripts/lib/http-stub.mjs';
import { resolvePayoutClaim } from '../src/financial/payout-claims.mjs';
import { OWNER_ACCOUNTS } from '../src/owner-directive.mjs';
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
const claimStore = path.join(tmp, 'data', 'financial', 'payout-claims.json');
const stopFile = path.join(tmp, 'data', 'financial', 'settlement-emergency-stop.json');
const daemonPath = fileURLToPath(new URL('../auto_settlement_daemon.js', import.meta.url));
process.chdir(tmp);

Object.assign(process.env, {
    BASE44_OFFLINE: 'true',
    BASE44_OFFLINE_STORE_PATH: storePath,
    PAYOUT_CLAIM_STORE: claimStore,
    SETTLEMENT_EMERGENCY_STOP_FILE: stopFile,
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

/** The stop latch outlives the process that wrote it, so tests clear it. */
function resetStop() {
    fs.rmSync(stopFile, { force: true });
}

/** Run the daemon CLI in a fresh process, as a restart would. */
function runDaemon(args) {
    return new Promise(resolve => {
        const child = spawn(process.execPath, [daemonPath, ...args], { cwd: tmp, env: { ...process.env } });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('close', status => resolve({ status, stdout, stderr }));
    });
}

function writeStore({ revenueEvents = [], payoutItems = [] }) {
    fs.writeFileSync(storePath, JSON.stringify({
        entities: {
            RevenueEvent: { records: revenueEvents },
            PayoutItem: { records: payoutItems }
        }
    }));
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

/** The claim store is the daemon's only memory that a payout may have left. */
function resetClaims() {
    fs.rmSync(claimStore, { force: true });
}

function claims() {
    if (!fs.existsSync(claimStore)) return [];
    return JSON.parse(fs.readFileSync(claimStore, 'utf8')).claims;
}

function writeClaims(records) {
    fs.mkdirSync(path.dirname(claimStore), { recursive: true });
    fs.writeFileSync(claimStore, JSON.stringify({ version: 1, claims: records }, null, 2));
}

function claimRecord(overrides = {}) {
    return {
        batch_id: 'BATCH_PAYONEER_0123456789abcdef01234567',
        rail: 'PAYONEER',
        revenue_event_ids: ['evt-claimed-1'],
        amount: 19,
        currency: 'USD',
        status: 'in_flight',
        claimed_at: hoursAgo(1),
        closed_at: null,
        execution: null,
        error: null,
        ...overrides
    };
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

    const [claim] = claims();
    assert.equal(claim.batch_id, record.payout_batch_id);
    assert.equal(claim.status, 'closed', 'a marked batch closes its claim');
    assert.deepEqual(daemon.getDaemonHealth().payout_claims.open, []);
});

test('the Payoneer rail creates the exports directory when it is missing', async () => {
    resetClaims();
    fs.rmSync(exportsDir, { recursive: true, force: true });
    writeEvents([revenueEvent('evt-mkdir-1', 19)]);

    await daemon.performSettlementCycle();

    const [record] = readEvents();
    assert.equal(record.status, 'export_ready');
    assert.equal(fs.existsSync(exportsDir), true, 'a fresh checkout has no exports/');
    assert.deepEqual(exportFiles(), [`payoneer_${record.payout_batch_id}.csv`]);
    assert.match(csvText(), /evt-mkdir-1/);
});

test('a batch pays the destination the selection returned, not a registry constant', async () => {
    resetClaims();
    fs.rmSync(exportsDir, { recursive: true, force: true });
    fs.mkdirSync(exportsDir, { recursive: true });

    // Re-identify the primary Payoneer account (to the other allowlisted id).
    // The CSV must follow the account the selection chose, not a constant.
    const original = OWNER_ACCOUNTS.payoneer.accountId;
    OWNER_ACCOUNTS.payoneer.accountId = '101137054';
    try {
        writeEvents([revenueEvent('evt-payee-1', 19)]);
        await daemon.performSettlementCycle();
    } finally {
        OWNER_ACCOUNTS.payoneer.accountId = original;
    }

    assert.equal(readEvents()[0].status, 'export_ready');
    const text = csvText();
    assert.match(text, /101137054/);
    assert.doesNotMatch(text, new RegExp(original));
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

test('a payout whose rows were never marked is completed, not sent again', async () => {
    resetClaims();
    fs.rmSync(exportsDir, { recursive: true, force: true });
    fs.mkdirSync(exportsDir, { recursive: true });

    const batchId = 'BATCH_PAYONEER_0123456789abcdef01234567';
    const execution = { method: 'manual_csv', export_filename: `payoneer_${batchId}.csv` };
    // The crash landed after the rail reported success and before the rows were
    // updated, so the recorded outcome is on the claim and the rows are not.
    writeClaims([claimRecord({ status: 'executed', execution })]);
    writeEvents([revenueEvent('evt-claimed-1', 19)]);

    await daemon.performSettlementCycle();

    const [record] = readEvents();
    assert.equal(record.status, 'export_ready', 'the paid rows are marked from the claim');
    assert.equal(record.settled, false);
    assert.equal(record.payout_batch_id, batchId);
    assert.equal(record.settlement_details.export_filename, execution.export_filename);

    assert.deepEqual(exportFiles(), [], 'the instruction was written before the crash; it is not written twice');
    assert.equal(stub.hits.length, 0);

    const [claim] = claims();
    assert.equal(claim.status, 'closed');
    assert.equal(claim.execution.export_filename, `payoneer_${batchId}.csv`);
    assert.deepEqual(daemon.getDaemonHealth().payout_claims.open, []);
});

test('a claimed payout with an unknown outcome keeps its rows unpaid', async () => {
    resetClaims();
    fs.rmSync(exportsDir, { recursive: true, force: true });
    fs.mkdirSync(exportsDir, { recursive: true });

    const batchId = 'BATCH_PAYONEER_0123456789abcdef01234567';
    writeClaims([claimRecord({ revenue_event_ids: ['evt-claimed-2'] })]);
    writeEvents([revenueEvent('evt-claimed-2', 19)]);

    const errorsBefore = daemon.getDaemonHealth().errorCount;
    await daemon.performSettlementCycle();
    await daemon.performSettlementCycle();

    const [record] = readEvents();
    assert.equal(record.status, 'VERIFIED', 'the row must not be paid again on a guess');
    assert.equal(record.payout_batch_id, undefined);
    assert.deepEqual(exportFiles(), [], 'no second payout instruction');
    assert.equal(stub.hits.length, 0);

    const health = daemon.getDaemonHealth();
    assert.equal(health.payout_claims.open.length, 1, 'the claim is visible in health, not only in a log');
    assert.equal(health.payout_claims.open[0].batch_id, batchId);
    assert.deepEqual(health.payout_claims.open[0].revenue_event_ids, ['evt-claimed-2']);
    assert.ok(health.errorCount > errorsBefore, 'the unresolved claim is reported');
    assert.equal(claims()[0].status, 'in_flight', 'only a provider check may close it');
});

test('a rail that fails after the claim is not retried until it is resolved', async () => {
    resetClaims();
    // Writing the export fails: the rail throws after the claim was recorded,
    // which is exactly the ambiguous state a restart must not guess about.
    fs.rmSync(exportsDir, { recursive: true, force: true });
    fs.writeFileSync(exportsDir, 'not a directory');
    writeEvents([revenueEvent('evt-claim-fail-1', 19)]);

    await daemon.performSettlementCycle();

    assert.equal(readEvents()[0].status, 'VERIFIED');
    assert.deepEqual(claims().map(record => record.status), ['in_flight']);
    assert.match(claims()[0].error, /not a directory|ENOTDIR|EEXIST/i);
    assert.ok(daemon.getDaemonHealth().errorCount > 0);

    // The filesystem recovers, but the attempt is still ambiguous: no retry.
    fs.rmSync(exportsDir, { force: true });
    fs.mkdirSync(exportsDir, { recursive: true });
    await daemon.performSettlementCycle();

    assert.deepEqual(exportFiles(), [], 'the ambiguous attempt is not sent again');
    assert.equal(readEvents()[0].status, 'VERIFIED');
    assert.equal(claims().length, 1);

    // Only an owner who confirmed the payout never arrived frees the rows.
    assert.equal(resolvePayoutClaim(tmp, claims()[0].batch_id).resolved, true);
    await daemon.performSettlementCycle();

    assert.equal(readEvents()[0].status, 'export_ready');
    assert.equal(exportFiles().length, 1);
    assert.equal(claims()[0].status, 'closed');
});

test('a payout the provider recorded is marked settled instead of staying stuck', async () => {
    resetClaims();
    fs.rmSync(exportsDir, { recursive: true, force: true });
    fs.mkdirSync(exportsDir, { recursive: true });

    const batchId = 'BATCH_PAYONEER_0123456789abcdef01234567';
    writeClaims([claimRecord({ revenue_event_ids: ['evt-claimed-3'] })]);
    // The daemon died before recording the outcome, but PayPal's webhook left a
    // payout item for the row: the money did move.
    writeStore({
        revenueEvents: [revenueEvent('evt-claimed-3', 19)],
        payoutItems: [{
            id: 'pi-1',
            batch_id: 'PAYPAL-BATCH-9',
            revenue_event_id: 'evt-claimed-3',
            status: 'success',
            transaction_id: 'TXN-9'
        }]
    });

    await daemon.performSettlementCycle();

    const [record] = readEvents();
    assert.equal(record.status, 'paid_out', 'the provider says the payout happened');
    assert.equal(record.settled, true);
    assert.equal(record.payout_batch_id, batchId);
    assert.equal(record.settlement_details.method, 'payout_item_evidence');
    assert.equal(record.settlement_details.provider_batch_id, 'PAYPAL-BATCH-9');
    assert.deepEqual(exportFiles(), [], 'nothing is sent again');
    assert.equal(stub.hits.length, 0);

    const [claim] = claims();
    assert.equal(claim.status, 'closed');
    assert.equal(claim.execution.method, 'payout_item_evidence', 'the claim records what paid the rows');
    assert.deepEqual(daemon.getDaemonHealth().payout_claims.open, []);
});

test('a batch the provider recorded as failed frees its rows to be paid', async () => {
    resetClaims();
    fs.rmSync(exportsDir, { recursive: true, force: true });
    fs.mkdirSync(exportsDir, { recursive: true });

    const batchId = 'BATCH_PAYONEER_0123456789abcdef01234567';
    writeClaims([claimRecord({ revenue_event_ids: ['evt-claimed-4'] })]);
    writeStore({
        revenueEvents: [revenueEvent('evt-claimed-4', 19)],
        payoutItems: [{ id: 'pi-1', batch_id: batchId, revenue_event_id: 'evt-claimed-4', status: 'failed' }]
    });

    await daemon.performSettlementCycle();

    const [record] = readEvents();
    assert.equal(record.status, 'export_ready', 'a payout the provider refused may be sent again');
    assert.equal(exportFiles().length, 1);
    assert.equal(stub.hits.length, 0);
});

// ============================================================================
// MANUAL CSV CONFIRMATION
// ============================================================================

/** Runs one cycle and returns the batch id its exported rows belong to. */
async function exportBatch(eventId, amount = 19) {
    resetClaims();
    fs.rmSync(exportsDir, { recursive: true, force: true });
    fs.mkdirSync(exportsDir, { recursive: true });
    writeEvents([revenueEvent(eventId, amount)]);
    await daemon.performSettlementCycle();
    const [record] = readEvents();
    assert.equal(record.status, 'export_ready');
    return record.payout_batch_id;
}

test('an exported batch is confirmed paid by an explicit step, and only then', async () => {
    const batchId = await exportBatch('evt-confirm-1');

    // Exporting is not paying: the batch waits for the operator in health.
    assert.deepEqual(
        daemon.getDaemonHealth().payout_claims.awaiting_confirmation.map(batch => batch.batch_id),
        [batchId]
    );

    const result = await daemon.confirmExportedBatch(batchId, { note: 'uploaded to Payoneer' });
    assert.deepEqual(result.confirmed, ['evt-confirm-1']);
    assert.deepEqual(result.already_paid, []);

    const [paid] = readEvents();
    assert.equal(paid.status, 'paid_out');
    assert.equal(paid.settled, true);
    assert.equal(paid.paid_out, true);
    assert.equal(typeof paid.settled_at, 'string');
    assert.equal(paid.confirmed_by, 'operator');
    assert.equal(paid.settlement_details.paid_confirmation_note, 'uploaded to Payoneer');
    assert.equal(paid.payout_batch_id, batchId, 'the payment stays tied to its batch');

    const [claim] = claims();
    assert.equal(claim.status, 'closed');
    assert.equal(claim.resolution.outcome, 'paid');
    assert.equal(claim.resolution.resolved_by, 'operator');
    assert.deepEqual(daemon.getDaemonHealth().payout_claims.awaiting_confirmation, []);

    // Confirmed money is never selected or exported again.
    await daemon.performSettlementCycle();
    assert.equal(readEvents()[0].status, 'paid_out');
    assert.deepEqual(exportFiles(), [`payoneer_${batchId}.csv`]);
    assert.equal(stub.hits.length, 0);
});

test('confirming the same batch twice records one payment', async () => {
    const batchId = await exportBatch('evt-confirm-twice-1');

    await daemon.confirmExportedBatch(batchId);
    const again = await daemon.confirmExportedBatch(batchId);

    assert.deepEqual(again.confirmed, []);
    assert.deepEqual(again.already_paid, ['evt-confirm-twice-1']);
    assert.equal(claims().filter(claim => claim.batch_id === batchId).length, 1);
    assert.equal(readEvents()[0].status, 'paid_out');
});

test('a batch whose claim is still open is not confirmed as paid', async () => {
    resetClaims();
    const batchId = claimRecord().batch_id;
    writeEvents([revenueEvent('evt-confirm-open-1', 19, {
        status: 'export_ready',
        payout_batch_id: batchId
    })]);
    writeClaims([claimRecord({ revenue_event_ids: ['evt-confirm-open-1'] })]);

    await assert.rejects(daemon.confirmExportedBatch(batchId), /PAYOUT_BATCH_UNRESOLVED/);
    assert.equal(readEvents()[0].status, 'export_ready', 'a payout in flight is not a payment');
    assert.equal(claims()[0].resolution, undefined);
});

test('a batch closed as never sent has no payment to confirm', async () => {
    resetClaims();
    const batchId = claimRecord().batch_id;
    writeEvents([revenueEvent('evt-confirm-never-1', 19, {
        status: 'export_ready',
        payout_batch_id: batchId
    })]);
    writeClaims([claimRecord({ revenue_event_ids: ['evt-confirm-never-1'] })]);
    assert.equal(resolvePayoutClaim(tmp, batchId, { note: 'nothing arrived' }).resolved, true);

    await assert.rejects(daemon.confirmExportedBatch(batchId), /PAYOUT_BATCH_NEVER_SENT/);
    assert.equal(readEvents()[0].status, 'export_ready');
});

test('an unknown batch is refused instead of confirming untracked money', async () => {
    resetClaims();
    writeEvents([revenueEvent('evt-confirm-untracked-1', 19)]);

    await assert.rejects(daemon.confirmExportedBatch(''), /PAYOUT_BATCH_UNKNOWN/);
    await assert.rejects(daemon.confirmExportedBatch('BATCH_PAYONEER_ffffffffffffffffffffffff'), /PAYOUT_BATCH_UNKNOWN/);
    assert.equal(readEvents()[0].status, 'VERIFIED');
});

test('a row the batch cannot prove refuses the whole batch without writing', async () => {
    resetClaims();
    const batchId = claimRecord().batch_id;
    writeEvents([
        revenueEvent('evt-confirm-mine-1', 19, { status: 'export_ready', payout_batch_id: batchId }),
        // Another batch already owns this row: confirming the first batch must
        // not mark it paid.
        revenueEvent('evt-confirm-other-1', 19, {
            status: 'export_ready',
            payout_batch_id: 'BATCH_PAYONEER_111111111111111111111111'
        })
    ]);
    writeClaims([claimRecord({
        status: 'closed',
        execution: { method: 'manual_csv', export_filename: 'payoneer_x.csv' },
        revenue_event_ids: ['evt-confirm-mine-1', 'evt-confirm-other-1']
    })]);

    await assert.rejects(daemon.confirmExportedBatch(batchId), /PAYOUT_BATCH_UNCONFIRMED/);

    const rows = readEvents();
    assert.equal(rows.find(row => row.id === 'evt-confirm-other-1').status, 'export_ready');
    assert.equal(rows.find(row => row.id === 'evt-confirm-mine-1').status, 'export_ready', 'a refused batch marks no row at all');
    assert.equal(claims()[0].resolution, undefined, 'a refused batch is not recorded as paid');
});

test('a batch a payout rail already paid is not confirmed by hand', async () => {
    resetClaims();
    const batchId = claimRecord().batch_id;
    writeEvents([revenueEvent('evt-confirm-rail-1', 19, {
        status: 'paid_out',
        settled: true,
        paid_out: true,
        payout_batch_id: batchId
    })]);
    writeClaims([claimRecord({
        status: 'closed',
        closed_at: hoursAgo(1),
        execution: { method: 'payout_item_evidence', provider_batch_id: 'PAYPAL-BATCH-9' },
        revenue_event_ids: ['evt-confirm-rail-1']
    })]);

    await assert.rejects(daemon.confirmExportedBatch(batchId), /PAYOUT_BATCH_NOT_EXPORTED/);
    assert.equal(claims()[0].resolution, undefined, 'the rail\'s payment stands, an operator does not restamp it');
});

test('--confirm-payout marks an exported batch paid from the command line', async () => {
    const batchId = await exportBatch('evt-confirm-cli-1');

    const confirmed = await runDaemon(['--confirm-payout', batchId, '--note', 'uploaded']);
    assert.equal(confirmed.status, 0, confirmed.stderr);
    assert.match(confirmed.stdout, /marked paid_out/);
    assert.equal(readEvents()[0].status, 'paid_out');
    assert.equal(claims()[0].resolution.outcome, 'paid');

    const unknown = await runDaemon(['--confirm-payout', 'BATCH_UNKNOWN']);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /PAYOUT_BATCH_UNKNOWN/);

    const missing = await runDaemon(['--confirm-payout']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /PAYOUT_BATCH_UNKNOWN/);
});

test('a persisted stop survives a restart and refuses --once until it is cleared', async () => {
    resetClaims();
    fs.rmSync(exportsDir, { recursive: true, force: true });
    fs.mkdirSync(exportsDir, { recursive: true });
    writeEvents([revenueEvent('evt-stop-restart-1', 19)]);

    const latched = latchEmergencyStop(tmp, { reason: 'money behaviour under review', by: 'test' });
    assert.equal(latched.stopped, true);

    // A fresh process knows nothing about the stop until it reads the latch.
    const startRefused = await runDaemon([]);
    assert.equal(startRefused.status, 1, startRefused.stderr);
    assert.match(startRefused.stderr, /EMERGENCY_STOP/);

    const refused = await runDaemon(['--once']);
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /EMERGENCY_STOP/);
    assert.equal(readEvents()[0].status, 'VERIFIED', 'the startup cycle must not pay');
    assert.deepEqual(exportFiles(), []);
    assert.deepEqual(claims(), [], 'nothing is even claimed while stopped');

    // Restarting again must not clear it either.
    const stillRefused = await runDaemon(['--once']);
    assert.equal(stillRefused.status, 1);

    // Only an explicit clear lets settlement run again.
    const cleared = await runDaemon(['--clear-emergency-stop']);
    assert.equal(cleared.status, 0, cleared.stderr);

    // Cleared, the cycle runs again instead of refusing. (The gate still holds
    // this row for its own reasons in a child process — its bound evidence is
    // stubbed inside this test — so the assertion is that settlement proceeds.)
    const resumed = await runDaemon(['--once']);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.doesNotMatch(resumed.stderr, /EMERGENCY_STOP/);
    assert.match(resumed.stdout, /Starting single settlement cycle/);
});

test('a persisted stop refuses a manual trigger in a fresh process', async () => {
    resetClaims();
    resetStop();
    fs.rmSync(exportsDir, { recursive: true, force: true });
    fs.mkdirSync(exportsDir, { recursive: true });
    writeEvents([revenueEvent('evt-stop-manual-1', 19)]);

    latchEmergencyStop(tmp, { reason: 'still under review' });

    assert.equal(await daemon.triggerManualSettlement(), false);
    assert.equal(readEvents()[0].status, 'VERIFIED');
    assert.deepEqual(exportFiles(), []);
    assert.equal(daemon.getDaemonHealth().emergencyStopped, true, 'the latch is now this process\'s state too');
});

test('the emergency stop latches and refuses every later payout', async () => {
    resetStop();
    fs.rmSync(exportsDir, { recursive: true, force: true });
    fs.mkdirSync(exportsDir, { recursive: true });
    writeEvents([revenueEvent('evt-stopped-1', 19)]);

    daemon.emergencyStop({ reason: 'test stop' });

    assert.equal(fs.existsSync(stopFile), true, 'the stop is persisted, not only in memory');

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
