import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  clearPayPalTokenCache,
  getPayPalOrderDetails,
  verifyPayPalWebhookSignature
} from "../src/paypal-api.mjs";

beforeEach(() => {
  clearPayPalTokenCache();
});

test("verifyPayPalWebhookSignature uses webhookEvent without parsing rawBody", async () => {
  const prevFetch = globalThis.fetch;
  const prevClientId = process.env.PAYPAL_CLIENT_ID;
  const prevClientSecret = process.env.PAYPAL_CLIENT_SECRET;
  try {
    process.env.PAYPAL_CLIENT_ID = "id";
    process.env.PAYPAL_CLIENT_SECRET = "secret";

    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).includes("/v1/oauth2/token")) {
        assert.ok(options?.signal);
        return {
          ok: true,
          status: 200,
          headers: new Map([["content-type", "application/json"]]),
          json: async () => ({ access_token: "token" })
        };
      }

      if (String(url).includes("/v1/notifications/verify-webhook-signature")) {
        const parsed = JSON.parse(options.body);
        assert.deepEqual(parsed.webhook_event, { id: "evt" });
        return {
          ok: true,
          status: 200,
          headers: new Map([["content-type", "application/json"]]),
          json: async () => ({ verification_status: "SUCCESS" })
        };
      }

      throw new Error(`Unexpected url: ${url}`);
    };

    const out = await verifyPayPalWebhookSignature({
      webhookId: "wh_1",
      headers: {
        authAlgo: "algo",
        certUrl: "cert",
        transmissionId: "tid",
        transmissionSig: "sig",
        transmissionTime: "time"
      },
      rawBody: "{not json",
      webhookEvent: { id: "evt" }
    });

    assert.equal(out?.verification_status, "SUCCESS");
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevClientId == null) delete process.env.PAYPAL_CLIENT_ID;
    else process.env.PAYPAL_CLIENT_ID = prevClientId;
    if (prevClientSecret == null) delete process.env.PAYPAL_CLIENT_SECRET;
    else process.env.PAYPAL_CLIENT_SECRET = prevClientSecret;
  }
});

test("verifyPayPalWebhookSignature throws on invalid JSON when webhookEvent missing", async () => {
  const prevFetch = globalThis.fetch;
  const prevClientId = process.env.PAYPAL_CLIENT_ID;
  const prevClientSecret = process.env.PAYPAL_CLIENT_SECRET;
  try {
    process.env.PAYPAL_CLIENT_ID = "id";
    process.env.PAYPAL_CLIENT_SECRET = "secret";

    globalThis.fetch = async (url) => {
      if (String(url).includes("/v1/oauth2/token")) {
        return {
          ok: true,
          status: 200,
          headers: new Map([["content-type", "application/json"]]),
          json: async () => ({ access_token: "token" })
        };
      }
      throw new Error(`Unexpected url: ${url}`);
    };

    await assert.rejects(
      verifyPayPalWebhookSignature({
        webhookId: "wh_1",
        headers: {
          authAlgo: "algo",
          certUrl: "cert",
          transmissionId: "tid",
          transmissionSig: "sig",
          transmissionTime: "time"
        },
        rawBody: "{not json"
      }),
      /Invalid JSON webhook body/
    );
  } finally {
    globalThis.fetch = prevFetch;
    if (prevClientId == null) delete process.env.PAYPAL_CLIENT_ID;
    else process.env.PAYPAL_CLIENT_ID = prevClientId;
    if (prevClientSecret == null) delete process.env.PAYPAL_CLIENT_SECRET;
    else process.env.PAYPAL_CLIENT_SECRET = prevClientSecret;
  }
});

test("getPayPalOrderDetails fetches order details", async () => {
  const prevFetch = globalThis.fetch;
  const prevClientId = process.env.PAYPAL_CLIENT_ID;
  const prevClientSecret = process.env.PAYPAL_CLIENT_SECRET;
  try {
    process.env.PAYPAL_CLIENT_ID = "id";
    process.env.PAYPAL_CLIENT_SECRET = "secret";

    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).includes("/v1/oauth2/token")) {
        return {
          ok: true,
          status: 200,
          headers: new Map([["content-type", "application/json"]]),
          json: async () => ({ access_token: "token" })
        };
      }
      if (String(url).includes("/v2/checkout/orders/ORDER_1")) {
        return {
          ok: true,
          status: 200,
          headers: new Map([["content-type", "application/json"]]),
          json: async () => ({ id: "ORDER_1", status: "COMPLETED" })
        };
      }
      throw new Error(`Unexpected url: ${url}`);
    };

    const out = await getPayPalOrderDetails("ORDER_1");
    assert.equal(out?.id, "ORDER_1");
    assert.equal(out?.status, "COMPLETED");
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevClientId == null) delete process.env.PAYPAL_CLIENT_ID;
    else process.env.PAYPAL_CLIENT_ID = prevClientId;
    if (prevClientSecret == null) delete process.env.PAYPAL_CLIENT_SECRET;
    else process.env.PAYPAL_CLIENT_SECRET = prevClientSecret;
  }
});
