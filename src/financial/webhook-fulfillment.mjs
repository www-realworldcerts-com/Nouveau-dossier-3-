import { getPayPalOrderDetails } from '../paypal-api.mjs';
import { parsePayPalCustomId } from '../sales/price-quote.mjs';
import { fulfillPaidOrder } from './fulfillment-service.mjs';

/**
 * Fulfilment driven by the verified PayPal webhook.
 *
 * The capture route only runs when the buyer's browser comes back from PayPal.
 * A buyer who pays and then closes the tab, loses their connection, or whose
 * return request never arrives is charged with nothing delivered. Two verified
 * events close that hole:
 *
 * - `PAYMENT.CAPTURE.COMPLETED`: the money is captured, so deliver. The order is
 *   read back from PayPal because the capture resource carries no buyer email.
 * - `CHECKOUT.ORDER.APPROVED`: the buyer approved an order but the capture never
 *   reached us. Capture it now (PayPal's request id makes that idempotent with
 *   the browser's own capture call) and deliver.
 *
 * Both paths are idempotent against the settlement ledger's order key, so a
 * webhook replayed beside the capture route delivers at most once. Nothing here
 * throws at the webhook: a failure becomes a critical finding, because a 500
 * would make PayPal retry an event that has already recorded its revenue.
 */

export const WEBHOOK_FULFILLMENT_FAILED = 'WEBHOOK_FULFILLMENT_FAILED';
export const WEBHOOK_AUTO_CAPTURE_FAILED = 'WEBHOOK_AUTO_CAPTURE_FAILED';

const CAPTURE_COMPLETED = 'PAYMENT.CAPTURE.COMPLETED';
const ORDER_APPROVED = 'CHECKOUT.ORDER.APPROVED';
const ALREADY_CAPTURED = /ORDER_ALREADY_CAPTURED|ORDER_ALREADY_COMPLETED/i;

function eventType(evt) {
  return String(evt?.event_type ?? '').trim().toUpperCase();
}

function finding(code, detail, extra = {}) {
  return { code, severity: 'critical', detail, ...extra };
}

async function fulfillFromOrder({ order, orderId, fulfill, resolveProduct, captureId = null }) {
  const unit = Array.isArray(order?.purchase_units) ? order.purchase_units[0] || {} : {};
  const productId = parsePayPalCustomId(unit?.custom_id).productId;

  let product = null;
  try {
    product = productId ? resolveProduct(productId) || null : null;
  } catch {
    product = null;
  }

  try {
    const result = await fulfill({ order, product });
    return {
      attempted: true,
      ok: result?.ok === true,
      order_id: orderId,
      product_id: productId || null,
      delivery: result?.delivery ?? null,
      reason: result?.reason ?? null,
      duplicate: result?.duplicate === true,
      email: result?.email ?? null,
      capture_id: captureId
    };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      order_id: orderId,
      product_id: productId || null,
      reason: 'FULFILLMENT_FAILED',
      capture_id: captureId,
      finding: finding(
        WEBHOOK_FULFILLMENT_FAILED,
        `The buyer of order ${orderId} has paid but fulfilment failed: ` +
        `${error?.message ?? String(error)}. Deliver access manually or replay reconcile-paypal.`,
        { order_id: orderId, capture_id: captureId }
      )
    };
  }
}

/**
 * Deliver a captured order announced by `PAYMENT.CAPTURE.COMPLETED`.
 *
 * @param {object} options
 * @param {object} options.evt verified PayPal webhook event
 * @param {Function} [options.lookupOrder] PayPal order lookup
 * @param {Function} [options.fulfill] fulfilment entry point
 * @param {Function} [options.resolveProduct] product id -> configured product
 */
export async function fulfillCaptureWebhook({
  evt,
  lookupOrder = getPayPalOrderDetails,
  fulfill = (args) => fulfillPaidOrder(args),
  resolveProduct = () => null
} = {}) {
  if (eventType(evt) !== CAPTURE_COMPLETED) {
    return { attempted: false, reason: 'NOT_A_CAPTURE_COMPLETED_EVENT' };
  }
  const resource = evt?.resource ?? {};
  const orderId = resource?.supplementary_data?.related_ids?.order_id
    ? String(resource.supplementary_data.related_ids.order_id)
    : null;
  if (!orderId) {
    return {
      attempted: false,
      reason: 'NO_ORDER_ID',
      capture_id: resource?.id ? String(resource.id) : null
    };
  }

  let order;
  try {
    order = await lookupOrder(orderId);
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      order_id: orderId,
      capture_id: resource?.id ? String(resource.id) : null,
      reason: 'ORDER_LOOKUP_FAILED',
      finding: finding(
        WEBHOOK_FULFILLMENT_FAILED,
        `Verified capture ${resource?.id ?? '(unknown)'} for order ${orderId} could not be read ` +
        `back from PayPal: ${error?.message ?? String(error)}. The buyer has paid and has no ` +
        'access pass.',
        { order_id: orderId, capture_id: resource?.id ? String(resource.id) : null }
      )
    };
  }

  return fulfillFromOrder({
    order,
    orderId,
    fulfill,
    resolveProduct,
    captureId: resource?.id ? String(resource.id) : null
  });
}

