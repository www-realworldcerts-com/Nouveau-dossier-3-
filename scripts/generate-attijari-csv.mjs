#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    DEFAULT_HISTORY_DIR,
    DEFAULT_LEDGER_FILE,
    PayoutLedgerConflictError,
    findPayoutConflicts,
    loadPayoutLedger,
    markCredited,
    readPayoutHistory,
    recordSubmitted,
    savePayoutLedger
} from '../src/financial/payout-ledger.mjs';
import { readEncryptedJson } from '../src/security/data-at-rest.mjs';

/**
 * Build an Attijariwafa bank-wire CSV from a payout batch.
 *
 * The account number is never committed and never printed: pass it with
 * --account or ATTIJARI_ACCOUNT. Bulk CSV transfer is an Attijari Entreprise
 * feature; a personal Attijarinet account cannot upload these files, so this
 * output is only usable when the account is a business/cash-management one.
 */

export const HEADERS = [
    'Beneficiary Account',
    'Amount',
    'Currency',
    'Reference',
    'Date',
    'Description'
];

function csvCell(value) {
    const text = String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function batchItems(batch) {
    const payload = batch?.data && Array.isArray(batch.data.items) ? batch.data : batch;
    return { payload, items: Array.isArray(payload?.items) ? payload.items : [] };
}

export function normalizeAccount(account) {
    const digits = String(account ?? '').replace(/\s+/g, '');
    if (!/^\d{10,34}$/.test(digits)) {
        throw new Error('Attijari account must be 10-34 digits (use --account or ATTIJARI_ACCOUNT)');
    }
    return digits;
}

export function maskAccount(account) {
    const digits = String(account ?? '');
    return digits.length <= 4 ? '****' : `****${digits.slice(-4)}`;
}

export function buildBankWireCsv(batch, { account, date = null } = {}) {
    const beneficiary = normalizeAccount(account);
    const { payload, items } = batchItems(batch);
    if (!items.length) throw new Error('Batch has no items to transfer');

    const batchId = payload.batch_id || payload.id || 'batch';
    const created = date || payload.created_at || new Date().toISOString();
    const parsed = new Date(created);
    if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid date: ${created}`);
    const transferDate = parsed.toISOString().slice(0, 10);

    const currencies = new Set();
    const entries = [];
    const rows = items.map((item, index) => {
        const amount = Number(item.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
            throw new Error(`Item ${item.item_id || index + 1} has an invalid amount`);
        }
        const currency = String(item.currency || payload.currency || '').toUpperCase();
        if (!/^[A-Z]{3}$/.test(currency)) {
            throw new Error(`Item ${item.item_id || index + 1} has an invalid currency`);
        }
        currencies.add(currency);
        const reference = String(item.item_id || item.earning_id || '').trim();
        if (!reference) throw new Error(`Item ${index + 1} has no reference`);
        const description = `Autonomous revenue settlement - ${item.earning_id || reference}`;
        entries.push({
            earning_id: item.earning_id ? String(item.earning_id) : null,
            item_id: item.item_id ? String(item.item_id) : null,
            amount,
            currency,
            reference,
            description
        });
        return [beneficiary, amount.toFixed(2), currency, reference, transferDate, description];
    });

    if (currencies.size > 1) {
        throw new Error(`Batch mixes currencies (${[...currencies].join(', ')}); split it before export`);
    }

    return {
        batch_id: batchId,
        currency: [...currencies][0],
        total_amount: rows.reduce((sum, row) => sum + Number(row[1]), 0),
        rows,
        entries,
        csv: [HEADERS, ...rows].map(row => row.map(csvCell).join(',')).join('\n')
    };
}

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

const HELP = `Attijariwafa bank-wire CSV

Usage:
  ATTIJARI_ACCOUNT=<digits> node scripts/generate-attijari-csv.mjs --batch <payout.json> [options]
  node scripts/generate-attijari-csv.mjs --mark-credited <earning|item|payout id> [--bank-ref <ref>]

Options:
  --batch <file>     Payout batch JSON (also ATTIJARI_BATCH_FILE)
  --account <digits> Beneficiary account (also ATTIJARI_ACCOUNT); never committed
  --out-dir <dir>    Output directory (default exports/bank-wire)
  --date <date>      Transfer date (default the batch created_at)
  --dry-run          Validate, check duplicates and print the summary without writing
  --ledger <file>    Payout ledger (default data/financial/payout_ledger.json)
  --history-dir <d>  Existing batch directory checked for duplicates
  --no-history       Only check the ledger (for isolated tests; not for real exports)
  --mark-credited <id>  Move a submitted payout to credited
  --bank-ref <ref>   Bank/Payoneer reference stored with the credit
  --credited-at <iso> Credit timestamp (default now)

Every earning_id and item_id is reserved permanently once exported. The same
identifier appearing in any historical batch or in the ledger blocks the export.

Bulk CSV upload requires Attijari Entreprise/cash management. Personal
Attijarinet accounts must use unit transfers instead.`;

export function run(argv = process.argv.slice(2), { stdout = console.log } = {}) {
    const flags = parseArgs(argv);
    if (flags.help) {
        stdout(HELP);
        return null;
    }

    const ledgerFile = path.resolve(
        flags.ledger || process.env.PAYOUT_LEDGER_FILE || DEFAULT_LEDGER_FILE
    );

    if (flags['mark-credited']) {
        const ledger = loadPayoutLedger(ledgerFile);
        const next = markCredited(ledger, flags['mark-credited'], {
            at: flags['credited-at'] || new Date(),
            bankReference: flags['bank-ref'] || null
        });
        savePayoutLedger(ledgerFile, next);
        stdout(`Marked ${flags['mark-credited']} credited in ${ledgerFile}`);
        return next;
    }

    const batchFile = flags.batch || process.env.ATTIJARI_BATCH_FILE;
    if (!batchFile) throw new Error('Missing --batch <file> or ATTIJARI_BATCH_FILE');
    const account = flags.account || process.env.ATTIJARI_ACCOUNT;
    if (!account) throw new Error('Missing --account or ATTIJARI_ACCOUNT');

    const resolved = path.resolve(batchFile);
    if (!fs.existsSync(resolved)) throw new Error(`Batch file not found: ${resolved}`);
    const batch = readEncryptedJson(resolved);
    const result = buildBankWireCsv(batch, { account, date: flags.date || null });

    const ledger = loadPayoutLedger(ledgerFile);
    const history = flags['no-history']
        ? new Map()
        : readPayoutHistory(
            flags['history-dir'] || process.env.PAYOUT_HISTORY_DIR || DEFAULT_HISTORY_DIR,
            { excludeBatchId: result.batch_id }
        );
    const conflicts = findPayoutConflicts(result.entries, { ledger, history });
    if (conflicts.length) throw new PayoutLedgerConflictError(conflicts);

    const summary = `${result.batch_id}: ${result.rows.length} transfer(s), ${result.total_amount.toFixed(2)} ${result.currency} to ${maskAccount(account)}`;
    if (flags['dry-run']) {
        stdout(`DRY RUN — ${summary}; no file written`);
        return result;
    }

    const outDir = path.resolve(flags['out-dir'] || 'exports/bank-wire');
    fs.mkdirSync(outDir, { recursive: true });
    const filename = `bank_wire_${String(result.batch_id).replace(/[^A-Za-z0-9_-]/g, '_')}.csv`;
    const filepath = path.join(outDir, filename);
    const tmp = `${filepath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${result.csv}\n`);
    try {
        const next = recordSubmitted(ledger, result.entries, {
            batchId: result.batch_id,
            csvFile: path.relative(process.cwd(), filepath)
        });
        savePayoutLedger(ledgerFile, next);
        fs.renameSync(tmp, filepath);
    } catch (error) {
        try {
            fs.unlinkSync(tmp);
        } catch {
            // The temp file may already be gone; the ledger is the safety record.
        }
        throw error;
    }
    stdout(`Wrote ${filepath} — ${summary}`);
    return result;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        run();
    } catch (error) {
        console.error(`attijari: ${error.message}`);
        process.exitCode = 1;
    }
}
