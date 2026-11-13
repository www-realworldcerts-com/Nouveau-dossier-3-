#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import {
    DEFAULT_LEDGER_FILE,
    loadPayoutLedger,
    savePayoutLedger
} from '../src/financial/payout-ledger.mjs';
import {
    normalizeTransactions,
    parseCsv,
    planStatementImport
} from '../src/financial/payout-statements.mjs';

/**
 * Import an Attijari or Payoneer statement and settle submitted payouts.
 * Matching is reference-first; amount/date matching is used only when exactly
 * one payout fits. Ambiguous and unmatched rows are reported, never guessed.
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

const HELP = `Payout statement import (Attijari / Payoneer)

Usage:
  node scripts/import-payout-statement.mjs --source attijari --file statement.csv [options]
  node scripts/import-payout-statement.mjs --source payoneer --file transactions.csv --dry-run

Options:
  --source <name>      attijari or payoneer (required)
  --file <path>        CSV or JSON statement (required)
  --ledger <file>      Payout ledger (default data/financial/payout_ledger.json)
  --map <file>         JSON header mapping, e.g. {"reference":"Reference","amount":"Montant"}
  --currency <code>    Default currency when the statement has no currency column
  --date-window <n>    Amount-match window in days (default 10)
  --dry-run            Match and report without writing the ledger
  --json               Print the full report as JSON
  --help               Show this help

Statuses: credited, failed and returned. Fees, net amount, FX rate and FX
difference are stored on the payout settlement. Already-imported statement
rows are skipped by fingerprint, so re-importing a file is safe.`;

function readRows(file) {
    const text = fs.readFileSync(file, 'utf8');
    if (String(file).toLowerCase().endsWith('.json')) {
        const parsed = JSON.parse(text);
        const rows = Array.isArray(parsed) ? parsed : parsed?.transactions;
        if (!Array.isArray(rows)) throw new Error('JSON statement must be an array or { transactions: [] }');
        return rows;
    }
    return parseCsv(text);
}

export function run(argv = process.argv.slice(2), { stdout = console.log } = {}) {
    const flags = parseArgs(argv);
    if (flags.help) {
        stdout(HELP);
        return null;
    }
    const source = String(flags.source || '').toLowerCase();
    if (!['attijari', 'payoneer'].includes(source)) {
        throw new Error('Missing or invalid --source (attijari or payoneer)');
    }
    const file = flags.file;
    if (!file) throw new Error('Missing --file <statement.csv>');
    const resolved = path.resolve(file);
    if (!fs.existsSync(resolved)) throw new Error(`Statement not found: ${resolved}`);

    const mapping = flags.map ? JSON.parse(fs.readFileSync(path.resolve(flags.map), 'utf8')) : {};
    const rows = readRows(resolved);
    const normalized = normalizeTransactions(rows, {
        source,
        mapping,
        defaultCurrency: flags.currency || null
    });
    const ledgerFile = path.resolve(
        flags.ledger || process.env.PAYOUT_LEDGER_FILE || DEFAULT_LEDGER_FILE
    );
    const ledger = loadPayoutLedger(ledgerFile);
    const { ledger: next, report } = planStatementImport(ledger, normalized.transactions, {
        source,
        file: resolved,
        dateWindowDays: flags['date-window'] === undefined ? 10 : Number(flags['date-window'])
    });
    report.issues.push(...normalized.issues);
    report.columns = normalized.columns;

    if (!flags['dry-run']) savePayoutLedger(ledgerFile, next);

    if (flags.json) {
        stdout(JSON.stringify(report, null, 2));
        return report;
    }

    const counts = {
        credited: report.applied.filter(row => row.status === 'credited').length,
        failed: report.applied.filter(row => row.status === 'failed').length,
        returned: report.applied.filter(row => row.status === 'returned').length
    };
    stdout(`${flags['dry-run'] ? 'DRY RUN — ' : ''}${source}: ${report.transactions} row(s); applied ${report.applied.length} (credited ${counts.credited}, failed ${counts.failed}, returned ${counts.returned}); already imported ${report.already_applied.length}; unmatched ${report.unmatched.length}; ambiguous ${report.ambiguous.length}; conflicts ${report.conflicts.length}`);
    for (const row of report.applied) {
        stdout(`  ${row.status.toUpperCase()} ${row.payout} — ${row.amount} ${row.currency || ''}${row.fee ? `, fee ${row.fee}` : ''}${row.fx_difference !== null && row.fx_difference !== undefined ? `, FX diff ${row.fx_difference}` : ''}`);
    }
    if (!flags['dry-run']) stdout(`Ledger: ${ledgerFile}`);
    return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        run();
    } catch (error) {
        console.error(`statement-import: ${error.message}`);
        process.exitCode = 1;
    }
}
