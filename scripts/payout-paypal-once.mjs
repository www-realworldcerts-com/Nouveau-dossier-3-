#!/usr/bin/env node
/**
 * Send one PayPal payout batch to an authorised owner account.
 *
 * This is the only thing the `Owner payout` workflow is allowed to run, so it
 * refuses rather than guesses: every refusal that happens before a request
 * leaves the process prints `no_funds_moved: true` with the reason, and the
 * checker downstream turns that into an annotation. Anything that could have
 * reached PayPal without a confirmed batch id is printed without that flag, so
 * the checker says the outcome is unknown instead of implying nothing happened.
 *
 * Always exits 0 after printing a parseable result: the checker owns the run
 * status, and `set -euo pipefail` in the workflow would otherwise stop before
 * the explanation is printed.
 */

import { createHash } from "node:crypto";
import { createPayPalPayoutBatch } from "../src/paypal-api.mjs";
import { ALLOWED_BENEFICIARIES } from "../src/policy/RecipientRegistry.mjs";
import { readArgs } from "./lib/cli-args.mjs";

const MAX_AMOUNT = 100000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._-]{1,64}$/;
// Plain decimal with at most two fraction digits; a comma is accepted as the
// decimal separator, but "1,234" is three decimals and is refused.
const AMOUNT_RE = /^\d+(?:[.,]\d{1,2})?$/;

// PayPal's payout batch statuses. Only these mean the batch was taken for
// processing; anything else (FAILED, BLOCKED, a missing status) is not a
// submission, however successful the HTTP response looked.
const ACCEPTED_BATCH_STATUSES = new Set(["PENDING", "PROCESSING", "SUCCESS"]);
const UNPROCESSED_BATCH_STATUSES = new Set(["DENIED", "CANCELED", "CANCELLED"]);

const LIVE_PAYPAL_API = "https://api-m.paypal.com";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function truthyFlag(name) {
  return String(process.env[name] ?? "").trim().toLowerCase() === "true";
}

function print(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(0);
}

/** Nothing was sent, and nothing will be. */
function refuse({ code, error }) {
  print({
    ok: false,
    result: {
      payout: {
        ...(code ? { code } : {}),
        error,
        no_funds_moved: true
      }
    }
  });
}

/** No payout was attempted because there is nothing to authenticate with. */
function refuseNoCredentials(missing) {
  print({
    ok: false,
    result: {
      payout: {
        status: "NOT_ATTEMPTED",
        error: `No payout was attempted: ${missing.join(", ")} not configured.`
      },
      fallback: "no_credentials"
    }
  });
}

function payoutBaseUrl() {
  const raw = String(process.env.PAYPAL_API_BASE_URL ?? "").trim();
  return raw ? raw.replace(/\/+$/, "") : LIVE_PAYPAL_API;
}

