#!/usr/bin/env node
import '../src/load-env.mjs';

import { DEFAULT_QUEUE_FILE } from '../src/real/fulfillment/paypal-reconciliation.mjs';
import { drainFulfillmentQueue } from '../src/real/fulfillment/fulfillment-drain.mjs';

/**
 * Deliver paid orders that are stuck in the fulfilment queue.
 *
 * Dry-run by default. `--apply` re-reads each pending order from PayPal and
 * re-runs the webhook's fulfilment path, which is idempotent through the
 * settlement ledger: an order whose access email already went out is reported
 * as a duplicate instead of being sent twice. Scheduled by the swarm tick for
 * both the GitHub workflow and the local supervisor.
 */

function parseArgs(argv) {
    const flags = {};
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token.startsWith('--')) continue;
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) flags[key] = true;
        else {
            flags[key] = next;
            i += 1;
        }
    }
    return flags;
}

const HELP = `Drain the paid-order fulfilment queue (idempotent delivery retry).

Usage:
  node scripts/drain-fulfillment.mjs [options]

Options:
  --apply             Deliver pending orders (default: dry run)
  --queue <file>      Fulfilment queue (default $FULFILLMENT_QUEUE_FILE or ${DEFAULT_QUEUE_FILE})
  --limit <n>         Most orders to attempt in one run (default 25)
  --max-attempts <n>  Failures before an order stops being retried (default 5)
  --backoff-minutes <n>  First retry delay; doubles per failure (default 15)
  --json              Machine-readable report
  --help              This help

Exit codes: 0 ok, 1 error. Re-running is safe: delivery is keyed by PayPal
order id in the settlement ledger, so a delivered order is never emailed twice.
A failed attempt is recorded in the queue with a retry time; after
--max-attempts it becomes DELIVERY_EXHAUSTED and is reported for manual
delivery or refund instead of being retried forever.`;

async function main() {
    const flags = parseArgs(process.argv.slice(2));
    if (flags.help) return console.log(HELP);

    const numeric = value => (value === undefined || value === true ? undefined : Number(value));
    const backoffMinutes = numeric(flags['backoff-minutes']);
    const report = await drainFulfillmentQueue({
        // Same queue the webhook writes, including its FULFILLMENT_QUEUE_FILE override.
        queueFile: typeof flags.queue === 'string'
            ? flags.queue
            : (process.env.FULFILLMENT_QUEUE_FILE || DEFAULT_QUEUE_FILE),
        apply: Boolean(flags.apply),
        limit: numeric(flags.limit),
        maxAttempts: numeric(flags['max-attempts']),
        ...(backoffMinutes ? { baseBackoffMs: backoffMinutes * 60000 } : {})
    });

    if (flags.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
    }

    console.log(`Fulfilment drain — ${report.at}${report.applied ? ' (apply)' : ' (dry run)'}`);
    console.log(`  queue: ${report.queue_file}`);
    if (!report.queue_present) {
        // Never print a clean drain for a queue this host cannot see: that is
        // exactly how a decorative run looks like a working one.
        console.log('  skipped: no fulfilment queue at this path; nothing was drained.');
        console.log('  The queue lives on the host that runs the PayPal webhook — run the drain there.');
        return;
    }
    console.log(`  pending ${report.pending}; due ${report.due}${report.waiting_for_backoff ? ` (${report.waiting_for_backoff} waiting for backoff)` : ''}; attempted ${report.attempted}; delivered ${report.delivered.length}; remaining ${report.remaining}; exhausted ${report.exhausted}`);
    for (const item of report.delivered) console.log(`    DELIVERED ${item.order_id}${item.email_id ? ` (${item.email_id})` : ''}`);
    for (const item of report.still_pending) {
        const retry = item.next_attempt_at ? ` retry ${item.next_attempt_at}` : '';
        const attempts = item.attempts ? ` attempt ${item.attempts}/${report.max_attempts}` : '';
        console.log(`    PENDING ${item.order_id}: ${item.reason}${attempts}${retry}`);
    }
    for (const item of report.escalated) {
        console.log(`    ESCALATED ${item.order_id}: stopped after ${item.attempts} attempt(s) — ${item.reason}`);
        console.log('      deliver manually or refund; this order is no longer retried automatically.');
    }
    for (const item of report.skipped) console.log(`    skipped ${item.order_id}: ${item.reason}`);
    if (report.unattempted) console.log(`  ${report.unattempted} pending order(s) left for the next run (--limit ${report.attempted + report.unattempted}).`);
    if (!report.applied && report.pending) console.log('  dry run: re-run with --apply to deliver these orders.');
}

main().catch(error => {
    console.error(`drain-fulfillment: ${error.message}`);
    process.exit(1);
});
