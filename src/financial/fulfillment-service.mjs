import crypto from 'node:crypto';

import { SettlementLedger } from './SettlementLedger.mjs';
import { FulfillmentManager } from '../real/fulfillment/FulfillmentManager.mjs';
import { parsePayPalCustomId } from '../sales/price-quote.mjs';

/**
 * Paid-order fulfilment.
 *
 * A captured sale is first credited to the settlement ledger and its
 * fulfillment cost is reserved from unallocated swarm revenue. Access is only
 * released after that prepayment succeeds. The email send is idempotent through
 * the ledger's order key; a provider failure leaves a queued obligation rather
 * than losing the paid order.
 */

const DEFAULT_ACCESS_TTL_SECONDS = 365 * 24 * 60 * 60;
const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function signAccessPayload(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

export function createAccessToken({
  orderId,
  productId = null,
  now = new Date(),
  ttlSeconds = DEFAULT_ACCESS_TTL_SECONDS
}, secret) {
  if (!orderId) throw new Error('createAccessToken requires an orderId');
  if (!secret) throw new Error('Missing FULFILLMENT_ACCESS_SECRET');
  const issuedAt = Math.floor(new Date(now).getTime() / 1000);
  const payload = base64url(JSON.stringify({
    o: String(orderId),
    p: productId ? String(productId) : null,
    iat: issuedAt,
    exp: issuedAt + Math.max(60, Number(ttlSeconds) || DEFAULT_ACCESS_TTL_SECONDS)
  }));
  return `${payload}.${signAccessPayload(payload, secret)}`;
}

export function verifyAccessToken(token, secret, { now = new Date() } = {}) {
  if (!secret) throw new Error('Missing FULFILLMENT_ACCESS_SECRET');
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'MALFORMED_TOKEN' };
  const expected = signAccessPayload(parts[0], secret);
  const actual = Buffer.from(parts[1]);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length || !crypto.timingSafeEqual(actual, wanted)) {
    return { ok: false, reason: 'INVALID_SIGNATURE' };
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'INVALID_PAYLOAD' };
  }
  if (!payload || !payload.o || !Number.isFinite(Number(payload.exp))) {
    return { ok: false, reason: 'INVALID_PAYLOAD' };
  }
  if (Number(payload.exp) <= Math.floor(new Date(now).getTime() / 1000)) {
    return { ok: false, reason: 'EXPIRED_TOKEN' };
  }
  return { ok: true, orderId: String(payload.o), productId: payload.p ? String(payload.p) : null, exp: Number(payload.exp) };
}

export function capturedOrderDetails(order) {
  const units = Array.isArray(order?.purchase_units) ? order.purchase_units : [];
  const unit = units[0] || {};
  const captures = units.flatMap((item) => (Array.isArray(item?.payments?.captures) ? item.payments.captures : []));
  const capture = captures.find((item) => String(item?.status || '').toUpperCase() === 'COMPLETED') || captures[0] || null;
  const amount = Number(capture?.amount?.value ?? unit?.amount?.value ?? NaN);
  return {
    orderId: order?.id ? String(order.id) : null,
    productId: parsePayPalCustomId(unit?.custom_id).productId,
    productName: String(unit?.description || '').trim() || null,
    amount: Number.isFinite(amount) ? amount : null,
    currency: String(capture?.amount?.currency_code || unit?.amount?.currency_code || 'USD').toUpperCase(),
    payerEmail: order?.payer?.email_address ? String(order.payer.email_address) : null,
    completed: String(order?.status || '').toUpperCase() === 'COMPLETED'
  };
}

function accessEmail({ productName, accessUrl, orderId, amount, currency }) {
  const safeProduct = escapeHtml(productName || 'your course');
  const safeUrl = escapeHtml(accessUrl);
  const safeOrder = escapeHtml(orderId);
  const amountText = amount == null ? '' : `${Number(amount).toFixed(2)} ${escapeHtml(currency || 'USD')}`;
  const text = [
    `Your payment for ${productName || 'your course'} is confirmed.`,
    amountText ? `Amount: ${amountText}` : null,
    `Access your course: ${accessUrl}`,
    `Order: ${orderId}`
  ].filter(Boolean).join('\n\n');
  const html = `<!doctype html><html><body style="margin:0;background:#0b0c10;color:#eaeef2;font-family:system-ui,sans-serif;padding:24px">
<div style="max-width:560px;margin:0 auto;border:1px solid #1e2532;border-radius:12px;background:#0e1118;padding:24px">
<h1 style="font-size:22px;margin:0 0 12px">Your access is ready</h1>
<p style="line-height:1.6;color:#b8c1cf">Payment received for <strong>${safeProduct}</strong>${amountText ? ` (${escapeHtml(amountText)})` : ''}.</p>
<p style="margin:24px 0"><a href="${safeUrl}" style="display:inline-block;background:#2f81f7;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700">Open your course</a></p>
<p style="font-size:13px;color:#8b949e">Order ${safeOrder}. Keep this email for your records.</p>
</div></body></html>`;
  return { subject: `Your RealWorldCerts access: ${productName || 'course'}`, text, html };
}

async function enqueue(queue, entry) {
  try {
    return await queue(entry);
  } catch {
    return null;
  }
}

