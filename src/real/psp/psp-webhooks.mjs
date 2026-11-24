// src/real/psp/psp-webhooks.mjs
import { isRegisteredWebhookId } from './webhook-registry.mjs';

/**
 * A psp id confirms money only when we recorded a webhook PayPal verified.
 *
 * This used to accept any id longer than five characters, so a forged capture
 * id passed as "confirmed". The registry is the authority now: an id that no
 * SUCCESS-verified webhook named is not a confirmation, whatever it looks like.
 */
export async function assertPSPWebhookExists(pspId, { registry } = {}) {
  return isRegisteredWebhookId(pspId, { registry });
}

/**
 * Whether a proof carries the amount and currency its verified webhook
 * recorded.
 *
 * `receipt` is the registry entry that webhook left (`findVerifiedWebhook`),
 * or null when the registry has none. A missing receipt cannot contradict a
 * row, and one written before amounts were kept states no number, so both
 * agree: only a receipt that states another amount refuses anything. Reading
 * the registry is the caller's step, because a registry that cannot be read
 * has confirmed nothing — settlement fails closed on that, ingest treats it as
 * unknown.
 */
export function agreesWithVerifiedAmount(proof, receipt) {
  const amount = Number(receipt?.amount);
  const currency = String(receipt?.currency ?? '').toUpperCase();
  if (!Number.isFinite(amount) || amount <= 0 || !currency) return true;
  return (
    Number(proof?.amount) === amount &&
    String(proof?.currency ?? '').toUpperCase() === currency
  );
}
