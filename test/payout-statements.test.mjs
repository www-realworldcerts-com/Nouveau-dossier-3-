import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    emptyLedger,
    loadPayoutLedger,
    recordSubmitted,
    savePayoutLedger
} from '../src/financial/payout-ledger.mjs';
import {
    normalizeTransactions,
    parseAmount,
    parseCsv,
    parseStatementDate,
    planStatementImport
} from '../src/financial/payout-statements.mjs';
import { run as importRun } from '../scripts/import-payout-statement.mjs';

const NOW = new Date('2026-11-13T10:00:00Z');

function ledgerWith(entries) {
    return recordSubmitted(emptyLedger(), entries, { batchId: 'BATCH_A', at: NOW });
}

function entry(id, overrides = {}) {
    return {
        earning_id: `EARN_${id}`,
        item_id: `ITEM_${id}`,
        amount: 100,
        currency: 'USD',
        reference: `ITEM_${id}`,
        description: `Settlement ${id}`,
        ...overrides
    };
}

function importCsv(csv, { source = 'attijari', ledger = ledgerWith([entry('1')]), options = {} } = {}) {
    const normalized = normalizeTransactions(parseCsv(csv), { source });
    return {
        normalized,
        ...planStatementImport(ledger, normalized.transactions, { source, at: NOW, ...options })
    };
}

test('parses French Attijari CSV and records a credited payout with its fee', () => {
    const csv = [
        'Date;Libellé;Référence;Crédit;Débit;Devise;Frais',
        '13/11/2026;VIREMENT ITEM_1;ITEM_1;100,00;;USD;1,50'
    ].join('\n');
    const { normalized, ledger, report } = importCsv(csv);

    assert.equal(normalized.transactions.length, 1);
    assert.equal(normalized.transactions[0].status, 'credited');
    assert.equal(normalized.transactions[0].date, '2026-11-13');
    assert.equal(report.applied.length, 1);
    assert.equal(report.applied[0].matched_by, 'reference');

    const item = ledger.items.EARN_1;
    assert.equal(item.status, 'credited');
    assert.equal(item.fees[0].amount, 1.5);
    assert.equal(item.settlements[0].amount, 100);
    assert.equal(item.settlements[0].fee, 1.5);
    assert.equal(item.settlements[0].amount_difference, 0);
});

test('records FX rate and FX difference when the statement currency differs', () => {
    const csv = [
        'Date,Status,Type,Currency,Amount,Fees,Net Amount,Transaction ID,Reference ID,Description,FX Rate',
        '11/13/2026,Completed,Payment,EUR,92.00,2.00,90.00,TX-1,ITEM_1,Monthly settlement,0.90'
    ].join('\n');
    const { ledger, report } = importCsv(csv, {
        source: 'payoneer',
        ledger: ledgerWith([entry('1', { reference: 'ITEM_1' })])
    });

    assert.equal(report.applied.length, 1);
    assert.equal(report.applied[0].matched_by, 'reference');
    const settlement = ledger.items.EARN_1.settlements[0];
    assert.equal(settlement.currency, 'EUR');
    assert.equal(settlement.fx_rate, 0.9);
    assert.equal(settlement.fx_difference, 2);
    assert.equal(settlement.net_amount, 90);
    assert.equal(settlement.fee, 2);
});

