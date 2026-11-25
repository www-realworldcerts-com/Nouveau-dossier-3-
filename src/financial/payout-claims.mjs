import fs from 'node:fs';
import path from 'node:path';

import { writeJsonPlainAtomic } from '../security/data-at-rest.mjs';

/**
 * Persisted in-flight payout claims.
 *
 * The settlement daemon builds a batch, pays it, and only then marks its rows.
 * A crash in between leaves no record that money may already have moved: the
 * rows are still VERIFIED, the next cycle selects them again and sends a second
 * payout. PayPal refuses a reused `sender_batch_id`, but nothing in the daemon
 * knows the batch was ever attempted, and the CSV rails have no such protection
 * at all.
 *
 * So a claim is written to disk and flushed *before* the rail is called, and
 * closed only once the rows are marked. Every cycle reconciles the open claims
 * against the ledger before it may pay anything: a claim whose rows are now
 * accounted for is closed, one with a recorded execution finishes the marks it
 * was interrupted before (that cannot move money twice), and anything else is
 * reported and its rows are withheld from every later batch.
 *
 * The store is plain JSON, written through a temp file and renamed: money
 * recovery must not depend on the encryption key being present, and a crash
 * cannot leave a half-written claim. It is keyed by batch id; an open claim
 * also reserves its revenue rows, because a new event can change the batch id
 * of the rows that were already claimed.
 *
 * Reconciling with the provider is the owner's step, not this module's: the
 * crash may have happened after the request left, and only PayPal can say
 * whether it arrived. Once that is confirmed, close the claim with
 * `resolvePayoutClaim` or the daemon's `--resolve-claim <batch_id>` flag — only
 * when the provider holds nothing — and those rows become payable again.
 * Anything else stays open rather than risk a second payout.
 *
 * The daemon is a single process per store; claims are claim-once and are not
 * written concurrently.
 */

export const PAYOUT_CLAIM_STORE_ENV = 'PAYOUT_CLAIM_STORE';
export const DEFAULT_PAYOUT_CLAIM_FILE = path.join('data', 'financial', 'payout-claims.json');

/** Written before the rail is called; the provider may now hold the payout. */
export const PAYOUT_CLAIM_IN_FLIGHT = 'in_flight';
/** The rail reported success and its result is recorded; marks may be missing. */
export const PAYOUT_CLAIM_EXECUTED = 'executed';
/**
 * The claim no longer holds its rows. `execution` says what paid them, and
 * `resolution` says why a claim was closed without one.
 */
export const PAYOUT_CLAIM_CLOSED = 'closed';

const OPEN_STATUSES = new Set([PAYOUT_CLAIM_IN_FLIGHT, PAYOUT_CLAIM_EXECUTED]);

export function payoutClaimStorePath(root = process.cwd(), env = process.env) {
    const configured = String(env?.[PAYOUT_CLAIM_STORE_ENV] ?? '').trim();
    if (configured) return path.resolve(configured);
    return path.resolve(root, DEFAULT_PAYOUT_CLAIM_FILE);
}

/** Claims whose money may already have moved. */
export function openPayoutClaims(claims = []) {
    return (Array.isArray(claims) ? claims : []).filter(claim => OPEN_STATUSES.has(claim?.status));
}

/**
 * Exported batches waiting for an operator to say the file was uploaded: closed
 * by the claim lifecycle, paid by a manual CSV, and not yet resolved. The
 * confirmation step accepts exactly these, daemon health lists them and the
 * audit ages them, so the three cannot disagree about what is waiting.
 */
export function exportedClaimsAwaitingConfirmation(claims = []) {
    return (Array.isArray(claims) ? claims : []).filter(claim =>
        claim?.status === PAYOUT_CLAIM_CLOSED &&
        claim?.execution?.method === 'manual_csv' &&
        !claim?.resolution
    );
}

/** The revenue rows every open claim reserves. */
export function claimedRevenueEventIds(claims = []) {
    const ids = new Set();
    for (const claim of openPayoutClaims(claims)) {
        for (const id of claim.revenue_event_ids ?? []) {
            const value = String(id ?? '').trim();
            if (value) ids.add(value);
        }
    }
    return ids;
}

/**
 * The stored claims. A missing file is an empty store; an unreadable one is an
 * error the caller must treat as "unknown", never as "nothing in flight".
 */
export function readPayoutClaims(root = process.cwd(), { env = process.env } = {}) {
    const file = payoutClaimStorePath(root, env);
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') return { path: file, claims: [], error: null };
        return { path: file, claims: [], error: String(error?.message ?? error) };
    }
    try {
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed?.claims)) {
            return { path: file, claims: [], error: 'claim store has no claims array' };
        }
        return { path: file, claims: parsed.claims, error: null };
    } catch (error) {
        return { path: file, claims: [], error: String(error?.message ?? error) };
    }
}

function savePayoutClaims(file, claims) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonPlainAtomic(file, { version: 1, updated_at: new Date().toISOString(), claims });
    return claims;
}

/**
 * Record that this batch is about to be paid. Refuses when the batch id or any
 * of its rows is already claimed: that is the case a retry would double-pay.
 */
