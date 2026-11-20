import { parsePayPalCustomId, parsePayPalInvoiceId } from './price-quote.mjs';

/**
 * Post-capture reconciliation for a PayPal order.
 *
 * The purchase path binds an order to a signed price quote. By the time PayPal
 * reports a capture, that quote token is gone, so the facts it carried are
 * stored in the signed checkout attempt record for its quote id. This compares
 * what was actually captured with that record — amount, currency and the
 * catalog revision the quote was issued from — and reports the result.
 *
 * It is deliberately read-only: no price, order, capture or catalog is changed.
 * A mismatch is a finding for an owner to refund, collect or accept.
 */

function toCents(value) {
    const amount = Number(value);
    return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

function currencyOf(amount) {
    const currency = String(amount?.currency_code || '').trim().toUpperCase();
    return currency || null;
}

/**
 * The settled money for an order. Only COMPLETED captures count, which is the
 * same definition of paid the rest of the code uses; pending, declined or
 * merely authorized money has not been captured and is reported as such rather
 * than compared as if it had. Completed captures are summed, so a multi-capture
 * order is compared with its full settled total. Mixed capture currencies
 * cannot be summed and are reported as unchecked rather than guessed.
 */
function capturedPayment(order) {
    const units = Array.isArray(order?.purchase_units) ? order.purchase_units : [];
    const captures = units.flatMap(item => (Array.isArray(item?.payments?.captures) ? item.payments.captures : []));
    const settled = captures.filter(capture => String(capture?.status || '').toUpperCase() === 'COMPLETED');

    if (settled.length === 0) {
        return {
            value_cents: null,
            currency: null,
            capture_count: 0,
            capture_ids: [],
            mixed_currency: false,
            // Captures exist but none settled: the order is not captured yet.
            unsettled: captures.length > 0
        };
    }

    const rows = settled.map(capture => ({
        id: capture?.id ?? null,
        value_cents: toCents(capture?.amount?.value),
        currency: currencyOf(capture?.amount)
    }));
    const currencies = new Set(rows.map(row => row.currency).filter(Boolean));
    return {
        value_cents: rows.every(row => row.value_cents !== null)
            ? rows.reduce((sum, row) => sum + row.value_cents, 0)
            : null,
        currency: currencies.size === 1 ? [...currencies][0] : null,
        mixed_currency: currencies.size > 1,
        capture_count: rows.length,
        capture_ids: rows.map(row => row.id).filter(Boolean),
        unsettled: false
    };
}

function quotedFacts(attempt) {
    const quote = attempt?.quote;
    if (!quote || typeof quote !== 'object') return null;
    const amount = Number(quote.amount_cents);
    return {
        value_cents: Number.isInteger(amount) && amount > 0 ? amount : null,
        currency: String(quote.currency || '').trim().toUpperCase() || null,
        catalog_version: quote.catalog_version === undefined || quote.catalog_version === null
            ? null
            : String(quote.catalog_version),
        catalog_digest: quote.catalog_digest === undefined || quote.catalog_digest === null
            ? null
            : String(quote.catalog_digest)
    };
}

/**
 * Compare one captured order with the signed attempt record for its quote and
 * with the catalog revision that quote was issued from.
 *
 * `status` covers the payment: `mismatch` when the captured amount or currency
 * differs from the quote, `unchecked` when no comparison is possible (no quote
 * reference, no stored record, or no settled capture). `catalog_revision` is
 * reported separately: a catalog change after the order was created does not
 * make an accurately captured payment wrong, it only means the quote predates
 * the current catalog.
 */
export function reconcileCapturedPayment({
    order = null,
    attempt = null,
    catalog = null,
    catalogError = null
} = {}) {
    const units = Array.isArray(order?.purchase_units) ? order.purchase_units : [];
    const unit = units[0] || {};
    const custom = parsePayPalCustomId(unit?.custom_id);
    const invoice = parsePayPalInvoiceId(unit?.invoice_id);
    const captured = capturedPayment(order);
    const quoted = quotedFacts(attempt);
    const quoteId = custom.quoteId || invoice.quoteId || null;
    const currentVersion = catalog?.version === undefined || catalog?.version === null
        ? null
        : String(catalog.version);
    const currentDigest = catalog?.digest ? String(catalog.digest) : null;

    let catalogRevision = 'unchecked';
    let catalogRevisionReason = null;
    if (catalogError) {
        catalogRevisionReason = String(catalogError);
    } else if (!catalog || !currentDigest) {
        catalogRevisionReason = 'catalog_unavailable';
    } else if (!quoted?.catalog_digest || !quoted?.catalog_version) {
        catalogRevisionReason = 'quote_record_incomplete';
    } else if (quoted.catalog_digest === currentDigest && quoted.catalog_version === currentVersion) {
        catalogRevision = 'ok';
    } else {
        catalogRevision = 'mismatch';
        catalogRevisionReason = 'catalog_revision_changed';
    }

    const base = {
        order_id: order?.id ?? null,
        quote_id: quoteId,
        capture_count: captured.capture_count,
        capture_ids: captured.capture_ids,
        captured: { value_cents: captured.value_cents, currency: captured.currency },
        quoted,
        catalog_version_current: currentVersion,
        catalog_digest_current: currentDigest,
        catalog_revision: catalogRevision,
        catalog_revision_reason: catalogRevisionReason
    };

    let unchecked = null;
    if (custom.quoteId && invoice.quoteId && custom.quoteId !== invoice.quoteId) {
        unchecked = 'quote_id_conflict';
    } else if (!quoteId) {
        unchecked = 'quote_reference_missing';
    } else if (!attempt) {
        unchecked = 'quote_record_unavailable';
    } else if (!quoted || quoted.value_cents === null || !quoted.currency) {
        unchecked = 'quote_record_incomplete';
    } else if (captured.mixed_currency) {
        unchecked = 'mixed_capture_currency';
    } else if (captured.unsettled) {
        unchecked = 'capture_not_settled';
    } else if (captured.value_cents === null) {
        unchecked = 'missing_captured_amount';
    } else if (!captured.currency) {
        unchecked = 'missing_currency';
    }
    if (unchecked) {
        return { ...base, status: 'unchecked', reason: unchecked, reasons: [], delta_cents: null };
    }

    const reasons = [];
    if (captured.currency !== quoted.currency) reasons.push('currency_mismatch');
    if (captured.value_cents !== quoted.value_cents) reasons.push('amount_mismatch');

    return {
        ...base,
        status: reasons.length > 0 ? 'mismatch' : 'ok',
        reason: reasons[0] ?? null,
        reasons,
        delta_cents: captured.value_cents - quoted.value_cents
    };
}
