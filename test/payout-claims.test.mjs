import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    PAYOUT_CLAIM_CLOSED,
    PAYOUT_CLAIM_EXECUTED,
    claimPayoutBatch,
    claimedRevenueEventIds,
    confirmPayoutBatch,
    openPayoutClaims,
    readPayoutClaims,
    recordPayoutOutcome,
    resolvePayoutClaim
} from '../src/financial/payout-claims.mjs';

/**
 * The claim store is the daemon's only memory that a payout may already have
 * left: these tests pin what it must refuse, not how it stores it.
 */
function tempStore(t) {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'payout-claims-')), 'claims.json');
    t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
    return { file, env: { PAYOUT_CLAIM_STORE: file } };
}

function claim(overrides = {}) {
    return {
        batch_id: 'BATCH_PAYONEER_0123456789abcdef01234567',
        rail: 'PAYONEER',
        revenue_event_ids: ['rev-1', 'rev-2'],
        amount: 19,
        currency: 'USD',
        ...overrides
    };
}

test('a claim reserves its batch and every row in it', t => {
    const { env } = tempStore(t);

    const first = claimPayoutBatch('/root', claim(), { env });
    assert.equal(first.claimed, true);
    assert.equal(first.claim.status, 'in_flight');

    assert.equal(claimPayoutBatch('/root', claim(), { env }).reason, 'already_claimed');

    // A new event changes the batch id, so the rows must be reserved by id too.
    const overlap = claimPayoutBatch('/root', claim({ batch_id: 'BATCH_PAYONEER_ffffffffffffffffffffffff', revenue_event_ids: ['rev-2', 'rev-3'] }), { env });
    assert.equal(overlap.claimed, false);
    assert.equal(overlap.reason, 'already_claimed');

    assert.equal(
        claimPayoutBatch('/root', claim({ batch_id: 'BATCH_PAYONEER_aaaaaaaaaaaaaaaaaaaaaaaa', revenue_event_ids: ['rev-9'] }), { env }).claimed,
        true,
        'an unrelated batch is not blocked'
    );

    const { claims } = readPayoutClaims('/root', { env });
    assert.deepEqual([...claimedRevenueEventIds(claims)].sort(), ['rev-1', 'rev-2', 'rev-9']);
});

