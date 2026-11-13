import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    PayoutLedgerConflictError,
    emptyLedger,
    findPayoutConflicts,
    loadPayoutLedger,
    markCredited,
    readPayoutHistory,
    recordSubmitted,
    savePayoutLedger,
    summarizeLedger
} from '../src/financial/payout-ledger.mjs';
import { run as exportRun } from '../scripts/generate-attijari-csv.mjs';

const ACCOUNT = '007810000448500030594182';
const ENTRY = {
    earning_id: 'EARN_1',
    item_id: 'ITEM_1',
    amount: 100,
    currency: 'USD',
    reference: 'ITEM_1',
    description: 'Autonomous revenue settlement - EARN_1'
};

function ledgerWith(entries = [ENTRY], options = {}) {
    return recordSubmitted(emptyLedger(), entries, {
        batchId: 'BATCH_A',
        at: new Date('2026-11-13T10:00:00Z'),
        ...options
    });
}

test('records submitted payouts and saves them atomically', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payout-ledger-'));
    const file = path.join(dir, 'payout-ledger.json');
    const next = savePayoutLedger(file, ledgerWith());

    const loaded = loadPayoutLedger(file);
    assert.equal(loaded.items.EARN_1.status, 'submitted');
    assert.equal(loaded.items.EARN_1.item_id, 'ITEM_1');
    assert.equal(loaded.items.EARN_1.amount, 100);
    assert.equal(loaded.items.EARN_1.credited_at, null);
    assert.equal(next.updated_at, loaded.updated_at);
    assert.deepEqual(summarizeLedger(loaded), { total: 1, submitted: 1, credited: 0, failed: 0, returned: 0 });
});

test('blocks a reused earning or item even across different batches', () => {
    const ledger = ledgerWith();
    const earningReuse = findPayoutConflicts([
        { earning_id: 'EARN_1', item_id: 'ITEM_NEW', amount: 100, currency: 'USD' }
    ], { ledger });
    assert.equal(earningReuse.length, 1);
    assert.equal(earningReuse[0].kind, 'earning');
    assert.equal(earningReuse[0].source, 'ledger');

    const itemReuse = findPayoutConflicts([
        { earning_id: 'EARN_NEW', item_id: 'ITEM_1', amount: 100, currency: 'USD' }
    ], { ledger });
    assert.equal(itemReuse.length, 1);
    assert.equal(itemReuse[0].kind, 'item');

    assert.equal(findPayoutConflicts([
        { earning_id: 'EARN_2', item_id: 'ITEM_2', amount: 100, currency: 'USD' }
    ], { ledger }).length, 0);
});

test('rejects duplicates inside the same batch and finds historical batches', () => {
    const duplicate = findPayoutConflicts([
        { earning_id: 'EARN_1', item_id: 'ITEM_A', amount: 1, currency: 'USD' },
        { earning_id: 'EARN_1', item_id: 'ITEM_B', amount: 1, currency: 'USD' }
    ], { ledger: emptyLedger() });
    assert.equal(duplicate.length, 1);
    assert.equal(duplicate[0].source, 'batch');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payout-history-'));
    fs.writeFileSync(path.join(dir, 'batch_OLD.json'), JSON.stringify({
        batch_id: 'BATCH_OLD',
        currency: 'USD',
        items: [{ earning_id: 'EARN_OLD', item_id: 'ITEM_OLD', amount: 50, currency: 'USD' }]
    }));
    const history = readPayoutHistory(dir);
    const conflicts = findPayoutConflicts([
        { earning_id: 'EARN_OLD', item_id: 'ITEM_NEW', amount: 50, currency: 'USD' }
    ], { ledger: emptyLedger(), history });
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].source, 'history');
    assert.equal(conflicts[0].batch_id, 'BATCH_OLD');
});

test('marks a payout credited, records the bank reference and rejects unknown ids', () => {
    const ledger = ledgerWith();
    const credited = markCredited(ledger, 'ITEM_1', {
        at: new Date('2026-11-14T09:00:00Z'),
        bankReference: 'ATT-20261114-001'
    });
    assert.equal(credited.items.EARN_1.status, 'credited');
    assert.equal(credited.items.EARN_1.bank_reference, 'ATT-20261114-001');
    assert.equal(credited.items.EARN_1.credited_at, '2026-11-14T09:00:00.000Z');
    assert.equal(markCredited(credited, 'ITEM_1').items.EARN_1.credited_at, '2026-11-14T09:00:00.000Z');
    assert.throws(() => markCredited(ledger, 'UNKNOWN'), /not in the ledger/);
});

test('CSV export records submitted state and refuses the same batch again', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payout-export-'));
    const batchFile = path.join(dir, 'batch.json');
    const ledgerFile = path.join(dir, 'ledger.json');
    const outDir = path.join(dir, 'out');
    fs.writeFileSync(batchFile, JSON.stringify({
        batch_id: 'BATCH_EXPORT',
        created_at: '2026-11-13T10:00:00Z',
        currency: 'USD',
        items: [{ earning_id: 'EARN_EXPORT', item_id: 'ITEM_EXPORT', amount: 125, currency: 'USD' }]
    }));

    const args = [
        '--batch', batchFile,
        '--account', ACCOUNT,
        '--ledger', ledgerFile,
        '--out-dir', outDir,
        '--no-history'
    ];
    exportRun(args, { stdout: () => {} });
    const ledger = loadPayoutLedger(ledgerFile);
    assert.equal(ledger.items.EARN_EXPORT.status, 'submitted');
    assert.match(fs.readFileSync(path.join(outDir, 'bank_wire_BATCH_EXPORT.csv'), 'utf8'), /ITEM_EXPORT/);

    assert.throws(() => exportRun(args, { stdout: () => {} }), PayoutLedgerConflictError);
    exportRun(['--mark-credited', 'ITEM_EXPORT', '--ledger', ledgerFile], { stdout: () => {} });
    assert.equal(loadPayoutLedger(ledgerFile).items.EARN_EXPORT.status, 'credited');
    assert.throws(() => exportRun(args, { stdout: () => {} }), PayoutLedgerConflictError);
});
