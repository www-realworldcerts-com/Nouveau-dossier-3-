import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import "./load-env.mjs";
import { enforceConstitutionSoft } from "./bootstrap/constitution-validator.mjs";
import { buildBase44ServiceClient } from "./base44-client.mjs";
import {
  extractPayPalWebhookHeaders,
  verifyPayPalWebhookSignature,
  getPayPalAccessToken,
  paypalRequest,
  getPayPalOrderDetails
} from "./paypal-api.mjs";
import { OwnerSettlementEnforcer } from "./policy/owner-settlement.mjs";
import { mapPayPalWebhookToRevenueEvent } from "./paypal-event-mapper.mjs";
import {
  createBase44RevenueEventIdempotent,
  getRevenueConfigFromEnv
} from "./base44-revenue.mjs";
import { maybeSendAlert } from "./alerts.mjs";
import { createDedupeStore } from "./dedupe-store.mjs";
import { enforceAuthorityProtocol } from "./authority.mjs";
import { addSecurityHeaders, validateRequest, validateAuth } from "./security-middleware.mjs";
import { escapeHtml, fulfillPaidOrder, verifyAccessToken } from "./financial/fulfillment-service.mjs";
import { loadCourseCatalog, productsFromCatalog, storefrontPricePayload } from "./sales/course-catalog.mjs";
import {
  createPriceQuote,
  encodePayPalCustomId,
  encodePayPalInvoiceId,
  normalizeQuoteRedirectUrl,
  parsePayPalCustomId,
  parsePayPalInvoiceId,
  resolvePriceQuoteKeys,
  verifyPriceQuote
} from "./sales/price-quote.mjs";
import { checkoutAttemptKey, createCheckoutAttemptRegistry } from "./sales/checkout-attempts.mjs";

const isDirectExecution =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

let requestHandler = null;
const checkoutAttempts = createCheckoutAttemptRegistry({
  // A store directory shared by every instance makes quote replay protection
  // survive restarts; without one the registry is per process.
  directory: process.env.CHECKOUT_ATTEMPT_STORE_DIR || null,
  // How long a request waits for a competing creator before answering with a
  // retryable conflict instead of starting a second PayPal order.
  claimTimeoutMs: process.env.CHECKOUT_ATTEMPT_CLAIM_TIMEOUT_MS || undefined
});

/**
 * Handler for embedded/serverless runtimes (Vercel). The module initialises the
 * dedupe store and config check on import, then registers this handler instead
 * of binding a port.
 */
export function getRequestHandler() {
  if (!requestHandler) throw new Error("webhook server handler is not initialised");
  return requestHandler;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

try { enforceConstitutionSoft(process.env.AUDIT_HMAC_SECRET || process.env.CONSTITUTION_RUNTIME_SECRET || ''); } catch {}

function getEnvOrThrow(name) {
  const v = process.env[name];
  if (v == null || String(v).trim() === "") throw new Error(`Missing required env var: ${name}`);
  if (isPlaceholderValue(v)) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function getEnvBool(name, defaultValue = false) {
  const v = process.env[name];
  if (v == null) return defaultValue;
  return v.toLowerCase() === "true";
}

function requireLiveMode(reason) {
  if (!getEnvBool("SWARM_LIVE", false)) {
    throw new Error(`Refusing live operation without SWARM_LIVE=true (${reason})`);
  }
  if (getEnvBool("BASE44_OFFLINE", false) || getEnvBool("BASE44_OFFLINE_MODE", false)) {
    throw new Error(`LIVE MODE NOT GUARANTEED (offline mode enabled: ${reason})`);
  }
  const paypalMode = String(process.env.PAYPAL_MODE ?? "live").toLowerCase();
  const paypalBase = String(process.env.PAYPAL_API_BASE_URL ?? "").toLowerCase();
  if (paypalMode === "sandbox" || paypalBase.includes("sandbox.paypal.com")) {
    throw new Error(`LIVE MODE NOT GUARANTEED (PayPal sandbox configured: ${reason})`);
  }
  enforceAuthorityProtocol({ action: reason, requireLive: true });
}

function isPlaceholderValue(value) {
  if (value == null) return true;
  const v = String(value).trim();
  if (!v) return true;
  if (/^\s*<\s*YOUR_[A-Z0-9_]+\s*>\s*$/i.test(v)) return true;
  if (/^\s*YOUR_[A-Z0-9_]+\s*$/i.test(v)) return true;
  if (/^\s*(REPLACE_ME|CHANGEME|TODO)\s*$/i.test(v)) return true;
  return false;
}

function getPathname(req) {
  try {
    const raw = req?.url ?? "/";
    const u = new URL(raw, "http://localhost");
    const p = u.pathname || "/";
    if (p.length > 1 && p.endsWith("/")) return p.slice(0, -1);
    return p;
  } catch {
    return "/";
  }
}

function getSearchParams(req) {
  try {
    return new URL(req?.url ?? "/", "http://localhost").searchParams;
  } catch {
    return new URLSearchParams();
  }
}

const DEFAULT_STOREFRONT_ORIGIN = "https://www.realworldcerts.com";

function checkoutOrigin(value) {
  try {
    return new URL(String(value || "")).origin;
  } catch {
    return null;
  }
}

function allowedCheckoutOrigins() {
  const origins = new Set([
    checkoutOrigin(process.env.STOREFRONT_URL) || DEFAULT_STOREFRONT_ORIGIN
  ]);
  for (const value of [
    process.env.CHECKOUT_PRICE_ORIGIN_URL,
    process.env.PAYPAL_RETURN_URL,
    process.env.PAYPAL_CANCEL_URL
  ]) {
    const origin = checkoutOrigin(value);
    if (origin) origins.add(origin);
  }
  return origins;
}

function resolveCheckoutRedirects({ returnUrl = null, cancelUrl = null } = {}) {
  const storefront = checkoutOrigin(process.env.STOREFRONT_URL || DEFAULT_STOREFRONT_ORIGIN) || DEFAULT_STOREFRONT_ORIGIN;
  const defaults = {
    returnUrl: process.env.PAYPAL_RETURN_URL || `${storefront}/buy/success`,
    cancelUrl: process.env.PAYPAL_CANCEL_URL || `${storefront}/buy/cancel`
  };
  let resolvedReturn;
  let resolvedCancel;
  try {
    resolvedReturn = normalizeQuoteRedirectUrl(returnUrl || defaults.returnUrl);
    resolvedCancel = normalizeQuoteRedirectUrl(cancelUrl || defaults.cancelUrl);
  } catch (error) {
    return { ok: false, reason: `checkout_redirect_invalid: ${error.message}` };
  }
  const returnPath = new URL(resolvedReturn).pathname;
  const cancelPath = new URL(resolvedCancel).pathname;
  if (returnPath !== "/buy/success" || cancelPath !== "/buy/cancel") {
    return { ok: false, reason: "checkout_redirect_path: return_url must be /buy/success and cancel_url must be /buy/cancel" };
  }
  const allowed = allowedCheckoutOrigins();
  if (!allowed.has(new URL(resolvedReturn).origin) || !allowed.has(new URL(resolvedCancel).origin)) {
    return { ok: false, reason: "checkout_redirect_origin: return_url and cancel_url must use an allowed checkout origin" };
  }
  return {
    ok: true,
    returnUrl: resolvedReturn,
    cancelUrl: resolvedCancel
  };
}

function bufferToText(value) {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString("utf8");
  return null;
}

/**
 * Raw bytes that a runtime buffered before invoking the handler. Only exact
 * representations are accepted; a parsed object cannot be verified, because
 * re-serialising it changes whitespace and key order.
 */
function readBufferedRawBody(req) {
  for (const key of ["rawBody", "body"]) {
    const value = req?.[key];
    if (value == null) continue;
    const text = bufferToText(value);
    if (text != null) return text;
    if (typeof value === "object") {
      throw new Error("Raw request body was parsed before signature verification");
    }
  }
  return null;
}

export function readRawBody(req, { limitBytes }) {
  const finish = (text) => {
    if (text == null) return "";
    if (Buffer.byteLength(text, "utf8") > limitBytes) throw new Error("Request body too large");
    return text;
  };

  return new Promise((resolve, reject) => {
    // Some runtimes hand over an already-consumed stream with the body buffered
    // separately; use those bytes rather than an empty string.
    if (req?.readableEnded === true) {
      try {
        resolve(finish(readBufferedRawBody(req)));
      } catch (e) {
        reject(e);
      }
      return;
    }

    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      const streamed = Buffer.concat(chunks).toString("utf8");
      if (streamed.length > 0) {
        resolve(streamed);
        return;
      }
      try {
        resolve(finish(readBufferedRawBody(req)));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function html(res, status, body) {
  const text = String(body ?? "");
  // HTML pages are self-contained and use inline scripts. Keep the strict API
  // CSP, but allow the page's own inline code so checkout buttons work.
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none';"
  );
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(text)
  });
  res.end(text);
}

function normalizeCurrency(value, fallback) {
  if (!value) return fallback;
  const v = String(value).trim().toUpperCase();
  if (v.length !== 3) return fallback;
  return v;
}

function pickApprovalUrl(order) {
  const links = order?.links ?? [];
  const approval = links.find((l) => l?.rel === "approve");
  return approval?.href ?? null;
}

function shouldCreatePayPalOrders() {
  return (process.env.PAYPAL_ENABLE_ORDER_CREATE ?? "false").toLowerCase() === "true";
}

async function createPayPalCheckoutOrder({ amount, currency, description, customId, productId, quoteId, catalogVersion, catalogDigest, returnUrl, cancelUrl, requestId = null }) {
  const token = await getPayPalAccessToken();
  const customIdValue = quoteId
    ? encodePayPalCustomId({ productId: productId || customId, quoteId, catalogVersion })
    : (productId || customId ? String(productId || customId).slice(0, 127) : null);
  const invoiceIdValue = quoteId
    ? (encodePayPalInvoiceId({ quoteId, catalogDigest }) || (customId ? String(customId).slice(0, 127) : null))
    : (customId ? String(customId).slice(0, 127) : null);
  const purchaseUnit = {
    amount: {
      currency_code: currency,
      value: Number(amount).toFixed(2)
    },
    ...(description ? { description } : {}),
    ...(customIdValue ? { custom_id: customIdValue } : {}),
    ...(invoiceIdValue ? { invoice_id: invoiceIdValue } : {})
  };
  const body = {
    intent: "CAPTURE",
    purchase_units: [purchaseUnit],
    application_context: {
      return_url: returnUrl,
      cancel_url: cancelUrl
    }
  };
  return paypalRequest("/v2/checkout/orders", {
    method: "POST",
    token,
    body,
    ...(requestId ? { headers: { "PayPal-Request-Id": requestId } } : {})
  });
}

function shouldFulfillPaidOrders() {
  return String(process.env.FULFILLMENT_ENABLED ?? "true").toLowerCase() !== "false";
}

async function capturePayPalCheckoutOrder(orderId) {
  const token = await getPayPalAccessToken();
  return paypalRequest(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: "POST",
    token,
    headers: { "PayPal-Request-Id": `capture_${orderId}` }
  });
}

function publicProducts() {
  try {
    return productsFromCatalog();
  } catch (error) {
    console.warn(`[course-catalog] ${error.message}`);
    return [];
  }
}

function buyPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Checkout · RealWorldCerts</title>
<style>
body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0c10;color:#eaeef2}
main{max-width:640px;margin:0 auto;padding:28px 20px}.card{border:1px solid #1e2532;border-radius:12px;padding:20px;background:#0e1118}
a{color:#8ab4ff}h1{font-size:24px;margin:0 0 8px}p{line-height:1.55;color:#b8c1cf}label{display:block;margin:16px 0 6px;font-weight:600}select,button{width:100%;padding:12px;border-radius:8px;border:1px solid #2a3e58;background:#16263a;color:#eaf1ff;font-size:16px}button{margin-top:16px;background:#2f81f7;border-color:#2f81f7;font-weight:700;cursor:pointer}button:disabled{opacity:.6;cursor:not-allowed}.err{display:none;margin-top:14px;padding:10px;border:1px solid #f85149;border-radius:8px;color:#ffb4ab;background:#2a1113;white-space:pre-wrap}.muted{font-size:13px;color:#8b949e}
</style>
</head>
<body><main><div class="card">
<h1>Complete your purchase</h1>
<p>Pay securely with PayPal. Access is emailed after PayPal confirms the payment.</p>
<form id="checkout">
<label for="product">Course</label>
<select id="product" required><option value="">Loading courses…</option></select>
<button id="pay" type="submit" disabled>Continue to PayPal</button>
</form>
<div id="error" class="err" role="alert"></div>
<p class="muted">Need help? Email <a href="mailto:billing@realworldcerts.com">billing@realworldcerts.com</a>.</p>
</div></main>
<script>
(function(){
  var q = new URLSearchParams(location.search);
  var select = document.getElementById('product');
  var button = document.getElementById('pay');
  var error = document.getElementById('error');
  var productsById = {};
  var quoteCache = null;
  var requested = q.get('product_id') || '';
  function show(message){ error.textContent = message; error.style.display = 'block'; }
  function clear(){ error.textContent = ''; error.style.display = 'none'; }
  function loadQuote(productId, returnUrl, cancelUrl){
    var cacheKey = productId + '|' + returnUrl + '|' + cancelUrl;
    if (quoteCache && quoteCache.key === cacheKey && Date.now() < quoteCache.expiresAt - 30000) {
      return Promise.resolve({status:200, body:quoteCache.body});
    }
    var quotePath = '/acp/v1/price-quote?product_id=' + encodeURIComponent(productId)
      + '&return_url=' + encodeURIComponent(returnUrl)
      + '&cancel_url=' + encodeURIComponent(cancelUrl);
    return fetch(quotePath, {cache:'no-store'})
      .then(function(r){ return r.json().then(function(body){ return {status:r.status, body:body}; }); })
      .then(function(result){
        var quote = result.body || {};
        if (result.status === 200 && quote.ok === true && quote.quote) {
          quoteCache = {key:cacheKey, body:quote, expiresAt:Date.parse(quote.expires_at) || 0};
        }
        return result;
      });
  }
  function reference(){
    var ref = q.get('ref');
    if (ref && /^[A-Za-z0-9._-]{1,64}$/.test(ref)) return ref;
    return 'RWC-' + Date.now().toString(36).toUpperCase();
  }
  fetch('/acp/v1/discovery', {cache:'no-store'}).then(function(r){ return r.json(); }).then(function(data){
    var products = Array.isArray(data.products) ? data.products : [];
    select.innerHTML = '';
    if (!products.length) {
      select.innerHTML = '<option value="">Checkout is not configured yet</option>';
      show('No products are configured. Email billing@realworldcerts.com and we will complete your order.');
      return;
    }
    products.forEach(function(p){
      if (!p || !p.id) return;
      productsById[String(p.id)] = p;
      var option = document.createElement('option');
      option.value = String(p.id);
      var price = p.price != null ? ' — ' + Number(p.price).toFixed(2) + ' ' + String(p.currency || 'USD') : '';
      option.textContent = String(p.name || p.title || p.id) + price;
      if (requested && String(p.id) === requested) option.selected = true;
      select.appendChild(option);
    });
    if (!select.value && products[0] && products[0].id) select.value = String(products[0].id);
    button.disabled = !select.value;
    if (requested && select.value !== requested) show('That course is not available. Choose another course below.');
  }).catch(function(e){ show('Could not load courses: ' + (e && e.message ? e.message : e)); });
  select.addEventListener('change', function(){ button.disabled = !select.value; });
  document.getElementById('checkout').addEventListener('submit', function(event){
    event.preventDefault();
    clear();
    var productId = select.value;
    if (!productId) return show('Choose a course first.');
    button.disabled = true;
    button.textContent = 'Starting secure checkout…';
    var selected = productsById[String(productId)] || null;
    var returnUrl = location.origin + '/buy/success';
    var cancelUrl = location.origin + '/buy/cancel';
    var requestBody = {
      product_id: productId,
      reference: reference(),
      return_url: returnUrl,
      cancel_url: cancelUrl
    };
    if (selected && selected.price != null) {
      requestBody.amount = Number(selected.price);
      requestBody.currency = String(selected.currency || 'USD');
    }
    loadQuote(productId, returnUrl, cancelUrl)
      .then(function(result){
        var quote = result.body || {};
        if (result.status >= 300 || quote.ok !== true || !quote.quote) {
          throw new Error(quote.error || ('Price quote failed (HTTP ' + result.status + ')'));
        }
        requestBody.price_quote = quote.quote;
        return fetch('/acp/v1/transactions', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify(requestBody)
        });
      })
      .then(function(r){ return r.json().then(function(body){ return {status:r.status, body:body}; }); }).then(function(result){
      var body = result.body || {};
      if (result.status === 409) quoteCache = null;
      if (result.status >= 300 || body.ok !== true) throw new Error(body.error || ('Checkout failed (HTTP ' + result.status + ')'));
      var approval = body.payment_instructions && body.payment_instructions.approval_url;
      if (!approval) throw new Error('PayPal did not return an approval link. Nothing was charged.');
      location.href = approval;
    }).catch(function(e){
      button.disabled = false;
      button.textContent = 'Continue to PayPal';
      show('Checkout could not start: ' + (e && e.message ? e.message : e));
    });
  });
})();
</script>
</body></html>`;
}

function buySuccessPage() {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Confirming payment · RealWorldCerts</title>
<style>body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0c10;color:#eaeef2}main{max-width:640px;margin:0 auto;padding:28px 20px}.card{border:1px solid #1e2532;border-radius:12px;padding:20px;background:#0e1118}a{color:#8ab4ff}h1{font-size:24px;margin:0 0 8px}p{line-height:1.55;color:#b8c1cf}.err{display:none;margin-top:14px;padding:10px;border:1px solid #f85149;border-radius:8px;color:#ffb4ab;background:#2a1113;white-space:pre-wrap}.ok{display:none;margin-top:14px;padding:10px;border:1px solid #2ea043;border-radius:8px;color:#7ee787;background:#0d1a14}.muted{font-size:13px;color:#8b949e}</style></head>
<body><main><div class="card"><h1 id="title">Confirming your payment…</h1><p id="copy">Please keep this page open while PayPal confirms the transaction.</p><div id="ok" class="ok"></div><div id="error" class="err" role="alert"></div><p class="muted">Order reference: <strong id="ref">—</strong></p><p class="muted">Need help? Email <a href="mailto:billing@realworldcerts.com">billing@realworldcerts.com</a>.</p></div></main>
<script>
(function(){
  var q = new URLSearchParams(location.search);
  var token = q.get('token') || '';
  var title = document.getElementById('title');
  var copy = document.getElementById('copy');
  var ok = document.getElementById('ok');
  var error = document.getElementById('error');
  document.getElementById('ref').textContent = q.get('ref') || token || '—';
  function fail(message){ title.textContent = 'Payment not confirmed'; copy.textContent = 'No access was delivered. You can retry checkout or contact support.'; error.textContent = message; error.style.display = 'block'; }
  if (!token) return fail('Missing PayPal order token. Return to checkout and try again.');
  fetch('/acp/v1/transactions/' + encodeURIComponent(token) + '/capture', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'})
    .then(function(r){ return r.json().then(function(body){ return {status:r.status, body:body}; }); })
    .then(function(result){
      var body = result.body || {};
      if (result.status >= 300 || body.ok !== true) throw new Error(body.error || ('Capture failed (HTTP ' + result.status + ')'));
      if (body.status !== 'COMPLETED') { title.textContent = 'Payment pending'; copy.textContent = 'PayPal has not completed the payment yet. Keep this page open and refresh in a moment.'; return; }
      title.textContent = 'Payment received';
      var fulfillment = body.fulfillment || {};
      if (fulfillment.ok === false) {
        copy.textContent = 'Payment is confirmed, but access is blocked pending support. Quote your order reference.';
      } else if (fulfillment.delivery === 'emailed') {
        copy.textContent = 'Your access email has been sent. Check your inbox and spam folder.';
      } else if (fulfillment.delivery === 'queued') {
        copy.textContent = 'Payment is confirmed. Your access is queued for email; contact support if it does not arrive.';
      } else if (fulfillment.delivery === 'disabled') {
        copy.textContent = 'Payment is confirmed. Access delivery is temporarily unavailable; contact support with your order reference.';
      } else {
        copy.textContent = 'Thank you. Your access is being prepared for email delivery.';
      }
      ok.textContent = 'Paid' + (body.amount ? ' ' + body.amount.value + ' ' + body.amount.currency : '') + '. Order ' + (body.transaction_id || token) + ' confirmed.';
      ok.style.display = 'block';
    }).catch(function(e){ fail(e && e.message ? e.message : String(e)); });
})();
</script></body></html>`;
}

function accessPage({ orderId, product }) {
  const name = escapeHtml(product?.name || product?.title || 'Your course');
  const slug = product?.slug || product?.id;
  const target = product?.url || (slug ? `/catalog/${encodeURIComponent(slug)}.html` : '/catalog/index.html');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your access · RealWorldCerts</title><style>body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0c10;color:#eaeef2}main{max-width:640px;margin:0 auto;padding:28px 20px}.card{border:1px solid #1e2532;border-radius:12px;padding:20px;background:#0e1118}a{color:#8ab4ff}h1{font-size:24px;margin:0 0 8px}p{line-height:1.55;color:#b8c1cf}.btn{display:inline-block;margin-top:12px;background:#2f81f7;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700}</style></head><body><main><div class="card"><h1>${name}</h1><p>Your payment is confirmed and your access is ready.</p><p><a class="btn" href="${escapeHtml(target)}">Open course</a></p><p style="font-size:13px;color:#8b949e">Order ${escapeHtml(orderId)}</p></div></main></body></html>`;
}

function buyCancelPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Checkout cancelled · RealWorldCerts</title><style>body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0c10;color:#eaeef2}main{max-width:640px;margin:0 auto;padding:28px 20px}.card{border:1px solid #1e2532;border-radius:12px;padding:20px;background:#0e1118}a{color:#8ab4ff}h1{font-size:24px;margin:0 0 8px}p{line-height:1.55;color:#b8c1cf}</style></head><body><main><div class="card"><h1>Checkout cancelled</h1><p>Nothing was charged. You can return to the catalog and start again whenever you are ready.</p><p><a href="/catalog/index.html">Back to catalog</a></p></div></main></body></html>`;
}

function lastJsonLine(text) {
  const raw = String(text ?? "");
  const lines = raw.split(/\r?\n/g).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.startsWith("{") && l.endsWith("}")) return l;
  }
  return null;
}

