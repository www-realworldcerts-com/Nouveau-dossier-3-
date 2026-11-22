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

import { createPayPalPayoutBatch } from "../src/paypal-api.mjs";
import { ALLOWED_BENEFICIARIES } from "../src/policy/RecipientRegistry.mjs";

const MAX_AMOUNT = 100000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function truthyFlag(name) {
  return String(process.env[name] ?? "").trim().toLowerCase() === "true";
}

function readArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq !== -1) {
      args[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i++;
  }
  return args;
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

function invalidArguments(error) {
  refuse({ code: "INVALID_ARGUMENTS", error });
}

function parseAmount(raw) {
  const amount = Number(String(raw).replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (amount > MAX_AMOUNT) return null;
  return Math.round(amount * 100) / 100;
}

async function main() {
  const args = readArgs(process.argv.slice(2));

  if (args.help === true) {
    print({
      ok: false,
      usage:
        "node scripts/payout-paypal-once.mjs --confirm --amount <n> --currency <ISO> --email <owner> [--note <text>] [--sender-batch-id <id>]",
      result: { payout: { status: "NOT_ATTEMPTED", no_funds_moved: true, error: "help requested" } }
    });
  }

  const amount = parseAmount(args.amount);
  if (amount == null) {
    invalidArguments(
      `--amount must be a number greater than 0 and at most ${MAX_AMOUNT} (got ${JSON.stringify(args.amount ?? null)}).`
    );
  }

  const currency = String(args.currency ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    invalidArguments(`--currency must be a 3-letter ISO code (got ${JSON.stringify(args.currency ?? null)}).`);
  }

  const email = String(args.email ?? "").trim();
  if (!EMAIL_RE.test(email)) {
    invalidArguments(`--email must be a valid email address (got ${JSON.stringify(args.email ?? null)}).`);
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
    invalidArguments("--note must be 400 characters or fewer.");
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

  const senderBatchId =
    String(args["sender-batch-id"] ?? "").trim() ||
    `owner-payout-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;

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
    print({
      ok: false,
      result: {
        payout: {
          status: "UNKNOWN",
          error: `PayPal payout request failed: ${error?.message ?? String(error)}`
        }
      }
    });
    return;
  }

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
    return;
  }

  if (paypalStatus === "DENIED" || paypalStatus === "CANCELED" || paypalStatus === "CANCELLED") {
    refuse({
      code: "PAYPAL_BATCH_NOT_ACCEPTED",
      error: `PayPal refused the batch (${paypalStatus}); no funds left the account.`
    });
    return;
  }

  print({
    ok: true,
    batchId,
    senderBatchId,
    result: {
      payout: {
        // Accepted for processing. "IN_TRANSIT" is a submission, not settlement.
        status: "IN_TRANSIT",
        paypal_status: paypalStatus || "UNKNOWN",
        batch_id: batchId,
        sender_batch_id: senderBatchId,
        amount: amount.toFixed(2),
        currency
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
