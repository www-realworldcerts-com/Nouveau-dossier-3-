#!/usr/bin/env node
import {
    DEFAULT_LOOKBACK_DAYS,
    DEFAULT_QUEUE_FILE,
    reconcilePayPalOrders
} from '../src/real/fulfillment/paypal-reconciliation.mjs';
import '../src/load-env.mjs';

/**
 * Replay paid-but-unfulfilled PayPal orders.
 *
 * Dry-run by default: reads PayPal and the fulfilment queue, reports drift, and
 * writes nothing. `--apply` enqueues each missing order through the existing
 * FulfillmentManager path; the queue is the idempotency key, so re-running is
 * safe.
 */

function parseArgs(argv) {
    const tokens = [...argv];
    let command = 'run';
    // Flags may come before the (optional) command: `--apply` alone must not
    // become the command name.
    if (tokens[0] && !tokens[0].startsWith('--')) command = tokens.shift();
    const flags = {};
    const positional = [];
    for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i];
        if (token.startsWith('--')) {
            const key = token.slice(2);
            const next = tokens[i + 1];
            if (next === undefined || next.startsWith('--')) flags[key] = true;
            else {
                flags[key] = next;
                i += 1;
            }
        } else {
            positional.push(token);
        }
    }
    return { command, flags, positional };
}

function parseIds(value) {
    if (value === undefined || value === null) return [];
    if (value === true) throw new Error('--order-id requires a value');
    return String(value).split(',').map(id => id.trim()).filter(Boolean);
}

const HELP = `PayPal paid-but-unfulfilled reconciliation (idempotent replay).

Usage:
  node scripts/reconcile-paypal.mjs [run] [options]

Options:
  --apply                 Enqueue missing orders (default: dry run)
  --order-id <ids>        Explicit PayPal order ids, comma-separated
  --no-search             Do not scan PayPal transactions; use --order-id only
  --lookback-days <n>     Transaction window (default ${DEFAULT_LOOKBACK_DAYS})
  --queue <file>          Fulfilment queue (default ${DEFAULT_QUEUE_FILE})
  --json                  Machine-readable report

Exit codes: 0 ok, 1 error. Re-running is safe: fulfilment order ids already in
the queue are never enqueued twice.`;

async function main() {
    const { command, flags } = parseArgs(process.argv.slice(2));
    if (command === 'help' || flags.help) return console.log(HELP);

    const report = await reconcilePayPalOrders({
        orderIds: parseIds(flags['order-id']),
        lookbackDays: Number(flags['lookback-days'] || DEFAULT_LOOKBACK_DAYS),
        apply: Boolean(flags.apply),
        queueFile: flags.queue || DEFAULT_QUEUE_FILE,
        search: !flags['no-search']
    });

    if (flags.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
    }

    console.log(`PayPal reconciliation — ${report.at}${report.applied ? ' (apply)' : ' (dry run)'}`);
    console.log(`  window: ${report.window.from} .. ${report.window.to}`);
    if (report.search_error) console.log(`  transaction search failed: ${report.search_error}`);
    console.log(`  scanned ${report.scanned_orders} order(s); paid ${report.paid_orders}; already fulfilled ${report.already_fulfilled}`);
    if (!report.missing_count) {
        console.log('  no paid-but-unfulfilled orders.');
    } else {
        console.log(`  MISSING FULFILMENT: ${report.missing_count}`);
        for (const order of report.missing) {
            console.log(`    ${order.order_id} — ${order.currency} ${order.revenue} — ${order.product} — ${order.customer_email || 'EMAIL MISSING'}`);
        }
        if (report.applied) console.log(`  enqueued: ${report.enqueued.join(', ') || 'none'}`);
        else console.log('  dry run: re-run with --apply to enqueue these orders.');
    }
    for (const warning of report.warnings) console.log(`  WARNING ${warning}`);
    if (report.failed.length) for (const failure of report.failed) console.log(`  FAILED ${failure.order_id}: ${failure.error}`);
    if (report.skipped.length) for (const skip of report.skipped) console.log(`  skipped ${skip.order_id}: ${skip.reason}`);
}

main().catch(error => {
    console.error(`reconcile-paypal: ${error.message}`);
    process.exit(1);
});
