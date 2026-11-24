import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { claimPayoutBatch, recordPayoutOutcome } from '../src/financial/payout-claims.mjs';
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
