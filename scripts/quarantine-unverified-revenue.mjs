#!/usr/bin/env node
// Rewrites revenue records that claim VERIFIED without a payment-provider
// transaction id. `revenue-proof-audit` demotes them only at read time, so the
// file on disk keeps asserting money that never arrived; this fixes the stored
// state and records why. Dry by default; pass --apply to write. Re-running is
// safe: a second pass finds nothing and writes no bytes.

import path from 'node:path';

import { quarantineDirectory } from '../src/real/ledger/quarantine.mjs';

const args = process.argv.slice(2);
const dirArg = args.find((arg) => arg.startsWith('--dir='));
const dir = path.resolve(dirArg ? dirArg.slice('--dir='.length) : (process.env.LEDGER_DIR || 'data/autonomous/ledger'));
const apply = args.includes('--apply');
const asJson = args.includes('--json');

const report = quarantineDirectory(dir, { apply });

if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.missing ? 2 : 0;
} else if (report.missing) {
    console.error(`Ledger directory not found: ${report.directory}`);
    process.exitCode = 2;
} else {
    const rows = report.files
        .map((file) => ({ ...file, events: file.events.filter((event) => event.changed) }))
        .filter((file) => file.events.length > 0);

    console.log(`Quarantine unverified revenue: ${report.directory}`);
    console.log('='.repeat(64));
    console.log(`${rows.length} file(s) with a VERIFIED claim and no provider transaction id`);
    for (const file of rows) {
        for (const event of file.events) {
            console.log(
                `  ${event.amount.toFixed(2)} ${event.currency || '?'}  ${event.event_id || '(no id)'}  ` +
                `${event.reason}${event.psp_id ? ` (${event.psp_id})` : ''}  ` +
                `${event.previous_status} -> ${event.status}  [${path.basename(file.file)}]`
            );
        }
    }
    if (report.unreadable > 0) console.log(`\n${report.unreadable} file(s) could not be read and were left alone.`);
    console.log(
        `\n${report.changed} record(s) ${apply ? 'rewritten to UNVERIFIED' : 'would be rewritten (dry run; pass --apply)'}.`
    );
    if (apply && report.changed === 0) console.log('Nothing to change: every stored record is consistent.');
}
