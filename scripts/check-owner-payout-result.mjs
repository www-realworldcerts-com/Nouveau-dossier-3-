import { readFileSync } from "node:fs";

let result;
try {
  result = JSON.parse(readFileSync(0, "utf8"));
} catch {
  console.error("::error::Invalid payout response. Check PayPal before retrying; the payout outcome may be unknown.");
  process.exit(1);
}

const payout = result?.result?.payout;

// A repeat dispatch of the same payment. PayPal kept the first batch, so this
// run moved nothing — but the run must stay red and must not be retried with a
// fresh key, or the same payment goes out twice.
if (payout?.code === "DUPLICATE_SENDER_BATCH_ID") {
  console.error(
    `::error::${payout.error || "PayPal already has a batch with this sender_batch_id."} ` +
      "Confirm the original batch with scripts/confirm-owner-payout.mjs instead of dispatching a new idempotency key."
  );
  process.exit(1);
}

if (payout?.no_funds_moved === true) {
  if (payout.code === "PAYPAL_PPP2_DISABLED") {
    console.error("::error::PayPal Payouts is not enabled. After PayPal approves Payouts, set Actions variables PAYPAL_PPP2_APPROVED and PAYPAL_PPP2_ENABLE_SEND to true in the payouts environment or repository; ensure PAYPAL_DISABLED is not true.");
  } else {
    console.error(`::error::No funds moved: ${payout.error || payout.code || "PayPal rail not configured"}`);
  }
  process.exit(1);
}

if (result?.result?.fallback === "no_credentials") {
  console.error("::error::No payout was attempted: configure PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET as Actions secrets.");
  process.exit(1);
}

if (result?.ok !== true || payout?.status !== "IN_TRANSIT" || !result.batchId) {
  console.error("::error::Payout was not confirmed as submitted. Check PayPal before retrying; the payout outcome may be unknown.");
  process.exit(1);
}

// A green run should prove the submission is the one that was dispatched. The
// workflow exports the inputs, so compare them when they are present; a bare
// stdin-only run of this checker still works without them.
const mismatches = [];

const rawAmount = String(process.env.INPUT_AMOUNT ?? "").trim();
if (rawAmount) {
  const text = rawAmount.replace(",", ".");
  const expected = /^\d+(?:\.\d{1,2})?$/.test(text) ? Number(text).toFixed(2) : null;
  if (!expected) {
    mismatches.push(`dispatch amount ${JSON.stringify(rawAmount)} is not a plain amount`);
  } else if (payout?.amount !== expected) {
    mismatches.push(`amount ${JSON.stringify(payout?.amount ?? null)} but the dispatch asked for ${expected}`);
  }
}

const expectedCurrency = String(process.env.INPUT_CURRENCY ?? "").trim().toUpperCase();
if (expectedCurrency && payout?.currency !== expectedCurrency) {
  mismatches.push(
    `currency ${JSON.stringify(payout?.currency ?? null)} but the dispatch asked for ${expectedCurrency}`
  );
}

const expectedRecipient = String(process.env.INPUT_EMAIL ?? "").trim().toLowerCase();
if (expectedRecipient && String(payout?.recipient ?? "").toLowerCase() !== expectedRecipient) {
  mismatches.push(
    `recipient ${JSON.stringify(payout?.recipient ?? null)} but the dispatch asked for ${expectedRecipient}`
  );
}

if (mismatches.length > 0) {
  console.error(
    `::error::Payout was submitted with ${mismatches.join("; ")}. The run sent something other than what was requested; check PayPal before treating this as the intended payment.`
  );
  process.exit(1);
}

console.log("PayPal accepted the payout batch. Submission does not confirm settlement.");
