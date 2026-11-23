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
// Overridable so a test can drive delivery against a loopback stub instead of
// sending mail; deployments keep the public endpoint by default.
const RESEND_ENDPOINT = `${String(process.env.RESEND_API_BASE_URL || 'https://api.resend.com').replace(/\/+$/, '')}/emails`;

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
    // The capture is what PayPal issued the money against. It is the only id a
    // refund or chargeback names, so it has to reach the queue for a reversal
    // to be matched to the delivery it was paid for.
    captureId: capture?.id ? String(capture.id) : null,
    productId: parsePayPalCustomId(unit?.custom_id).productId,
    productName: String(unit?.description || '').trim() || null,
    amount: Number.isFinite(amount) ? amount : null,
    currency: String(capture?.amount?.currency_code || unit?.amount?.currency_code || 'USD').toUpperCase(),
    payerEmail: order?.payer?.email_address ? String(order.payer.email_address) : null,
    completed: String(order?.status || '').toUpperCase() === 'COMPLETED'
  };
}

export const DEFAULT_SUPPORT_EMAIL = 'billing@realworldcerts.com';

function amountLabel(amount, currency) {
  return amount == null ? '' : `${Number(amount).toFixed(2)} ${String(currency || 'USD').toUpperCase()}`;
}

function passFilename(orderId) {
  const safe = String(orderId ?? 'order').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'order';
  return `access-${safe}.html`;
}

/**
 * A self-contained access pass, attached to the delivery email.
 *
 * The emailed `/access/<token>` page lives on the app server, so the buyer's
 * link is dead whenever that server is not deployed. This document carries the
 * same signed token, the order and the entitlement, with no scripts, images or
 * external references: it opens from the buyer's downloads folder on any
 * device, offline, and support can still verify the token against the secret.
 */
export function buildAccessPass({
  orderId,
  productId = null,
  productName = 'Your course',
  amount = null,
  currency = 'USD',
  token,
  issuedAt = new Date(),
  expiresAt = null,
  supportEmail = DEFAULT_SUPPORT_EMAIL,
  onlineUrl = null
} = {}) {
  if (!orderId) throw new Error('buildAccessPass requires an orderId');
  if (!token) throw new Error('buildAccessPass requires a token');
  const name = String(productName || 'Your course');
  const order = String(orderId);
  const amountText = amountLabel(amount, currency);
  const issued = new Date(issuedAt).toISOString().slice(0, 10);
  const expires = expiresAt ? new Date(expiresAt).toISOString().slice(0, 10) : null;
  const support = String(supportEmail || DEFAULT_SUPPORT_EMAIL);
  const redeem = `mailto:${support}?subject=${encodeURIComponent(`Access request ${order}`)}`;
  const esc = escapeHtml;

  const rows = [
    ['Order', order],
    ['Product', name],
    productId ? ['Product id', String(productId)] : null,
    amountText ? ['Amount paid', amountText] : null,
    ['Issued', issued],
    expires ? ['Valid until', expires] : null
  ].filter(Boolean);

  const text = [
    `${name} — access pass`,
    ...rows.map(([label, value]) => `${label}: ${value}`),
    '',
    `This pass confirms your paid access to ${name}. Keep this file; it is yours and does not expire when a website goes offline.`,
    `To activate or restore access, email ${support} quoting order ${order}.`,
    onlineUrl ? `Online copy (when the site is available): ${onlineUrl}` : null,
    '',
    `Signed token: ${token}`,
    'Support can verify this pass without our server: HMAC-SHA256 over the part before the final dot, using FULFILLMENT_ACCESS_SECRET.'
  ].filter(line => line !== null).join('\n');

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)} — access pass</title></head>
<body style="margin:0;background:#0b0c10;color:#eaeef2;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
<main style="max-width:640px;margin:0 auto;padding:28px 20px">
<div style="border:1px solid #1e2532;border-radius:12px;background:#0e1118;padding:24px">
<p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8b949e">RealWorldCerts access pass</p>
<h1 style="font-size:24px;margin:0 0 16px">${esc(name)}</h1>
<table style="width:100%;border-collapse:collapse;font-size:14px">
${rows.map(([label, value]) => `<tr><td style="padding:6px 0;color:#8b949e">${esc(label)}</td><td style="padding:6px 0;text-align:right;color:#eaeef2">${esc(value)}</td></tr>`).join('\n')}
</table>
<p style="line-height:1.6;color:#b8c1cf;margin:18px 0 8px">This pass confirms your paid access to ${esc(name)}. Keep this file: it is yours, and it does not stop working when a website goes offline.</p>
<p style="line-height:1.6;color:#b8c1cf;margin:0 0 16px">To activate or restore access, email <a href="${esc(redeem)}" style="color:#8ab4ff">${esc(support)}</a> quoting order <strong>${esc(order)}</strong>.</p>
${onlineUrl ? `<p style="line-height:1.6;color:#b8c1cf;margin:0 0 16px">Online copy (when the site is available): <a href="${esc(onlineUrl)}" style="color:#8ab4ff">${esc(onlineUrl)}</a></p>` : ''}
<p style="margin:0 0 6px;font-size:12px;color:#8b949e">Signed token</p>
<p style="margin:0;padding:10px;border:1px solid #1e2532;border-radius:8px;background:#0b0c10;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all;color:#c9d1d9">${esc(token)}</p>
<p style="margin:10px 0 0;font-size:12px;color:#8b949e">Support verifies this pass offline: HMAC-SHA256 over the part before the final dot, using the fulfilment access secret.</p>
</div></main></body></html>`;

  return {
    filename: passFilename(order),
    html,
    text,
    sha256: crypto.createHash('sha256').update(html, 'utf8').digest('hex')
  };
}

function accessEmail({ productName, orderId, amount, currency, accessPass, onlineUrl = null, supportEmail = DEFAULT_SUPPORT_EMAIL }) {
  const safeProduct = escapeHtml(productName || 'your course');
  const safeOrder = escapeHtml(orderId);
  const support = escapeHtml(supportEmail || DEFAULT_SUPPORT_EMAIL);
  const amountText = amountLabel(amount, currency);
  const redeem = `mailto:${supportEmail || DEFAULT_SUPPORT_EMAIL}?subject=${encodeURIComponent(`Access request ${orderId}`)}`;
  const text = [
    `Your payment for ${productName || 'your course'} is confirmed.`,
    amountText ? `Amount: ${amountText}` : null,
    `Order: ${orderId}`,
    `Your access pass is attached (${accessPass.filename}). It is a self-contained file: open it on any device, and it keeps working even when our website is not online.`,
    onlineUrl ? `Online copy (when the site is available): ${onlineUrl}` : null,
    `To activate or restore access, reply to this email or write to ${supportEmail || DEFAULT_SUPPORT_EMAIL} quoting order ${orderId}.`,
    'Keep this email and its attachment for your records.'
  ].filter(Boolean).join('\n\n');
  const html = `<!doctype html><html><body style="margin:0;background:#0b0c10;color:#eaeef2;font-family:system-ui,sans-serif;padding:24px">
