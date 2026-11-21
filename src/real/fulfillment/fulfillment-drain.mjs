import fs from 'node:fs';

import { getPayPalOrderDetails } from '../../paypal-api.mjs';
import { fulfillPaidOrder } from '../../financial/fulfillment-service.mjs';
import { parsePayPalCustomId } from '../../sales/price-quote.mjs';
import { DEFAULT_QUEUE_FILE, isPaidOrder, readFulfillmentQueue } from './paypal-reconciliation.mjs';

/**
 * Drain paid orders that are already sitting in the fulfilment queue.
 *
 * `logs/fulfillment_queue.log` is append-only and `DELIVERED` is its only
 * terminal state. Until this module existed nothing read it back: an order that
 * failed to get its access email (provider error, missing payer email, missing
 * `FULFILLMENT_ACCESS_SECRET`) stayed `PENDING_EMAIL` forever, and the
 * reconciliation treated its order id as fulfilled because a line existed.
 * A buyer who paid was then never delivered without someone noticing by hand.
 *
 * Draining re-reads each pending order from PayPal and calls the same
 * `fulfillPaidOrder` path the webhook uses, so delivery is idempotent through
 * the settlement ledger's order key: an order that is already sent is returned
 * as a duplicate instead of being emailed twice.
 *
 * The queue belongs to the host that runs the webhook. A machine that does not
 * have it (a fresh CI checkout, a serverless instance) must not report a clean
 * drain: a missing queue is reported as `skipped_run: 'queue_missing'` so an
 * empty run is never mistaken for "every paid order was delivered".
 */

export const DELIVERED_STATUS = 'DELIVERED';

const DEFAULT_LIMIT = 25;

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

/**
 * Queue entries whose latest state is not `DELIVERED`, oldest first.
 *
 * These are the paid orders a buyer is still waiting on.
 */
export function undeliveredQueueEntries(queueFile = DEFAULT_QUEUE_FILE) {
    return [...latestQueueEntries(queueFile).values()]
        .filter(entry => String(entry?.status || '').toUpperCase() !== DELIVERED_STATUS)
        .map(entry => ({
            order_id: String(entry.order_id),
            status: entry.status || null,
            product: entry.product || null,
            customer_email: entry.customer_email || null,
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
 * @param {Function} [options.resolveProduct] product id -> configured product
 * @param {boolean} [options.apply] false reads and reports only
 * @param {number} [options.limit] most orders to attempt in one run
 * @param {Date} [options.now]
 */
export async function drainFulfillmentQueue({
    queueFile = DEFAULT_QUEUE_FILE,
    paypal = { getPayPalOrderDetails },
    fulfill = (args) => fulfillPaidOrder(args),
    resolveProduct = () => null,
    apply = false,
    limit = DEFAULT_LIMIT,
    now = new Date()
} = {}) {
    const queuePresent = fs.existsSync(queueFile);
    const pending = queuePresent ? undeliveredQueueEntries(queueFile) : [];
    const max = Math.max(1, Math.round(Number(limit) || DEFAULT_LIMIT));
    const candidates = pending.slice(0, max);
    const report = {
        at: new Date(now).toISOString(),
        queue_file: queueFile,
        queue_present: queuePresent,
        ...(queuePresent ? {} : { skipped_run: 'queue_missing' }),
        applied: Boolean(apply),
        pending: pending.length,
        attempted: 0,
        delivered: [],
        still_pending: [],
        skipped: [],
        failed: [],
        unattempted: Math.max(0, pending.length - candidates.length)
    };

    for (const entry of candidates) {
        let order;
        try {
            order = await paypal.getPayPalOrderDetails(entry.order_id);
        } catch (error) {
            // Unreadable is not delivered: leave the entry in place and report it.
            report.failed.push({
                order_id: entry.order_id,
                error: `order_lookup_failed: ${error?.message ?? String(error)}`
            });
            continue;
        }

        if (!isPaidOrder(order)) {
            report.skipped.push({
                order_id: entry.order_id,
                reason: `not_paid: ${order?.status || 'unknown'}`
            });
            continue;
        }

        if (!apply) {
            report.still_pending.push({
                order_id: entry.order_id,
                status: entry.status,
                reason: 'dry_run'
            });
            continue;
        }

        const unit = Array.isArray(order?.purchase_units) ? order.purchase_units[0] || {} : {};
        const productId = parsePayPalCustomId(unit?.custom_id).productId;
        let product = null;
        try {
            product = productId ? resolveProduct(productId) || null : null;
        } catch {
            product = null;
        }

        report.attempted += 1;
        try {
            const result = await fulfill({ order, product });
            if (result?.delivery === 'emailed') {
                report.delivered.push({
                    order_id: entry.order_id,
                    email_id: result?.email?.id ?? null
                });
            } else {
                report.still_pending.push({
                    order_id: entry.order_id,
                    status: result?.reason || 'NOT_DELIVERED',
                    reason: result?.reason || result?.delivery || 'not_delivered'
                });
            }
        } catch (error) {
            report.failed.push({
                order_id: entry.order_id,
                error: error?.message ?? String(error)
            });
        }
    }

    report.remaining = queuePresent ? undeliveredQueueEntries(queueFile).length : 0;
    return report;
}

export default drainFulfillmentQueue;
