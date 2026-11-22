import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { startStub } from "./lib/http-stub.mjs";
import { runNode } from "./lib/run-node.mjs";

const SCRIPT = fileURLToPath(new URL("./payout-paypal-once.mjs", import.meta.url));
const OWNER_EMAIL = "younestsouli2019@gmail.com";

// Cleared on every run so an ambient PayPal/SWARM setting in the developer's
// shell can never turn a refusal test into a real request.
const CLEARED_ENV = [
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "PAYPAL_DISABLED",
  "PAYPAL_PPP2_APPROVED",
  "PAYPAL_PPP2_ENABLE_SEND",
  "PAYPAL_API_BASE_URL",
  "PAYPAL_MODE",
  "SWARM_LIVE",
  "NO_PLATFORM_WALLET",
];

function baseEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of CLEARED_ENV) delete env[key];
  return {
    ...env,
    // Never live, and a single attempt so a stub failure fails fast.
    SWARM_LIVE: "false",
    PAYPAL_HTTP_RETRY_ATTEMPTS: "1",
    ...extra,
  };
}

function args({ confirm = true, amount = "12.50", currency = "EUR", email = OWNER_EMAIL } = {}) {
  const out = ["--amount", amount, "--currency", currency, "--email", email];
  if (confirm) out.unshift("--confirm");
  return out;
}

// spawn (not spawnSync): the stub server lives in this process and needs the
// event loop while the script under test is running.
function runPayout(argv, env) {
  return runNode(SCRIPT, argv, env);
}

const CREDENTIALS = {
  PAYPAL_CLIENT_ID: "stub-client",
  PAYPAL_CLIENT_SECRET: "stub-secret",
};

const PPP2_ON = {
  PAYPAL_PPP2_APPROVED: "true",
  PAYPAL_PPP2_ENABLE_SEND: "true",
};

// Stub that accepts the batch and reports back the given batch status.
function stubReturningBatchStatus(status) {
  return startStub((hit) => {
    if (hit.url === "/v1/oauth2/token") {
      return { body: { access_token: "stub-token", expires_in: 3600 } };
    }
    if (hit.url === "/v1/payments/payouts") {
      return { body: { batch_header: { payout_batch_id: `BATCH-${status || "MISSING"}`, batch_status: status } } };
    }
    return null;
  });
}

