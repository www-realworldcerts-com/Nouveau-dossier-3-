import crypto from 'node:crypto';
import { verifyPayPalWebhookSignature, extractPayPalWebhookHeaders } from '../../paypal-api.mjs';
import { mapPayPalWebhookToRevenueEvent } from '../../paypal-event-mapper.mjs';
import { ProofValidator } from '../proof-validator.mjs';
import { identifiersFromPayPalEvent, recordVerifiedWebhook } from './webhook-registry.mjs';

export async function handlePayPalWebhook(req, rawBody) {
  const headers = extractPayPalWebhookHeaders(req.headers || {});
  const webhookId = process.env.PAYPAL_WEBHOOK_ID || '';
  const verification = webhookId
    ? await verifyPayPalWebhookSignature({ headers, body: rawBody, webhookId })
    : null;
  const verified = verification?.verification_status === 'SUCCESS';
  const parsed = verified ? JSON.parse(rawBody) : null;
  const event = parsed ? mapPayPalWebhookToRevenueEvent(parsed) : null;
  const proof = event ? {
    type: 'psp_transaction_id',
    psp_id: event?.metadata?.psp_transaction_id || event?.metadata?.paypal_capture_id || event?.resource?.id || headers['paypal-transmission-id'] || '',
    amount: Number(event.amount || event?.resource?.amount?.value || 0),
    currency: String(event.currency || event?.resource?.amount?.currency_code || '').toUpperCase(),
    timestamp: event.occurredAt || new Date().toISOString(),
    recipient: event?.metadata?.beneficiary || null
  } : null;
  if (parsed) {
    // Record the receipt before the proof is asserted: the assertion can only
    // pass for a webhook we actually received.
    await recordVerifiedWebhook(identifiersFromPayPalEvent(parsed, headers['paypal-transmission-id']));
  }
  if (event && proof) {
    await ProofValidator.assertValid({ ...event, verification_proof: proof });
  }
  return { provider: 'paypal', verified, event, proof };
}
