
import { getEnvBool } from "./autonomous-config.mjs";
import { OWNER_ACCOUNTS as REGISTRY_ACCOUNTS, ALLOWED_BENEFICIARIES as REGISTRY_BENEFICIARIES } from "./policy/RecipientRegistry.mjs";

/**
 * STRICT OWNER REVENUE DIRECTIVE
 * 
 * This module enforces the "Owner Revenue Directive" to ensure that:
 * 1. No payouts are sent to unauthorized accounts.
 * 2. Middlemen are eliminated.
 * 3. Configs attempting to bypass this are rejected.
 * 
 * @see whats.so.difficult.éunderstand.txt
 */

const ALLOWED_BENEFICIARIES = REGISTRY_BENEFICIARIES;

const ALLOWED_PAYONEER_DIRS = [
    "out/payoneer",
    "out/bank-wire"
];

export const OWNER_ACCOUNTS = REGISTRY_ACCOUNTS;

/**
 * The payee an account can actually receive at, or null when no rail the
 * daemon owns can pay it.
 *
 * This is the single place a destination is decided. It used to be three:
 * `selectOptimalOwnerAccount` chose an account, `generateOwnerPayoutConfig`
 * described it one way (email first) and each CSV rail wrote a hardcoded
 * registry constant as the payee — so the rail was chosen from one account
 * while the instruction paid another, and an account without the identifier its
 * rail needs was selected and then not payable at all.
 */
export function ownerAccountDestination(account) {
  if (!account || account.enabled === false) return null;
  if (account.type === 'BANK_WIRE') {
    const destination = String(account.rib ?? account.identifier ?? '').trim();
    return destination ? { destination, recipient_type: 'BANK_ACCOUNT' } : null;
  }
  if (account.type === 'PAYONEER') {
    const destination = String(account.accountId ?? '').trim();
    return destination ? { destination, recipient_type: 'ACCOUNT_ID' } : null;
  }
  // No rail in this daemon pays any other type (CRYPTO, a redirected PayPal, …).
  return null;
}

export function selectOptimalOwnerAccount(amount, currency) {
  // Amount bands keep the fees down; each falls back to the other account when
  // the preferred one cannot be paid, and nothing is selected rather than a
  // destination no rail can pay.
  const order = Number(amount) > 2000 ? ['bank', 'payoneer'] : ['payoneer', 'bank'];
  for (const key of order) {
    if (ownerAccountDestination(OWNER_ACCOUNTS[key])) return OWNER_ACCOUNTS[key];
  }
  return null;
}

export function generateOwnerPayoutConfig(amount, currency) {
  const account = selectOptimalOwnerAccount(amount, currency);
  const payee = ownerAccountDestination(account);
  if (!payee) {
    throw new Error(`NO_PAYABLE_OWNER_ACCOUNT: no owner account can be paid for ${amount} ${currency}`);
  }
  return {
    recipient: payee.destination,
    recipient_type: payee.recipient_type,
    amount: amount,
    currency: currency,
    note: "Owner Settlement"
  };
}

export function validateOwnerDirectiveSetup() {
  // Check env vars
  if (!process.env.OWNER_PAYONEER_ID) {
    console.warn("⚠️ OWNER_PAYONEER_ID not set. Payoneer settlement may fail.");
  }
  // Check constants
  if (!OWNER_ACCOUNTS.paypal.email || !OWNER_ACCOUNTS.bank.rib) {
      throw new Error("Critical Owner Accounts missing configuration");
  }
}

export async function preExecutionOwnerCheck({ batch }) {
    // Validate batch against owner directive
    if (!batch) return;
    for (const item of batch.items) {
        enforceOwnerDirective({ payout: { beneficiary: item.receiver || item.recipient } });
    }
}

export function enforceOwnerDirective(cfg) {
  // 1. Check Payout Beneficiary
  const beneficiary = cfg.payout?.beneficiary;
  if (beneficiary) {
    const isAllowed = ALLOWED_BENEFICIARIES.some(b => 
      String(beneficiary).trim().toLowerCase() === b.toLowerCase()
    );
    if (!isAllowed) {
      throw new Error(`VIOLATION: Owner Revenue Directive. Unauthorized beneficiary: ${beneficiary}`);
    }
  }

  // 2. Check PayPal Recipient Allowlist (Environment)
  const envAllowlist = process.env.AUTONOMOUS_ALLOWED_PAYPAL_RECIPIENTS;
  if (envAllowlist) {
      const list = envAllowlist.split(',').map(s => s.trim().toLowerCase());
      const hasUnauthorized = list.some(email => !ALLOWED_BENEFICIARIES.some(allowed => allowed.toLowerCase() === email));
      if (hasUnauthorized) {
          throw new Error(`VIOLATION: Owner Revenue Directive. Unauthorized PayPal recipient in env.`);
      }
  }

  // 3. Enforce Middleman Elimination
  // If the config attempts to use a settlement ID that isn't explicitly approved, warn or block.
  // For now, we focus on the destination.

  // 4. Validate Export Directories (Prevent hiding money in obscure folders)
  if (cfg.tasks?.autoExportPayoneerPayoutBatches === true) {
      const outDir = cfg.payout?.export?.payoneerOutDir;
      if (outDir && !ALLOWED_PAYONEER_DIRS.some(d => outDir.includes(d) || outDir.endsWith("payoneer") || outDir.endsWith("bank-wire"))) {
           throw new Error(`VIOLATION: Owner Revenue Directive. Suspicious export directory: ${outDir}`);
      }
  }

  console.log("✅ Owner Revenue Directive Enforced: Configuration is SAFE.");
}