describe("payout-paypal-once.mjs refusal paths", () => {
  it("refuses without --confirm and never touches the network", async () => {
    const stub = await startStub(() => null);
    try {
      const run = await runPayout(args({ confirm: false }), baseEnv({ PAYPAL_API_BASE_URL: stub.url }));
      assert.equal(run.code, 0, run.stderr);
      assert.equal(run.json?.ok, false);
      assert.equal(run.json?.result?.payout?.code, "CONFIRMATION_REQUIRED");
      assert.equal(run.json?.result?.payout?.no_funds_moved, true);
      assert.equal(stub.hits.length, 0);
    } finally {
      await stub.close();
    }
  });

  it("refuses when the PPP2 gates are off", async () => {
    const stub = await startStub(() => null);
    try {
      const run = await runPayout(
        args(),
        baseEnv({ ...CREDENTIALS, PAYPAL_API_BASE_URL: stub.url })
      );
      assert.equal(run.code, 0, run.stderr);
      assert.equal(run.json?.ok, false);
      assert.equal(run.json?.result?.payout?.code, "PAYPAL_PPP2_DISABLED");
      assert.equal(run.json?.result?.payout?.no_funds_moved, true);
      assert.equal(stub.hits.length, 0);
    } finally {
      await stub.close();
    }
  });

  it("refuses when only one of the two PPP2 gates is true", async () => {
    const stub = await startStub(() => null);
    try {
      const run = await runPayout(
        args(),
        baseEnv({
          ...CREDENTIALS,
          PAYPAL_API_BASE_URL: stub.url,
          PAYPAL_PPP2_APPROVED: "true",
          PAYPAL_PPP2_ENABLE_SEND: "false",
        })
      );
      assert.equal(run.json?.result?.payout?.code, "PAYPAL_PPP2_DISABLED");
      assert.equal(run.json?.result?.payout?.no_funds_moved, true);
      assert.equal(stub.hits.length, 0);
    } finally {
      await stub.close();
    }
  });

  it("reports missing credentials without claiming funds moved", async () => {
    const stub = await startStub(() => null);
    try {
      const run = await runPayout(args(), baseEnv({ PAYPAL_API_BASE_URL: stub.url }));
      assert.equal(run.code, 0, run.stderr);
      assert.equal(run.json?.ok, false);
      const { result } = run.json;
      assert.equal(result.fallback, "no_credentials");
      assert.equal(result.payout.status, "NOT_ATTEMPTED");
      // The no-credentials path must not be reported as a refusal that proves
      // nothing was sent, or the two messages get masked into one.
      assert.equal("no_funds_moved" in result.payout, false);
      assert.match(result.payout.error, /PAYPAL_CLIENT_ID/);
      assert.match(result.payout.error, /PAYPAL_CLIENT_SECRET/);
      assert.equal(stub.hits.length, 0);
    } finally {
      await stub.close();
    }
  });

  it("refuses a recipient outside the owner registry", async () => {
    const stub = await startStub(() => null);
    try {
      const run = await runPayout(
        args({ email: "attacker@example.com" }),
        baseEnv({ ...CREDENTIALS, ...PPP2_ON, PAYPAL_API_BASE_URL: stub.url })
      );
      assert.equal(run.code, 0, run.stderr);
      assert.equal(run.json?.ok, false);
      assert.equal(run.json?.result?.payout?.code, "RECIPIENT_NOT_ALLOWED");
      assert.equal(run.json?.result?.payout?.no_funds_moved, true);
      assert.match(run.json?.result?.payout?.error, /attacker@example\.com/);
      assert.equal(stub.hits.length, 0);
    } finally {
      await stub.close();
    }
  });

  it("refuses a batch PayPal reported as FAILED instead of calling it accepted", async () => {
    const stub = await stubReturningBatchStatus("FAILED");
    try {
      const run = await runPayout(
        args(),
        baseEnv({ ...CREDENTIALS, ...PPP2_ON, PAYPAL_API_BASE_URL: stub.url })
      );
      assert.equal(run.code, 0, run.stderr);
      assert.equal(run.json?.ok, false);
      assert.equal(run.json?.result?.payout?.code, "PAYPAL_BATCH_NOT_ACCEPTED");
      assert.match(run.json?.result?.payout?.error, /FAILED/);
      // FAILED does not prove nothing was sent, so no retry-inviting promise.
      assert.equal("no_funds_moved" in run.json.result.payout, false);
    } finally {
      await stub.close();
    }
  });

  it("accepts only PENDING, PROCESSING and SUCCESS batch statuses", async () => {
    for (const status of ["PENDING", "PROCESSING", "SUCCESS"]) {
      const stub = await stubReturningBatchStatus(status);
      try {
        const run = await runPayout(
          args(),
          baseEnv({ ...CREDENTIALS, ...PPP2_ON, PAYPAL_API_BASE_URL: stub.url })
        );
        assert.equal(run.code, 0, run.stderr);
        assert.equal(run.json?.ok, true, `${status} should be accepted`);
        assert.equal(run.json?.result?.payout?.status, "IN_TRANSIT");
        assert.equal(run.json?.result?.payout?.paypal_status, status);
      } finally {
        await stub.close();
      }
    }
  });

  it("refuses a non-live PayPal endpoint instead of paying out against it", async () => {
    const stub = await startStub(() => null);
    // Same stub port on a second loopback address: if the live guard ever
    // regresses the script fails to connect rather than reaching PayPal.
    const nonLiveUrl = `http://127.0.0.2:${new URL(stub.url).port}`;
    try {
      const run = await runPayout(
        args(),
        baseEnv({ ...CREDENTIALS, ...PPP2_ON, PAYPAL_API_BASE_URL: nonLiveUrl })
      );
      assert.equal(run.code, 0, run.stderr);
      assert.equal(run.json?.ok, false);
      assert.equal(run.json?.result?.payout?.code, "PAYPAL_NOT_LIVE");
      assert.equal(run.json?.result?.payout?.no_funds_moved, true);
      assert.match(run.json?.result?.payout?.error, /127\.0\.0\.2/);
      assert.equal(stub.hits.length, 0);
    } finally {
      await stub.close();
    }
  });

  it("refuses PAYPAL_MODE=sandbox even with a base URL set", async () => {
    const stub = await startStub(() => null);
    const nonLiveUrl = `http://127.0.0.2:${new URL(stub.url).port}`;
    try {
      const run = await runPayout(
        args(),
        baseEnv({ ...CREDENTIALS, ...PPP2_ON, PAYPAL_MODE: "sandbox", PAYPAL_API_BASE_URL: nonLiveUrl })
      );
      assert.equal(run.code, 0, run.stderr);
      assert.equal(run.json?.result?.payout?.code, "PAYPAL_NOT_LIVE");
      assert.equal(run.json?.result?.payout?.no_funds_moved, true);
      assert.match(run.json?.result?.payout?.error, /PAYPAL_MODE=sandbox/);
      assert.equal(stub.hits.length, 0);
    } finally {
      await stub.close();
    }
  });

  it("refuses a batch PayPal denied and reports no funds as moved", async () => {
    const stub = await startStub((hit) => {
      if (hit.url === "/v1/oauth2/token") {
        return { body: { access_token: "stub-token", expires_in: 3600 } };
      }
      if (hit.url === "/v1/payments/payouts") {
        return {
          body: {
            batch_header: { payout_batch_id: "BATCH-STUB-1", batch_status: "DENIED" },
          },
        };
      }
      return null;
    });
    try {
      const run = await runPayout(
        args(),
        baseEnv({ ...CREDENTIALS, ...PPP2_ON, PAYPAL_API_BASE_URL: stub.url })
      );
      assert.equal(run.code, 0, run.stderr);
      assert.equal(run.json?.ok, false);
      assert.equal(run.json?.result?.payout?.code, "PAYPAL_BATCH_NOT_ACCEPTED");
      assert.equal(run.json?.result?.payout?.no_funds_moved, true);
      assert.match(run.json?.result?.payout?.error, /DENIED/);

      const submission = stub.hits.find((hit) => hit.url === "/v1/payments/payouts");
      assert.ok(submission, "expected the script to submit a payout batch");
      assert.equal(submission.method, "POST");
      assert.equal(submission.headers.authorization, "Bearer stub-token");

      const submitted = JSON.parse(submission.body);
      assert.equal(submitted.items.length, 1);
      assert.equal(submitted.items[0].receiver, OWNER_EMAIL);
      assert.deepEqual(submitted.items[0].amount, { value: "12.50", currency: "EUR" });
      assert.ok(submitted.sender_batch_header.sender_batch_id);
    } finally {
      await stub.close();
    }
  });
});
