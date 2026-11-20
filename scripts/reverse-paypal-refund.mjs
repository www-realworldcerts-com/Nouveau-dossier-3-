#!/usr/bin/env node
// Reverse revenue for a PayPal refund, capture reversal or dispute.
//
// The original capture stays on the ledger. A negative event keyed to that
// capture (`reversal_of`) is written beside it, so revenue totals net to zero
// instead of leaving a positive row with a `refunded` status string. A reversal
// with no matching capture prints a critical finding and exits non-zero.

import fs from 'node:fs';
import path from 'node:path';

import { mapPayPalWebhookToRevenueReversal } from '../src/paypal-event-mapper.mjs';
import { applyRevenueReversal } from '../src/real/ledger/reversals.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
    const prefixed = args.find((arg) => arg.startsWith(`--${name}=`));
    if (prefixed) return prefixed.slice(name.length + 3);
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : undefined;
};

const eventFile = flag('event');
const dir = path.resolve(flag('dir') || process.env.LEDGER_DIR || 'data/autonomous/ledger');
const apply = args.includes('--apply');
const asJson = args.includes('--json');

if (!eventFile) {
    console.error(
        'Usage: node scripts/reverse-paypal-refund.mjs --event <paypal-event.json> [--dir <ledger>] [--apply] [--json]'
    );
    process.exit(2);
}

function emit(value) {
    if (asJson) console.log(JSON.stringify(value, null, 2));
    else if (value.finding) {
        console.error(`FINDING ${value.finding.code} (${value.finding.severity}): ${value.finding.detail}`);
    } else if (value.reason === 'already_reversed') {
        console.log(`Already reversed: ${value.reversal_event_id}`);
    } else {
        console.log(
            `${value.applied ? 'Reversed' : 'Would reverse'} ${value.reversal.amount} ${value.reversal.currency} ` +
            `against capture ${value.reversal.reversal_of} (${value.reversal.status}) -> ${value.file}`
        );
    }
}

let raw;
try {
    raw = JSON.parse(fs.readFileSync(path.resolve(eventFile), 'utf8'));
} catch (error) {
    console.error(`Could not read the PayPal event ${eventFile}: ${error.message}`);
    process.exit(2);
}

const reversal = mapPayPalWebhookToRevenueReversal(raw);
if (!reversal) {
    console.error(`Not a refund, capture reversal or dispute event: ${raw?.event_type ?? '(no event_type)'}`);
    process.exit(2);
}

let report;
try {
    report = applyRevenueReversal({ dir, reversal, apply });
} catch (error) {
    console.error(error.message);
    process.exit(2);
}

emit(report);
if (report.finding) process.exit(2);
if (!apply) console.log('Dry run: pass --apply to write the reversal.');
