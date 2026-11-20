/** A positive amount and its currency, or nulls when PayPal stated neither. */
function readAmount(amount) {
  const value = Number(amount?.value);
  return {
    value: Number.isFinite(value) && value > 0 ? value : null,
    currency: amount?.currency_code || amount?.currency || null
  };
}

/** A refund's `up` link is the capture it takes money back from. */
function captureFromLinks(links) {
  const up = Array.isArray(links) ? links.find((link) => link?.rel === "up") : null;
  return String(up?.href ?? "").split("/").filter(Boolean).pop() || null;
}

/** What a reversal event takes money back from, or null for other events. */
function reversalSubject(evt) {
  const resource = evt?.resource ?? null;

  if (evt?.event_type === "PAYMENT.CAPTURE.REFUNDED") {
    const refundId = resource?.id ?? null;
    return {
      type: "refunded",
      captureId: captureFromLinks(resource?.links),
      externalId: `REFUND_${refundId ?? evt.id ?? ""}`,
      ...readAmount(resource?.amount),
      metadata: { paypal_refund_id: refundId }
    };
  }

  if (evt?.event_type === "PAYMENT.CAPTURE.REVERSED") {
    return {
      type: "reversed",
      captureId: resource?.id ?? null,
      externalId: `REVERSAL_${resource?.id ?? ""}`,
      ...readAmount(resource?.amount),
      metadata: {}
    };
  }

  if (evt?.event_type === "CUSTOMER.DISPUTE.CREATED") {
    const transaction = resource?.disputed_transactions?.[0] ?? null;
    const disputeId = resource?.dispute_id ?? null;
    return {
      type: "disputed",
      captureId: transaction?.seller_transaction_id ?? resource?.seller_transaction_id ?? null,
      externalId: `DISPUTE_${disputeId ?? evt.id ?? ""}`,
      // A dispute may not state an amount yet; the ledger then reverses the
      // whole capture.
      ...readAmount(resource?.dispute_amount ?? transaction?.seller_amount),
      metadata: { paypal_dispute_id: disputeId }
    };
  }

  return null;
}

/**
 * Map a refund, reversal or dispute to the capture it takes money back from.
 * Returns null for every other event. `amount` is null when the provider did not
 * state one, so the ledger can reverse the original capture amount instead.
 */
export function mapPayPalWebhookToRevenueReversal(evt, { defaultCurrency = "USD" } = {}) {
  const subject = evt && typeof evt === "object" ? reversalSubject(evt) : null;
  if (!subject?.captureId) return null;

  return {
    type: subject.type,
    amount: subject.value,
    currency: String(subject.currency || defaultCurrency).toUpperCase(),
    occurredAt: evt.create_time ?? new Date().toISOString(),
    source: "paypal",
    externalId: subject.externalId,
    original_capture_id: String(subject.captureId),
    metadata: {
      paypal_event_type: evt.event_type ?? null,
      paypal_event_id: evt.id ?? null,
      ...subject.metadata
    }
  };
}

export function mapPayPalWebhookToRevenueEvent(evt, { defaultCurrency = "USD" } = {}) {
  if (evt?.event_type !== "PAYMENT.CAPTURE.COMPLETED") return null;

  const resource = evt.resource ?? null;
  const amount = readAmount(resource?.amount);
  if (!amount.value) return null;

  const externalId = evt.id ?? resource?.id ?? null;
  if (!externalId) return null;

  return {
    amount: amount.value,
    currency: (amount.currency ?? defaultCurrency) || defaultCurrency,
    occurredAt: evt.create_time ?? new Date().toISOString(),
    source: "paypal",
    externalId,
    metadata: {
      kind: "client_to_owner",
      paypal_event_type: evt.event_type ?? null,
      paypal_capture_id: resource?.id ?? null,
      paypal_status: resource?.status ?? null,
      paypal_custom_id: resource?.custom_id ?? null,
      paypal_invoice_id: resource?.invoice_id ?? null
    }
  };
}
