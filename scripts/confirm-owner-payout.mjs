#!/usr/bin/env node
/**
 * Confirm a PayPal payout batch that was submitted earlier.
 *
 * Submission is not settlement: a batch can be accepted as PENDING and only
 * later turn FAILED, or leave its items UNCLAIMED (the receiver address is not
 * a PayPal account, so the money returns after 30 days). Polling the batch
 * details turns that into a red run instead of a 90-day artifact nobody reads.
 *
 * Prints a JSON summary on stdout for the workflow artifact and an `::error::`
 * annotation on stderr, then exits 0 only when every item settled.
 */

import { readFileSync } from "node:fs";
import { getPayoutBatchDetails } from "../src/paypal-api.mjs";
import { readArgs } from "./lib/cli-args.mjs";

const DEFAULT_WAIT_SECONDS = 180;
const DEFAULT_INTERVAL_SECONDS = 10;
const MAX_WAIT_SECONDS = 3600;

// The item reached the recipient.
const SETTLED_STATUSES = new Set(["SUCCESS"]);
// The item will not pay out without intervention.
const FAILED_STATUSES = new Set([
  "FAILED",
  "DENIED",
  "CANCELED",
  "CANCELLED",
  "BLOCKED",
  "RETURNED",
  "REVERSED",
  "REFUNDED"
]);
// The money left the account but nobody claimed it; PayPal returns it later.
const UNCLAIMED_STATUSES = new Set(["UNCLAIMED"]);

function intArg(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function batchIdFromResult(path) {
  const payload = JSON.parse(readFileSync(path, "utf8"));
  const id = payload?.batchId ?? payload?.result?.payout?.batch_id;
  if (!id) throw new Error(`${path} does not record a confirmed payout batch id`);
  return String(id).trim();
}

function summarize(batch) {
  const header = batch?.batch_header ?? {};
  const batchStatus = String(header.batch_status ?? "").toUpperCase() || "UNKNOWN";
  const items = (Array.isArray(batch?.items) ? batch.items : []).map((item) => ({
    transaction_status: String(item?.transaction_status ?? "UNKNOWN").toUpperCase(),
    transaction_id: item?.transaction_id ?? null,
    amount: item?.payout_item?.amount ?? null,
    receiver: item?.payout_item?.receiver ?? null
  }));
  const statuses = items.map((item) => item.transaction_status);
  const failed = statuses.filter((status) => FAILED_STATUSES.has(status));
  const unclaimed = statuses.filter((status) => UNCLAIMED_STATUSES.has(status));
  const settled = statuses.filter((status) => SETTLED_STATUSES.has(status));
  // A batch with no items exposed falls back to its own status.
  const allSettled = items.length > 0
    ? settled.length === items.length
    : SETTLED_STATUSES.has(batchStatus);

  let verdict = "PENDING";
  if (FAILED_STATUSES.has(batchStatus) || failed.length > 0) verdict = "FAILED";
  else if (unclaimed.length > 0) verdict = "UNCLAIMED";
  else if (batchStatus === "SUCCESS" && allSettled) verdict = "SETTLED";

  return { batchStatus, items, verdict };
}

function emit(payload, exitCode, annotation) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (annotation) console.error(annotation);
  // exitCode, not exit(): lets a piped stdout drain so the JSON is never cut off.
  process.exitCode = exitCode;
}

async function main() {
  const args = readArgs(process.argv.slice(2));

  if (args.help === true) {
    emit(
      {
        ok: false,
        usage:
          "node scripts/confirm-owner-payout.mjs (--batch-id <id> | --from-result out.json) [--wait-seconds 180] [--interval-seconds 10]"
      },
      1
    );
    return;
  }

  let batchId = String(args["batch-id"] ?? "").trim();
  if (!batchId && args["from-result"]) {
    try {
      batchId = batchIdFromResult(String(args["from-result"]));
    } catch (error) {
      emit({ ok: false, verdict: "ERROR", error: error?.message ?? String(error) }, 1,
        "::error::Cannot confirm the payout: the payout result file does not carry a batch id.");
      return;
    }
  }
  if (!batchId) {
    emit({ ok: false, verdict: "ERROR", error: "missing --batch-id / --from-result" }, 1,
      "::error::Cannot confirm the payout: pass --batch-id or --from-result.");
    return;
  }

  const waitSeconds = intArg(args["wait-seconds"], DEFAULT_WAIT_SECONDS, 0, MAX_WAIT_SECONDS);
  const intervalSeconds = intArg(args["interval-seconds"], DEFAULT_INTERVAL_SECONDS, 1, 300);
  const startedAt = Date.now();
  const deadline = startedAt + waitSeconds * 1000;

  let polls = 0;
  let summary = null;
  let lastError = null;

  for (;;) {
    polls += 1;
    try {
      summary = summarize(await getPayoutBatchDetails(batchId));
    } catch (error) {
      lastError = error;
      break;
    }
    if (summary.verdict !== "PENDING") break;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
  }

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  const base = {
    batchId,
    polls,
    waited_seconds: elapsed,
    ...(summary
      ? { batch_status: summary.batchStatus, items: summary.items }
      : { batch_status: "UNKNOWN", items: [] })
  };

  if (!summary) {
    emit(
      { ok: false, ...base, verdict: "ERROR", error: String(lastError?.message ?? lastError) },
      1,
      `::error::Could not read payout batch ${batchId} from PayPal: ${lastError?.message ?? lastError}. The payout outcome is unknown; check PayPal before retrying.`
    );
    return;
  }

  if (summary.verdict === "SETTLED") {
    emit({ ok: true, ...base, verdict: "SETTLED" }, 0,
      `Payout batch ${batchId} confirmed: every item SUCCESS.`);
    return;
  }

  if (summary.verdict === "FAILED") {
    const failed = summary.items.filter((item) => FAILED_STATUSES.has(item.transaction_status));
    emit(
      { ok: false, ...base, verdict: "FAILED" },
      1,
      `::error::PayPal reports payout batch ${batchId} as ${summary.batchStatus} with ${failed.length} of ${summary.items.length} item(s) not paid (` +
        `${failed.map((item) => item.transaction_status).join(", ") || summary.batchStatus}). Check PayPal before retrying; do not assume the money moved.`
    );
    return;
  }

  if (summary.verdict === "UNCLAIMED") {
    emit(
      { ok: false, ...base, verdict: "UNCLAIMED" },
      1,
      `::error::Payout batch ${batchId} has unclaimed item(s): the receiver is not a PayPal account that can accept the payment. PayPal returns unclaimed funds after 30 days; confirm the recipient email and re-check before resending.`
    );
    return;
  }

  emit(
    { ok: false, ...base, verdict: "NOT_CONFIRMED" },
    1,
    `::error::Payout batch ${batchId} was submitted but is still ${summary.batchStatus} after ${elapsed}s (waited up to ${waitSeconds}s); it is not confirmed as settled. Re-check later with: node scripts/confirm-owner-payout.mjs --batch-id ${batchId}`
  );
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, verdict: "ERROR", error: error?.message ?? String(error) })}\n`);
  console.error(`::error::Payout confirmation crashed: ${error?.message ?? String(error)}`);
  process.exitCode = 1;
});
