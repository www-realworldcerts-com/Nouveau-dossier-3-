/**
 * Dispatch a verified PayPal refund, capture reversal or dispute to the ledger.
 *
 * `npm run ledger:reverse` reverses a saved event by hand. A live refund then
 * waits on a person, and until someone runs the command every total still
 * reports money PayPal already took back. This module is the automatic path:
 * the webhook server hands it the event PayPal just verified, so the negative,
 * capture-keyed event is written while that notification is processed.
 *
 * It never throws into the webhook. A failed write is returned so the caller
 * must surface it, rather than turning an already-idempotent replay into a 500
 * that PayPal retries and the buyer's order path has to survive.
 */

import { mapPayPalWebhookToRevenueReversal } from '../../paypal-event-mapper.mjs';
import { applyRevenueReversal } from './reversals.mjs';

/** Where the revenue ledger lives, matching the CLI and the quarantine script. */
export function reversalLedgerDirectory(env = process.env) {
    return env.REVENUE_LEDGER_DIR || env.LEDGER_DIR || 'data/autonomous/ledger';
}

/**
 * Reverse the capture a verified event points at.
 *
 * Returns `{ dispatched: false, reason: 'not_a_reversal' }` for a capture
 * completion or any other notification, and otherwise the reversal report
 * (`applied`, `reason`, `finding`) plus the mapped reversal for the response.
 */
export function dispatchVerifiedPayPalReversal(evt, {
    dir,
    apply = true,
    now,
    env = process.env
} = {}) {
    const reversal = mapPayPalWebhookToRevenueReversal(evt);
    if (!reversal) return { dispatched: false, reason: 'not_a_reversal', reversal: null };

    let report;
    try {
        report = applyRevenueReversal({
            dir: dir ?? reversalLedgerDirectory(env),
            reversal,
            apply,
            now
        });
    } catch (error) {
        return {
            dispatched: true,
            ok: false,
            applied: false,
            reason: 'reversal_failed',
            error: error?.message ?? String(error),
            reversal
        };
    }

    return { dispatched: true, ...report, reversal };
}
