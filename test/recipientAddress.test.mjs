import test from "node:test";
import assert from "node:assert/strict";

import { createPayoutBatchesFromEarnings, resolveRecipientAddress } from "../src/emit-revenue-events.mjs";

test("resolveRecipientAddress resolves payoneer recipient from payoneer_id", () => {
  const recipient = resolveRecipientAddress("payoneer", { payoneer_id: "user@example.com" }, null);
  assert.equal(recipient, "user@example.com");
});

test("resolveRecipientAddress returns null when payoneer recipient missing", () => {
  const recipient = resolveRecipientAddress("payoneer", {}, "not-an-email");
  assert.equal(recipient, null);
});

test("payment routing optimization prefers bank wire when PayPal payouts disabled", async () => {
  const prevOptimize = process.env.AUTONOMOUS_OPTIMIZE_PAYMENT_ROUTING;
  const prevApproved = process.env.PAYPAL_PPP2_APPROVED;
  const prevEnable = process.env.PAYPAL_PPP2_ENABLE_SEND;
  try {
    process.env.AUTONOMOUS_OPTIMIZE_PAYMENT_ROUTING = "true";
    process.env.PAYPAL_PPP2_APPROVED = "false";
    process.env.PAYPAL_PPP2_ENABLE_SEND = "false";

    const base44 = {
      asServiceRole: {
        entities: {
          Earning: {
            list: async () => [
              {
                id: "1",
                earning_id: "E1",
                amount: 10,
                currency: "USD",
                occurred_at: "2025-01-01T00:00:00.000Z",
                beneficiary: "user@example.com",
                metadata: {
                  paypal_email: "user@example.com",
                  bank_wire_destination: { bank: "X", swift: "Y", account: "123", beneficiary: "User" }
                }
              }
            ]
          },
          RevenueEvent: { filter: async () => [] },
          PayoutBatch: { filter: async () => [] },
          PayoutItem: { filter: async () => [] }
        }
      }
    };

    const out = await createPayoutBatchesFromEarnings(base44, {
      settlementId: null,
      beneficiary: null,
      recipientType: null,
      fromIso: null,
      toIso: null,
      limit: 10,
      dryRun: true
    });

    assert.equal(out?.batches?.length, 1);
    assert.equal(out.batches[0].recipientType, "bank_wire");
  } finally {
    if (prevOptimize == null) delete process.env.AUTONOMOUS_OPTIMIZE_PAYMENT_ROUTING;
    else process.env.AUTONOMOUS_OPTIMIZE_PAYMENT_ROUTING = prevOptimize;
    if (prevApproved == null) delete process.env.PAYPAL_PPP2_APPROVED;
    else process.env.PAYPAL_PPP2_APPROVED = prevApproved;
    if (prevEnable == null) delete process.env.PAYPAL_PPP2_ENABLE_SEND;
    else process.env.PAYPAL_PPP2_ENABLE_SEND = prevEnable;
  }
});

test("createPayoutBatchesFromEarnings skips paypal batch when no owner sink is configured", async () => {
  const prev = process.env.AUTONOMOUS_ALLOWED_PAYPAL_RECIPIENTS;
  const ownerKeys = [
    "OWNER_PAYPAL_EMAIL",
    "OWNER_PAYONEER_ID",
    "OWNER_BANK_ACCOUNT",
    "OWNER_BANK_RIB",
    "BANK_ACCOUNT",
    "BANK_RIB",
    "BANK_IBAN"
  ];
  const prevOwner = Object.fromEntries(ownerKeys.map((key) => [key, process.env[key]]));
  try {
    process.env.AUTONOMOUS_ALLOWED_PAYPAL_RECIPIENTS = "owner@example.com";
    for (const key of ownerKeys) delete process.env[key];

    const base44 = {
      asServiceRole: {
        entities: {
          Earning: {
            list: async () => [
              {
                id: "1",
                earning_id: "E1",
                amount: 10,
                currency: "USD",
                occurred_at: "2025-01-01T00:00:00.000Z",
                beneficiary: "attacker@example.com",
                metadata: { paypal_email: "attacker@example.com" }
              }
            ]
          },
          RevenueEvent: { filter: async () => [] },
          PayoutBatch: { filter: async () => [] },
          PayoutItem: { filter: async () => [] }
        }
      }
    };

    const out = await createPayoutBatchesFromEarnings(base44, {
      settlementId: null,
      beneficiary: null,
      recipientType: "paypal",
      fromIso: null,
      toIso: null,
      limit: 10,
      dryRun: true
    });

    assert.equal(out?.batches?.length, 1);
    assert.equal(out.batches[0].skipped, true);
    assert.equal(out.batches[0].reason, "owner_sink_forbidden");
  } finally {
    if (prev == null) delete process.env.AUTONOMOUS_ALLOWED_PAYPAL_RECIPIENTS;
    else process.env.AUTONOMOUS_ALLOWED_PAYPAL_RECIPIENTS = prev;
    for (const key of ownerKeys) {
      if (prevOwner[key] == null) delete process.env[key];
      else process.env[key] = prevOwner[key];
    }
  }
});

test("createPayoutBatchesFromEarnings allows paypal batch when recipient in allowlist", async () => {
  const prev = process.env.AUTONOMOUS_ALLOWED_PAYPAL_RECIPIENTS;
  const prevOwner = process.env.OWNER_PAYPAL_EMAIL;
  try {
    process.env.AUTONOMOUS_ALLOWED_PAYPAL_RECIPIENTS = "owner@example.com";
    process.env.OWNER_PAYPAL_EMAIL = "owner@example.com";

    const base44 = {
      asServiceRole: {
        entities: {
          Earning: {
            list: async () => [
              {
                id: "1",
                earning_id: "E1",
                amount: 10,
                currency: "USD",
                occurred_at: "2025-01-01T00:00:00.000Z",
                beneficiary: "owner@example.com",
                metadata: { paypal_email: "owner@example.com" }
              }
            ]
          },
          RevenueEvent: { filter: async () => [] },
          PayoutBatch: { filter: async () => [] },
          PayoutItem: { filter: async () => [] }
        }
      }
    };

    const out = await createPayoutBatchesFromEarnings(base44, {
      settlementId: null,
      beneficiary: null,
      recipientType: "paypal",
      fromIso: null,
      toIso: null,
      limit: 10,
      dryRun: true
    });

    assert.equal(out?.batches?.length, 1);
    assert.equal(!!out.batches[0].skipped, false);
    assert.equal(out.batches[0].recipientType, "paypal");
  } finally {
    if (prev == null) delete process.env.AUTONOMOUS_ALLOWED_PAYPAL_RECIPIENTS;
    else process.env.AUTONOMOUS_ALLOWED_PAYPAL_RECIPIENTS = prev;
    if (prevOwner == null) delete process.env.OWNER_PAYPAL_EMAIL;
    else process.env.OWNER_PAYPAL_EMAIL = prevOwner;
  }
});
