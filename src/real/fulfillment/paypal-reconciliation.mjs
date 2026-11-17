import fs from 'node:fs';
import path from 'node:path';

import { getPayPalOrderDetails, searchTransactions } from '../../paypal-api.mjs';
import { loadCourseCatalog, priceInCurrency } from '../../sales/course-catalog.mjs';
import { FulfillmentManager } from './FulfillmentManager.mjs';

/**
 * Reconcile paid PayPal orders against the existing fulfilment queue.
 *
 * This is the replay path for missed webhooks: once the endpoint is reachable,
 * orders that PayPal captured but that never reached fulfilment are found and
 * enqueued through FulfillmentManager, the same path the live webhook uses.
 * There is no second ledger: `logs/fulfillment_queue.log` is both the record of
 * what was fulfilled and the idempotency key.
 */

export const DEFAULT_QUEUE_FILE = path.join('logs', 'fulfillment_queue.log');
export const DEFAULT_LOOKBACK_DAYS = 30;

export function readFulfillmentQueue(queueFile = DEFAULT_QUEUE_FILE) {
    if (!fs.existsSync(queueFile)) return [];
    return fs.readFileSync(queueFile, 'utf8')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
            try {
                return JSON.parse(line);
            } catch {
                return null;
            }
        })
        .filter(Boolean);
}

export function fulfilledOrderIds(queueFile = DEFAULT_QUEUE_FILE) {
    return new Set(readFulfillmentQueue(queueFile)
        .map(entry => entry?.order_id)
        .filter(Boolean)
        .map(String));
}

/** Successful PayPal payment transactions (reporting API shape). */
export function extractPaymentTransactions(response) {
    const rows = Array.isArray(response?.transaction_details)
        ? response.transaction_details
        : Array.isArray(response?.transactionDetails)
            ? response.transactionDetails
            : [];
    return rows
        .map(row => row?.transaction_info)
        .filter(Boolean)
        .filter(info => String(info.transaction_status || '').toUpperCase() === 'S')
        .map(info => ({
            transaction_id: info.transaction_id || null,
            status: info.transaction_status || null,
            event_code: info.transaction_event_code || null,
            reference_id: info.paypal_reference_id || null,
            reference_type: String(info.paypal_reference_id_type || '').toUpperCase() || null,
            email: info.payer_info?.email_address || null,
            amount: Number(info.transaction_amount?.value ?? NaN),
            currency: info.transaction_amount?.currency_code || null,
            paid_at: info.transaction_initiation_date || null
        }))
        .filter(tx => Number.isFinite(tx.amount) && tx.amount > 0);
}

export function isPaidOrder(order) {
    const units = Array.isArray(order?.purchase_units) ? order.purchase_units : [];
    const captures = units.flatMap(unit => (Array.isArray(unit?.payments?.captures) ? unit.payments.captures : []));
    return captures.some(capture => String(capture?.status || '').toUpperCase() === 'COMPLETED');
}

/** Map a paid PayPal order onto the FulfillmentManager order contract. */
export function orderToFulfillment(order) {
    const unit = Array.isArray(order?.purchase_units) ? order.purchase_units[0] || {} : {};
    const captures = Array.isArray(unit?.payments?.captures) ? unit.payments.captures : [];
    const capture = captures.find(item => String(item?.status || '').toUpperCase() === 'COMPLETED') || captures[0] || {};
    const amount = capture?.amount?.value ?? unit?.amount?.value ?? null;
    return {
        id: order?.id ?? null,
        product_id: unit?.custom_id ? String(unit.custom_id) : null,
        product: unit?.description || unit?.items?.[0]?.name || 'PayPal order',
        customer_email: order?.payer?.email_address || null,
        revenue: Number(amount),
        currency: capture?.amount?.currency_code || unit?.amount?.currency_code || 'USD',
        capture_id: capture?.id || null,
        paid_at: capture?.create_time || order?.update_time || null
    };
}

/**
 * Compare one captured order with the canonical catalog. This is deliberately
 * read-only: it reports a mismatch for an owner to refund or resolve and never
 * changes the catalog, Shopify or PayPal price.
 */
export function reconcileOrderPrice(order, { catalog = null, catalogError = null } = {}) {
    const unit = Array.isArray(order?.purchase_units) ? order.purchase_units[0] || {} : {};
    const captures = Array.isArray(unit?.payments?.captures) ? unit.payments.captures : [];
    const capture = captures.find(item => String(item?.status || '').toUpperCase() === 'COMPLETED') || captures[0] || {};
    const currency = String(capture?.amount?.currency_code || unit?.amount?.currency_code || '').trim().toUpperCase();
    const actual = Number(capture?.amount?.value ?? unit?.amount?.value ?? NaN);
    const productId = unit?.custom_id ? String(unit.custom_id) : null;
    const base = {
        order_id: order?.id ?? null,
        product_id: productId,
        product: unit?.description || unit?.items?.[0]?.name || null,
        capture_id: capture?.id || null,
        paid_at: capture?.create_time || order?.update_time || null,
        currency: currency || null
    };

    if (!productId) return { ...base, status: 'unchecked', reason: 'missing_product_id' };
    if (!catalog) return { ...base, status: 'unchecked', reason: catalogError || 'catalog_unavailable' };
    const course = catalog.bySlug?.[productId];
    if (!course) return { ...base, status: 'unchecked', reason: 'unknown_product' };
    if (!Number.isFinite(actual) || actual <= 0) {
        return { ...base, status: 'unchecked', reason: 'missing_captured_amount' };
    }
    if (!currency) return { ...base, status: 'unchecked', reason: 'missing_currency' };

    let expected;
    try {
        expected = priceInCurrency(course, currency, catalog.fx);
    } catch (error) {
        return { ...base, status: 'unchecked', reason: 'price_unavailable', error: error.message };
    }

    if (Math.round(expected.amount * 100) !== Math.round(actual * 100)) {
        return {
            ...base,
            status: 'mismatch',
            expected: expected.amount,
            actual,
            delta: Math.round((actual - expected.amount) * 100) / 100
        };
    }
    return { ...base, status: 'ok', expected: expected.amount, actual };
}

