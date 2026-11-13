#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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
  ATTIJARI_ACCOUNT=<digits> node scripts/generate-attijari-csv.mjs --batch <payout.json> [--out-dir exports/bank-wire] [--date YYYY-MM-DD] [--dry-run]

Options:
  --batch <file>     Payout batch JSON (also ATTIJARI_BATCH_FILE)
  --account <digits> Beneficiary account (also ATTIJARI_ACCOUNT); never committed
  --out-dir <dir>    Output directory (default exports/bank-wire)
  --date <date>      Transfer date (default the batch created_at)
  --dry-run          Validate and print the summary without writing a file

Bulk CSV upload requires Attijari Entreprise/cash management. Personal
Attijarinet accounts must use unit transfers instead.`;

export function run(argv = process.argv.slice(2), { stdout = console.log } = {}) {
    const flags = parseArgs(argv);
    if (flags.help) {
        stdout(HELP);
        return null;
    }
    const batchFile = flags.batch || process.env.ATTIJARI_BATCH_FILE;
    if (!batchFile) throw new Error('Missing --batch <file> or ATTIJARI_BATCH_FILE');
    const account = flags.account || process.env.ATTIJARI_ACCOUNT;
    if (!account) throw new Error('Missing --account or ATTIJARI_ACCOUNT');

    const resolved = path.resolve(batchFile);
    if (!fs.existsSync(resolved)) throw new Error(`Batch file not found: ${resolved}`);
    const batch = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    const result = buildBankWireCsv(batch, { account, date: flags.date || null });

    const summary = `${result.batch_id}: ${result.rows.length} transfer(s), ${result.total_amount.toFixed(2)} ${result.currency} to ${maskAccount(account)}`;
    if (flags['dry-run']) {
        stdout(`DRY RUN — ${summary}; no file written`);
        return result;
    }

    const outDir = path.resolve(flags['out-dir'] || 'exports/bank-wire');
    fs.mkdirSync(outDir, { recursive: true });
    const filename = `bank_wire_${String(result.batch_id).replace(/[^A-Za-z0-9_-]/g, '_')}.csv`;
    const filepath = path.join(outDir, filename);
    fs.writeFileSync(filepath, `${result.csv}\n`);
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
