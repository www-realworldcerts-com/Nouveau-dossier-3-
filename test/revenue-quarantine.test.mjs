import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { quarantineDirectory, quarantineRecord } from '../src/real/ledger/quarantine.mjs';
import { assertStorableRevenueStatus, RevenueNotProviderVerifiedError } from '../src/real/revenue-verification.mjs';
import { decryptBuffer, encryptBuffer } from '../src/security/data-at-rest.mjs';

const PAYPAL_ID = '3C679366HH908993F';
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

/** Run `fn` with a data-at-rest key configured, restoring the environment after. */
function withEncryptionKey(fn) {
    const previous = process.env.DATA_ENCRYPTION_KEY;
    process.env.DATA_ENCRYPTION_KEY = ENCRYPTION_KEY;
    try {
        return fn();
    } finally {
        if (previous == null) delete process.env.DATA_ENCRYPTION_KEY;
        else process.env.DATA_ENCRYPTION_KEY = previous;
    }
}

function selfProofRecord(overrides = {}) {
    return {
        event_id: 'LIVE_1767462282000',
        amount: 75,
        currency: 'USD',
        occurred_at: '2026-01-03T16:00:00.000Z',
        source: 'Instant Email Campaign Setup',
        status: 'VERIFIED',
        verification_proof: {
            type: 'autonomous_execution',
            psp_id: 'PROOF_1767462282250',
            amount: 75,
            currency: 'USD',
            timestamp: '2026-01-03T16:00:00.000Z',
            details: 'Successfully executed cold email campaign targeting 100 leads via SmartLead.'
        },
        metadata: { execution_type: 'autonomous', created_by: 'autonomous-daemon' },
        settled: false,
        created_at: '2026-01-03T16:00:00.000Z',
        ...overrides
    };
}

function providerRecord() {
    return {
        event_id: 'PAYPAL_CAPTURE_1',
        amount: 19,
        currency: 'USD',
        status: 'VERIFIED',
        verification_proof: { type: 'psp_transaction_id', psp_id: PAYPAL_ID },
        metadata: { paypal_capture_id: PAYPAL_ID }
    };
}

function ledgerDir(records) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quarantine-'));
    for (const [name, value] of Object.entries(records)) {
        fs.writeFileSync(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
    }
    return dir;
}

test('a stored VERIFIED record with a self-issued proof is rewritten to UNVERIFIED', () => {
    const dir = ledgerDir({ 'revenue_LIVE_1.json': selfProofRecord() });
    const report = quarantineDirectory(dir, { apply: true, now: '2026-11-20T00:00:00.000Z' });

    assert.equal(report.changed, 1);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'revenue_LIVE_1.json'), 'utf8'));
    assert.equal(saved.status, 'UNVERIFIED');
    assert.equal(saved.amount, 75, 'the amount is preserved, not deleted');
    assert.equal(saved.quarantine.previous_status, 'VERIFIED');
    assert.equal(saved.quarantine.reason, 'self_issued_proof');
    assert.equal(saved.quarantine.psp_id, 'PROOF_1767462282250');
    assert.equal(saved.quarantine.quarantined_at, '2026-11-20T00:00:00.000Z');
    assert.equal(saved.verification_proof.type, 'autonomous_execution', 'the evidence that made it unverified is kept');
    assert.equal(saved.metadata.created_by, 'autonomous-daemon');
});

test('a record backed by a provider transaction id is left byte-for-byte alone', () => {
    const dir = ledgerDir({ 'revenue_paypal.json': providerRecord() });
    const before = fs.readFileSync(path.join(dir, 'revenue_paypal.json'), 'utf8');

    const report = quarantineDirectory(dir, { apply: true, now: '2026-11-20T00:00:00.000Z' });
    assert.equal(report.changed, 0);
    assert.equal(fs.readFileSync(path.join(dir, 'revenue_paypal.json'), 'utf8'), before);
});

test('payout batches and earning rows are not revenue and are never touched', () => {
    const batch = {
        batch_id: 'BATCH_STIMULUS_1',
        status: 'completed',
        total_amount: 850,
        items: [{ amount: 850, currency: 'USDT', status: 'VERIFIED', proof: 'PROOF_1' }]
    };
    const dir = ledgerDir({ 'batch_BATCH_STIMULUS_1.json': batch });
    const before = fs.readFileSync(path.join(dir, 'batch_BATCH_STIMULUS_1.json'), 'utf8');

    const report = quarantineDirectory(dir, { apply: true });
    assert.equal(report.changed, 0);
    assert.equal(fs.readFileSync(path.join(dir, 'batch_BATCH_STIMULUS_1.json'), 'utf8'), before);
});

test('running the migration again changes nothing and writes no bytes', () => {
    const dir = ledgerDir({ 'revenue_LIVE_1.json': selfProofRecord() });
    quarantineDirectory(dir, { apply: true, now: '2026-11-20T00:00:00.000Z' });
    const afterFirst = fs.readFileSync(path.join(dir, 'revenue_LIVE_1.json'), 'utf8');

    const second = quarantineDirectory(dir, { apply: true, now: '2026-11-21T00:00:00.000Z' });
    assert.equal(second.changed, 0);
    assert.equal(fs.readFileSync(path.join(dir, 'revenue_LIVE_1.json'), 'utf8'), afterFirst);
    const saved = JSON.parse(afterFirst);
    assert.equal(saved.quarantine.quarantined_at, '2026-11-20T00:00:00.000Z', 'the first quarantine is not overwritten');
});