test('marks failed and returned transfers and keeps terminal transitions', () => {
    const failed = importCsv([
        'Date,Status,Currency,Amount,Reference',
        '11/13/2026,Failed,USD,100,ITEM_1'
    ].join('\n'), { source: 'payoneer' });
    assert.equal(failed.ledger.items.EARN_1.status, 'failed');
    assert.equal(failed.report.applied[0].status, 'failed');

    const credited = importCsv([
        'Date,Status,Currency,Amount,Reference',
        '11/13/2026,Completed,USD,100,ITEM_1'
    ].join('\n'), { source: 'payoneer' });
    const returned = importCsv([
        'Date,Status,Currency,Amount,Reference',
        '11/14/2026,Returned,USD,100,ITEM_1'
    ].join('\n'), { source: 'payoneer', ledger: credited.ledger });
    assert.equal(returned.ledger.items.EARN_1.status, 'returned');
    assert.equal(returned.ledger.items.EARN_1.returned_at, NOW.toISOString());

    const conflict = importCsv([
        'Date,Status,Currency,Amount,Reference',
        '11/15/2026,Completed,USD,100,ITEM_1'
    ].join('\n'), { source: 'payoneer', ledger: returned.ledger });
    assert.equal(conflict.report.conflicts.length, 1);
    assert.equal(conflict.ledger.items.EARN_1.status, 'returned');
});

test('falls back to amount and date only when exactly one payout fits', () => {
    const unique = importCsv([
        'Date,Status,Currency,Amount,Description',
        '11/13/2026,Completed,USD,100,Bank transfer'
    ].join('\n'), { source: 'attijari' });
    assert.equal(unique.report.applied.length, 1);
    assert.equal(unique.report.applied[0].matched_by, 'amount_date');

    const ambiguous = importCsv([
        'Date,Status,Currency,Amount,Description',
        '11/13/2026,Completed,USD,100,Bank transfer'
    ].join('\n'), {
        source: 'attijari',
        ledger: ledgerWith([entry('1'), entry('2')])
    });
    assert.equal(ambiguous.report.ambiguous.length, 1);
    assert.equal(ambiguous.report.applied.length, 0);
    assert.equal(ambiguous.ledger.items.EARN_1.status, 'submitted');
});

test('re-importing the same statement is idempotent', () => {
    const csv = [
        'Date,Status,Currency,Amount,Reference',
        '11/13/2026,Completed,USD,100,ITEM_1'
    ].join('\n');
    const first = importCsv(csv, { source: 'payoneer' });
    assert.equal(first.report.applied.length, 1);

    const second = importCsv(csv, { source: 'payoneer', ledger: first.ledger });
    assert.equal(second.report.applied.length, 0);
    assert.equal(second.report.already_applied.length, 1);
    assert.equal(second.ledger.items.EARN_1.status, 'credited');
});

test('parses amounts and dates used by both banks', () => {
    assert.equal(parseAmount('1 234,56'), 1234.56);
    assert.equal(parseAmount('1,234.56'), 1234.56);
    assert.equal(parseAmount('(100,00)'), -100);
    assert.equal(parseStatementDate('13/11/2026', { source: 'attijari' }), '2026-11-13');
    assert.equal(parseStatementDate('11/13/2026', { source: 'payoneer' }), '2026-11-13');
});

test('CLI imports a statement, supports dry-run and persists the ledger', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payout-statement-'));
    const statement = path.join(dir, 'statement.csv');
    const ledgerFile = path.join(dir, 'ledger.json');
    const csv = [
        'Date,Status,Currency,Amount,Reference,Fees',
        '11/13/2026,Completed,USD,100,ITEM_1,1.25'
    ].join('\n');
    fs.writeFileSync(statement, csv);
    savePayoutLedger(ledgerFile, ledgerWith([entry('1')]));

    const dry = importRun(
        ['--source', 'payoneer', '--file', statement, '--ledger', ledgerFile, '--dry-run'],
        { stdout: () => {} }
    );
    assert.equal(dry.applied.length, 1);
    assert.equal(loadPayoutLedger(ledgerFile).items.EARN_1.status, 'submitted');

    importRun(
        ['--source', 'payoneer', '--file', statement, '--ledger', ledgerFile],
        { stdout: () => {} }
    );
    const ledger = loadPayoutLedger(ledgerFile);
    assert.equal(ledger.items.EARN_1.status, 'credited');
    assert.equal(ledger.items.EARN_1.fees[0].amount, 1.25);
});