test('a store that cannot be read refuses the claim instead of paying blind', t => {
    const { file, env } = tempStore(t);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"claims": [');

    const read = readPayoutClaims('/root', { env });
    assert.match(read.error, /JSON/i);
    assert.deepEqual(read.claims, []);

    const refused = claimPayoutBatch('/root', claim(), { env });
    assert.equal(refused.claimed, false);
    assert.equal(refused.reason, 'claim_store_unreadable');
});

test('an absent store is an empty store, not an error', () => {
    const read = readPayoutClaims('/root', { env: { PAYOUT_CLAIM_STORE: path.join(os.tmpdir(), 'never-written', 'claims.json') } });
    assert.equal(read.error, null);
    assert.deepEqual(read.claims, []);
});

test('a claim stays open until the rows are marked', t => {
    const { env } = tempStore(t);
    claimPayoutBatch('/root', claim(), { env });

    const executed = recordPayoutOutcome('/root', claim().batch_id, {
        status: PAYOUT_CLAIM_EXECUTED,
        execution: { method: 'manual_csv', export_filename: 'payoneer_x.csv' }
    }, { env });
    assert.equal(executed.recorded, true);
    assert.equal(openPayoutClaims(readPayoutClaims('/root', { env }).claims).length, 1, 'money may have moved');

    recordPayoutOutcome('/root', claim().batch_id, { status: PAYOUT_CLAIM_CLOSED, error: null }, { env });
    const { claims } = readPayoutClaims('/root', { env });
    assert.deepEqual(openPayoutClaims(claims), []);
    assert.equal(claims[0].closed_at != null, true);
    assert.equal(claims[0].execution.export_filename, 'payoneer_x.csv', 'the recorded payout survives closing');

    assert.equal(recordPayoutOutcome('/root', 'BATCH_UNKNOWN', { status: PAYOUT_CLAIM_CLOSED }, { env }).reason, 'claim_missing');
});

test('only a confirmed non-send closes a claim and frees its rows', t => {
    const { env } = tempStore(t);
    claimPayoutBatch('/root', claim(), { env });

    assert.equal(resolvePayoutClaim('/root', 'BATCH_UNKNOWN', {}, { env }).reason, 'claim_missing');

    const resolved = resolvePayoutClaim('/root', claim().batch_id, { note: 'PayPal has no such batch', resolvedBy: 'owner' }, { env });
    assert.equal(resolved.resolved, true);
    assert.equal(resolved.claim.status, PAYOUT_CLAIM_CLOSED);
    assert.equal(resolved.claim.resolution.outcome, 'not_sent');
    assert.equal(resolved.claim.resolution.resolved_by, 'owner');

    const { claims } = readPayoutClaims('/root', { env });
    assert.deepEqual(openPayoutClaims(claims), []);
    assert.deepEqual([...claimedRevenueEventIds(claims)], []);
    assert.equal(resolvePayoutClaim('/root', claim().batch_id, {}, { env }).reason, 'claim_already_closed');

    // The rows are payable again, under the same deterministic batch id.
    assert.equal(claimPayoutBatch('/root', claim(), { env }).claimed, true);
});

test('only a closed export can be confirmed as paid, and only once', t => {
    const { env } = tempStore(t);
    claimPayoutBatch('/root', claim(), { env });

    // Money may still be on its way: the claim is open.
    const early = confirmPayoutBatch('/root', claim().batch_id, { by: 'owner' }, { env });
    assert.equal(early.confirmed, false);
    assert.equal(early.reason, 'claim_open');

    recordPayoutOutcome('/root', claim().batch_id, {
        status: PAYOUT_CLAIM_EXECUTED,
        execution: { method: 'manual_csv', export_filename: 'payoneer_x.csv' }
    }, { env });
    recordPayoutOutcome('/root', claim().batch_id, { status: PAYOUT_CLAIM_CLOSED, error: null }, { env });

    const confirmed = confirmPayoutBatch('/root', claim().batch_id, { by: 'owner', note: 'uploaded' }, { env });
    assert.equal(confirmed.confirmed, true);
    assert.equal(confirmed.claim.status, PAYOUT_CLAIM_CLOSED);
    assert.equal(confirmed.claim.resolution.outcome, 'paid');
    assert.equal(confirmed.claim.resolution.resolved_by, 'owner');
    assert.equal(typeof confirmed.claim.resolution.at, 'string');
    assert.equal(confirmed.claim.paid_at, undefined, 'the confirmation time lives once, in the resolution');
    assert.equal(confirmed.claim.execution.export_filename, 'payoneer_x.csv', 'the exported file survives confirmation');

    const again = confirmPayoutBatch('/root', claim().batch_id, {}, { env });
    assert.equal(again.confirmed, false);
    assert.equal(again.reason, 'already_confirmed');
    assert.equal(again.claim.resolution.outcome, 'paid');

    assert.equal(confirmPayoutBatch('/root', 'BATCH_UNKNOWN', {}, { env }).reason, 'claim_missing');
});

test('a claim closed as never sent cannot be confirmed as paid', t => {
    const { env } = tempStore(t);
    claimPayoutBatch('/root', claim(), { env });
    resolvePayoutClaim('/root', claim().batch_id, { note: 'provider holds nothing' }, { env });

    const refused = confirmPayoutBatch('/root', claim().batch_id, { by: 'owner' }, { env });
    assert.equal(refused.confirmed, false);
    assert.equal(refused.reason, 'never_sent');
    assert.equal(refused.claim.resolution.outcome, 'not_sent');
});