test('a dry run reports the record without writing it', () => {
    const dir = ledgerDir({ 'revenue_LIVE_1.json': selfProofRecord() });
    const before = fs.readFileSync(path.join(dir, 'revenue_LIVE_1.json'), 'utf8');

    const report = quarantineDirectory(dir, { apply: false });
    assert.equal(report.changed, 1);
    assert.equal(report.applied, false);
    assert.equal(fs.readFileSync(path.join(dir, 'revenue_LIVE_1.json'), 'utf8'), before);
});

test('an already-UNVERIFIED record is not rewritten or re-annotated', () => {
    const record = selfProofRecord({ status: 'UNVERIFIED', quarantine: { previous_status: 'VERIFIED', reason: 'self_issued_proof' } });
    const report = quarantineRecord(record, { now: '2026-11-20T00:00:00.000Z' });
    assert.equal(report.changed, false);
    assert.equal(report.record.quarantine.previous_status, 'VERIFIED');
});

test('a VERIFIED record cannot be stored without a provider transaction id', () => {
    assert.throws(
        () => assertStorableRevenueStatus(selfProofRecord()),
        error => {
            assert.ok(error instanceof RevenueNotProviderVerifiedError);
            assert.equal(error.code, 'REVENUE_NOT_PROVIDER_VERIFIED');
            assert.match(error.message, /Refusing to record revenue event LIVE_1767462282000/);
            return true;
        }
    );
});

test('the storage guard accepts a provider-backed VERIFIED record and ignores honest statuses', () => {
    assert.equal(assertStorableRevenueStatus(providerRecord()).status, 'VERIFIED');
    assert.equal(assertStorableRevenueStatus(selfProofRecord({ status: 'UNVERIFIED' })).status, 'UNVERIFIED');
    assert.equal(assertStorableRevenueStatus({ status: undefined }).status, null);
});

test('a whole-file encrypted record is decrypted, rewritten in place and written back sealed', () => {
    withEncryptionKey(() => {
        const dir = ledgerDir({});
        const file = path.join(dir, 'revenue_LIVE_sealed.json');
        fs.writeFileSync(file, encryptBuffer(Buffer.from(`${JSON.stringify(selfProofRecord(), null, 2)}\n`, 'utf8')));
        const before = fs.readFileSync(file);

        const report = quarantineDirectory(dir, { apply: true, now: '2026-11-20T00:00:00.000Z' });
        assert.equal(report.unreadable, 0, 'a sealed record is not counted as unreadable');
        assert.equal(report.changed, 1);

        const sealed = fs.readFileSync(file);
        assert.notDeepEqual(sealed, before, 'the rewrite actually reached the disk');
        assert.deepEqual(sealed.subarray(0, 8), Buffer.from('DATAENC1'), 'the file stays whole-file encrypted');

        const saved = JSON.parse(decryptBuffer(sealed).toString('utf8'));
        assert.equal(saved.status, 'UNVERIFIED');
        assert.equal(saved.amount, 75, 'the amount survives the round trip');
        assert.equal(saved.quarantine.reason, 'self_issued_proof');
        assert.equal(saved.quarantine.psp_id, 'PROOF_1767462282250');
        assert.equal(saved.verification_proof.type, 'autonomous_execution');

        const afterFirst = fs.readFileSync(file);
        const second = quarantineDirectory(dir, { apply: true, now: '2026-11-21T00:00:00.000Z' });
        assert.equal(second.changed, 0);
        assert.deepEqual(fs.readFileSync(file), afterFirst, 'a second run rewrites no bytes');
    });
});

test('a record nested under `data` is rewritten there and the rest of the file survives', () => {
    const wrapper = {
        type: 'revenue_record',
        version: 2,
        notes: ['do not drop'],
        data: selfProofRecord({ nested_note: 'keep me' })
    };
    const dir = ledgerDir({ 'revenue_data_1.json': wrapper });

    const report = quarantineDirectory(dir, { apply: true, now: '2026-11-20T00:00:00.000Z' });
    assert.equal(report.changed, 1);

    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'revenue_data_1.json'), 'utf8'));
    assert.equal(saved.data.status, 'UNVERIFIED', 'the nested record is the one rewritten');
    assert.equal(saved.data.quarantine.previous_status, 'VERIFIED');
    assert.equal(saved.data.nested_note, 'keep me');
    assert.equal(saved.type, 'revenue_record', 'the wrapper keeps its own fields');
    assert.equal(saved.version, 2);
    assert.deepEqual(saved.notes, ['do not drop']);
    assert.equal(saved.status, undefined, 'the wrapper is not turned into a revenue event');
});

test('the repository ledger stores no VERIFIED record without a provider transaction id', () => {
    const dir = path.resolve('data/autonomous/ledger');
    if (!fs.existsSync(dir)) return;
    const report = quarantineDirectory(dir, { apply: false });
    assert.equal(
        report.changed,
        0,
        `${report.changed} stored record(s) still claim VERIFIED without provider evidence; run npm run ledger:quarantine -- --apply`
    );
});