function runAllGoodSummaryOnce({ timeoutMs }) {
  return new Promise((resolve) => {
    const cmd = process.execPath;
    const args = ["./src/autonomous-daemon.mjs", "--all-good-summary"];
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve({ ok: false, error: "all_good_timeout", stdout, stderr });
    }, Math.max(500, Number(timeoutMs ?? 15000)));

    child.on("close", (code) => {
      clearTimeout(timer);
      const line = lastJsonLine(stdout) ?? lastJsonLine(stderr);
      const parsed = line ? safeJsonParse(line, null) : null;
      if (parsed && typeof parsed === "object") {
        resolve({ ok: true, exitCode: code, result: parsed });
        return;
      }
      resolve({
        ok: false,
        exitCode: code,
        error: "all_good_no_json",
        stdout: stdout.slice(-2000),
        stderr: stderr.slice(-2000)
      });
    });
  });
}

function shouldWriteToBase44() {
  return (process.env.BASE44_ENABLE_PAYPAL_WEBHOOK_WRITE ?? "false").toLowerCase() === "true";
}

function shouldWriteRevenueFromPayPal() {
  return (process.env.BASE44_ENABLE_REVENUE_FROM_PAYPAL ?? "false").toLowerCase() === "true";
}

function shouldWritePayoutStatusFromPayPal() {
  return (process.env.BASE44_ENABLE_PAYPAL_PAYOUT_STATUS_WRITE ?? "false").toLowerCase() === "true";
}

function shouldWritePayoutLedger() {
  return (process.env.BASE44_ENABLE_PAYOUT_LEDGER_WRITE ?? "false").toLowerCase() === "true";
}

function shouldAlertOnWebhookErrors() {
  return (process.env.BASE44_ENABLE_ALERTS_ON_WEBHOOK_ERRORS ?? "false").toLowerCase() === "true";
}

function shouldAlertOnPayoutFailures() {
  return (process.env.BASE44_ENABLE_ALERTS_ON_PAYOUT_FAILURES ?? "false").toLowerCase() === "true";
}

function getAlertCooldownMs() {
  const ms = Number(process.env.ALERT_COOLDOWN_MS ?? "900000");
  if (!ms || Number.isNaN(ms) || ms < 1000) return 900000;
  return ms;
}

function getWebhookId() {
  const v = process.env.PAYPAL_WEBHOOK_ID;
  if (!v) throw new Error("Missing required env var: PAYPAL_WEBHOOK_ID");
  return v;
}

function getEntityConfig() {
  return {
    eventEntity: process.env.BASE44_PAYPAL_EVENT_ENTITY ?? "PayPalWebhookEvent",
    fieldMap: {
      eventType: process.env.BASE44_PAYPAL_FIELD_EVENT_TYPE ?? "event_type",
      eventId: process.env.BASE44_PAYPAL_FIELD_EVENT_ID ?? "event_id",
      createdAt: process.env.BASE44_PAYPAL_FIELD_CREATED_AT ?? "created_at",
      summary: process.env.BASE44_PAYPAL_FIELD_SUMMARY ?? "summary",
      payload: process.env.BASE44_PAYPAL_FIELD_PAYLOAD ?? "payload"
    }
  };
}

