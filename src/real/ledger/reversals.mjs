/**
 * Reverse revenue when a capture is refunded, reversed or disputed.
 *
 * A refund or chargeback is not a status change: the money left. Writing a
 * `refunded` string onto the original record keeps its positive amount in the
 * ledger, so every total still reports revenue that was returned. This module
 * writes a second, negative event keyed to the capture that was reversed
 * (`reversal_of`), which nets the two rows to zero while keeping both on the
 * record. Reversing twice is refused by the same key.
 *
 * A reversal whose capture is not in the ledger cannot be netted out. That is
 * reported as a critical finding instead of silently dropping the money.
 */

import fs from 'node:fs';
import path from 'node:path';

import { readJsonAtRest, writeJsonAtomic } from '../../security/data-at-rest.mjs';
import { revenueEventsIn } from './quarantine.mjs';

export const REVENUE_REVERSAL_WITHOUT_CAPTURE = 'REVENUE_REVERSAL_WITHOUT_CAPTURE';

/** Each accepted reversal type and how it reads in a finding. */
const REVERSAL_TYPES = new Map([
    ['refunded', 'refund'],
    ['reversed', 'reversal'],
    ['disputed', 'dispute']
]);

/** The metadata/proof fields a capture event can identify itself by. */
function captureIds(record) {
    const meta = record?.metadata ?? {};
    const proof = record?.verification_proof ?? meta.verification_proof ?? null;
    return [meta.paypal_capture_id, meta.psp_transaction_id, proof?.psp_id]
        .filter((value) => value != null && String(value).trim() !== '')
        .map((value) => String(value).trim());
}

/** Every revenue record in a directory with the file it lives in. */
export function readLedgerRecords(dir) {
    const resolved = path.resolve(dir);
    const records = [];
    if (!fs.existsSync(resolved)) return { directory: resolved, records };
    for (const name of fs.readdirSync(resolved).filter((file) => file.endsWith('.json')).sort()) {
        const file = path.join(resolved, name);
        let stored;
        try {
            stored = readJsonAtRest(file);
        } catch {
            continue;
        }
        for (const record of revenueEventsIn(stored.value)) {
            records.push({ file, sealed: stored.sealed, record });
        }
    }
    return { directory: resolved, records };
}

export function findCaptureRecord(records, captureId) {
    const id = String(captureId ?? '').trim();
    if (!id) return null;
    return records.find(({ record }) =>
        !record?.reversal_of &&
        !record?.metadata?.reversal_of &&
        captureIds(record).includes(id)
    ) ?? null;
}

/** A reversal id that is stable across a replayed webhook. */
function reversalKey(reversal, captureId) {
    return String(reversal?.externalId || `${reversal?.type ?? 'reversal'}_${captureId}`);
}

function fileForReversal(dir, key) {
    const safe = key.replace(/[^A-Za-z0-9._-]/g, '_');
    return path.join(path.resolve(dir), `reversal_${safe}.json`);
}

/** The refunded amount, or the whole captured amount when none was stated. */
function amountOf(reversal, capture) {
    const declared = Number(reversal?.amount);
    if (Number.isFinite(declared) && declared > 0) return declared;
    const captured = Math.abs(Number(capture?.record?.amount));
    return Number.isFinite(captured) && captured > 0 ? captured : null;
}

/**
 * The loud, actionable result when a reversal cannot be netted out.
 *
 * `ledger` names the ledger searched, so a missing Base44 row cannot be
 * mistaken for a missing local file (and the reverse).
 */
export function reversalWithoutCaptureFinding(reversal, {
    captureId = null,
    reason = 'capture_not_found',
    now = new Date().toISOString(),
    ledger = 'the local revenue ledger'
} = {}) {
    const amount = reversal?.amount == null ? null : Number(reversal.amount);
    const currency = String(reversal?.currency || '').toUpperCase() || null;
    const subject = captureId ? `capture ${captureId}` : 'no capture id';
    const label = REVERSAL_TYPES.get(reversal?.type) ?? reversal?.type ?? 'reversal';
    return {
        code: REVENUE_REVERSAL_WITHOUT_CAPTURE,
        domain: 'revenue',
        severity: 'critical',
        title: 'A refund, reversal or dispute has no matching capture in the ledger',
        detail:
            `A ${label}${amount != null ? ` of ${currency || '?'} ${amount}` : ''} ` +
            `refers to ${subject}, but no revenue event in ${ledger} is keyed to it (${reason}).`,
        evidence: {
            reversal_event_id: reversal?.externalId ?? null,
            reversal_type: reversal?.type ?? null,
            capture_id: captureId,
            amount,
            currency,
            ledger,
            reason
        },
        detected_at: now
    };
}

/**
 * Reverse `reversal` against the ledger in `dir`.
 *
 * Dry run by default, like the quarantine migration: pass `apply` to write the
 * negative event. Returns the finding instead of throwing when the capture is
 * missing, so a caller can report it and keep the original revenue untouched.
 */
export function applyRevenueReversal({ dir, reversal, apply = false, now = new Date().toISOString() } = {}) {
    const type = String(reversal?.type ?? '').trim().toLowerCase();
    if (!REVERSAL_TYPES.has(type)) {
        throw new Error(`Not a refund, reversal or dispute: ${reversal?.type ?? '(none)'}`);
    }

    const captureId = String(reversal?.original_capture_id ?? '').trim();
    const ledger = readLedgerRecords(dir);
    const key = reversalKey(reversal, captureId);

    const unmatched = (reason) => ({
        applied: false,
        reason,
        finding: reversalWithoutCaptureFinding(reversal, { captureId: captureId || null, reason, now })
    });

    if (!captureId) return unmatched('capture_id_missing');

    if (ledger.records.some(({ record }) => record?.event_id === key)) {
        return { applied: false, reason: 'already_reversed', reversal_event_id: key };
    }

    const original = findCaptureRecord(ledger.records, captureId);
    if (!original) return unmatched('capture_not_found');

    const amount = amountOf(reversal, original);
    if (amount == null) return unmatched('capture_amount_missing');

    const currency = String(reversal?.currency || original.record.currency || '').toUpperCase();
    const occurredAt = reversal?.occurredAt ?? now;
    const refundId = reversal?.metadata?.paypal_refund_id ?? null;
    const disputeId = reversal?.metadata?.paypal_dispute_id ?? null;
    const record = {
        event_id: key,
        amount: -amount,
        currency,
        occurred_at: occurredAt,
        source: reversal?.source ?? 'paypal',
        status: type,
        reversal_of: captureId,
        verification_proof: {
            // The capture id is the provider evidence: it proves which real
            // payment this row reverses, not merely why the status changed.
            type: 'paypal_capture_reversal',
            psp_id: captureId,
            amount,
            currency,
            timestamp: occurredAt,
            ...(refundId ? { refund_id: refundId } : {}),
            ...(disputeId ? { dispute_id: disputeId } : {})
        },
        metadata: {
            paypal_event_type: reversal?.metadata?.paypal_event_type ?? null,
            paypal_event_id: reversal?.metadata?.paypal_event_id ?? null,
            ...(refundId ? { paypal_refund_id: refundId } : {}),
            ...(disputeId ? { paypal_dispute_id: disputeId } : {})
        },
        created_at: now
    };

    const file = fileForReversal(ledger.directory, key);
    if (apply) writeJsonAtomic(file, record, { sealed: original.sealed });

    return {
        applied: Boolean(apply),
        reason: 'reversed',
        reversal: record,
        reversal_event_id: key,
        capture_event_id: original.record.event_id ?? null,
        file
    };
}
