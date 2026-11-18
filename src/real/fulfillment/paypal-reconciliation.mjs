import fs from 'node:fs';
import path from 'node:path';

import { getPayPalOrderDetails, searchTransactions } from '../../paypal-api.mjs';
import { loadCourseCatalog, priceInCurrency } from '../../sales/course-catalog.mjs';
import { parsePayPalCustomId, parsePayPalInvoiceId } from '../../sales/price-quote.mjs';
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
const CATALOG_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

function legacyOrderIdSet(value) {
    const values = value instanceof Set
        ? [...value]
        : (Array.isArray(value) ? value : String(value || '').split(','));
    return new Set(values.map(item => String(item || '').trim()).filter(Boolean));
}

function quoteMetadataStatus({ orderId, paidAt, custom, invoice, catalog, legacyOrderIds, quoteRequiredAfter }) {
    const quoteId = custom.quoteId || invoice.quoteId || null;
    const catalogVersion = custom.catalogVersion || null;
    const catalogDigest = invoice.catalogDigest || null;
    const hasMetadata = Boolean(quoteId || catalogVersion || catalogDigest);
    const cutoff = quoteRequiredAfter ? Date.parse(quoteRequiredAfter) : NaN;
    const paidTime = paidAt ? Date.parse(paidAt) : NaN;
    const legacy = legacyOrderIds.has(String(orderId || ''))
        || (Number.isFinite(cutoff) && Number.isFinite(paidTime) && paidTime < cutoff);
    const base = { quote_id: quoteId, catalog_version: catalogVersion, catalog_digest: catalogDigest };

    if (!hasMetadata) {
        return {
            ...base,
            status: legacy ? 'legacy' : 'missing',
            reason: legacy ? 'legacy_quote_metadata_allowlisted' : 'missing_quote_metadata'
        };
    }

    const reasons = [];
    if (!custom.quoteId || !custom.catalogVersion) reasons.push('incomplete_custom_id_quote_metadata');
    if (!invoice.quoteId || !invoice.catalogDigest) reasons.push('incomplete_invoice_quote_metadata');
    if (custom.quoteId && invoice.quoteId && custom.quoteId !== invoice.quoteId) reasons.push('quote_id_mismatch');
    if (catalogDigest && !CATALOG_DIGEST_PATTERN.test(catalogDigest)) reasons.push('invalid_catalog_digest');
    if (reasons.length) return { ...base, status: 'malformed', reason: reasons.join(','), reasons };

    const expectedVersion = catalog?.version === undefined || catalog?.version === null
        ? null
        : String(catalog.version);
    const expectedDigest = catalog?.digest || null;
    if (!expectedVersion || !expectedDigest) {
        return {
            ...base,
            status: 'unchecked',
            reason: 'catalog_revision_unavailable',
            catalog_version_expected: expectedVersion,
            catalog_digest_expected: expectedDigest
        };
    }

    const stale = [];
    if (String(catalogVersion) !== expectedVersion) stale.push('catalog_version_mismatch');
    if (catalogDigest !== expectedDigest) stale.push('catalog_digest_mismatch');
    return {
        ...base,
        status: stale.length ? 'stale' : 'ok',
        ...(stale.length ? { reason: stale.join(','), reasons: stale } : {}),
        catalog_version_expected: expectedVersion,
        catalog_digest_expected: expectedDigest
    };
}

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
        product_id: parsePayPalCustomId(unit?.custom_id).productId,
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
export function reconcileOrderPrice(order, {
    catalog = null,
    catalogError = null,
    legacyQuoteOrderIds = [],
    quoteRequiredAfter = null
} = {}) {
    const unit = Array.isArray(order?.purchase_units) ? order.purchase_units[0] || {} : {};
    const captures = Array.isArray(unit?.payments?.captures) ? unit.payments.captures : [];
    const capture = captures.find(item => String(item?.status || '').toUpperCase() === 'COMPLETED') || captures[0] || {};
    const currency = String(capture?.amount?.currency_code || unit?.amount?.currency_code || '').trim().toUpperCase();
    const actual = Number(capture?.amount?.value ?? unit?.amount?.value ?? NaN);
    const custom = parsePayPalCustomId(unit?.custom_id);
    const invoice = parsePayPalInvoiceId(unit?.invoice_id);
    const productId = custom.productId;
    const quoteMetadata = quoteMetadataStatus({
        orderId: order?.id,
        paidAt: capture?.create_time || order?.update_time || null,
        custom,
        invoice,
        catalog,
        legacyOrderIds: legacyOrderIdSet(legacyQuoteOrderIds),
        quoteRequiredAfter
    });
    const expectedCatalogDigest = catalog?.digest || null;
    const catalogRevision = invoice.catalogDigest && expectedCatalogDigest
        ? (invoice.catalogDigest === expectedCatalogDigest ? 'ok' : 'mismatch')
        : 'unchecked';
    const base = {
        order_id: order?.id ?? null,
        product_id: productId,
        product: unit?.description || unit?.items?.[0]?.name || null,
        capture_id: capture?.id || null,
        paid_at: capture?.create_time || order?.update_time || null,
        currency: currency || null,
        quote_id: quoteMetadata.quote_id || null,
        catalog_version: quoteMetadata.catalog_version || null,
        catalog_digest: quoteMetadata.catalog_digest || null,
        catalog_digest_expected: expectedCatalogDigest,
        catalog_revision: catalogRevision,
        quote_metadata_status: quoteMetadata.status,
        quote_metadata_reason: quoteMetadata.reason || null,
        quote_metadata: quoteMetadata
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
    checkPrices = true,
    legacyQuoteOrderIds = process.env.PAYPAL_LEGACY_QUOTE_ORDER_IDS || process.env.PAYPAL_LEGACY_ORDER_IDS || [],
    legacyOrderIds = [],
    quoteRequiredAfter = process.env.PAYPAL_QUOTE_REQUIRED_AFTER || null
} = {}) {
    const at = now instanceof Date ? now : new Date(now);
    const from = new Date(at.getTime() - Number(lookbackDays) * 86400000);
    const candidates = new Set(orderIds.map(String).filter(Boolean));
    const legacyIds = legacyOrderIdSet(legacyQuoteOrderIds);
    for (const id of legacyOrderIdSet(legacyOrderIds)) legacyIds.add(id);
    const skipped = [];
    const priceMismatches = [];
    const priceUnchecked = [];
    const catalogRevisionMismatches = [];
    const catalogRevisionUnchecked = [];
    const quoteMetadataFindings = [];
    const quoteMetadataLegacy = [];
    const quoteMetadataUnchecked = [];
    let priceChecked = 0;
    let catalogRevisionChecked = 0;
    let quoteMetadataChecked = 0;
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
            const price = reconcileOrderPrice(order, {
                catalog: priceCatalog,
                catalogError: priceCatalogError,
                legacyQuoteOrderIds: legacyIds,
                quoteRequiredAfter
            });
            if (price.status === 'mismatch') {
                priceMismatches.push(price);
                priceChecked += 1;
            } else if (price.status === 'unchecked') {
                priceUnchecked.push(price);
            } else {
                priceChecked += 1;
            }
            if (price.catalog_revision === 'mismatch') {
                catalogRevisionMismatches.push(price);
                catalogRevisionChecked += 1;
            } else if (price.catalog_revision === 'unchecked') {
                catalogRevisionUnchecked.push(price);
            } else {
                catalogRevisionChecked += 1;
            }
            if (['missing', 'malformed', 'stale'].includes(price.quote_metadata_status)) {
                quoteMetadataFindings.push(price);
                quoteMetadataChecked += 1;
            } else if (price.quote_metadata_status === 'legacy') {
                quoteMetadataLegacy.push(price);
            } else if (price.quote_metadata_status === 'unchecked') {
                quoteMetadataUnchecked.push(price);
            } else {
                quoteMetadataChecked += 1;
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
        catalog_digest: priceCatalog?.digest || null,
        catalog_revision_checked: catalogRevisionChecked,
        catalog_revision_mismatch_count: catalogRevisionMismatches.length,
        catalog_revision_mismatches: catalogRevisionMismatches,
        catalog_revision_unchecked: catalogRevisionUnchecked,
        quote_metadata_checked: quoteMetadataChecked,
        quote_metadata_finding_count: quoteMetadataFindings.length,
        quote_metadata_findings: quoteMetadataFindings,
        quote_metadata_legacy: quoteMetadataLegacy,
        quote_metadata_unchecked: quoteMetadataUnchecked,
        enqueued,
        failed,
        skipped,
        warnings: missing.filter(order => !order.customer_email).map(order => `missing_email:${order.id}`)
    };
}

export default reconcilePayPalOrders;