function shouldWriteMetricsToBase44() {
  return (process.env.BASE44_ENABLE_PAYPAL_METRICS ?? "false").toLowerCase() === "true";
}

function validateConfig() {
  getWebhookId();
  getEnvOrThrow("PAYPAL_CLIENT_ID");
  getEnvOrThrow("PAYPAL_CLIENT_SECRET");

  const wantWriteEvent = shouldWriteToBase44();
  const wantWriteRevenue = shouldWriteRevenueFromPayPal();
  const wantWritePayoutStatus = shouldWritePayoutStatusFromPayPal();
  const wantWriteMetrics = shouldWriteMetricsToBase44();
  const wantAlerts = shouldAlertOnWebhookErrors();
  const wantPayoutFailureAlerts = shouldAlertOnPayoutFailures();

  if (wantWriteEvent || wantWriteRevenue || wantWriteMetrics || wantWritePayoutStatus) {
    requireLiveMode("webhook write flags enabled");
    getEnvOrThrow("BASE44_APP_ID");
    getEnvOrThrow("BASE44_SERVICE_TOKEN");
  }

  if (wantWritePayoutStatus && !shouldWritePayoutLedger()) {
    throw new Error("Refusing payout status writes without BASE44_ENABLE_PAYOUT_LEDGER_WRITE=true");
  }

  if (wantAlerts || wantPayoutFailureAlerts) {
    getEnvOrThrow("BASE44_APP_ID");
    getEnvOrThrow("BASE44_SERVICE_TOKEN");
  }
}

function getConfigCheck() {
  const missing = [];
  const have = (name) => {
    const v = process.env[name];
    return v != null && String(v).trim() !== "" && !isPlaceholderValue(v);
  };

  if (!have("PAYPAL_WEBHOOK_ID")) missing.push("PAYPAL_WEBHOOK_ID");
  if (!have("PAYPAL_CLIENT_ID")) missing.push("PAYPAL_CLIENT_ID");
  if (!have("PAYPAL_CLIENT_SECRET")) missing.push("PAYPAL_CLIENT_SECRET");

  const wantWriteEvent = shouldWriteToBase44();
  const wantWriteRevenue = shouldWriteRevenueFromPayPal();
  const wantWritePayoutStatus = shouldWritePayoutStatusFromPayPal();
  const wantWriteMetrics = shouldWriteMetricsToBase44();
  const wantAlerts = shouldAlertOnWebhookErrors() || shouldAlertOnPayoutFailures();
  const anyWrites = wantWriteEvent || wantWriteRevenue || wantWriteMetrics || wantWritePayoutStatus;

  if (anyWrites && String(process.env.SWARM_LIVE ?? "false").toLowerCase() !== "true") missing.push("SWARM_LIVE");
  if ((anyWrites || wantAlerts) && (!have("BASE44_APP_ID") || !have("BASE44_SERVICE_TOKEN"))) missing.push("BASE44_APP_ID/BASE44_SERVICE_TOKEN");
  if (wantWritePayoutStatus && !shouldWritePayoutLedger()) missing.push("BASE44_ENABLE_PAYOUT_LEDGER_WRITE");

  return {
    ok: missing.length === 0,
    missing,
    flags: {
      SWARM_LIVE: String(process.env.SWARM_LIVE ?? "false").toLowerCase() === "true",
      BASE44_ENABLE_PAYPAL_WEBHOOK_WRITE: wantWriteEvent,
      BASE44_ENABLE_REVENUE_FROM_PAYPAL: wantWriteRevenue,
      BASE44_ENABLE_PAYPAL_PAYOUT_STATUS_WRITE: wantWritePayoutStatus,
      BASE44_ENABLE_PAYPAL_METRICS: wantWriteMetrics,
      BASE44_ENABLE_ALERTS_ON_WEBHOOK_ERRORS: shouldAlertOnWebhookErrors(),
      BASE44_ENABLE_ALERTS_ON_PAYOUT_FAILURES: shouldAlertOnPayoutFailures()
    }
  };
}

function getMetricsConfig() {
  return {
    entity: process.env.BASE44_PAYPAL_METRIC_ENTITY ?? "PayPalMetric",
    fieldMap: {
      at: process.env.BASE44_PAYPAL_METRIC_FIELD_AT ?? "at",
      kind: process.env.BASE44_PAYPAL_METRIC_FIELD_KIND ?? "kind",
      ok: process.env.BASE44_PAYPAL_METRIC_FIELD_OK ?? "ok",
      summary: process.env.BASE44_PAYPAL_METRIC_FIELD_SUMMARY ?? "summary"
    }
  };
}

function buildSummary(evt, extra = null) {
  const type = evt?.event_type ?? "";
  const id = evt?.id ?? "";
  const resourceType = evt?.resource_type ?? "";
  const resourceId = evt?.resource?.payout_batch_id ?? evt?.resource?.id ?? "";
  const base = { type, id, resourceType, resourceId };
  if (!extra || typeof extra !== "object") return base;
  return { ...base, ...extra };
}

function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function getPayoutBatchConfigFromEnv() {
  const entityName = process.env.BASE44_LEDGER_PAYOUT_BATCH_ENTITY ?? "PayoutBatch";
  const mapFromEnv = safeJsonParse(process.env.BASE44_LEDGER_PAYOUT_BATCH_FIELD_MAP, null);
  const fieldMap = mapFromEnv ?? {
    batchId: "batch_id",
    status: "status",
    completedAt: "completed_at",
    notes: "notes"
  };
  return { entityName, fieldMap };
}

function getPayoutItemConfigFromEnv() {
  const entityName = process.env.BASE44_LEDGER_PAYOUT_ITEM_ENTITY ?? "PayoutItem";
  const mapFromEnv = safeJsonParse(process.env.BASE44_LEDGER_PAYOUT_ITEM_FIELD_MAP, null);
  const fieldMap = mapFromEnv ?? {
    itemId: "item_id",
    batchId: "batch_id",
    recipient: "recipient",
    status: "status",
    revenueEventId: "revenue_event_id",
    amount: "amount",
    currency: "currency",
    processedAt: "processed_at",
    errorMessage: "error_message",
    paypalStatus: "paypal_status",
    paypalTransactionId: "paypal_transaction_id",
    paypalItemId: "paypal_item_id"
  };
  return { entityName, fieldMap };
}

function getTransactionLogConfigFromEnv() {
  const entityName = process.env.BASE44_LEDGER_TRANSACTION_LOG_ENTITY ?? "TransactionLog";
  const mapFromEnv = safeJsonParse(process.env.BASE44_LEDGER_TRANSACTION_LOG_FIELD_MAP, null);
  const fieldMap = mapFromEnv ?? {
    transactionType: "transaction_type",
    amount: "amount",
    description: "description",
    transactionDate: "transaction_date",
    category: "category",
    paymentMethod: "payment_method",
    referenceId: "reference_id",
    status: "status",
    payoutBatchId: "payout_batch_id",
    payoutItemId: "payout_item_id"
  };
  return { entityName, fieldMap };
}

async function findOneBy(entity, filter) {
  const existing = await entity.filter(filter, "-created_date", 1, 0);
  if (Array.isArray(existing) && existing[0]) return existing[0];
  return null;
}

async function listAll(entity, { fields = null, pageSize = 250, order = "-created_date", max = 2500 } = {}) {
  const out = [];
  const limit = Math.max(1, Math.floor(Number(pageSize)));
  const cap = Math.max(limit, Math.floor(Number(max)));
  let offset = 0;
  while (out.length < cap) {
    const page = await entity.list(order, limit, offset, fields ?? undefined);
    if (!Array.isArray(page) || page.length === 0) break;
    out.push(...page);
    offset += page.length;
    if (page.length < limit) break;
  }
  return out.slice(0, cap);
}

async function findPayoutBatchByPayPalBatchId(base44, paypalBatchId) {
  if (!paypalBatchId) return null;
  const payoutBatchCfg = getPayoutBatchConfigFromEnv();
  const batchEntity = base44.asServiceRole.entities[payoutBatchCfg.entityName];
  const fields = ["id", payoutBatchCfg.fieldMap.batchId, payoutBatchCfg.fieldMap.notes, payoutBatchCfg.fieldMap.status].filter(Boolean);
  const batches = await listAll(batchEntity, { fields, pageSize: 250, max: 5000 });
  for (const b of batches) {
    const notes = payoutBatchCfg.fieldMap.notes ? b?.[payoutBatchCfg.fieldMap.notes] : null;
    const pid = notes?.paypal_payout_batch_id ?? notes?.paypalPayoutBatchId ?? null;
    if (pid && String(pid) === String(paypalBatchId)) return b;
  }
  return null;
}

function mapPayPalWebhookToPayoutItemUpdate(evt) {
  const type = String(evt?.event_type ?? "").trim();
  const upper = type.toUpperCase();
  if (!upper.includes("PAYOUTS") || !upper.includes("ITEM")) return null;

  const resource = evt?.resource ?? {};
  const paypalItemId =
    resource?.payout_item_id ??
    resource?.payout_item?.payout_item_id ??
    resource?.payout_item?.payout_item_id ??
    null;
  if (!paypalItemId) return null;

  const paypalBatchId = resource?.payout_batch_id ?? resource?.payout_item?.payout_batch_id ?? null;
  const paypalTxnId = resource?.transaction_id ?? resource?.payout_item?.transaction_id ?? null;
  const paypalStatus = resource?.transaction_status ?? resource?.payout_item?.transaction_status ?? null;
  const processedAt = resource?.time_processed ?? resource?.time_completed ?? evt?.create_time ?? new Date().toISOString();

  let status = null;
  if (upper.includes("SUCCEEDED") || upper.includes("SUCCESS")) status = "success";
  else if (upper.includes("FAILED")) status = "failed";
  else if (upper.includes("REFUNDED")) status = "refunded";
  else if (upper.includes("UNCLAIMED")) status = "unclaimed";

  const errorMessage = resource?.errors ? truncate(JSON.stringify(resource.errors), 500) : null;

  return {
    paypalItemId: String(paypalItemId),
    paypalBatchId: paypalBatchId != null ? String(paypalBatchId) : null,
    paypalTxnId: paypalTxnId != null ? String(paypalTxnId) : null,
    paypalStatus: paypalStatus != null ? String(paypalStatus) : null,
    processedAt: String(processedAt),
    status,
    errorMessage,
    webhookEventId: evt?.id != null ? String(evt.id) : null,
    webhookEventType: type || null
  };
}

function mapPayPalWebhookToPayoutBatchUpdate(evt) {
  const type = String(evt?.event_type ?? "").trim();
  const upper = type.toUpperCase();
  if (!upper.includes("PAYOUTS") || !upper.includes("BATCH")) return null;

  const resource = evt?.resource ?? {};
  const batchId =
    resource?.batch_header?.payout_batch_id ??
    resource?.payout_batch_id ??
    resource?.payout_batch_id ??
    null;
  if (!batchId) return null;

  const batchStatus =
    resource?.batch_header?.batch_status ??
    resource?.batch_status ??
    null;

  const processedAt =
    resource?.batch_header?.time_completed ??
    resource?.batch_header?.time_created ??
    evt?.create_time ??
    new Date().toISOString();

  let ledgerStatus = null;
  if (upper.includes("SUCCESS") || upper.includes("SUCCEEDED")) ledgerStatus = "completed";
  else if (upper.includes("FAILED") || upper.includes("DENIED") || upper.includes("CANCELED") || upper.includes("CANCELLED")) ledgerStatus = "failed";
  else if (upper.includes("PROCESSING") || upper.includes("PENDING")) ledgerStatus = "processing";

  return {
    paypalBatchId: String(batchId),
    paypalBatchStatus: batchStatus != null ? String(batchStatus) : null,
    processedAt: String(processedAt),
    ledgerStatus,
    webhookEventId: evt?.id != null ? String(evt.id) : null,
    webhookEventType: type || null
  };
}

function isFinalItemStatus(status) {
  return status === "success" || status === "failed" || status === "refunded" || status === "unclaimed" || status === "cancelled";
}

function normalizeLedgerStatus(value) {
  const v = String(value ?? "").trim().toLowerCase();
  return v || null;
}

const ALLOWED_ITEM_STATUS_TRANSITIONS = {
  pending: ["processing", "success", "failed", "unclaimed", "refunded", "cancelled"],
  processing: ["success", "failed", "unclaimed", "refunded", "cancelled"],
  unclaimed: ["refunded", "cancelled"],
  success: [],
  failed: [],
  refunded: [],
  cancelled: []
};

