import fs from 'node:fs';
import path from 'node:path';

import { getPayPalOrderDetails } from '../../paypal-api.mjs';
import { fulfillPaidOrder } from '../../financial/fulfillment-service.mjs';
import { DEFAULT_QUEUE_FILE, isPaidOrder, readFulfillmentQueue } from './paypal-reconciliation.mjs';

/**
 * Drain paid orders that are already sitting in the fulfilment queue.
 *
 * `logs/fulfillment_queue.log` is append-only and `DELIVERED` is its normal
 * terminal state. Until this module existed nothing read it back: an order that
 * failed to get its access email (provider error, missing payer email, missing
 * `FULFILLMENT_ACCESS_SECRET`) stayed `PENDING_EMAIL` forever, and the
 * reconciliation treated its order id as fulfilled because a line existed.
 *
 * Draining re-reads each pending order from PayPal and re-runs
 * `fulfillPaidOrder`, the same path the webhook uses. Sending is deduplicated by
 * the settlement ledger, not by the queue: a second call for an order whose
 * prepayment recorded `email_status: sent` returns that delivery instead of
 * emailing again. The drain therefore also marks the queue `DELIVERED` when the
 * fulfiller reports an email that the queue has not caught up with, so a
 * ledger-deduplicated order cannot be retried on every tick.
 *
 * Retries are bounded. Every failed attempt appends a queue line carrying
 * `drain.attempts` and `drain.next_attempt_at`, with exponential backoff, so a
 * permanently undeliverable order (bad address, missing payer email, missing
 * secret) is not looked up and re-emailed forever. After `maxAttempts`
 * failures the order becomes `DELIVERY_EXHAUSTED`, is never retried again, and
 * is reported for a human to deliver or refund.
 *
 * An order PayPal reports as not captured is skipped, not delivered, and the
 * skip is recorded too: a line that copies the delivery state, keeps its
 * original `timestamp` and adds `drain.last_skip_at`. Without it a queue full
 * of unpaid orders is indistinguishable from a drain that never ran. The line
 * is written at most once per `SKIP_HEARTBEAT_MS` per order, so an unpaid order
 * does not append a line on every tick.
 *
 * The queue belongs to the host that runs the webhook. A machine that does not
 * have it must not report a clean drain: a missing queue is reported as
 * `skipped_run: 'queue_missing'`.
 */

export const DELIVERED_STATUS = 'DELIVERED';
export const EXHAUSTED_STATUS = 'DELIVERY_EXHAUSTED';
export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_BASE_BACKOFF_MS = 15 * 60 * 1000;
export const DEFAULT_MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
export const SKIP_HEARTBEAT_MS = 60 * 60 * 1000;

const DEFAULT_LIMIT = 25;

function appendEntry(queueFile, entry) {
    fs.mkdirSync(path.dirname(queueFile), { recursive: true });
    fs.appendFileSync(queueFile, JSON.stringify(entry) + '\n');
}

function statusOf(entry) {
    return String(entry?.status || '').toUpperCase();
}

/** Latest queue line per order id. The log is append-only, so last line wins. */
export function latestQueueEntries(queueFile = DEFAULT_QUEUE_FILE) {
    const latest = new Map();
    for (const entry of readFulfillmentQueue(queueFile)) {
        const orderId = entry?.order_id ? String(entry.order_id) : null;
        if (!orderId) continue;
        latest.set(orderId, entry);
    }
    return latest;
}

/** Attempt bookkeeping recorded on the queue by previous drains. */
export function drainState(entry) {
    const drain = entry?.drain && typeof entry.drain === 'object' ? entry.drain : {};
    const attempts = Math.max(0, Math.round(Number(drain.attempts) || 0));
    const nextAt = drain.next_attempt_at ? Date.parse(drain.next_attempt_at) : NaN;
    return {
        attempts,
        next_attempt_at: Number.isFinite(nextAt) ? new Date(nextAt) : null,
        last_reason: drain.last_reason || null
    };
}

/**
 * Record that the drain looked at an order and found it unpaid.
 *
 * The delivery state is copied unchanged and the original `timestamp` is kept,
 * so the order keeps aging for `FULFILLMENT_BACKLOG`; only `drain.last_skip_at`
 * and `drain.last_skip_reason` move. Throttled so one unpaid order cannot append
 * a line on every tick.
 */