// Loopback is the only non-live endpoint this script will talk to, so the
// tests can run against a stub. Anything else is a sandbox or a
// misconfiguration, and a payout against it would look successful on the
// workflow summary while moving no real money.
function isLoopbackEndpoint(url) {
  try {
    const parsed = new URL(url);
    const httpish = parsed.protocol === "http:" || parsed.protocol === "https:";
    return httpish && LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * PayPal refuses a `sender_batch_id` reused within 30 days, so the same payment
 * must always produce the same id. A dispatch that omits an explicit key gets
 * one derived from what is being paid, which makes a plain re-run collide
 * instead of paying twice.
 */
function paymentIdempotencyKey(args, { amount, currency, email, note }) {
  const explicit = String(args["idempotency-key"] ?? "").trim();
  if (explicit) return explicit;
  return createHash("sha256")
    .update([amount.toFixed(2), currency, email.toLowerCase(), note].join("|"))
    .digest("hex")
    .slice(0, 24);
}

function isDuplicateSenderBatchId(message) {
  return /sender_batch_id/i.test(message) && /already\s+exists/i.test(message);
}

function originalBatchIdFromMessage(message) {
  const match = message.match(/\/v1\/payments\/payouts\/([A-Za-z0-9-]+)/);
  return match ? match[1] : null;
}

function parseAmount(raw) {
  // Refuse rather than round: 12.345 must not become a 12.35 payment nobody
  // typed, and exponent/hex notation is not an amount a human meant to send.
  const text = String(raw ?? "").trim();
  if (!AMOUNT_RE.test(text)) return null;
  const amount = Number(text.replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (amount > MAX_AMOUNT) return null;
  // Safe now that the input has at most two decimals; the round only strips
  // binary floating-point noise (12.35 * 100 = 1234.9999999999998).
  return Math.round(amount * 100) / 100;
}

async function main() {
  const args = readArgs(process.argv.slice(2));

  if (args.help === true) {
    print({
      ok: false,
      usage:
        "node scripts/payout-paypal-once.mjs --confirm --amount <n> --currency <ISO> --email <owner> [--note <text>] [--idempotency-key <key>]",
      result: { payout: { status: "NOT_ATTEMPTED", no_funds_moved: true, error: "help requested" } }
    });
  }

  const amount = parseAmount(args.amount);
  if (amount == null) {
    refuse({
      code: "INVALID_ARGUMENTS",
      error: `--amount must be a number greater than 0, at most ${MAX_AMOUNT}, with at most two decimals (got ${JSON.stringify(args.amount ?? null)}).`
    });
  }

  const currency = String(args.currency ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    refuse({
      code: "INVALID_ARGUMENTS",
      error: `--currency must be a 3-letter ISO code (got ${JSON.stringify(args.currency ?? null)}).`
    });
  }

  const email = String(args.email ?? "").trim();
  if (!EMAIL_RE.test(email)) {
    refuse({
      code: "INVALID_ARGUMENTS",
      error: `--email must be a valid email address (got ${JSON.stringify(args.email ?? null)}).`
    });
  }

  // Owner-only settlement: a free-text recipient from the dispatch form must
  // still be an account the registry already knows about.
  const ownerKey = email.toLowerCase();
  if (!ALLOWED_BENEFICIARIES.some((allowed) => String(allowed).toLowerCase() === ownerKey)) {
    refuse({
      code: "RECIPIENT_NOT_ALLOWED",
      error: `Recipient ${email} is not an authorised owner account in src/policy/RecipientRegistry.mjs; no payout was sent.`
    });
  }

  const note = String(args.note ?? "").trim();
  if (note.length > 400) {
    refuse({ code: "INVALID_ARGUMENTS", error: "--note must be 400 characters or fewer." });
  }

  const explicitKey = String(args["idempotency-key"] ?? "").trim();
  if (explicitKey && !IDEMPOTENCY_KEY_RE.test(explicitKey)) {
    refuse({
      code: "INVALID_ARGUMENTS",
      error: "--idempotency-key must be 1-64 characters of A-Z, a-z, 0-9, dot, underscore or hyphen."
    });
  }

  if (args.confirm !== true) {
    refuse({
      code: "CONFIRMATION_REQUIRED",
      error: "Refusing to send money without --confirm; no payout was attempted."
    });
  }

  const missing = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"].filter(
    (name) => !String(process.env[name] ?? "").trim()
  );
  if (missing.length > 0) refuseNoCredentials(missing);

  if (truthyFlag("PAYPAL_DISABLED")) {
    refuse({
      code: "PAYPAL_DISABLED",
      error: "PAYPAL_DISABLED is true, so the PayPal rail is switched off; no payout was attempted."
    });
  }

  if (!truthyFlag("PAYPAL_PPP2_APPROVED") || !truthyFlag("PAYPAL_PPP2_ENABLE_SEND")) {
    refuse({
      code: "PAYPAL_PPP2_DISABLED",
      error:
        "PAYPAL_PPP2_APPROVED and PAYPAL_PPP2_ENABLE_SEND must both be true before PayPal Payouts may send money."
    });
  }

  const baseUrl = payoutBaseUrl();
  const paypalMode = String(process.env.PAYPAL_MODE ?? "live").trim().toLowerCase();
  if (!isLoopbackEndpoint(baseUrl) && (baseUrl !== LIVE_PAYPAL_API || paypalMode === "sandbox")) {
    refuse({
      code: "PAYPAL_NOT_LIVE",
      error: `Refusing to pay out against ${baseUrl} (PAYPAL_MODE=${paypalMode}): owner payouts must use the live PayPal API ${LIVE_PAYPAL_API}.`
    });
  }

  // Deterministic on purpose: a fresh id per run is what let a re-dispatch pay
  // a second time, because PayPal only deduplicates on sender_batch_id.
  const idempotencyKey = paymentIdempotencyKey(args, { amount, currency, email, note });
  const senderBatchId = `owner-payout-${idempotencyKey}`;

  const items = [
    {
      recipient_type: "EMAIL",
      receiver: email,
      amount: { value: amount.toFixed(2), currency },
      note: note || "Owner payout",
      sender_item_id: `${senderBatchId}-1`
    }
  ];

  let batch;
  try {
    batch = await createPayPalPayoutBatch({
      senderBatchId,
      items,
      emailSubject: "RealWorldCerts owner payout",
      emailMessage: note || undefined
    });
  } catch (error) {
    const message = String(error?.message ?? String(error));
    if (isDuplicateSenderBatchId(message)) {
      // PayPal keeps the first batch for 30 days and rejects the repeat. This
      // run sent nothing; paying again would need a deliberately new key.
      const originalBatchId = originalBatchIdFromMessage(message);
      print({
        ok: false,
        senderBatchId,
        result: {
          payout: {
            code: "DUPLICATE_SENDER_BATCH_ID",
            status: "DUPLICATE",
            sender_batch_id: senderBatchId,
            ...(originalBatchId ? { original_batch_id: originalBatchId } : {}),
            no_funds_moved: true,
            error: `PayPal already has a payout batch for sender_batch_id ${senderBatchId}, so this dispatch sent nothing. Do not retry with a new key; check the original batch in PayPal first.`
          }
        }
      });
    }

    print({
      ok: false,
      result: {
        payout: {
          status: "UNKNOWN",
          error: `PayPal payout request failed: ${message}`
        }
      }
    });
  }

  // print() exits, so the request-failure branch above ends the run here.
  const header = batch?.batch_header ?? {};
  const batchId = header.payout_batch_id ?? batch?.payout_batch_id ?? null;
  const paypalStatus = String(header.batch_status ?? batch?.batch_status ?? "").toUpperCase();

  if (!batchId) {
    print({
      ok: false,
      result: {
        payout: {
          status: paypalStatus || "UNKNOWN",
          error: "PayPal replied without a payout batch id, so the submission is unconfirmed."
        }
      }
    });
  }

  if (UNPROCESSED_BATCH_STATUSES.has(paypalStatus)) {
    // DENIED/CANCELED mean PayPal rejected the batch before processing it.
    refuse({
      code: "PAYPAL_BATCH_NOT_ACCEPTED",
      error: `PayPal refused the batch (${paypalStatus}); no funds left the account.`
    });
  }

  if (!ACCEPTED_BATCH_STATUSES.has(paypalStatus)) {
    // A status we do not recognise is not proof that nothing was sent, so this
    // branch deliberately omits no_funds_moved (refuse() would add it): the
    // checker then says the outcome is unknown and asks for a PayPal check
    // before any retry, instead of inviting a second payment.
    print({
      ok: false,
      result: {
        payout: {
          code: "PAYPAL_BATCH_NOT_ACCEPTED",
          status: "UNKNOWN",
          paypal_status: paypalStatus || "MISSING",
          error: `PayPal did not accept the batch (status ${paypalStatus || "missing"}); treat the payout as unconfirmed and check PayPal before retrying.`
        }
      }
    });
  }

  print({
    ok: true,
    batchId,
    senderBatchId,
    idempotencyKey,
    result: {
      payout: {
        // Accepted for processing. "IN_TRANSIT" is a submission, not settlement.
        status: "IN_TRANSIT",
        paypal_status: paypalStatus || "UNKNOWN",
        batch_id: batchId,
        sender_batch_id: senderBatchId,
        amount: amount.toFixed(2),
        currency,
        recipient: email
      }
    }
  });
}

main().catch((error) => {
  print({
    ok: false,
    result: {
      payout: {
        status: "UNKNOWN",
        error: `Payout script crashed: ${error?.message ?? String(error)}`
      }
    }
  });
});