function isValidItemStatusTransition(from, to) {
  const f = normalizeLedgerStatus(from);
  const t = normalizeLedgerStatus(to);
  if (!t) return false;
  if (!f) return true;
  if (f === t) return true;
  const allowed = ALLOWED_ITEM_STATUS_TRANSITIONS[f];
  return Array.isArray(allowed) ? allowed.includes(t) : false;
}

const ALLOWED_BATCH_STATUS_TRANSITIONS = {
  processing: ["completed", "failed"],
  completed: [],
  failed: []
};

function isValidBatchStatusTransition(from, to) {
  const f = normalizeLedgerStatus(from);
  const t = normalizeLedgerStatus(to);
  if (!t) return false;
  if (!f) return true;
  if (f === t) return true;
  const allowed = ALLOWED_BATCH_STATUS_TRANSITIONS[f];
  return Array.isArray(allowed) ? allowed.includes(t) : false;
}

async function applyPayoutBatchUpdate(base44, update) {
  const payoutBatchCfg = getPayoutBatchConfigFromEnv();
  const batchEntity = base44.asServiceRole.entities[payoutBatchCfg.entityName];

  const batch = await findPayoutBatchByPayPalBatchId(base44, update.paypalBatchId);
  if (!batch?.id) return { ok: false, updated: false, reason: "payout_batch_not_found" };

  if (update.ledgerStatus && payoutBatchCfg.fieldMap.status) {
    const currentStatus = batch?.[payoutBatchCfg.fieldMap.status] ?? null;
    if (!isValidBatchStatusTransition(currentStatus, update.ledgerStatus)) {
      return {
        ok: true,
        updated: false,
        reason: "invalid_batch_state_transition",
        from: currentStatus,
        to: update.ledgerStatus,
        paypalBatchId: update.paypalBatchId
      };
    }
  }

  const existingNotes = payoutBatchCfg.fieldMap.notes ? (batch?.[payoutBatchCfg.fieldMap.notes] ?? {}) : null;
  const mergedNotes =
    existingNotes && typeof existingNotes === "object" && !Array.isArray(existingNotes)
      ? {
          ...existingNotes,
          paypal_payout_batch_id: update.paypalBatchId,
          ...(update.paypalBatchStatus != null ? { paypal_batch_status: update.paypalBatchStatus } : {}),
          paypal_synced_at: new Date().toISOString(),
          paypal_webhook_last_event_id: update.webhookEventId ?? null,
          paypal_webhook_last_event_type: update.webhookEventType ?? null
        }
      : {
          paypal_payout_batch_id: update.paypalBatchId,
          ...(update.paypalBatchStatus != null ? { paypal_batch_status: update.paypalBatchStatus } : {}),
          paypal_synced_at: new Date().toISOString(),
          paypal_webhook_last_event_id: update.webhookEventId ?? null,
          paypal_webhook_last_event_type: update.webhookEventType ?? null
        };

  const patch = {
    ...(payoutBatchCfg.fieldMap.notes ? { [payoutBatchCfg.fieldMap.notes]: mergedNotes } : {})
  };

  if (update.ledgerStatus && payoutBatchCfg.fieldMap.status) {
    patch[payoutBatchCfg.fieldMap.status] = update.ledgerStatus;
  }
  if (update.ledgerStatus === "completed" && payoutBatchCfg.fieldMap.completedAt) {
    patch[payoutBatchCfg.fieldMap.completedAt] = update.processedAt ?? new Date().toISOString();
  }

  const updated = await batchEntity.update(batch.id, patch);
  return { ok: true, updated: true, batchId: batch?.[payoutBatchCfg.fieldMap.batchId] ?? null, id: updated?.id ?? batch.id };
}

async function applyPayoutItemUpdate(base44, update) {
  const payoutItemCfg = getPayoutItemConfigFromEnv();
  const payoutBatchCfg = getPayoutBatchConfigFromEnv();
  const txCfg = getTransactionLogConfigFromEnv();
  const revenueCfg = getRevenueConfigFromEnv();

  const itemEntity = base44.asServiceRole.entities[payoutItemCfg.entityName];
  const batchEntity = base44.asServiceRole.entities[payoutBatchCfg.entityName];
  const txEntity = base44.asServiceRole.entities[txCfg.entityName];
  const revenueEntity = base44.asServiceRole.entities[revenueCfg.entityName];

  const item = await findOneBy(itemEntity, { [payoutItemCfg.fieldMap.paypalItemId]: update.paypalItemId });
  if (!item?.id) return { ok: false, updated: false, reason: "payout_item_not_found" };

  if (update.status && payoutItemCfg.fieldMap.status) {
    const current = item?.[payoutItemCfg.fieldMap.status] ?? null;
    if (!isValidItemStatusTransition(current, update.status)) {
      try {
        await txEntity.create({
          [txCfg.fieldMap.transactionType]: "STATE_TRANSITION_VIOLATION",
          [txCfg.fieldMap.amount]: 0,
          [txCfg.fieldMap.description]: `Invalid payout item state transition ${String(current)} -> ${String(update.status)} for PayPal item ${String(
            update.paypalItemId
          )}`,
          [txCfg.fieldMap.transactionDate]: new Date().toISOString(),
          [txCfg.fieldMap.category]: "incident",
          [txCfg.fieldMap.paymentMethod]: "paypal",
          [txCfg.fieldMap.referenceId]: update.webhookEventId ?? null,
          [txCfg.fieldMap.status]: "rejected",
          ...(txCfg.fieldMap.payoutItemId && payoutItemCfg.fieldMap.itemId
            ? { [txCfg.fieldMap.payoutItemId]: item?.[payoutItemCfg.fieldMap.itemId] ?? null }
            : {})
        });
      } catch {}
      return {
        ok: true,
        updated: false,
        reason: "invalid_item_state_transition",
        from: current,
        to: update.status,
        paypalItemId: update.paypalItemId
      };
    }
  }

  const patch = {
    ...(payoutItemCfg.fieldMap.processedAt ? { [payoutItemCfg.fieldMap.processedAt]: update.processedAt } : {}),
    ...(payoutItemCfg.fieldMap.paypalStatus ? { [payoutItemCfg.fieldMap.paypalStatus]: update.paypalStatus } : {}),
    ...(payoutItemCfg.fieldMap.paypalTransactionId
      ? { [payoutItemCfg.fieldMap.paypalTransactionId]: update.paypalTxnId }
      : {}),
    ...(payoutItemCfg.fieldMap.errorMessage && update.errorMessage
      ? { [payoutItemCfg.fieldMap.errorMessage]: update.errorMessage }
      : {})
  };
  if (update.status && payoutItemCfg.fieldMap.status) patch[payoutItemCfg.fieldMap.status] = update.status;

  const updatedItem = await itemEntity.update(item.id, patch);

  const revenueEventId = payoutItemCfg.fieldMap.revenueEventId ? item?.[payoutItemCfg.fieldMap.revenueEventId] : null;
  const batchId = payoutItemCfg.fieldMap.batchId ? item?.[payoutItemCfg.fieldMap.batchId] : null;

  if (batchId && payoutBatchCfg.fieldMap.notes) {
    const batch = await findOneBy(batchEntity, { [payoutBatchCfg.fieldMap.batchId]: batchId }).catch(() => null);
    if (batch?.id) {
      const existingNotes = batch?.[payoutBatchCfg.fieldMap.notes] ?? {};
      const mergedNotes =
        existingNotes && typeof existingNotes === "object" && !Array.isArray(existingNotes)
          ? {
              ...existingNotes,
              ...(update.paypalBatchId && !existingNotes?.paypal_payout_batch_id && !existingNotes?.paypalPayoutBatchId
                ? { paypal_payout_batch_id: update.paypalBatchId }
                : {}),
              paypal_synced_at: new Date().toISOString(),
              paypal_webhook_last_event_id: update.webhookEventId ?? null,
              paypal_webhook_last_event_type: update.webhookEventType ?? null
            }
          : {
              ...(update.paypalBatchId ? { paypal_payout_batch_id: update.paypalBatchId } : {}),
              paypal_synced_at: new Date().toISOString(),
              paypal_webhook_last_event_id: update.webhookEventId ?? null,
              paypal_webhook_last_event_type: update.webhookEventType ?? null
            };
      await batchEntity.update(batch.id, { [payoutBatchCfg.fieldMap.notes]: mergedNotes }).catch(() => null);
    }
  }

  let revenueUpdated = false;
  if (update.status === "success" && revenueEventId && revenueCfg.fieldMap.status && update.paypalTxnId) {
    const revPatch = { [revenueCfg.fieldMap.status]: "paid_out" };
    if (revenueCfg.fieldMap.payoutBatchId && batchId) revPatch[revenueCfg.fieldMap.payoutBatchId] = batchId;
    await revenueEntity.update(revenueEventId, revPatch).catch(() => null);
    revenueUpdated = true;
  }

  let txCreatedId = null;
  let txDeduped = false;
  if (update.status === "success" && txCfg.fieldMap.amount && txCfg.fieldMap.transactionDate) {
    if (txCfg.fieldMap.referenceId && update.paypalTxnId) {
      const existing = await findOneBy(txEntity, {
        [txCfg.fieldMap.referenceId]: String(update.paypalTxnId),
        [txCfg.fieldMap.transactionType]: "withdrawal"
      }).catch(() => null);
      if (existing?.id) {
        txCreatedId = existing.id;
        txDeduped = true;
      }
    }

    if (!txDeduped) {
      const amount = Number(payoutItemCfg.fieldMap.amount ? item?.[payoutItemCfg.fieldMap.amount] : 0);
      const created = await txEntity.create({
        [txCfg.fieldMap.transactionType]: "withdrawal",
        [txCfg.fieldMap.amount]: Number.isFinite(amount) ? Number(amount.toFixed(2)) : null,
        [txCfg.fieldMap.description]: `Payout to ${String(item?.[payoutItemCfg.fieldMap.recipient] ?? "")} for ${String(revenueEventId ?? "")}`,
        [txCfg.fieldMap.transactionDate]: update.processedAt,
        [txCfg.fieldMap.category]: "withdrawal",
        [txCfg.fieldMap.paymentMethod]: "paypal",
        [txCfg.fieldMap.referenceId]: update.paypalTxnId,
        [txCfg.fieldMap.status]: "completed",
        ...(txCfg.fieldMap.payoutBatchId && batchId ? { [txCfg.fieldMap.payoutBatchId]: batchId } : {}),
        ...(txCfg.fieldMap.payoutItemId && payoutItemCfg.fieldMap.itemId
          ? { [txCfg.fieldMap.payoutItemId]: item?.[payoutItemCfg.fieldMap.itemId] ?? null }
          : {})
      });
      txCreatedId = created?.id ?? null;
    }
  }

  let batchCompleted = false;
  let batchFailed = false;
  let batchStatusWriteSkippedReason = null;
  if (batchId) {
    const items = await itemEntity.filter({ [payoutItemCfg.fieldMap.batchId]: batchId }, "-created_date", 500, 0);
    const allFinal = Array.isArray(items) && items.length > 0
      ? items.every((it) => isFinalItemStatus(it?.[payoutItemCfg.fieldMap.status] ?? null))
      : false;
    const allSuccess = Array.isArray(items) && items.length > 0
      ? items.every((it) => (it?.[payoutItemCfg.fieldMap.status] ?? null) === "success")
      : false;
    if (allFinal && payoutBatchCfg.fieldMap.status) {
      const batch = await findOneBy(batchEntity, { [payoutBatchCfg.fieldMap.batchId]: batchId });
      if (batch?.id) {
        const notes = payoutBatchCfg.fieldMap.notes ? batch?.[payoutBatchCfg.fieldMap.notes] : null;
        const providerId = notes?.paypal_payout_batch_id ?? notes?.paypalPayoutBatchId ?? update.paypalBatchId ?? null;
        if (!providerId) {
          batchStatusWriteSkippedReason = "missing_paypal_payout_batch_id";
          if (payoutBatchCfg.fieldMap.notes) {
            const now = new Date().toISOString();
            const existingNotes = notes && typeof notes === "object" && !Array.isArray(notes) ? notes : {};
            const ledgerStatus = payoutBatchCfg.fieldMap.status ? batch?.[payoutBatchCfg.fieldMap.status] : null;
            const mergedNotes = {
              ...existingNotes,
              truth_enforced_at: now,
              truth_enforced_reason: "missing_paypal_payout_batch_id",
              truth_enforced_previous_status: ledgerStatus
            };
            await batchEntity.update(batch.id, { [payoutBatchCfg.fieldMap.notes]: mergedNotes }).catch(() => null);
          }
        } else {
          const completedAt = new Date().toISOString();
          await batchEntity.update(batch.id, {
            [payoutBatchCfg.fieldMap.status]: allSuccess ? "completed" : "failed",
            ...(payoutBatchCfg.fieldMap.completedAt ? { [payoutBatchCfg.fieldMap.completedAt]: completedAt } : {})
          });
          batchCompleted = allSuccess;
          batchFailed = !allSuccess;
        }
      }
    }
  }

  return {
    ok: true,
    updated: true,
    payoutItemId: updatedItem?.id ?? item.id,
    payoutItemStatus: update.status,
    revenueUpdated,
    txCreatedId,
    txDeduped,
    batchCompleted,
    batchFailed,
    batchStatusWriteSkippedReason
  };
}

