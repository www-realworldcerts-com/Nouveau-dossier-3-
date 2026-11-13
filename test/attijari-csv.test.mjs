import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    buildBankWireCsv,
    HEADERS,
    maskAccount,
    normalizeAccount,
    run
} from '../scripts/generate-attijari-csv.mjs';

const ACCOUNT = '007810000448500030594182';
const BATCH = {
    batch_id: 'BATCH_TEST',
    created_at: '2026-11-13T10:00:00.000Z',
    currency: 'USD',
    items: [
        { item_id: 'ITEM_1', earning_id: 'EARN_1', amount: 100, currency: 'USD' },
        { item_id: 'ITEM_2', earning_id: 'EARN, "2"', amount: 75.5, currency: 'USD' }
    ]
};

test('builds a header plus one escaped row per item', () => {
    const result = buildBankWireCsv(BATCH, { account: ACCOUNT });
    const lines = result.csv.split('\n');
    assert.equal(lines[0], HEADERS.join(','));
    assert.equal(lines.length, 3);
    assert.match(lines[1], /^007810000448500030594182,100\.00,USD,ITEM_1,2026-11-13,/);
    assert.match(lines[2], /"Autonomous revenue settlement - EARN, ""2"""/);
    assert.equal(result.total_amount, 175.5);
    assert.equal(result.currency, 'USD');
});

test('accepts a batch wrapped in a data envelope', () => {
    const result = buildBankWireCsv({ data: BATCH }, { account: ACCOUNT });
    assert.equal(result.rows.length, 2);
});

test('rejects a bad account, invalid amount, mixed currencies or empty batch', () => {
    assert.throws(() => normalizeAccount('123'), /10-34 digits/);
    assert.throws(() => normalizeAccount(''), /10-34 digits/);
    assert.throws(
        () => buildBankWireCsv({ ...BATCH, items: [{ item_id: 'A', amount: -5, currency: 'USD' }] }, { account: ACCOUNT }),
        /invalid amount/
    );
    assert.throws(
        () => buildBankWireCsv({ ...BATCH, items: [
            { item_id: 'A', amount: 1, currency: 'USD' },
            { item_id: 'B', amount: 1, currency: 'MAD' }
        ] }, { account: ACCOUNT }),
        /mixes currencies/
    );
    assert.throws(() => buildBankWireCsv({ batch_id: 'X', items: [] }, { account: ACCOUNT }), /no items/);
});

test('masks the account when reporting', () => {
    assert.equal(maskAccount(ACCOUNT), '****4182');
    assert.equal(maskAccount('12'), '****');
});

test('CLI writes the CSV and dry-run writes nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attijari-'));
    const batchFile = path.join(dir, 'batch.json');
    fs.writeFileSync(batchFile, JSON.stringify(BATCH));
    const outDir = path.join(dir, 'out');
    const messages = [];

    const dry = run(['--batch', batchFile, '--account', ACCOUNT, '--out-dir', outDir, '--dry-run'], {
        stdout: message => messages.push(message)
    });
    assert.equal(dry.rows.length, 2);
    assert.equal(fs.existsSync(outDir), false);
    assert.match(messages[0], /DRY RUN/);
    assert.doesNotMatch(messages[0], /007810000448500030594182/);

    run(['--batch', batchFile, '--account', ACCOUNT, '--out-dir', outDir], { stdout: () => {} });
    const written = fs.readFileSync(path.join(outDir, 'bank_wire_BATCH_TEST.csv'), 'utf8');
    assert.match(written, /^Beneficiary Account,Amount,Currency,Reference,Date,Description/);
    assert.match(written, /ITEM_2/);
});
