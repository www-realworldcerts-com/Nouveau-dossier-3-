import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { claimPayoutBatch, recordPayoutOutcome } from '../src/financial/payout-claims.mjs';
import { DEFAULT_EXPORT_CONFIRM_DAYS } from '../src/resilience/silent-failure.mjs';
import { detectSilentFailures } from '../src/resilience/silent-failure.mjs';

const NOW = new Date('2026-11-24T12:00:00Z');
const DAY = 86400000;

function tempRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'payout-claim-audit-'));
}

/** A clean audit apart from whatever the test puts in the claim store. */
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

/** Writes the claim store directly: the audit reads it, so its ages must be exact. */
function writeClaims(root, claims) {
    const file = path.join(root, 'data', 'financial', 'payout-claims.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, claims }));
}

/** A CSV batch the daemon exported `daysAgo` days ago and nobody has confirmed. */
function exportedClaim({ daysAgo = 5, ...overrides } = {}) {
    const exportedAt = new Date(NOW.getTime() - daysAgo * DAY).toISOString();
    return {
        batch_id: 'BATCH_PAYONEER_0123456789abcdef01234567',
        rail: 'PAYONEER',
        revenue_event_ids: ['rev-1', 'rev-2'],
        amount: 38,
        currency: 'USD',
        status: 'closed',
        claimed_at: exportedAt,
        closed_at: exportedAt,
        execution: { method: 'manual_csv', export_filename: 'payoneer_BATCH_PAYONEER_0123456789abcdef01234567.csv' },
        resolution: null,
        error: null,
        ...overrides
    };
}

const BATCH_ID = 'BATCH_PAYONEER_0123456789abcdef01234567';

function claim(root, overrides = {}) {
    return claimPayoutBatch(root, {
        batch_id: BATCH_ID,
        rail: 'PAYONEER',
        revenue_event_ids: ['rev-1', 'rev-2'],
        amount: 38,
        currency: 'USD',
        ...overrides
    }, { env: {} });
}

test('an unresolved claim is a critical finding the audit raises', () => {
    const root = tempRoot();
    claim(root);

    const { findings, evidence } = detectSilentFailures(cleanOptions(root));

    const finding = findings.find(item => item.code === 'PAYOUT_CLAIM_UNRESOLVED');
    assert.ok(finding, 'money whose fate is unknown must be an incident');
    assert.equal(finding.severity, 'critical');
    assert.match(finding.detail, /BATCH_PAYONEER_0123456789abcdef01234567/);

    const [row] = finding.evidence.rows;
    assert.equal(row.batch_id, BATCH_ID);
    assert.equal(row.rail, 'PAYONEER');
    assert.equal(row.status, 'in_flight');
    assert.deepEqual(row.revenue_event_ids, ['rev-1', 'rev-2']);
    assert.equal(row.amount, 38);
    assert.equal(evidence.payout_claims.open, 1);
    assert.equal(evidence.payout_claims.path, path.join(root, 'data', 'financial', 'payout-claims.json'));

    // No payout was refused, so the settlement-block finding must not claim one.
    assert.equal(findings.some(item => item.code === 'REVENUE_SETTLEMENT_BLOCKED'), false);
});

test('a claim that was paid and marked is no longer a finding', () => {
    const root = tempRoot();
    claim(root);
    recordPayoutOutcome(root, BATCH_ID, { status: 'settled' }, { env: {} });

    const { findings, evidence } = detectSilentFailures(cleanOptions(root));

    assert.equal(findings.some(item => item.code === 'PAYOUT_CLAIM_UNRESOLVED'), false);
    assert.equal(evidence.payout_claims.open, 0);
});

test('an exported batch past the confirmation window is a finding the audit raises', () => {
    const root = tempRoot();
    writeClaims(root, [exportedClaim({ daysAgo: DEFAULT_EXPORT_CONFIRM_DAYS + 2 })]);

    const { findings, evidence } = detectSilentFailures(cleanOptions(root));

    const finding = findings.find(item => item.code === 'PAYOUT_EXPORT_UNCONFIRMED');
    assert.ok(finding, 'revenue exported but never confirmed must be an incident');
    assert.equal(finding.severity, 'high');
    assert.match(finding.detail, /BATCH_PAYONEER_0123456789abcdef01234567/);

    const [row] = finding.evidence.rows;
    assert.equal(row.batch_id, BATCH_ID);
    assert.equal(row.rail, 'PAYONEER');
    assert.equal(row.amount, 38);
    assert.equal(row.export_filename, `payoneer_${BATCH_ID}.csv`);
    assert.equal(row.age_days, DEFAULT_EXPORT_CONFIRM_DAYS + 2);
    assert.equal(finding.evidence.threshold_days, DEFAULT_EXPORT_CONFIRM_DAYS);
    assert.equal(evidence.payout_claims.awaiting_confirmation, 1);

    // An export is not a payout in flight: it must not also be reported as
    // money whose fate is unknown.
    assert.equal(findings.some(item => item.code === 'PAYOUT_CLAIM_UNRESOLVED'), false);
});

test('a fresh export and a confirmed or never-sent one are not findings', () => {
    const root = tempRoot();
    const paidAt = new Date(NOW.getTime() - 30 * DAY).toISOString();
    writeClaims(root, [
        exportedClaim({ batch_id: 'BATCH_PAYONEER_fresh000000000000000000', daysAgo: 1 }),
        exportedClaim({
            batch_id: 'BATCH_PAYONEER_paid0000000000000000000',
            resolution: { outcome: 'paid', note: 'uploaded', resolved_by: 'owner', at: paidAt }
        }),
        exportedClaim({
            batch_id: 'BATCH_PAYONEER_neversent00000000000000',
            resolution: { outcome: 'not_sent', note: 'nothing arrived', resolved_by: 'owner', at: paidAt }
        })
    ]);

    const { findings, evidence } = detectSilentFailures(cleanOptions(root));

    assert.equal(findings.some(item => item.code === 'PAYOUT_EXPORT_UNCONFIRMED'), false);
    assert.equal(evidence.payout_claims.awaiting_confirmation, 1, 'only the fresh export is still waiting');
});

test('an export with no readable age is reported rather than assumed young', () => {
    const root = tempRoot();
    writeClaims(root, [exportedClaim({ closed_at: 'not-a-date', claimed_at: null })]);

    const { findings } = detectSilentFailures(cleanOptions(root));

    const finding = findings.find(item => item.code === 'PAYOUT_EXPORT_UNCONFIRMED');
    assert.ok(finding);
    assert.match(finding.detail, /age unknown/);
    assert.equal(finding.evidence.rows[0].age_days, null);
});

test('the confirmation window is configurable', () => {
    const root = tempRoot();
    writeClaims(root, [exportedClaim({ daysAgo: 2 })]);

    assert.equal(
        detectSilentFailures(cleanOptions(root)).findings.some(item => item.code === 'PAYOUT_EXPORT_UNCONFIRMED'),
        false,
        'two days is inside the default window'
    );
    assert.equal(
        detectSilentFailures(cleanOptions(root, { exportConfirmDays: 1 })).findings
            .some(item => item.code === 'PAYOUT_EXPORT_UNCONFIRMED'),
        true
    );
});

test('a claim store that cannot be read is a finding, not a clean audit', () => {
    const root = tempRoot();
    const file = path.join(root, 'data', 'financial', 'payout-claims.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"claims": [');

    const { findings, evidence } = detectSilentFailures(cleanOptions(root));

    const finding = findings.find(item => item.code === 'PAYOUT_CLAIM_UNRESOLVED');
    assert.ok(finding);
    assert.match(finding.detail, /could not be read/);
    assert.match(evidence.payout_claims.store_error, /JSON/i);
});