function truncate(value, maxLen) {
  const s = value == null ? "" : String(value);
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}…`;
}

function getWebhookDedupeTtlMs() {
  const ms = Number(process.env.WEBHOOK_DEDUPE_TTL_MS ?? "1800000");
  if (!ms || Number.isNaN(ms) || ms < 1000) return 1800000;
  return ms;
}

function getWebhookDedupeMaxEntries() {
  const n = Number(process.env.WEBHOOK_DEDUPE_MAX_ENTRIES ?? "5000");
  if (!n || Number.isNaN(n) || n < 10) return 5000;
  return Math.floor(n);
}

function getWebhookDedupeStorePath() {
  const v = process.env.WEBHOOK_DEDUPE_STORE_PATH ?? "";
  const trimmed = String(v).trim();
  return trimmed ? trimmed : null;
}

function getWebhookDedupeFlushIntervalMs() {
  const ms = Number(process.env.WEBHOOK_DEDUPE_FLUSH_MS ?? "5000");
  if (!ms || Number.isNaN(ms) || ms < 250) return 5000;
  return Math.floor(ms);
}

function buildEventData(cfg, evt) {
  const map = cfg.fieldMap;
  const summary = buildSummary(evt);
  return {
    [map.eventType]: evt?.event_type ?? null,
    [map.eventId]: evt?.id ?? null,
    [map.createdAt]: evt?.create_time ?? new Date().toISOString(),
    [map.summary]: summary,
    [map.payload]: evt
  };
}

async function writeEventToBase44(base44, cfg, evt) {
  const data = buildEventData(cfg, evt);
  const entity = base44.asServiceRole.entities[cfg.eventEntity];
  return entity.create(data);
}

async function writeEventToBase44Idempotent(base44, cfg, evt) {
  const eventId = evt?.id ?? null;
  const entity = base44.asServiceRole.entities[cfg.eventEntity];
  const data = buildEventData(cfg, evt);

  if (!eventId) return entity.create(data);

  const existing = await entity.filter({ [cfg.fieldMap.eventId]: eventId }, "-created_date", 1, 0);
  if (Array.isArray(existing) && existing[0]?.id) return { id: existing[0].id, deduped: true };

  try {
    return await entity.create(data);
  } catch (err) {
    const raced = await entity
      .filter({ [cfg.fieldMap.eventId]: eventId }, "-created_date", 1, 0)
      .catch(() => null);
    if (Array.isArray(raced) && raced[0]?.id) return { id: raced[0].id, deduped: true };
    throw err;
  }
}

async function writeMetricToBase44(base44, evt, { kind, ok, summaryExtra = null }) {
  const cfg = getMetricsConfig();
  const map = cfg.fieldMap;
  const entity = base44.asServiceRole.entities[cfg.entity];
  const data = {
    [map.at]: new Date().toISOString(),
    [map.kind]: kind,
    [map.ok]: ok,
    [map.summary]: buildSummary(evt, summaryExtra)
  };
  return entity.create(data);
}

let lastWebhookAlertAt = 0;

const args = parseArgs(process.argv);
if (args.check === true || args["config-check"] === true) {
  const out = getConfigCheck();
  process.stdout.write(`${JSON.stringify({ ok: out.ok, config: out })}\n`);
  process.exitCode = out.ok ? 0 : 1;
} else {
  let startupConfigError = null;
  try {
    validateConfig();
  } catch (e) {
    startupConfigError = e?.message ?? String(e);
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        warning: "webhook_server_started_with_invalid_config",
        error: startupConfigError,
        config: getConfigCheck()
      })}\n`
    );
  }

  const dedupeStore = createDedupeStore({
    filePath: getWebhookDedupeStorePath(),
    ttlMs: getWebhookDedupeTtlMs(),
    maxEntries: getWebhookDedupeMaxEntries(),
    flushIntervalMs: getWebhookDedupeFlushIntervalMs()
  });
  await dedupeStore.load().catch(() => {});
  dedupeStore.start();

  function attachFlushOnSignals() {
    if (!dedupeStore.stats().enabled) return;
    const shutdown = async (code) => {
      try {
        await dedupeStore.flush();
      } catch {}
      process.exit(code);
    };
    process.once("SIGINT", () => shutdown(0));
    process.once("SIGTERM", () => shutdown(0));
  }

  if (isDirectExecution) attachFlushOnSignals();

  const handler = async (req, res) => {
    addSecurityHeaders(res);
    const secErr = validateRequest(req);
    if (secErr) {
      json(res, secErr.status, { ok: false, error: secErr.error });
      return;
    }

    const startMs = Date.now();
  try {
    const pathname = getPathname(req);

    if (pathname === "/health") {
      json(res, 200, {
        ok: true,
        live: getEnvBool("SWARM_LIVE", false),
        dedupe: dedupeStore.stats(),
        config: getConfigCheck(),
        startupConfigError
      });
      return;
    }

    if (pathname === "/all-good") {
      const validTokens = [process.env.BASE44_SERVICE_TOKEN, process.env.SWARM_SECRET_KEY].filter(Boolean);
      if (!validateAuth(req, validTokens)) {
        json(res, 401, { ok: false, error: "Unauthorized" });
        return;
      }
      if (req.method !== "GET") {
        json(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }
      const timeoutMsRaw =
        process.env.WEBHOOK_ALL_GOOD_TIMEOUT_MS ??
        process.env.ALL_GOOD_TIMEOUT_MS ??
        process.env.AUTONOMOUS_ALL_GOOD_TIMEOUT_MS ??
        "45000";
      const timeoutMsNum = Number(timeoutMsRaw);
      const timeoutMs =
        Number.isFinite(timeoutMsNum) && timeoutMsNum >= 1000 && timeoutMsNum <= 120000 ? timeoutMsNum : 45000;
      const ran = await runAllGoodSummaryOnce({ timeoutMs });
      if (!ran.ok) {
        json(res, 503, { ok: false, error: ran.error ?? "all_good_failed", exitCode: ran.exitCode ?? null });
        return;
      }
      json(res, 200, { ok: true, exitCode: ran.exitCode ?? null, result: ran.result });
      return;
    }

    if (pathname === "/revenue/status") {
      const validTokens = [process.env.BASE44_SERVICE_TOKEN, process.env.SWARM_SECRET_KEY].filter(Boolean);
      if (!validateAuth(req, validTokens)) {
        json(res, 401, { ok: false, error: "Unauthorized" });
        return;
      }
      if (req.method !== "GET") {
        json(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }
      const timeoutMsRaw =
        process.env.WEBHOOK_ALL_GOOD_TIMEOUT_MS ??
        process.env.ALL_GOOD_TIMEOUT_MS ??
        process.env.AUTONOMOUS_ALL_GOOD_TIMEOUT_MS ??
        "45000";
      const timeoutMsNum = Number(timeoutMsRaw);
      const timeoutMs =
        Number.isFinite(timeoutMsNum) && timeoutMsNum >= 1000 && timeoutMsNum <= 120000 ? timeoutMsNum : 45000;
      const ran = await runAllGoodSummaryOnce({ timeoutMs });
      if (!ran.ok) {
        json(res, 503, { ok: false, error: ran.error ?? "revenue_status_failed", exitCode: ran.exitCode ?? null });
        return;
      }
      json(res, 200, { ok: true, at: new Date().toISOString(), result: ran.result });
      return;
    }

    if (pathname === "/revenue/live") {
      if (req.method !== "GET") {
        json(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }
      const page = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Revenue Status</title>
  <style>
    body { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; padding: 16px; }
    pre { white-space: pre-wrap; word-break: break-word; padding: 12px; background: #0b1020; color: #e6edf3; border-radius: 8px; }
    .ok { color: #2ea043; }
    .bad { color: #f85149; }
    a { color: #58a6ff; }
  </style>
</head>
<body>
  <h2>Swarm Revenue Status</h2>
  <div>Endpoint: <a href="/revenue/status">/revenue/status</a> | <a href="/all-good">/all-good</a> | <a href="/health">/health</a></div>
  <div id="meta"></div>
  <pre id="out">Loading…</pre>
  <script>
    async function tick() {
      const outEl = document.getElementById('out');
      const metaEl = document.getElementById('meta');
      try {
        const res = await fetch('/revenue/status', { cache: 'no-store' });
        const j = await res.json();
        const ok = !!j && j.ok === true;
        metaEl.innerHTML = 'Status: ' + (ok ? '<span class="ok">OK</span>' : '<span class="bad">NOT OK</span>') + ' | HTTP ' + res.status + ' | ' + new Date().toISOString();
        outEl.textContent = JSON.stringify(j, null, 2);
      } catch (e) {
        metaEl.innerHTML = 'Status: <span class="bad">ERROR</span> | ' + new Date().toISOString();
        outEl.textContent = String(e && e.message ? e.message : e);
      }
    }
    tick();
    setInterval(tick, 15000);
  </script>
</body>
</html>`;
      html(res, 200, page);
      return;
    }

    if (pathname === "/acp/health") {
      json(res, 200, { ok: true });
      return;
    }

    if (pathname === "/data/store-prices.json") {
      if (req.method !== "GET") {
        json(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }
      try {
        json(res, 200, storefrontPricePayload());
      } catch (error) {
        json(res, 503, { ok: false, error: error.message });
      }
      return;
    }

    if (pathname === "/buy") {
      if (req.method !== "GET") {
        json(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }
      html(res, 200, buyPage());
      return;
    }

    if (pathname === "/buy/success") {
      if (req.method !== "GET") {
        json(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }
      html(res, 200, buySuccessPage());
      return;
    }

    if (pathname === "/buy/cancel") {
      if (req.method !== "GET") {
        json(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }
      html(res, 200, buyCancelPage());
      return;
    }

    if (pathname.startsWith("/access/")) {
      if (req.method !== "GET") {
        json(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }
      const token = pathname.slice("/access/".length);
      try {
        const verified = verifyAccessToken(token, process.env.FULFILLMENT_ACCESS_SECRET || '');
        if (!verified.ok) {
          html(res, verified.reason === 'EXPIRED_TOKEN' ? 410 : 401, "<!doctype html><html><body style='font-family:system-ui;background:#0b0c10;color:#eaeef2;padding:40px'><h1>Access link unavailable</h1><p>This link is invalid or has expired. Email billing@realworldcerts.com for help.</p></body></html>");
          return;
        }
        const product = publicProducts().find((item) => String(item.id ?? '') === String(verified.productId ?? '')) || null;
        html(res, 200, accessPage({ orderId: verified.orderId, product }));
      } catch {
        html(res, 401, "<!doctype html><html><body style='font-family:system-ui;background:#0b0c10;color:#eaeef2;padding:40px'><h1>Access link unavailable</h1><p>Email billing@realworldcerts.com for help.</p></body></html>");
      }
      return;
    }

    if (pathname === "/acp/v1/discovery") {
      if (req.method !== "GET") {
        json(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }
      const products = publicProducts();
      json(res, 200, {
        ok: true,
        protocol: "ACP-1.0",
        merchant: {
          id: "swarm_owner",
          name: process.env.ACP_MERCHANT_NAME ?? "Autonomous Swarm Commerce",
          payment_methods: ["paypal_order"]
        },
        products: Array.isArray(products) ? products : [],
        endpoints: {
          checkout: "/buy",
          price_quote: "/acp/v1/price-quote?product_id=:id",
          initiate_transaction: "/acp/v1/transactions",
          capture_transaction: "/acp/v1/transactions/:id/capture",
          transaction_status: "/acp/v1/transactions/:id",
          health: "/acp/health"
        },
        compliance: { sbds: "1.0", direct_settlement: true, no_intermediaries: true }
      });
      return;
    }

    if (pathname === "/acp/v1/price-quote") {
      if (req.method !== "GET") {
        json(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }
      const searchParams = getSearchParams(req);
      const productId = searchParams.get("product_id");
      if (!productId) {
        json(res, 400, { ok: false, error: "product_id is required" });
        return;
      }
      const redirects = resolveCheckoutRedirects({
        returnUrl: searchParams.get("return_url"),
        cancelUrl: searchParams.get("cancel_url")
      });
      if (!redirects.ok) {
        json(res, 400, { ok: false, code: "CHECKOUT_REDIRECT_INVALID", error: redirects.reason });
        return;
      }
      let quoteKeys;
      try {
        quoteKeys = resolvePriceQuoteKeys();
      } catch (error) {
        json(res, 503, { ok: false, code: "PRICE_QUOTE_UNAVAILABLE", error: error?.message ?? String(error) });
        return;
      }
      if (!quoteKeys.current) {
        json(res, 503, { ok: false, code: "PRICE_QUOTE_UNAVAILABLE", error: "Price quoting is not configured (set PRICE_QUOTE_SECRET)" });
        return;
      }
      try {
        const catalog = loadCourseCatalog();
        const course = catalog.bySlug[String(productId)];
        if (!course) {
          json(res, 404, { ok: false, error: "Unknown product_id" });
          return;
        }
        const currency = normalizeCurrency(catalog.currency, String(process.env.PAYPAL_CURRENCY ?? "USD"));
        const quote = createPriceQuote({
          productId: course.slug,
          amountCents: course.price_cents,
          currency,
          catalogVersion: catalog.version,
          catalogDigest: catalog.digest,
          returnUrl: redirects.returnUrl,
          cancelUrl: redirects.cancelUrl,
          ttlSeconds: process.env.PRICE_QUOTE_TTL_SECONDS
        }, quoteKeys.current.secret, { keyId: quoteKeys.current.keyId });
        json(res, 200, {
          ok: true,
          protocol: "ACP-1.0",
          quote: quote.token,
          key_id: quote.key_id,
          quote_id: quote.quote_id,
          product_id: course.slug,
          amount: { value: (course.price_cents / 100).toFixed(2), currency },
          currency,
          catalog_version: String(catalog.version),
          catalog_digest: quote.catalog_digest,
          return_url: quote.return_url,
          cancel_url: quote.cancel_url,
          expires_at: quote.expires_at
        });
      } catch (error) {
        json(res, 503, { ok: false, code: "PRICE_QUOTE_UNAVAILABLE", error: error?.message ?? String(error) });
      }
      return;
    }

    if (pathname.startsWith("/acp/v1/transactions/") && pathname.endsWith("/capture")) {
      if (req.method !== "POST") {
        json(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }
      if (!shouldCreatePayPalOrders()) {
        json(res, 403, { ok: false, error: "Order capture disabled (set PAYPAL_ENABLE_ORDER_CREATE=true)" });
        return;
      }
      try {
        requireLiveMode("capture PayPal order");
      } catch (e) {
        json(res, 403, { ok: false, error: e?.message ?? String(e) });
        return;
      }
      const parts = pathname.split("/").filter(Boolean);
      const orderId = parts.length === 5 && parts[4] === "capture" ? parts[3] : null;
      if (!orderId) {
        json(res, 400, { ok: false, error: "Missing transaction id" });
        return;
      }
      try {
        let order;
        try {
          order = await capturePayPalCheckoutOrder(orderId);
        } catch (error) {
          if (!/ORDER_ALREADY_CAPTURED|ORDER_ALREADY_COMPLETED/.test(String(error?.message ?? error))) throw error;
          order = await getPayPalOrderDetails(orderId);
        }
        const units = Array.isArray(order?.purchase_units) ? order.purchase_units : [];
        const captures = units.flatMap((unit) => Array.isArray(unit?.payments?.captures) ? unit.payments.captures : []);
        const amount = captures[0]?.amount ?? units[0]?.amount ?? null;
        const custom = parsePayPalCustomId(units[0]?.custom_id);
        const invoice = parsePayPalInvoiceId(units[0]?.invoice_id);
        const productId = custom.productId;
        const product = productId ? publicProducts().find((item) => String(item.id ?? '') === productId) || null : null;
        const fulfill = shouldFulfillPaidOrders();
        let fulfillment = null;
        if (fulfill && String(order?.status || '').toUpperCase() === 'COMPLETED') {
          try {
            const result = await fulfillPaidOrder({ order, product });
            fulfillment = { ok: result.ok === true, delivery: result.delivery || null };
          } catch {
            fulfillment = { ok: false, delivery: null };
          }
        } else if (!fulfill) {
          fulfillment = { ok: true, delivery: 'disabled' };
        }
        json(res, 200, {
          ok: true,
          protocol: "ACP-1.0",
          transaction_id: order?.id ?? orderId,
          status: order?.status ?? null,
          amount: amount ? { value: amount.value ?? null, currency: amount.currency_code ?? amount.currency ?? null } : null,
          quote_id: custom.quoteId || invoice.quoteId || null,
          catalog_version: custom.catalogVersion || null,
          catalog_digest: invoice.catalogDigest || null,
          captures: captures.map((capture) => ({
            id: capture?.id ?? null,
            status: capture?.status ?? null,
            final_capture: capture?.final_capture ?? null
          })),
          fulfillment
        });
      } catch (e) {
        json(res, 502, { ok: false, error: e?.message ?? String(e) });
      }
      return;
    }

    if (pathname.startsWith("/acp/v1/transactions/")) {
      if (req.method !== "GET") {
        json(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }
      const parts = pathname.split("/").filter(Boolean);
      const id = parts.length > 0 ? parts[parts.length - 1] : null;
      if (!id) {
        json(res, 400, { ok: false, error: "Missing transaction id" });
        return;
      }
      try {
        requireLiveMode("get PayPal order");
      } catch (e) {
        json(res, 403, { ok: false, error: e?.message ?? String(e) });
        return;
      }
      try {
        const order = await getPayPalOrderDetails(id);
        const purchaseUnits = Array.isArray(order?.purchase_units)
          ? order.purchase_units.map((u) => {
              const captures = Array.isArray(u?.payments?.captures)
                ? u.payments.captures.map((c) => ({
                    id: c?.id ?? null,
                    status: c?.status ?? null,
                    amount: c?.amount ?? null,
                    final_capture: c?.final_capture ?? null,
                    create_time: c?.create_time ?? null,
                    update_time: c?.update_time ?? null
                  }))
                : [];
              return {
                reference_id: u?.reference_id ?? null,
                amount: u?.amount ?? null,
                payments: captures.length > 0 ? { captures } : null
              };
            })
          : [];
        json(res, 200, {
          ok: true,
          protocol: "ACP-1.0",
          transaction_id: order?.id ?? id,
          provider_status: order?.status ?? null,
          order: {
            id: order?.id ?? null,
            intent: order?.intent ?? null,
            status: order?.status ?? null,
            create_time: order?.create_time ?? null,
            update_time: order?.update_time ?? null,
            purchase_units: purchaseUnits
          }
        });
      } catch (e) {
        json(res, 502, { ok: false, error: e?.message ?? String(e) });
      }
      return;
    }

    if (pathname === "/acp/v1/transactions") {
      if (req.method !== "POST") {
        json(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }
      if (!shouldCreatePayPalOrders()) {
        json(res, 403, { ok: false, error: "Order creation disabled (set PAYPAL_ENABLE_ORDER_CREATE=true)" });
        return;
      }
      try {
        requireLiveMode("create PayPal order");
      } catch (e) {
        json(res, 403, { ok: false, error: e?.message ?? String(e) });
        return;
      }

      const rawBody = await readRawBody(req, { limitBytes: 200_000 });
      const body = safeJsonParse(rawBody, null);
      if (!body || typeof body !== "object") {
        json(res, 400, { ok: false, error: "Invalid JSON" });
        return;
      }

      const quoteToken = body.price_quote ?? body.priceQuote ?? body.quote ?? null;
      if (!quoteToken) {
        json(res, 400, {
          ok: false,
          code: "PRICE_QUOTE_REQUIRED",
          error: "A fresh price quote is required. Refresh checkout and try again."
        });
        return;
      }
      let quoteKeys;
      try {
        quoteKeys = resolvePriceQuoteKeys();
      } catch (error) {
        json(res, 503, { ok: false, code: "PRICE_QUOTE_UNAVAILABLE", error: error?.message ?? String(error) });
        return;
      }
      if (!quoteKeys.current) {
        json(res, 503, { ok: false, code: "PRICE_QUOTE_UNAVAILABLE", error: "Price quoting is not configured (set PRICE_QUOTE_SECRET)" });
        return;
      }
      const verifiedQuote = verifyPriceQuote(quoteToken, quoteKeys);
      if (!verifiedQuote.ok) {
        json(res, 409, {
          ok: false,
          code: "PRICE_CHANGED",
          error: "The price quote is invalid or expired. Refresh checkout and try again.",
          quote_error: verifiedQuote.reason
        });
        return;
      }
      const quote = verifiedQuote.quote;
      const productId = body.product_id ?? body.productId ?? quote.p;
      if (!productId) {
        json(res, 400, { ok: false, error: "product_id is required" });
        return;
      }
      let catalog;
      try {
        catalog = loadCourseCatalog();
      } catch (error) {
        json(res, 503, { ok: false, code: "PRICE_CATALOG_UNAVAILABLE", error: error?.message ?? String(error) });
        return;
      }
      const picked = catalog.bySlug[String(productId)];
      if (!picked) {
        json(res, 400, { ok: false, error: "Unknown product_id" });
        return;
      }
      const amount = Number(picked.price_cents) / 100;
      if (!Number.isFinite(amount) || amount <= 0) {
        json(res, 400, { ok: false, error: "Product price is not configured" });
        return;
      }

      const currency = normalizeCurrency(catalog.currency, String(process.env.PAYPAL_CURRENCY ?? "USD"));
      const catalogVersion = String(catalog.version);
      const catalogDigest = String(catalog.digest);
      if (String(quote.p) !== String(picked.slug)
          || Number(quote.a) !== Number(picked.price_cents)
          || String(quote.c) !== currency
          || String(quote.cv) !== catalogVersion
          || String(quote.cd) !== catalogDigest) {
        json(res, 409, {
          ok: false,
          code: "PRICE_CHANGED",
          error: "The price quote no longer matches the catalog. Refresh checkout and try again.",
          product_id: String(picked.slug),
          expected: {
            value: amount.toFixed(2),
            currency,
            catalog_version: catalogVersion,
            catalog_digest: catalogDigest
          },
          quote: {
            value: (Number(quote.a) / 100).toFixed(2),
            currency: String(quote.c),
            catalog_version: String(quote.cv),
            catalog_digest: String(quote.cd)
          }
        });
        return;
      }
      const submittedAmountRaw = body.amount ?? body.total ?? body.price ?? null;
      const hasSubmittedAmount = submittedAmountRaw !== null && submittedAmountRaw !== undefined && submittedAmountRaw !== "";
      const submittedAmount = hasSubmittedAmount ? Number(submittedAmountRaw) : null;
      const submittedCurrencyRaw = body.currency ?? body.currency_code ?? null;
      const submittedCurrency = submittedCurrencyRaw
        ? String(submittedCurrencyRaw).trim().toUpperCase()
        : null;
      if (hasSubmittedAmount && (!Number.isFinite(submittedAmount) || submittedAmount <= 0)) {
        json(res, 400, { ok: false, error: "Invalid amount" });
        return;
      }
      if (submittedCurrency && submittedCurrency.length !== 3) {
        json(res, 400, { ok: false, error: "Invalid currency" });
        return;
      }
      const submittedCents = hasSubmittedAmount ? Math.round(submittedAmount * 100) : null;
      const expectedCents = Math.round(amount * 100);
      if ((submittedCents !== null && submittedCents !== expectedCents)
          || (submittedCurrency && submittedCurrency !== currency)) {
        json(res, 409, {
          ok: false,
          code: "PRICE_CHANGED",
          error: "The price changed. Refresh checkout and try again.",
          product_id: String(picked.slug),
          expected: { value: amount.toFixed(2), currency },
          submitted: {
            value: hasSubmittedAmount ? Number(submittedAmount).toFixed(2) : null,
            currency: submittedCurrency
          }
        });
        return;
      }
      if (!quote.ru || !quote.cu) {
        json(res, 409, {
          ok: false,
          code: "QUOTE_REDIRECT_REQUIRED",
          error: "The price quote does not bind return and cancel URLs. Refresh checkout and try again."
        });
        return;
      }
      const signedRedirects = resolveCheckoutRedirects({ returnUrl: quote.ru, cancelUrl: quote.cu });
      if (!signedRedirects.ok) {
        json(res, 409, {
          ok: false,
          code: "QUOTE_REDIRECT_MISMATCH",
          error: `The signed checkout redirect URLs are not allowed: ${signedRedirects.reason}`
        });
        return;
      }
      const submittedReturn = body.return_url ?? body.returnUrl ?? null;
      const submittedCancel = body.cancel_url ?? body.cancelUrl ?? null;
      let normalizedReturn = signedRedirects.returnUrl;
      let normalizedCancel = signedRedirects.cancelUrl;
      try {
        if (submittedReturn !== null) normalizedReturn = normalizeQuoteRedirectUrl(submittedReturn);
        if (submittedCancel !== null) normalizedCancel = normalizeQuoteRedirectUrl(submittedCancel);
      } catch (error) {
        json(res, 409, {
          ok: false,
          code: "QUOTE_REDIRECT_MISMATCH",
          error: `The checkout redirect URL is invalid: ${error.message}`
        });
        return;
      }
      if (normalizedReturn !== signedRedirects.returnUrl || normalizedCancel !== signedRedirects.cancelUrl) {
        json(res, 409, {
          ok: false,
          code: "QUOTE_REDIRECT_MISMATCH",
          error: "The checkout redirect URLs do not match the signed price quote. Refresh checkout and try again."
        });
        return;
      }
      const returnUrl = signedRedirects.returnUrl;
      const cancelUrl = signedRedirects.cancelUrl;
      const description = String(picked.title || "").trim() || null;
      const customId = String(body.reference ?? body.custom_id ?? body.customId ?? `acp_${Date.now()}`).slice(0, 120);

      const requestId = checkoutAttemptKey(quote.qid);
      let order;
      try {
        ({ order } = await checkoutAttempts.run(
          quote.qid,
          () => createPayPalCheckoutOrder({
            amount,
            currency,
            description,
            customId,
            productId: picked.slug,
            quoteId: quote.qid,
            catalogVersion,
            catalogDigest,
            returnUrl,
            cancelUrl,
            requestId
          }),
          { expiresAt: verifiedQuote.expires_at }
        ));
      } catch (error) {
        // Another instance is still creating this quote's order and has not
        // published it yet. This request created nothing, so the page can retry
        // the same call; it must not fall through to an order of its own.
        if (error?.code !== "CHECKOUT_ATTEMPT_IN_PROGRESS") throw error;
        const retryAfterMs = Number(error.retryAfterMs) > 0 ? Number(error.retryAfterMs) : 2000;
        res.setHeader("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
        json(res, 409, {
          ok: false,
          code: "CHECKOUT_IN_PROGRESS",
          retryable: true,
          retry_after_ms: retryAfterMs,
          error: "Another checkout is already creating this order for this quote. Retry the same request shortly.",
          quote_id: quote.qid,
          request_id: requestId
        });
        return;
      }
      const approvalUrl = pickApprovalUrl(order);
      json(res, 200, {
        ok: true,
        status: "pending",
        protocol: "ACP-1.0",
        transaction_id: order?.id ?? null,
        amount: { value: amount.toFixed(2), currency },
        quote_id: quote.qid,
        catalog_version: catalogVersion,
        catalog_digest: catalogDigest,
        payment_instructions: {
          method: "paypal_order",
          approval_url: approvalUrl,
          custom_id: customId,
          quote_id: quote.qid,
          catalog_version: catalogVersion,
          catalog_digest: catalogDigest
        },
        order: { id: order?.id ?? null, status: order?.status ?? null }
      });
      return;
    }

    if (pathname === "/x402/payment-request") {
      if (req.method !== "POST") {
        json(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }
      const rawBody = await readRawBody(req, { limitBytes: 200_000 });
      const body = safeJsonParse(rawBody, null);
      if (!body || typeof body !== "object") {
        json(res, 400, { ok: false, error: "Invalid JSON" });
        return;
      }
      const amountRaw = body.amount ?? body.total ?? null;
      const amount = Number(amountRaw);
      if (!amount || Number.isNaN(amount) || amount <= 0) {
        json(res, 400, { ok: false, error: "Invalid amount" });
        return;
      }
      const currency = normalizeCurrency(body.currency, String(process.env.PAYPAL_CURRENCY ?? "USD"));
      const returnUrl = String(body.return_url ?? body.returnUrl ?? process.env.PAYPAL_RETURN_URL ?? "").trim();
      const cancelUrl = String(body.cancel_url ?? body.cancelUrl ?? process.env.PAYPAL_CANCEL_URL ?? "").trim();
      const customId = String(body.reference ?? body.custom_id ?? `x402_${Date.now()}`).slice(0, 120);
      const ownerBank = OwnerSettlementEnforcer.getOwnerAccountForType("bank");
      const ownerPayPal = OwnerSettlementEnforcer.getOwnerAccountForType("paypal");
      const ownerCrypto = process.env.TRUST_WALLET_ADDRESS ?? OwnerSettlementEnforcer.getOwnerAccountForType("crypto");
      let paypalOption = null;
      if (shouldCreatePayPalOrders() && returnUrl && cancelUrl) {
        try {
          requireLiveMode("create PayPal order");
          const order = await createPayPalCheckoutOrder({ amount, currency, description: body.description ?? null, customId, returnUrl, cancelUrl });
          const approvalUrl = pickApprovalUrl(order);
          paypalOption = {
            method: "paypal_order",
            approval_url: approvalUrl,
            custom_id: customId,
            transaction_id: order?.id ?? null
          };
        } catch {}
      }
      const bankOption = {
        method: "bank_transfer",
        destination: ownerBank,
        sepa: {
          iban: process.env.IBAN_BC ?? null,
          bic: process.env.BIC_BC ?? null,
          beneficiary: process.env.BENEFICIARY_NAME_BC ?? null
        },
        swift: {
          bank_name: process.env.BANK_NAME_CITI ?? null,
          routing_number: process.env.ROUTING_NUMBER_CITI ?? null,
          account_number: process.env.ACCOUNT_NUMBER_CITI ?? null,
          beneficiary: process.env.BENEFICIARY_NAME_BARCLAYS ?? null
        }
      };
      const cryptoOption = {
        method: "crypto",
        network: String(process.env.CRYPTO_NETWORK ?? "ERC20"),
        address: ownerCrypto
      };
      const payment_options = [
        ...(paypalOption ? [paypalOption] : []),
        bankOption,
        cryptoOption
      ];
      json(res, 200, {
        ok: true,
        status: "pending",
        protocol: "X402-compat",
        amount: { value: amount.toFixed(2), currency },
        payment_options
      });
      return;
    }

    if (pathname.startsWith("/x402/payment-status/")) {
      if (req.method !== "GET") {
        json(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }
      const parts = pathname.split("/").filter(Boolean);
      const id = parts.length > 0 ? parts[parts.length - 1] : null;
      if (!id) {
        json(res, 400, { ok: false, error: "Missing transaction id" });
        return;
      }
      try {
        requireLiveMode("get PayPal order");
      } catch (e) {
        json(res, 403, { ok: false, error: e?.message ?? String(e) });
        return;
      }
      try {
        const order = await getPayPalOrderDetails(id);
        const purchaseUnits = Array.isArray(order?.purchase_units)
          ? order.purchase_units.map((u) => {
              const captures = Array.isArray(u?.payments?.captures)
                ? u.payments.captures.map((c) => ({
                    id: c?.id ?? null,
                    status: c?.status ?? null,
                    amount: c?.amount ?? null,
                    final_capture: c?.final_capture ?? null,
                    create_time: c?.create_time ?? null,
                    update_time: c?.update_time ?? null
                  }))
                : [];
              return {
                reference_id: u?.reference_id ?? null,
                amount: u?.amount ?? null,
                payments: captures.length > 0 ? { captures } : null
              };
            })
          : [];
        json(res, 200, {
          ok: true,
          protocol: "X402-compat",
          transaction_id: order?.id ?? id,
          provider_status: order?.status ?? null,
          order: {
            id: order?.id ?? null,
            intent: order?.intent ?? null,
            status: order?.status ?? null,
            create_time: order?.create_time ?? null,
            update_time: order?.update_time ?? null,
            purchase_units: purchaseUnits
          }
        });
      } catch (e) {
        json(res, 502, { ok: false, error: e?.message ?? String(e) });
      }
      return;
    }

    if (pathname === "/rails/payment-request") {
      if (req.method !== "POST") {
        json(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }
      const rawBody = await readRawBody(req, { limitBytes: 200_000 });
      const body = safeJsonParse(rawBody, null);
      if (!body || typeof body !== "object") {
        json(res, 400, { ok: false, error: "Invalid JSON" });
        return;
      }
      const amountRaw = body.amount ?? body.total ?? null;
      const amount = Number(amountRaw);
      if (!amount || Number.isNaN(amount) || amount <= 0) {
        json(res, 400, { ok: false, error: "Invalid amount" });
        return;
      }
      const currency = normalizeCurrency(body.currency, String(process.env.PAYPAL_CURRENCY ?? "USD"));
      const returnUrl = String(body.return_url ?? body.returnUrl ?? process.env.PAYPAL_RETURN_URL ?? "").trim();
      const cancelUrl = String(body.cancel_url ?? body.cancelUrl ?? process.env.PAYPAL_CANCEL_URL ?? "").trim();
      const customId = String(body.reference ?? body.custom_id ?? `rails_${Date.now()}`).slice(0, 120);
      const ownerBank = OwnerSettlementEnforcer.getOwnerAccountForType("bank");
      const ownerPayPal = OwnerSettlementEnforcer.getOwnerAccountForType("paypal");
      const ownerCrypto = process.env.TRUST_WALLET_ADDRESS ?? OwnerSettlementEnforcer.getOwnerAccountForType("crypto");
      let paypalOption = null;
      if (shouldCreatePayPalOrders() && returnUrl && cancelUrl) {
        try {
          requireLiveMode("create PayPal order");
          const order = await createPayPalCheckoutOrder({ amount, currency, description: body.description ?? null, customId, returnUrl, cancelUrl });
          const approvalUrl = pickApprovalUrl(order);
          paypalOption = {
            method: "paypal_order",
            approval_url: approvalUrl,
            custom_id: customId,
            transaction_id: order?.id ?? null,
            destination: ownerPayPal
          };
        } catch {}
      }
      const achOption = {
        method: "ach",
        bank_name: process.env.BANK_NAME_CITI ?? null,
        routing_number: process.env.ROUTING_NUMBER_CITI ?? null,
        account_number: process.env.ACCOUNT_NUMBER_CITI ?? null,
        beneficiary: process.env.BENEFICIARY_NAME_BARCLAYS ?? null,
        destination: ownerBank
      };
      const sepaOption = {
        method: "sepa",
        iban: process.env.IBAN_BC ?? null,
        bic: process.env.BIC_BC ?? null,
        beneficiary: process.env.BENEFICIARY_NAME_BC ?? null,
        destination: process.env.IBAN_BC ?? ownerBank
      };
      const fedwireOption = {
        method: "fedwire",
        bank_name: process.env.BANK_NAME_CITI ?? null,
        routing_number: process.env.ROUTING_NUMBER_CITI ?? null,
        account_number: process.env.ACCOUNT_NUMBER_CITI ?? null,
        swift_code: process.env.SWIFT_CODE_CITI ?? null,
        destination: ownerBank
      };
      const swiftOption = {
        method: "swift",
        swift_code: process.env.SWIFT_CODE_CITI ?? null,
        beneficiary: process.env.BENEFICIARY_NAME_BARCLAYS ?? null,
        account_number: process.env.ACCOUNT_NUMBER_BARCLAYS ?? null,
        destination: ownerBank
      };
      const chipsOption = {
        method: "chips",
        chips_id: process.env.CHIPS_ID ?? null,
        destination: ownerBank
      };
      const fpsOption = {
        method: "faster_payments",
        sort_code: process.env.SORT_CODE_BARCLAYS ?? null,
        account_number: process.env.ACCOUNT_NUMBER_BARCLAYS ?? null,
        beneficiary: process.env.BENEFICIARY_NAME_BARCLAYS ?? null,
        destination: ownerBank
      };
      const stripeOption = {
        method: "stripe",
        publishable_key: process.env.STRIPE_PUBLISHABLE_KEY ?? null,
        requires_secret: !!process.env.STRIPE_SECRET_KEY,
        destination: ownerBank
      };
      const adyenOption = {
        method: "adyen",
        merchant_account: process.env.ADYEN_MERCHANT_ACCOUNT ?? null,
        destination: ownerBank
      };
      const openBankingOption = {
        method: "open_banking",
        region: process.env.OPEN_BANKING_REGION ?? null,
        accounts: [
          { iban: process.env.IBAN_BC ?? null, bic: process.env.BIC_BC ?? null, beneficiary: process.env.BENEFICIARY_NAME_BC ?? null }
        ],
        destination: process.env.IBAN_BC ?? ownerBank
      };
      const cryptoOption = {
        method: "crypto",
        network: String(process.env.CRYPTO_NETWORK ?? "ERC20"),
        address: ownerCrypto,
        destination: ownerCrypto
      };
      const payment_options = [
        ...(paypalOption ? [paypalOption] : []),
        achOption,
        sepaOption,
        fedwireOption,
        swiftOption,
        chipsOption,
        fpsOption,
        stripeOption,
        adyenOption,
        openBankingOption,
        cryptoOption
      ];
      json(res, 200, {
        ok: true,
        status: "pending",
        protocol: "Rails",
        amount: { value: amount.toFixed(2), currency },
        payment_options
      });
      return;
    }

    if (pathname.startsWith("/rails/payment-status/")) {
      if (req.method !== "GET") {
        json(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }
      const parts = pathname.split("/").filter(Boolean);
      const id = parts.length > 0 ? parts[parts.length - 1] : null;
      if (!id) {
        json(res, 400, { ok: false, error: "Missing transaction id" });
        return;
      }
      try {
        requireLiveMode("get PayPal order");
      } catch (e) {
        json(res, 403, { ok: false, error: e?.message ?? String(e) });
        return;
      }
      try {
        const order = await getPayPalOrderDetails(id);
        const purchaseUnits = Array.isArray(order?.purchase_units)
          ? order.purchase_units.map((u) => {
              const captures = Array.isArray(u?.payments?.captures)
                ? u.payments.captures.map((c) => ({
                    id: c?.id ?? null,
                    status: c?.status ?? null,
                    amount: c?.amount ?? null,
                    final_capture: c?.final_capture ?? null,
                    create_time: c?.create_time ?? null,
                    update_time: c?.update_time ?? null
                  }))
                : [];
              return {
                reference_id: u?.reference_id ?? null,
                amount: u?.amount ?? null,
                payments: captures.length > 0 ? { captures } : null
              };
            })
          : [];
        json(res, 200, {
          ok: true,
          protocol: "Rails",
          transaction_id: order?.id ?? id,
          provider_status: order?.status ?? null,
          order: {
            id: order?.id ?? null,
            intent: order?.intent ?? null,
            status: order?.status ?? null,
            create_time: order?.create_time ?? null,
            update_time: order?.update_time ?? null,
            purchase_units: purchaseUnits
          }
        });
      } catch (e) {
        json(res, 502, { ok: false, error: e?.message ?? String(e) });
      }
      return;
    }

    if (pathname === "/ilp/monetization") {
      if (req.method !== "GET") {
        json(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }
      json(res, 200, {
        ok: true,
        pointer: process.env.WM_PAYMENT_POINTER ?? null
      });
      return;
    }

    if (pathname !== "/paypal/webhook" && pathname !== "/api/webhooks/paypal") {
      json(res, 404, { ok: false, error: "Not found" });
      return;
    }

    if (req.method !== "POST") {
      json(res, 405, { ok: false, error: "Method not allowed" });
      return;
    }

    const config = getConfigCheck();
    if (!config.ok) {
      json(res, 503, { ok: false, error: "Webhook server not configured", config });
      return;
    }

    const rawBody = await readRawBody(req, { limitBytes: 1_000_000 });
    const headers = extractPayPalWebhookHeaders(req.headers);
    const evt = safeJsonParse(rawBody, null);
    if (!evt) {
      json(res, 400, { ok: false, error: "Invalid JSON webhook body" });
      return;
    }

    const webhookId = getWebhookId();
    const verification = await verifyPayPalWebhookSignature({ webhookId, headers, rawBody, webhookEvent: evt });

    const status = verification?.verification_status ?? null;
    if (status !== "SUCCESS") {
      if (shouldWriteMetricsToBase44()) {
        try {
          const base44 = buildBase44ServiceClient();
          await writeMetricToBase44(base44, evt, {
            kind: "webhook_verify_failed",
            ok: false,
            summaryExtra: { verificationStatus: status }
          });
        } catch {}
      }

      if (shouldAlertOnWebhookErrors()) {
        const now = Date.now();
        const cooldownMs = getAlertCooldownMs();
        if (now - lastWebhookAlertAt >= cooldownMs) {
          lastWebhookAlertAt = now;
          try {
            const base44 = buildBase44ServiceClient();
            await maybeSendAlert(base44, {
              subject: "PayPal Webhook Verification Failed",
              body: JSON.stringify(
                {
                  at: new Date().toISOString(),
                  verification_status: status,
                  summary: buildSummary(evt)
                },
                null,
                2
              )
            });
          } catch {}
        }
      }

      json(res, 401, {
        ok: false,
        verified: false,
        verification_status: status,
        processingMs: Date.now() - startMs,
        summary: buildSummary(evt)
      });
      return;
    }

    const dedupeKey =
      evt?.id ??
      headers?.transmissionId ??
      crypto.createHash("sha256").update(String(rawBody)).digest("hex");
    if (dedupeStore.isRecentlyDone(dedupeKey)) {
      json(res, 200, {
        ok: true,
        verified: true,
        deduped: true,
        dedupe: dedupeStore.stats(),
        processingMs: Date.now() - startMs,
        summary: buildSummary(evt)
      });
      return;
    }

    const revenueCfg = getRevenueConfigFromEnv();
    const revenueEvent = mapPayPalWebhookToRevenueEvent(evt, {
      defaultCurrency: revenueCfg.defaultCurrency
    });

    const wantWriteEvent = shouldWriteToBase44();
    const wantMetrics = shouldWriteMetricsToBase44();
    const wantRevenueWrite = shouldWriteRevenueFromPayPal() && !!revenueEvent;
    const payoutUpdate = mapPayPalWebhookToPayoutItemUpdate(evt);
    const wantPayoutStatusWrite = shouldWritePayoutStatusFromPayPal() && !!payoutUpdate;
    const payoutBatchUpdate = mapPayPalWebhookToPayoutBatchUpdate(evt);
    const wantPayoutBatchWrite = shouldWritePayoutStatusFromPayPal() && !!payoutBatchUpdate;
    const base44 = wantWriteEvent || wantMetrics || wantRevenueWrite || wantPayoutStatusWrite || wantPayoutBatchWrite ? buildBase44ServiceClient() : null;

    if (wantMetrics && base44) {
      await writeMetricToBase44(base44, evt, {
        kind: "webhook_verified",
        ok: true,
        summaryExtra: { verificationStatus: status }
      });
    }

    let created = null;
    if (wantWriteEvent) {
      const cfg = getEntityConfig();
      created = await writeEventToBase44Idempotent(base44, cfg, evt);
    }

    let revenueCreatedId = null;
    let revenueDeduped = false;
    if (wantRevenueWrite) {
      if (wantMetrics && base44) {
        await writeMetricToBase44(base44, evt, { kind: "revenue_create_started", ok: true });
      }
      try {
        const createdRevenue = await createBase44RevenueEventIdempotent(base44, revenueCfg, revenueEvent, {
          dryRun: false
        });
        revenueCreatedId = createdRevenue?.id ?? null;
        revenueDeduped = createdRevenue?.deduped === true;
        if (wantMetrics && base44) {
          await writeMetricToBase44(base44, evt, {
            kind: revenueDeduped ? "revenue_create_deduped" : "revenue_create_succeeded",
            ok: true,
            summaryExtra: { revenueCreatedId }
          });
        }
      } catch (err) {
        if (wantMetrics && base44) {
          await writeMetricToBase44(base44, evt, {
            kind: "revenue_create_failed",
            ok: false,
            summaryExtra: { error: truncate(err?.message ?? String(err), 500) }
          });
        }

        if (shouldAlertOnWebhookErrors()) {
          const now = Date.now();
          const cooldownMs = getAlertCooldownMs();
          if (now - lastWebhookAlertAt >= cooldownMs) {
            lastWebhookAlertAt = now;
            try {
              const alertClient = base44 ?? buildBase44ServiceClient();
              await maybeSendAlert(alertClient, {
                subject: "Revenue Creation Failed",
                body: JSON.stringify(
                  {
                    at: new Date().toISOString(),
                    error: err?.message ?? String(err),
                    summary: buildSummary(evt)
                  },
                  null,
                  2
                )
              });
            } catch {}
          }
        }

        throw err;
      }
    }

    let payoutStatusResult = null;
    if (wantPayoutStatusWrite && base44) {
      if (wantMetrics) {
        await writeMetricToBase44(base44, evt, { kind: "payout_status_update_started", ok: true });
      }
      try {
        payoutStatusResult = await applyPayoutItemUpdate(base44, payoutUpdate);
        if (wantMetrics) {
          await writeMetricToBase44(base44, evt, {
            kind: payoutStatusResult?.updated ? "payout_status_update_succeeded" : "payout_status_update_skipped",
            ok: !!payoutStatusResult?.updated,
            summaryExtra: payoutStatusResult
          });
        }

        if (shouldAlertOnPayoutFailures() && (payoutUpdate?.status === "failed" || payoutUpdate?.status === "refunded" || payoutUpdate?.status === "unclaimed")) {
          const now = Date.now();
          const cooldownMs = getAlertCooldownMs();
          if (now - lastWebhookAlertAt >= cooldownMs) {
            lastWebhookAlertAt = now;
            try {
              const alertClient = base44 ?? buildBase44ServiceClient();
              await maybeSendAlert(alertClient, {
                subject: "Payout Item Failure",
                body: JSON.stringify(
                  {
                    at: new Date().toISOString(),
                    payout: payoutUpdate,
                    result: payoutStatusResult,
                    summary: buildSummary(evt)
                  },
                  null,
                  2
                )
              });
            } catch {}
          }
        }
      } catch (err) {
        if (wantMetrics) {
          await writeMetricToBase44(base44, evt, {
            kind: "payout_status_update_failed",
            ok: false,
            summaryExtra: { error: truncate(err?.message ?? String(err), 500) }
          });
        }
        throw err;
      }
    }

    let payoutBatchStatusResult = null;
    if (wantPayoutBatchWrite && base44) {
      if (wantMetrics) {
        await writeMetricToBase44(base44, evt, { kind: "payout_batch_status_update_started", ok: true });
      }
      try {
        payoutBatchStatusResult = await applyPayoutBatchUpdate(base44, payoutBatchUpdate);
        if (wantMetrics) {
          await writeMetricToBase44(base44, evt, {
            kind: payoutBatchStatusResult?.updated ? "payout_batch_status_update_succeeded" : "payout_batch_status_update_skipped",
            ok: !!payoutBatchStatusResult?.updated,
            summaryExtra: payoutBatchStatusResult
          });
        }
      } catch (err) {
        if (wantMetrics) {
          await writeMetricToBase44(base44, evt, {
            kind: "payout_batch_status_update_failed",
            ok: false,
            summaryExtra: { error: truncate(err?.message ?? String(err), 500) }
          });
        }
        throw err;
      }
    }

    dedupeStore.markDone(dedupeKey);
    json(res, 200, {
      ok: true,
      verified: true,
      stored: !!created,
      createdId: created?.id ?? null,
      revenueStored: wantRevenueWrite,
      revenueCreatedId,
      revenueDeduped,
      payoutStatusUpdated: payoutStatusResult?.updated === true,
      payoutStatusResult,
      payoutBatchStatusUpdated: payoutBatchStatusResult?.updated === true,
      payoutBatchStatusResult,
      eventDeduped: created?.deduped === true,
      dedupe: dedupeStore.stats(),
      processingMs: Date.now() - startMs,
      summary: buildSummary(evt, { revenueCandidate: revenueEvent ? true : false })
    });
  } catch (e) {
    if (shouldAlertOnWebhookErrors()) {
      const now = Date.now();
      const cooldownMs = getAlertCooldownMs();
      if (now - lastWebhookAlertAt >= cooldownMs) {
        lastWebhookAlertAt = now;
        try {
          const base44 = buildBase44ServiceClient();
          await maybeSendAlert(base44, {
            subject: "PayPal Webhook Error",
            body: JSON.stringify(
              {
                error: e?.message ?? String(e),
                at: new Date().toISOString()
              },
              null,
              2
            )
          });
        } catch {}
      }
    }
    json(res, 500, { ok: false, error: e?.message ?? String(e), processingMs: Date.now() - startMs });
  }
  };
  requestHandler = handler;

  if (isDirectExecution && !process.env.VERCEL) {
    const server = http.createServer(handler);
    const port = Number(process.env.PORT ?? "8787");
    server.listen(port, () => {
      const localUrl = `http://127.0.0.1:${port}/paypal/webhook`;
      const healthUrl = `http://127.0.0.1:${port}/health`;
      process.stdout.write(`${JSON.stringify({ ok: true, listening: true, port, path: "/paypal/webhook", localUrl, healthUrl })}\n`);
      const publicBase = (process.env.PUBLIC_BASE_URL ?? process.env.PUBLIC_WEBHOOK_BASE_URL ?? "").trim();
      if (publicBase) {
        const base = publicBase.replace(/\/+$/g, "");
        process.stdout.write(
          `${JSON.stringify({
            ok: true,
            publicBase: base,
            webhookUrl: `${base}/paypal/webhook`,
            healthUrl: `${base}/health`
          })}\n`
        );
      }
    });
  } else {
    process.stdout.write(`${JSON.stringify({ ok: true, embedded: true, path: "/paypal/webhook", healthUrl: "/health" })}\n`);
  }
}