async function sendAccessEmail({ to, subject, text, html }, { fetchImpl = globalThis.fetch, apiKey, from } = {}) {
  if (!apiKey) return { ok: false, reason: 'MISSING_RESEND_API_KEY' };
  if (!from) return { ok: false, reason: 'MISSING_FULFILLMENT_FROM_EMAIL' };
  let response;
  try {
    response = await fetchImpl(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ from, to: [to], subject, text, html }),
      signal: AbortSignal.timeout(15000)
    });
  } catch (error) {
    return { ok: false, reason: 'EMAIL_REQUEST_FAILED', error: error?.message ?? String(error) };
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return { ok: false, reason: `EMAIL_HTTP_${response.status}`, error: body.slice(0, 300) };
  }
  const payload = await response.json().catch(() => ({}));
  return { ok: true, id: payload?.id ?? null };
}

/**
 * Fulfil a captured PayPal order.
 *
 * @param {object} options
 * @param {object} options.order PayPal order response
 * @param {object|null} options.product configured ACP product
 * @param {SettlementLedger} [options.ledger]
 * @param {Function} [options.queue]
 */
export async function fulfillPaidOrder({
  order,
  product = null,
  ledger = new SettlementLedger(),
  queue = (entry) => FulfillmentManager.fulfillOrder(entry),
  fetchImpl = globalThis.fetch,
  secret = process.env.FULFILLMENT_ACCESS_SECRET || '',
  baseUrl = process.env.APP_ORIGIN || 'https://www.realworldcerts.com',
  emailApiKey = process.env.RESEND_API_KEY || '',
  emailFrom = process.env.FULFILLMENT_FROM_EMAIL || 'billing@realworldcerts.com',
  costCents = null,
  now = new Date()
} = {}) {
  const details = capturedOrderDetails(order);
  if (!details.orderId || !details.completed) {
    return { ok: false, reason: 'ORDER_NOT_COMPLETED', details };
  }

  const cost = Math.max(0, Math.round(
    Number(costCents ?? product?.fulfillment_cost_cents ?? process.env.FULFILLMENT_COST_CENTS ?? 0) || 0
  ));
  const prepayment = await ledger.prepayFulfillment({
    orderId: details.orderId,
    revenueAmount: details.amount,
    currency: details.currency,
    costCents: cost,
    productId: product?.id || details.productId,
    now
  });

  if (!prepayment.ok) {
    await enqueue(queue, {
      id: details.orderId,
      product: product?.name || details.productName || 'Paid order',
      customer_email: details.payerEmail,
      revenue: details.amount,
      currency: details.currency,
      status: 'BLOCKED_PREPAYMENT',
      action_required: `Fund fulfillment from swarm revenue: ${prepayment.reason}`,
      funding: prepayment,
      email: null
    });
    return { ok: false, reason: prepayment.reason, details, funding: prepayment };
  }

  if (prepayment.duplicate && prepayment.emailStatus === 'sent') {
    return {
      ok: true,
      delivery: 'emailed',
      duplicate: true,
      details,
      funding: prepayment,
      email: { ok: true, id: prepayment.emailId || null }
    };
  }

  const productName = product?.name || details.productName || 'Your course';
  let accessUrl = null;
  if (secret) {
    const token = createAccessToken({
      orderId: details.orderId,
      productId: product?.id || details.productId,
      now
    }, secret);
    accessUrl = `${String(baseUrl).replace(/\/+$/, '')}/access/${encodeURIComponent(token)}`;
  }

  const funding = {
    prepaid_by: 'swarm',
    funding_source: 'swarm_revenue',
    cost_cents: prepayment.costCents,
    available_cents_after: prepayment.availableCents,
    transaction_id: prepayment.transaction?.id || null
  };

  if (!details.payerEmail) {
    await enqueue(queue, {
      id: details.orderId,
      product: productName,
      customer_email: null,
      revenue: details.amount,
      currency: details.currency,
      status: 'PENDING_EMAIL',
      action_required: 'Payer email missing; retrieve it from PayPal and send access manually',
      access_url: accessUrl,
      funding,
      email: { ok: false, reason: 'MISSING_PAYER_EMAIL' }
    });
    return { ok: true, delivery: 'queued', reason: 'MISSING_PAYER_EMAIL', details, funding };
  }

  if (!accessUrl) {
    await enqueue(queue, {
      id: details.orderId,
      product: productName,
      customer_email: details.payerEmail,
      revenue: details.amount,
      currency: details.currency,
      status: 'PENDING_ACCESS_SECRET',
      action_required: 'Set FULFILLMENT_ACCESS_SECRET, then resend access',
      funding,
      email: { ok: false, reason: 'MISSING_ACCESS_SECRET' }
    });
    return { ok: true, delivery: 'queued', reason: 'MISSING_ACCESS_SECRET', details, funding };
  }

  const message = accessEmail({
    productName,
    accessUrl,
    orderId: details.orderId,
    amount: details.amount,
    currency: details.currency
  });
  const email = await sendAccessEmail(
    { to: details.payerEmail, ...message },
    { fetchImpl, apiKey: emailApiKey, from: emailFrom }
  );
  if (typeof ledger.markFulfillmentEmail === 'function') {
    await ledger.markFulfillmentEmail(details.orderId, {
      status: email.ok ? 'sent' : 'failed',
      emailId: email.id || null,
      reason: email.reason || email.error || null,
      now
    }).catch(() => {});
  }

  const queued = await enqueue(queue, {
    id: details.orderId,
    product: productName,
    customer_email: details.payerEmail,
    revenue: details.amount,
    currency: details.currency,
    status: email.ok ? 'DELIVERED' : 'PENDING_EMAIL',
    action_required: email.ok ? null : 'Retry access email from the fulfillment queue',
    access_url: accessUrl,
    funding,
    email
  });

  return {
    ok: true,
    delivery: email.ok ? 'emailed' : 'queued',
    email,
    details,
    funding,
    queue: queued
  };
}

export default fulfillPaidOrder;