/**
 * Capture and deliver an order the buyer approved but that was never captured.
 *
 * @param {object} options
 * @param {object} options.evt verified PayPal webhook event
 * @param {Function} options.captureOrder PayPal capture call for an order id
 * @param {Function} [options.lookupOrder] PayPal order lookup
 * @param {Function} [options.fulfill] fulfilment entry point
 * @param {Function} [options.resolveProduct] product id -> configured product
 */
export async function captureApprovedOrderWebhook({
  evt,
  captureOrder = null,
  lookupOrder = getPayPalOrderDetails,
  fulfill = (args) => fulfillPaidOrder(args),
  resolveProduct = () => null
} = {}) {
  if (eventType(evt) !== ORDER_APPROVED) {
    return { attempted: false, reason: 'NOT_AN_APPROVED_ORDER_EVENT' };
  }
  const order = evt?.resource ?? null;
  const orderId = order?.id ? String(order.id) : null;
  if (!orderId) return { attempted: false, reason: 'NO_ORDER_ID' };

  const status = String(order?.status ?? '').toUpperCase();
  const intent = String(order?.intent ?? 'CAPTURE').toUpperCase();

  // A replayed approval can arrive after the capture route already captured the
  // order. Deliver from that order rather than asking PayPal to capture again.
  if (status !== 'APPROVED') {
    if (status === 'COMPLETED') {
      return { ...(await fulfillFromOrder({ order, orderId, fulfill, resolveProduct })), captured: false };
    }
    return { attempted: false, reason: 'ORDER_NOT_APPROVED', order_id: orderId, status: status || null };
  }
  if (intent !== 'CAPTURE') {
    return { attempted: false, reason: 'ORDER_NOT_CAPTURE_INTENT', order_id: orderId, intent };
  }
  if (typeof captureOrder !== 'function') {
    return {
      attempted: true,
      ok: false,
      order_id: orderId,
      reason: 'CAPTURE_NOT_AVAILABLE',
      finding: finding(
        WEBHOOK_AUTO_CAPTURE_FAILED,
        `The buyer approved order ${orderId} but no PayPal capture call is configured, so the ` +
        'payment was never taken and nothing was delivered.',
        { order_id: orderId }
      )
    };
  }

  let captured;
  try {
    captured = await captureOrder(orderId);
  } catch (error) {
    if (!ALREADY_CAPTURED.test(String(error?.message ?? error))) {
      return {
        attempted: true,
        ok: false,
        order_id: orderId,
        reason: 'CAPTURE_FAILED',
        finding: finding(
          WEBHOOK_AUTO_CAPTURE_FAILED,
          `The buyer approved order ${orderId} but the automatic capture failed: ` +
          `${error?.message ?? String(error)}. Capture it manually or replay the webhook.`,
          { order_id: orderId }
        )
      };
    }
    // Someone else won the race (usually the browser's own capture route).
    try {
      captured = await lookupOrder(orderId);
    } catch (lookupError) {
      return {
        attempted: true,
        ok: false,
        order_id: orderId,
        reason: 'ORDER_LOOKUP_FAILED',
        finding: finding(
          WEBHOOK_AUTO_CAPTURE_FAILED,
          `Order ${orderId} was already captured but could not be read back for delivery: ` +
          `${lookupError?.message ?? String(lookupError)}.`,
          { order_id: orderId }
        )
      };
    }
  }

  if (!captured || typeof captured !== 'object') {
    return {
      attempted: true,
      ok: false,
      order_id: orderId,
      reason: 'CAPTURE_RETURNED_NOTHING',
      finding: finding(
        WEBHOOK_AUTO_CAPTURE_FAILED,
        `PayPal returned no order after capturing ${orderId}; the buyer may have paid with ` +
        'nothing delivered.',
        { order_id: orderId }
      )
    };
  }

  return { ...(await fulfillFromOrder({ order: captured, orderId, fulfill, resolveProduct })), captured: true };
}

/** True when this verified event can produce a delivery. */
export function isWebhookFulfillmentEvent(evt) {
  const type = eventType(evt);
  return type === CAPTURE_COMPLETED || type === ORDER_APPROVED;
}

/** Route a verified webhook event to the fulfilment path it needs. */
export async function fulfillVerifiedWebhookEvent({ evt, captureOrder = null, ...options } = {}) {
  if (eventType(evt) === CAPTURE_COMPLETED) return fulfillCaptureWebhook({ evt, ...options });
  if (eventType(evt) === ORDER_APPROVED) return captureApprovedOrderWebhook({ evt, captureOrder, ...options });
  return { attempted: false, reason: 'NOT_A_FULFILLMENT_EVENT' };
}
