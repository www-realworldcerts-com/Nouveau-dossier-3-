import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startStub } from "./lib/http-stub.mjs";
import { runNode } from "./lib/run-node.mjs";

const SCRIPT = fileURLToPath(new URL("./confirm-owner-payout.mjs", import.meta.url));

const CLEARED_ENV = [
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "PAYPAL_API_BASE_URL",
  "PAYPAL_MODE",
  "SWARM_LIVE",
  "NO_PLATFORM_WALLET",
];

function baseEnv(stubUrl, extra = {}) {
  const env = { ...process.env };
  for (const key of CLEARED_ENV) delete env[key];
  return {
    ...env,
    PAYPAL_CLIENT_ID: "stub-client",
    PAYPAL_CLIENT_SECRET: "stub-secret",
    PAYPAL_API_BASE_URL: stubUrl,
    PAYPAL_HTTP_RETRY_ATTEMPTS: "1",
    PAYPAL_HTTP_RETRY_BASE_DELAY_MS: "50",
    SWARM_LIVE: "false",
    ...extra,
  };
}

function batchBody(batchStatus, itemStatuses) {
  return {
    batch_header: { payout_batch_id: "BATCH-1", batch_status: batchStatus },
    items: itemStatuses.map((transactionStatus, index) => ({
      transaction_status: transactionStatus,
      transaction_id: `TX-${index}`,
      payout_item: {
        amount: { value: "12.50", currency: "EUR" },
        receiver: "younestsouli2019@gmail.com",
      },
    })),
  };
}

function runConfirm(argv, env) {
  return runNode(SCRIPT, argv, env);
}

