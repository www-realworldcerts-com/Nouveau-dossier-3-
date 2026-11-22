import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function runCheck(stdinPayload) {
  return spawnSync(process.execPath, ["./scripts/check-owner-payout-result.mjs"], {
    input: typeof stdinPayload === "string" ? stdinPayload : JSON.stringify(stdinPayload),
    encoding: "utf8",
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