function recordSkip(queueFile, entry, reason, at, nowMs) {
    const latest = latestQueueEntries(queueFile).get(entry.order_id) || {};
    const previous = Date.parse(latest.drain?.last_skip_at || '');
    if (Number.isFinite(previous) && nowMs - previous < SKIP_HEARTBEAT_MS) return false;
    appendEntry(queueFile, {
        ...latest,
        // Ageing reads `timestamp`; a skip is not a delivery state change, so
        // the order must not look fresher than its last real queue line.
        timestamp: latest.timestamp || entry.queued_at || at,
        order_id: entry.order_id,
        status: latest.status || entry.status || null,
        drain: {
            ...(latest.drain && typeof latest.drain === 'object' ? latest.drain : {}),
            last_skip_at: at,
            last_skip_reason: reason
        }
    });
    return true;
}

/** Exponential backoff after `attempts` failures, capped. */
export function backoffDelayMs(attempts, {
    baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS
} = {}) {
    const base = Math.max(1000, Number(baseBackoffMs) || DEFAULT_BASE_BACKOFF_MS);
    const cap = Math.max(base, Number(maxBackoffMs) || DEFAULT_MAX_BACKOFF_MS);
    const exponent = Math.max(0, Math.min(30, Math.round(Number(attempts) || 1) - 1));
    return Math.min(cap, base * 2 ** exponent);
}

/**
 * Queue entries whose latest state still owes the buyer delivery.
 *
 * `DELIVERED` is done and `DELIVERY_EXHAUSTED` is a recorded terminal failure,
 * so neither is retried. Oldest first.
 */
export function undeliveredQueueEntries(queueFile = DEFAULT_QUEUE_FILE) {
    return [...latestQueueEntries(queueFile).values()]
        .filter(entry => ![DELIVERED_STATUS, EXHAUSTED_STATUS].includes(statusOf(entry)))
        .map(entry => {
            const state = drainState(entry);
            return {
                order_id: String(entry.order_id),
                status: entry.status || null,
                product: entry.product || null,
                customer_email: entry.customer_email || null,
                action_required: entry.action_required || null,
                queued_at: entry.timestamp || null,
                attempts: state.attempts,
                next_attempt_at: state.next_attempt_at ? state.next_attempt_at.toISOString() : null,
                last_reason: state.last_reason
            };
        });
}

/** Orders already stopped after the attempt cap, for reporting/escalation. */
export function exhaustedQueueEntries(queueFile = DEFAULT_QUEUE_FILE) {
    return [...latestQueueEntries(queueFile).values()]
        .filter(entry => statusOf(entry) === EXHAUSTED_STATUS)
        .map(entry => ({
            order_id: String(entry.order_id),
            attempts: drainState(entry).attempts,
            last_reason: drainState(entry).last_reason,
            action_required: entry.action_required || null,
            queued_at: entry.timestamp || null
        }));
}

/**
 * Re-drive delivery for queued-but-undelivered orders.
 *
 * @param {object} options
 * @param {string} [options.queueFile] fulfilment queue log
 * @param {{getPayPalOrderDetails: Function}} [options.paypal] PayPal lookup
 * @param {Function} [options.fulfill] fulfilment entry point (`fulfillPaidOrder`)
 * @param {boolean} [options.apply] false reads and reports only
 * @param {number} [options.limit] most orders to attempt in one run
 * @param {number} [options.maxAttempts] failures before an order is exhausted
 * @param {number} [options.baseBackoffMs] first retry delay
 * @param {number} [options.maxBackoffMs] backoff ceiling
 * @param {Date} [options.now]
 */
