import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// The workflow exports the dispatch inputs to the step; clear them by default
// so each test states explicitly whether it is comparing against them.
const DISPATCH_INPUT_KEYS = ["INPUT_AMOUNT", "INPUT_CURRENCY", "INPUT_EMAIL"];

function runCheck(stdinPayload, dispatchInputs = {}) {
  const env = { ...process.env };
  for (const key of DISPATCH_INPUT_KEYS) delete env[key];
  return spawnSync(process.execPath, ["./scripts/check-owner-payout-result.mjs"], {
    input: typeof stdinPayload === "string" ? stdinPayload : JSON.stringify(stdinPayload),
    encoding: "utf8",
    env: { ...env, ...dispatchInputs },
  });
}

describe("check-owner-payout-result.mjs", () => {
  it("exits 0 when payout is IN_TRANSIT with batchId", () => {
    const res = runCheck({
      ok: true,
      batchId: "BATCH_123",
      result: { payout: { status: "IN_TRANSIT" } },
    });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /PayPal accepted the payout batch/);
  });

  it("exits 0 when the submission matches the dispatch inputs", () => {
    const res = runCheck(
      {
        ok: true,
        batchId: "BATCH_123",
        result: {
          payout: {
            status: "IN_TRANSIT",
            amount: "12.50",
            currency: "EUR",
            recipient: "younestsouli2019@gmail.com",
          },
        },
      },
      { INPUT_AMOUNT: "12.5", INPUT_CURRENCY: "eur", INPUT_EMAIL: "Younestsouli2019@Gmail.com" }
    );
    assert.equal(res.status, 0);
  });

  it("exits 1 when the submitted amount differs from the dispatch", () => {
    const res = runCheck(
      {
        ok: true,
        batchId: "BATCH_123",
        result: { payout: { status: "IN_TRANSIT", amount: "12.35", currency: "EUR", recipient: "younestsouli2019@gmail.com" } },
      },
      { INPUT_AMOUNT: "12.50", INPUT_CURRENCY: "EUR", INPUT_EMAIL: "younestsouli2019@gmail.com" }
    );
    assert.equal(res.status, 1);
    assert.match(res.stderr, /::error::Payout was submitted with amount "12\.35"/);
    assert.match(res.stderr, /asked for 12\.50/);
  });

  it("exits 1 when the submitted currency differs from the dispatch", () => {
    const res = runCheck(
      {
        ok: true,
        batchId: "BATCH_123",
        result: { payout: { status: "IN_TRANSIT", amount: "12.50", currency: "USD", recipient: "younestsouli2019@gmail.com" } },
      },
      { INPUT_AMOUNT: "12.50", INPUT_CURRENCY: "EUR", INPUT_EMAIL: "younestsouli2019@gmail.com" }
    );
    assert.equal(res.status, 1);
    assert.match(res.stderr, /currency "USD"/);
    assert.match(res.stderr, /asked for EUR/);
  });

  it("exits 1 when the submitted recipient differs from the dispatch", () => {
    const res = runCheck(
      {
        ok: true,
        batchId: "BATCH_123",
        result: { payout: { status: "IN_TRANSIT", amount: "12.50", currency: "EUR", recipient: "other@gmail.com" } },
      },
      { INPUT_AMOUNT: "12.50", INPUT_CURRENCY: "EUR", INPUT_EMAIL: "younestsouli2019@gmail.com" }
    );
    assert.equal(res.status, 1);
    assert.match(res.stderr, /recipient "other@gmail\.com"/);
  });

  it("exits 1 with unknown outcome warning on invalid JSON", () => {
    const res = runCheck("not-json");
    assert.equal(res.status, 1);
    assert.match(res.stderr, /::error::Invalid payout response/);
  });

  it("exits 1 with setup instructions when PAYPAL_PPP2_DISABLED", () => {
    const res = runCheck({
      ok: false,
      result: { payout: { no_funds_moved: true, code: "PAYPAL_PPP2_DISABLED" } },
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /PAYPAL_PPP2_APPROVED and PAYPAL_PPP2_ENABLE_SEND/);
  });

  it("exits 1 and points at the original batch on a duplicate sender_batch_id", () => {
    const res = runCheck({
      ok: false,
      result: {
        payout: {
          code: "DUPLICATE_SENDER_BATCH_ID",
          status: "DUPLICATE",
          no_funds_moved: true,
          error:
            "PayPal already has a payout batch for sender_batch_id owner-payout-x, so this dispatch sent nothing.",
        },
      },
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /already has a payout batch/);
    assert.match(res.stderr, /confirm-owner-payout\.mjs/);
  });

  it("exits 1 when credentials are missing", () => {
    const res = runCheck({
      ok: false,
      result: { fallback: "no_credentials" },
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /configure PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET/);
  });

  it("exits 1 when ok is true but batchId is missing", () => {
    const res = runCheck({
      ok: true,
      result: { payout: { status: "IN_TRANSIT" } },
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Payout was not confirmed as submitted/);
  });
});
