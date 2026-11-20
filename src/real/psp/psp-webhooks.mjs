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
