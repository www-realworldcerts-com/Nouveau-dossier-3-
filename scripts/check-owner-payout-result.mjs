import { readFileSync } from "node:fs";

let result;
try {
  result = JSON.parse(readFileSync(0, "utf8"));
} catch {
  console.error("::error::Invalid payout response. Check PayPal before retrying; the payout outcome may be unknown.");
  process.exit(1);
}

const payout = result?.result?.payout;
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

console.log("PayPal accepted the payout batch. Submission does not confirm settlement.");