<div style="max-width:560px;margin:0 auto;border:1px solid #1e2532;border-radius:12px;background:#0e1118;padding:24px">
<h1 style="font-size:22px;margin:0 0 12px">Your access is ready</h1>
<p style="line-height:1.6;color:#b8c1cf">Payment received for <strong>${safeProduct}</strong>${amountText ? ` (${escapeHtml(amountText)})` : ''}.</p>
<p style="line-height:1.6;color:#b8c1cf">Your access pass is attached as <strong>${escapeHtml(accessPass.filename)}</strong>. It is a self-contained file: open it on any device, and it keeps working even when our website is not online.</p>
${onlineUrl ? `<p style="line-height:1.6;color:#b8c1cf">Online copy (when the site is available): <a href="${escapeHtml(onlineUrl)}" style="color:#8ab4ff">${escapeHtml(onlineUrl)}</a></p>` : ''}
<p style="margin:24px 0"><a href="${escapeHtml(redeem)}" style="display:inline-block;background:#2f81f7;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700">Email support</a></p>
<p style="font-size:13px;color:#8b949e">Order ${safeOrder}. Keep this email and its attachment for your records.</p>
</div></body></html>`;
  return { subject: `Your RealWorldCerts access pass: ${productName || 'course'}`, text, html };
}

async function enqueue(queue, entry) {
  try {
    return await queue(entry);
  } catch {
    return null;
  }
}

async function sendAccessEmail({ to, subject, text, html, attachments = [] }, { fetchImpl = globalThis.fetch, apiKey, from } = {}) {
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
      body: JSON.stringify({ from, to: [to], subject, text, html, ...(attachments.length ? { attachments } : {}) }),
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
  supportEmail = process.env.FULFILLMENT_SUPPORT_EMAIL || DEFAULT_SUPPORT_EMAIL,
  // The `/access/<token>` route is only in the email when the deployment that
  // serves it is live; the attached pass is the delivery that always works.
  includeAccessUrl = /^(1|true|yes|on)$/i.test(String(process.env.FULFILLMENT_ACCESS_LINK_ENABLED || '')),
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
      capture_id: details.captureId,
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
  const productId = product?.id || details.productId || null;
  let accessUrl = null;
  let accessPass = null;
  if (secret) {
    const token = createAccessToken({
      orderId: details.orderId,
      productId,
      now
    }, secret);
    const granted = verifyAccessToken(token, secret, { now });
    accessUrl = `${String(baseUrl).replace(/\/+$/, '')}/access/${encodeURIComponent(token)}`;
    accessPass = buildAccessPass({
      orderId: details.orderId,
      productId,
      productName,
      amount: details.amount,
      currency: details.currency,
      token,
      issuedAt: now,
      expiresAt: granted.ok ? new Date(granted.exp * 1000) : null,
      supportEmail,
      onlineUrl: includeAccessUrl ? accessUrl : null
    });
  }
  const passSummary = accessPass ? { filename: accessPass.filename, sha256: accessPass.sha256 } : null;

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
      capture_id: details.captureId,
      product: productName,
      customer_email: null,
      revenue: details.amount,
      currency: details.currency,
      status: 'PENDING_EMAIL',
      action_required: 'Payer email missing; retrieve it from PayPal and send access manually',
      access_url: accessUrl,
      access_pass: passSummary,
      funding,
      email: { ok: false, reason: 'MISSING_PAYER_EMAIL' }
    });
    return { ok: true, delivery: 'queued', reason: 'MISSING_PAYER_EMAIL', details, funding };
  }

  if (!accessUrl) {
    await enqueue(queue, {
      id: details.orderId,
      capture_id: details.captureId,
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
    orderId: details.orderId,
    amount: details.amount,
    currency: details.currency,
    accessPass,
    onlineUrl: includeAccessUrl ? accessUrl : null,
    supportEmail
  });
  const email = await sendAccessEmail(
    {
      to: details.payerEmail,
      ...message,
      attachments: [{
        filename: accessPass.filename,
        content: Buffer.from(accessPass.html, 'utf8').toString('base64')
      }]
    },
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
    capture_id: details.captureId,
    product: productName,
    customer_email: details.payerEmail,
    revenue: details.amount,
    currency: details.currency,
    status: email.ok ? 'DELIVERED' : 'PENDING_EMAIL',
    action_required: email.ok ? null : 'Retry access email from the fulfillment queue',
    access_url: accessUrl,
    access_pass: passSummary,
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