export async function reconcilePayPalOrders({
    paypal = { searchTransactions, getPayPalOrderDetails },
    orderIds = [],
    lookbackDays = DEFAULT_LOOKBACK_DAYS,
    now = new Date(),
    apply = false,
    queueFile = DEFAULT_QUEUE_FILE,
    fulfill = order => FulfillmentManager.fulfillOrder(order),
    search = true,
    catalog = null,
    catalogFile = undefined,
    checkPrices = true
} = {}) {
    const at = now instanceof Date ? now : new Date(now);
    const from = new Date(at.getTime() - Number(lookbackDays) * 86400000);
    const candidates = new Set(orderIds.map(String).filter(Boolean));
    const skipped = [];
    const priceMismatches = [];
    const priceUnchecked = [];
    let priceChecked = 0;
    let priceCatalogError = null;
    let searchError = null;

    let priceCatalog = catalog;
    if (checkPrices && !priceCatalog) {
        try {
            priceCatalog = loadCourseCatalog(catalogFile);
        } catch (error) {
            priceCatalogError = error.message;
        }
    }

    if (search) {
        try {
            const response = await paypal.searchTransactions({
                startDate: from.toISOString(),
                endDate: at.toISOString()
            });
            for (const tx of extractPaymentTransactions(response)) {
                if (tx.reference_type === 'OD' && tx.reference_id) {
                    candidates.add(String(tx.reference_id));
                }
            }
        } catch (error) {
            searchError = error.message;
        }
    }

    if (searchError && candidates.size === 0) {
        throw new Error(`PayPal transaction search failed and no explicit order ids were given: ${searchError}`);
    }

    const fulfilled = fulfilledOrderIds(queueFile);
    const paid = [];
    const missing = [];
    const enqueued = [];
    const failed = [];

    for (const orderId of candidates) {
        let order;
        try {
            order = await paypal.getPayPalOrderDetails(orderId);
        } catch (error) {
            skipped.push({ order_id: orderId, reason: `lookup_failed: ${error.message}` });
            continue;
        }
        if (!isPaidOrder(order)) {
            skipped.push({ order_id: orderId, reason: `not_paid: ${order?.status || 'unknown'}` });
            continue;
        }

        const mapped = orderToFulfillment(order);
        if (!mapped.id) mapped.id = orderId;
        paid.push({
            order_id: mapped.id,
            product_id: mapped.product_id,
            revenue: mapped.revenue,
            currency: mapped.currency,
            paid_at: mapped.paid_at
        });

        if (checkPrices) {
            const price = reconcileOrderPrice(order, { catalog: priceCatalog, catalogError: priceCatalogError });
            if (price.status === 'mismatch') {
                priceMismatches.push(price);
                priceChecked += 1;
            } else if (price.status === 'unchecked') {
                priceUnchecked.push(price);
            } else {
                priceChecked += 1;
            }
        }

        if (fulfilled.has(String(mapped.id))) continue;
        missing.push(mapped);
    }

    if (apply) {
        for (const order of missing) {
            try {
                await fulfill(order);
                fulfilled.add(String(order.id));
                enqueued.push(order.id);
            } catch (error) {
                failed.push({ order_id: order.id, error: error.message });
            }
        }
    }

    return {
        at: at.toISOString(),
        window: { from: from.toISOString(), to: at.toISOString() },
        applied: Boolean(apply),
        searched_transactions: search && !searchError,
        search_error: searchError,
        scanned_orders: candidates.size,
        paid_orders: paid.length,
        already_fulfilled: paid.length - missing.length,
        missing_count: missing.length,
        missing: missing.map(order => ({
            order_id: order.id,
            product_id: order.product_id,
            product: order.product,
            customer_email: order.customer_email,
            revenue: order.revenue,
            currency: order.currency,
            paid_at: order.paid_at,
            capture_id: order.capture_id
        })),
        price_checked: priceChecked,
        price_mismatch_count: priceMismatches.length,
        price_mismatches: priceMismatches,
        price_unchecked: priceUnchecked,
        price_catalog_error: priceCatalogError,
        enqueued,
        failed,
        skipped,
        warnings: missing.filter(order => !order.customer_email).map(order => `missing_email:${order.id}`)
    };
}

export default reconcilePayPalOrders;
