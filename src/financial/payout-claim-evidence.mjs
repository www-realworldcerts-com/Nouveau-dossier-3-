import { getPayoutItemConfigFromEnv } from '../base44-payout.mjs';

/**
 * What the payout-item ledger says about a claim the daemon left in flight.
 *
 * A crash after the provider accepted a payout leaves the claim with no
 * recorded outcome and the revenue rows unmarked. The daemon cannot ask PayPal
 * about a batch whose id it never received, but the payout items the webhook
 * path records are the provider's own statement about those rows: they carry
 * the revenue row and, for batches this daemon sent, the batch id it used as
 * `sender_batch_id`.
 *
 * Success is evidence money moved: when every claimed row has a successful
 * payout item, those rows can be marked settled, which is what un-sticks the
 * claim. Failure is acted on only when it is about *this* batch — a failed item
 * for the same row from an older payout says nothing about the money this claim
 * may have sent, and would free the row for a second payment. Anything else —
 * no records, pending items, only some rows covered — cannot be checked, and
 * the caller must keep withholding.
 */

const SETTLED_STATUSES = new Set(['success', 'succeeded', 'paid', 'paid_out', 'completed', 'settled', 'credited']);
const FAILED_STATUSES = new Set(['failed', 'denied', 'cancelled', 'canceled', 'returned', 'refunded', 'reversed']);

export const PAYOUT_EVIDENCE_SETTLED = 'settled';
export const PAYOUT_EVIDENCE_FAILED = 'failed';
export const PAYOUT_EVIDENCE_UNKNOWN = 'unknown';

function statusOf(record, fieldMap) {
    return String(record?.[fieldMap.status] ?? '').trim().toLowerCase();
}

function unknown(reason, rows = []) {
    return { outcome: PAYOUT_EVIDENCE_UNKNOWN, reason, rows };
}

export async function readPayoutClaimEvidence(base44, claim = {}, { pageSize = 100 } = {}) {
    const batchId = String(claim?.batch_id ?? '').trim();
    const revenueIds = (claim?.revenue_event_ids ?? []).map(id => String(id)).filter(Boolean);
    if (!base44) return unknown('base44_not_configured');
    if (!batchId && revenueIds.length === 0) return unknown('claim_names_no_batch_or_rows');

    const { entityName, fieldMap } = getPayoutItemConfigFromEnv();
    const entity = base44.asServiceRole.entities[entityName];

    let batchRecords = [];
    if (batchId) {
        try {
            const found = await entity.filter({ [fieldMap.batchId]: batchId }, '-created_date', pageSize, 0);
            batchRecords = Array.isArray(found) ? found : [];
        } catch (error) {
            return unknown(`payout items could not be read: ${error?.message ?? error}`);
        }
    }

    // A row's own payout item is evidence too, whichever batch recorded it: the
    // owner's manual transfer of an exported batch lands under the provider's
    // batch id, not the daemon's.
    const byRow = new Map();
    for (const id of revenueIds) {
        if (!fieldMap.revenueEventId) continue;
        try {
            const found = await entity.filter({ [fieldMap.revenueEventId]: id }, '-created_date', pageSize, 0);
            if (Array.isArray(found) && found.length) byRow.set(id, found[0]);
        } catch (error) {
            return unknown(`payout items could not be read: ${error?.message ?? error}`);
        }
    }

    const rows = revenueIds.map(id => {
        const record = byRow.get(id) ?? null;
        return { id, status: record ? statusOf(record, fieldMap) : null, record };
    });

    const settled = rows.filter(row => SETTLED_STATUSES.has(row.status));
    if (rows.length > 0 && settled.length === rows.length) {
        const [first] = settled;
        return {
            outcome: PAYOUT_EVIDENCE_SETTLED,
            provider_batch_id: String(first.record?.[fieldMap.batchId] ?? '').trim() || null,
            transaction_id: first.record?.[fieldMap.transactionId] ?? null,
            rows: rows.map(row => ({ id: row.id, status: row.status }))
        };
    }

    const batchStatuses = batchRecords.map(record => statusOf(record, fieldMap));
    if (
        batchRecords.length > 0 &&
        batchStatuses.every(status => FAILED_STATUSES.has(status)) &&
        !batchStatuses.some(status => SETTLED_STATUSES.has(status))
    ) {
        return {
            outcome: PAYOUT_EVIDENCE_FAILED,
            reason: 'the payout items for this batch record a failure',
            rows: rows.map(row => ({ id: row.id, status: row.status }))
        };
    }

    return unknown(
        batchRecords.length === 0 && settled.length === 0
            ? 'no payout item records this batch or its rows'
            : 'the payout items do not settle every row of the batch',
        rows.map(row => ({ id: row.id, status: row.status }))
    );
}