export function claimPayoutBatch(root = process.cwd(), claim = {}, { env = process.env } = {}) {
    const batchId = String(claim?.batch_id ?? '').trim();
    if (!batchId) return { claimed: false, reason: 'batch_id_missing' };

    const store = readPayoutClaims(root, { env });
    if (store.error) {
        // An unreadable store cannot prove this batch is new, so it is not paid.
        return { claimed: false, reason: 'claim_store_unreadable', error: store.error };
    }

    const ids = new Set((claim.revenue_event_ids ?? []).map(id => String(id)).filter(Boolean));
    const conflict = openPayoutClaims(store.claims).find(existing =>
        String(existing?.batch_id ?? '') === batchId ||
        (existing?.revenue_event_ids ?? []).some(id => ids.has(String(id)))
    );
    if (conflict) return { claimed: false, reason: 'already_claimed', existing: conflict };

    const record = {
        ...claim,
        batch_id: batchId,
        revenue_event_ids: [...ids],
        status: PAYOUT_CLAIM_IN_FLIGHT,
        claimed_at: new Date().toISOString(),
        closed_at: null,
        execution: null,
        error: null
    };
    const claims = [
        ...store.claims.filter(existing => String(existing?.batch_id ?? '') !== batchId),
        record
    ];
    savePayoutClaims(store.path, claims);
    return { claimed: true, claim: record };
}

/**
 * Update a claim after the rail was called. A status is only advanced here;
 * `in_flight` is kept (with the error) when the rail failed, because the
 * provider may have accepted the request before the failure reached us.
 */
export function recordPayoutOutcome(root = process.cwd(), batchId = '', { status, execution, error } = {}, { env = process.env } = {}) {
    const store = readPayoutClaims(root, { env });
    if (store.error) return { recorded: false, reason: 'claim_store_unreadable', error: store.error };

    const id = String(batchId ?? '').trim();
    const existing = store.claims.find(claim => String(claim?.batch_id ?? '') === id);
    if (!existing) return { recorded: false, reason: 'claim_missing' };

    const next = {
        ...existing,
        ...(status ? { status } : {}),
        ...(execution !== undefined ? { execution } : {}),
        ...(error !== undefined ? { error } : {})
    };
    if (!OPEN_STATUSES.has(next.status)) next.closed_at = new Date().toISOString();
    const claims = store.claims.map(claim => (claim === existing ? next : claim));
    savePayoutClaims(store.path, claims);
    return { recorded: true, claim: next };
}

/**
 * Record that an exported batch was paid.
 *
 * A CSV rail stops at `export_ready`: the file is an instruction to a human, so
 * the daemon cannot know the transfer happened and must neither call the row
 * settled nor select it again. Only the operator can say so, and their
 * confirmation is stamped here — on the already-closed claim — so that a second
 * confirmation is a no-op instead of a second payment, and a batch closed as
 * never sent has nothing to confirm.
 */
export function confirmPayoutBatch(root = process.cwd(), batchId = '', { by = null, note = null } = {}, { env = process.env } = {}) {
    const store = readPayoutClaims(root, { env });
    if (store.error) return { confirmed: false, reason: 'claim_store_unreadable', error: store.error };

    const id = String(batchId ?? '').trim();
    const existing = store.claims.find(claim => String(claim?.batch_id ?? '') === id);
    if (!existing) return { confirmed: false, reason: 'claim_missing' };
    // An open claim is money that may still be on its way: confirming a payment
    // for it would record a payout the batch never reported.
    if (OPEN_STATUSES.has(existing.status)) return { confirmed: false, reason: 'claim_open', claim: existing };
    if (existing.resolution?.outcome === 'not_sent') return { confirmed: false, reason: 'never_sent', claim: existing };
    if (existing.resolution?.outcome === 'paid') return { confirmed: false, reason: 'already_confirmed', claim: existing };

    const next = {
        ...existing,
        resolution: { outcome: 'paid', note, resolved_by: by, at: new Date().toISOString() }
    };
    const claims = store.claims.map(claim => (claim === existing ? next : claim));
    savePayoutClaims(store.path, claims);
    return { confirmed: true, claim: next };
}

/**
 * Close a claim whose provider was confirmed to hold nothing. This is the only
 * way back to payable rows that reconciliation cannot prove: a claim whose
 * money may have moved stays open, because re-sending it is the failure this
 * store exists to prevent.
 */
export function resolvePayoutClaim(root = process.cwd(), batchId = '', { note = null, resolvedBy = null } = {}, { env = process.env } = {}) {
    const store = readPayoutClaims(root, { env });
    if (store.error) return { resolved: false, reason: 'claim_store_unreadable', error: store.error };

    const id = String(batchId ?? '').trim();
    const existing = store.claims.find(claim => String(claim?.batch_id ?? '') === id);
    if (!existing) return { resolved: false, reason: 'claim_missing' };
    if (!OPEN_STATUSES.has(existing.status)) return { resolved: false, reason: 'claim_already_closed', claim: existing };

    const next = {
        ...existing,
        status: PAYOUT_CLAIM_CLOSED,
        resolution: { outcome: 'not_sent', note, resolved_by: resolvedBy, at: new Date().toISOString() },
        closed_at: new Date().toISOString()
    };
    const claims = store.claims.map(claim => (claim === existing ? next : claim));
    savePayoutClaims(store.path, claims);
    return { resolved: true, claim: next };
}