describe("confirm-owner-payout.mjs", () => {
  it("confirms a batch whose only item settled", async () => {
    const stub = await startStub((hit) => {
      if (hit.url === "/v1/oauth2/token") return { body: { access_token: "stub-token", expires_in: 3600 } };
      if (hit.url === "/v1/payments/payouts/BATCH-SETTLED") return { body: batchBody("SUCCESS", ["SUCCESS"]) };
      return null;
    });
    try {
      const run = await runConfirm(
        ["--batch-id", "BATCH-SETTLED", "--wait-seconds", "0"],
        baseEnv(stub.url)
      );
      assert.equal(run.code, 0, run.stderr);
      assert.equal(run.json?.verdict, "SETTLED");
      assert.equal(run.json?.batch_status, "SUCCESS");
      assert.equal(run.json?.items?.[0]?.transaction_status, "SUCCESS");
      assert.match(run.stderr, /confirmed: every item SUCCESS/);
    } finally {
      await stub.close();
    }
  });

  it("fails a batch PayPal reports as FAILED", async () => {
    const stub = await startStub((hit) => {
      if (hit.url === "/v1/oauth2/token") return { body: { access_token: "stub-token", expires_in: 3600 } };
      if (hit.url === "/v1/payments/payouts/BATCH-FAILED") return { body: batchBody("FAILED", ["FAILED"]) };
      return null;
    });
    try {
      const run = await runConfirm(
        ["--batch-id", "BATCH-FAILED", "--wait-seconds", "0"],
        baseEnv(stub.url)
      );
      assert.equal(run.code, 1);
      assert.equal(run.json?.verdict, "FAILED");
      assert.match(run.stderr, /::error::/);
      assert.match(run.stderr, /FAILED/);
      assert.match(run.stderr, /do not assume the money moved/);
    } finally {
      await stub.close();
    }
  });

  it("fails a batch whose item is UNCLAIMED even when the batch says SUCCESS", async () => {
    const stub = await startStub((hit) => {
      if (hit.url === "/v1/oauth2/token") return { body: { access_token: "stub-token", expires_in: 3600 } };
      if (hit.url === "/v1/payments/payouts/BATCH-UNCLAIMED") {
        return { body: batchBody("SUCCESS", ["UNCLAIMED"]) };
      }
      return null;
    });
    try {
      const run = await runConfirm(
        ["--batch-id", "BATCH-UNCLAIMED", "--wait-seconds", "0"],
        baseEnv(stub.url)
      );
      assert.equal(run.code, 1);
      assert.equal(run.json?.verdict, "UNCLAIMED");
      assert.match(run.stderr, /unclaimed/i);
    } finally {
      await stub.close();
    }
  });

  it("polls a PENDING batch until it settles", async () => {
    let detailCalls = 0;
    const stub = await startStub((hit) => {
      if (hit.url === "/v1/oauth2/token") return { body: { access_token: "stub-token", expires_in: 3600 } };
      if (hit.url === "/v1/payments/payouts/BATCH-POLL") {
        detailCalls += 1;
        return detailCalls === 1
          ? { body: batchBody("PENDING", ["PENDING"]) }
          : { body: batchBody("SUCCESS", ["SUCCESS"]) };
      }
      return null;
    });
    try {
      const run = await runConfirm(
        ["--batch-id", "BATCH-POLL", "--wait-seconds", "5", "--interval-seconds", "1"],
        baseEnv(stub.url)
      );
      assert.equal(run.code, 0, run.stderr);
      assert.equal(run.json?.verdict, "SETTLED");
      assert.equal(run.json?.polls, 2);
      assert.equal(detailCalls, 2);
    } finally {
      await stub.close();
    }
  });

  it("fails when the batch is still processing at the deadline", async () => {
    const stub = await startStub((hit) => {
      if (hit.url === "/v1/oauth2/token") return { body: { access_token: "stub-token", expires_in: 3600 } };
      if (hit.url === "/v1/payments/payouts/BATCH-PENDING") return { body: batchBody("PENDING", ["PENDING"]) };
      return null;
    });
    try {
      const run = await runConfirm(
        ["--batch-id", "BATCH-PENDING", "--wait-seconds", "0"],
        baseEnv(stub.url)
      );
      assert.equal(run.code, 1);
      assert.equal(run.json?.verdict, "NOT_CONFIRMED");
      assert.match(run.stderr, /still PENDING after/);
      assert.match(run.stderr, /confirm-owner-payout\.mjs --batch-id BATCH-PENDING/);
    } finally {
      await stub.close();
    }
  });

  it("takes the batch id from the payout result file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "payout-confirm-"));
    const resultPath = path.join(dir, "out.json");
    writeFileSync(resultPath, JSON.stringify({
      ok: true,
      batchId: "BATCH-FROM-RESULT",
      result: { payout: { status: "IN_TRANSIT", batch_id: "BATCH-FROM-RESULT" } },
    }));
    const stub = await startStub((hit) => {
      if (hit.url === "/v1/oauth2/token") return { body: { access_token: "stub-token", expires_in: 3600 } };
      if (hit.url === "/v1/payments/payouts/BATCH-FROM-RESULT") {
        return { body: batchBody("SUCCESS", ["SUCCESS"]) };
      }
      return null;
    });
    try {
      const run = await runConfirm(
        ["--from-result", resultPath, "--wait-seconds", "0"],
        baseEnv(stub.url)
      );
      assert.equal(run.code, 0, run.stderr);
      assert.equal(run.json?.batchId, "BATCH-FROM-RESULT");
      assert.equal(run.json?.verdict, "SETTLED");
      assert.ok(stub.hits.some((hit) => hit.url === "/v1/payments/payouts/BATCH-FROM-RESULT"));
    } finally {
      await stub.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to poll without a batch id", async () => {
    const run = await runConfirm([], baseEnv("http://127.0.0.1:9"));
    assert.equal(run.code, 1);
    assert.equal(run.json?.verdict, "ERROR");
    assert.match(run.stderr, /pass --batch-id or --from-result/);
  });

  it("reports an unreadable batch as ERROR, not as settled", async () => {
    const stub = await startStub((hit) => {
      if (hit.url === "/v1/oauth2/token") return { body: { access_token: "stub-token", expires_in: 3600 } };
      return { status: 500, body: { name: "INTERNAL_SERVER_ERROR" } };
    });
    try {
      const run = await runConfirm(
        ["--batch-id", "BATCH-ERROR", "--wait-seconds", "0"],
        baseEnv(stub.url)
      );
      assert.equal(run.code, 1);
      assert.equal(run.json?.verdict, "ERROR");
      assert.match(run.stderr, /Could not read payout batch BATCH-ERROR/);
    } finally {
      await stub.close();
    }
  });
});
