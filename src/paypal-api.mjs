import { CircuitBreaker } from "./swarm/circuit-breakers.mjs";

const PAYPAL_API_BASE =
  process.env.PAYPAL_API_BASE_URL || "https://api-m.paypal.com";

const globalCircuitBreaker = new CircuitBreaker(5, 60000);

// Access tokens are valid for hours; fetching one per request burns rate limit
// and invites 401 spikes. Cache per credential/base URL and refresh early.
const tokenCache = new Map();
const TOKEN_REFRESH_SAFETY_MS = 60000;

function tokenCacheKey(clientId) {
  return `${PAYPAL_API_BASE}|${clientId}`;
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

function getEnvOrThrow(name) {
  const v = process.env[name];
  if (v == null || String(v).trim() === "") throw new Error(`Missing required env var: ${name}`);
  if (isPlaceholderValue(v)) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function getHttpTimeoutMs() {
  const ms = Number(process.env.PAYPAL_HTTP_TIMEOUT_MS ?? "10000");
  if (!ms || Number.isNaN(ms) || ms < 1000) return 10000;
  return ms;
}

function base64BasicAuth(clientId, clientSecret) {
  const token = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

export async function getPayPalAccessToken({ forceRefresh = false } = {}) {
  const clientId = getEnvOrThrow("PAYPAL_CLIENT_ID");
  const clientSecret = getEnvOrThrow("PAYPAL_CLIENT_SECRET");
  const cacheKey = tokenCacheKey(clientId);
  const cached = tokenCache.get(cacheKey);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.token;
  const live = String(process.env.SWARM_LIVE ?? "false").toLowerCase() === "true";
  const paypalMode = String(process.env.PAYPAL_MODE ?? "live").toLowerCase();
  const paypalBase = String(process.env.PAYPAL_API_BASE_URL ?? "").toLowerCase();
  if (live && (paypalMode === "sandbox" || paypalBase.includes("sandbox.paypal.com"))) {
    throw new Error("LIVE MODE NOT GUARANTEED (PayPal sandbox configured)");
  }
  if (live && String(process.env.NO_PLATFORM_WALLET ?? "").toLowerCase() !== "true") {
    throw new Error("LIVE MODE NOT GUARANTEED (NO_PLATFORM_WALLET not true)");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getHttpTimeoutMs());
  let res;
  try {
    res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: base64BasicAuth(clientId, clientSecret),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials",
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PayPal token request failed (${res.status}): ${text}`);
  }

  const json = await res.json();
  if (!json?.access_token) throw new Error("PayPal token response missing access_token");
  const expiresInMs = Number(json.expires_in) > 0 ? Number(json.expires_in) * 1000 : 300000;
  tokenCache.set(cacheKey, {
    token: json.access_token,
    expiresAt: Date.now() + Math.max(0, expiresInMs - TOKEN_REFRESH_SAFETY_MS)
  });
  return json.access_token;
}

/** Drop a cached token (credential rotation, tests). */
export function clearPayPalTokenCache() {
  tokenCache.clear();
}

function paypalErrorMessage(status, method, path, text) {
  let name = null;
  let debugId = null;
  try {
    const parsed = JSON.parse(text);
    name = parsed?.name ?? null;
    debugId = parsed?.debug_id ?? null;
  } catch { /* non-JSON error body */ }
  const parts = [`PayPal request failed (${status}) ${method} ${path}`];
  if (name) parts.push(`[${name}]`);
  if (debugId) parts.push(`debug_id=${debugId}`);
  return `${parts.join(" ")}: ${text}`;
}

export async function paypalRequest(path, { method = "GET", token, headers, body } = {}) {
  return globalCircuitBreaker.call("paypal_api", async () => {
    const maxAttempts = Math.max(1, Math.floor(Number(process.env.PAYPAL_HTTP_RETRY_ATTEMPTS ?? "3")));
    const baseDelayMs = Math.max(50, Math.floor(Number(process.env.PAYPAL_HTTP_RETRY_BASE_DELAY_MS ?? "400")));
    const retryable = new Set([429, 500, 502, 503, 504]);

    let lastErr = null;
    let authRetried = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), getHttpTimeoutMs());
      let res;
      try {
        res = await fetch(`${PAYPAL_API_BASE}${path}`, {
          method,
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(body ? { "Content-Type": "application/json" } : {}),
            ...(headers ?? {})
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: controller.signal
        });
      } catch (e) {
        lastErr = e;
        if (attempt >= maxAttempts) throw e;
        const delayMs = Math.floor(baseDelayMs * 2 ** (attempt - 1) + Math.random() * 200);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      } finally {
        clearTimeout(timeout);
      }

      if (!res.ok) {
        const status = Number(res.status);
        const text = await res.text().catch(() => "");

        // A 401 usually means the cached token expired early. Refresh once and
        // repeat the request without consuming a normal retry.
        if (status === 401 && token && !authRetried) {
          authRetried = true;
          try {
            token = await getPayPalAccessToken({ forceRefresh: true });
            attempt -= 1;
            continue;
          } catch { /* fall through to the original error */ }
        }

        const err = new Error(paypalErrorMessage(status, method, path, text));
        lastErr = err;

        const retryAfter = res.headers.get("retry-after");
        const retryAfterMs = retryAfter && /^[0-9]+$/.test(String(retryAfter).trim()) ? Number(retryAfter) * 1000 : null;

        if (attempt < maxAttempts && retryable.has(status)) {
          const delayMs = retryAfterMs != null ? retryAfterMs : Math.floor(baseDelayMs * 2 ** (attempt - 1) + Math.random() * 200);
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        throw err;
      }

      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/json")) return res.json();
      return res.text();
    }

    throw lastErr ?? new Error(`PayPal request failed: ${method} ${path}`);
  });
}

export function extractPayPalWebhookHeaders(reqHeaders) {
  const headers = reqHeaders ?? {};
  const get = (name) => {
    const target = String(name).toLowerCase();
    for (const k of Object.keys(headers)) {
      if (String(k).toLowerCase() === target) return headers[k];
    }
    return null;
  };

  const transmissionId = get("paypal-transmission-id");
  const transmissionTime = get("paypal-transmission-time");
  const transmissionSig = get("paypal-transmission-sig");
  const certUrl = get("paypal-cert-url");
  const authAlgo = get("paypal-auth-algo");

  return { transmissionId, transmissionTime, transmissionSig, certUrl, authAlgo };
}

export async function verifyPayPalWebhookSignature({
  webhookId,
  headers,
  rawBody,
  webhookEvent
}) {
  const token = await getPayPalAccessToken();
  const evt = webhookEvent ?? (() => {
    try {
      return JSON.parse(rawBody);
    } catch {
      throw new Error("Invalid JSON webhook body");
    }
  })();
  const body = {
    auth_algo: headers.authAlgo,
    cert_url: headers.certUrl,
    transmission_id: headers.transmissionId,
    transmission_sig: headers.transmissionSig,
    transmission_time: headers.transmissionTime,
    webhook_id: webhookId,
    webhook_event: evt
  };

  const result = await paypalRequest("/v1/notifications/verify-webhook-signature", {
    method: "POST",
    token,
    body
  });

  return result;
}

export async function getPayoutBatchDetails(batchId) {
  const token = await getPayPalAccessToken();
  return paypalRequest(`/v1/payments/payouts/${encodeURIComponent(batchId)}`, { token });
}

export async function createPayPalPayoutBatch({ senderBatchId, items, emailSubject, emailMessage } = {}) {
  const token = await getPayPalAccessToken();
  const body = {
    sender_batch_header: {
      sender_batch_id: String(senderBatchId ?? ""),
      ...(emailSubject ? { email_subject: String(emailSubject) } : {}),
      ...(emailMessage ? { email_message: String(emailMessage) } : {})
    },
    items: Array.isArray(items) ? items : []
  };
  return paypalRequest("/v1/payments/payouts", { method: "POST", token, body });
}

export async function getPayPalOrderDetails(orderId) {
  const id = String(orderId ?? "").trim();
  if (!id) throw new Error("Missing PayPal order id");
  const token = await getPayPalAccessToken();
  return paypalRequest(`/v2/checkout/orders/${encodeURIComponent(id)}`, { token });
}

export async function searchTransactions({ startDate, endDate, transactionId, fields } = {}) {
  const token = await getPayPalAccessToken();
  const params = new URLSearchParams();
  // Default to last 30 days if not provided (required by API usually, but let's see)
  // Format: YYYY-MM-DDTHH:mm:ss.SSSZ
  if (!startDate) {
     const d = new Date();
     d.setDate(d.getDate() - 30);
     startDate = d.toISOString();
  }
  if (!endDate) {
     endDate = new Date().toISOString();
  }

  params.append('start_date', startDate);
  params.append('end_date', endDate);
  
  if (transactionId) params.append('transaction_id', transactionId);
  if (fields) params.append('fields', fields);

  return paypalRequest(`/v1/reporting/transactions?${params.toString()}`, { token });
}

export async function getPayPalBalance() {
  const token = await getPayPalAccessToken();
  // https://developer.paypal.com/docs/api/reporting/v1/#balances_get
  const result = await paypalRequest("/v1/reporting/balances?currency_code=USD", { token });
  return result;
}