export async function drainFulfillmentQueue({
    queueFile = DEFAULT_QUEUE_FILE,
    paypal = { getPayPalOrderDetails },
    fulfill = (args) => fulfillPaidOrder(args),
    apply = false,
    limit = DEFAULT_LIMIT,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
    now = new Date()
} = {}) {
    const nowMs = new Date(now).getTime();
    const at = new Date(nowMs).toISOString();
    const cap = Math.max(1, Math.round(Number(maxAttempts) || DEFAULT_MAX_ATTEMPTS));
    const queuePresent = fs.existsSync(queueFile);
    const owed = queuePresent ? undeliveredQueueEntries(queueFile) : [];
    const due = owed.filter(entry => !entry.next_attempt_at || !(Date.parse(entry.next_attempt_at) > nowMs));
    const max = Math.max(1, Math.round(Number(limit) || DEFAULT_LIMIT));
    const candidates = due.slice(0, max);
    const report = {
        at,
        queue_file: queueFile,
        queue_present: queuePresent,
        ...(queuePresent ? {} : { skipped_run: 'queue_missing' }),
        applied: Boolean(apply),
        max_attempts: cap,
        pending: owed.length,
        due: due.length,
        waiting_for_backoff: owed.length - due.length,
        attempted: 0,
        delivered: [],
        still_pending: [],
        escalated: [],
        skipped: [],
        unattempted: Math.max(0, due.length - candidates.length)
    };

    const recordFailure = (entry, reason) => {
        const attempts = entry.attempts + 1;
        const latest = latestQueueEntries(queueFile).get(entry.order_id) || {};
        // Keep whatever delivery state the fulfilment path wrote (e.g.
        // PENDING_EMAIL); the drain record only adds attempt bookkeeping.
        const deliveryStatus = latest.status || entry.status || null;

        if (attempts >= cap) {
            appendEntry(queueFile, {
                ...latest,
                timestamp: at,
                order_id: entry.order_id,
                status: EXHAUSTED_STATUS,
                action_required: `Delivery failed ${attempts} time(s): ${reason}. ` +
                    'Not retried automatically — deliver manually or refund this paid order.',
                drain: { attempts, last_attempt_at: at, last_reason: reason, next_attempt_at: null }
            });
            report.escalated.push({ order_id: entry.order_id, attempts, reason });
            return;
        }

        const nextAttemptAt = new Date(nowMs + backoffDelayMs(attempts, { baseBackoffMs, maxBackoffMs })).toISOString();
        appendEntry(queueFile, {
            ...latest,
            timestamp: at,
            order_id: entry.order_id,
            status: deliveryStatus,
            drain: { attempts, last_attempt_at: at, last_reason: reason, next_attempt_at: nextAttemptAt }
        });
        report.still_pending.push({ order_id: entry.order_id, status: deliveryStatus, reason, attempts, next_attempt_at: nextAttemptAt });
    };

    for (const entry of candidates) {
        let order;
        try {
            order = await paypal.getPayPalOrderDetails(entry.order_id);
        } catch (error) {
            recordFailure(entry, `order_lookup_failed: ${error?.message ?? String(error)}`);
            continue;
        }

        if (!isPaidOrder(order)) {
            const reason = `not_paid: ${order?.status || 'unknown'}`;
            // A dry run writes nothing; the tick runs with --apply, so the
            // audit has a skip record whenever the drain is actually running.
            const recorded = apply ? recordSkip(queueFile, entry, reason, at, nowMs) : false;
            report.skipped.push({ order_id: entry.order_id, reason, recorded });
            continue;
        }

        if (!apply) {
            report.still_pending.push({
                order_id: entry.order_id,
                status: entry.status,
                reason: 'dry_run',
                attempts: entry.attempts,
                next_attempt_at: entry.next_attempt_at
            });
            continue;
        }

        report.attempted += 1;
        let reason;
        try {
            const result = await fulfill({ order });
            if (result?.delivery === 'emailed') {
                const latest = latestQueueEntries(queueFile).get(entry.order_id);
                if (statusOf(latest) !== DELIVERED_STATUS) {
                    // The ledger deduplicated this delivery, so the fulfilment
                    // path returned without queueing it. Record delivery here
                    // or the same order would be retried on every tick.
                    appendEntry(queueFile, {
                        ...(latest || entry),
                        timestamp: at,
                        order_id: entry.order_id,
                        status: DELIVERED_STATUS,
                        action_required: null
                    });
                }
                report.delivered.push({ order_id: entry.order_id, email_id: result?.email?.id ?? null });
                continue;
            }
            reason = result?.reason || result?.delivery || 'not_delivered';
        } catch (error) {
            reason = error?.message ?? String(error);
        }
        recordFailure(entry, reason);
    }

    report.remaining = queuePresent ? undeliveredQueueEntries(queueFile).length : 0;
    report.exhausted = queuePresent ? exhaustedQueueEntries(queueFile).length : 0;
    return report;
}

export default drainFulfillmentQueue;
