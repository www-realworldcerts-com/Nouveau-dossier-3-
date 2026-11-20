#!/usr/bin/env node
// Audits the local revenue ledger under the same rule the writer now enforces:
// only money backed by a payment-provider transaction id counts as verified.
// Self-issued proofs (`autonomous_execution`, `PROOF_*`) are reported as
// unverified instead of being summed as revenue.

import fs from 'node:fs';
import path from 'node:path';

import { readEncryptedJson } from '../src/security/data-at-rest.mjs';
import { classifyRevenueEvent, summarizeRevenueEvents } from '../src/real/revenue-verification.mjs';

const args = process.argv.slice(2);
const dirArg = args.find(arg => arg.startsWith('--dir='));
const dir = path.resolve(dirArg ? dirArg.slice('--dir='.length) : (process.env.LEDGER_DIR || 'data/autonomous/ledger'));
const asJson = args.includes('--json');

function readJson(file) {
    try {
        return readEncryptedJson(file);
    } catch {
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            return null;
        }
    }
}

/**
 * Revenue events only: an amount plus a revenue id or a proof. Payout `items`
 * rows and `earning` records live in the same directory and are obligations,
 * not revenue, so they are never counted here.
 */
function revenueEvents(value) {
    const found = [];
    const consider = (node) => {
        if (!node || typeof node !== 'object' || Array.isArray(node)) return;
        const isRevenue = Number.isFinite(Number(node.amount)) && node.currency
            && (node.event_id || node.verification_proof || node.metadata?.verification_proof);
        if (isRevenue) found.push(node);
    };
    consider(value);
    if (value && typeof value === 'object' && value.data && typeof value.data === 'object' && !Array.isArray(value.data)) {
        consider(value.data);
    }
    return found;
}

if (!fs.existsSync(dir)) {
    console.error(`Ledger directory not found: ${dir}`);
    process.exit(2);
}

const events = [];
for (const name of fs.readdirSync(dir).filter(file => file.endsWith('.json'))) {
    for (const event of revenueEvents(readJson(path.join(dir, name)))) {
        events.push({ ...event, __file: name });
    }
}

const summary = summarizeRevenueEvents(events);
const detail = events.map(event => {
    const verdict = classifyRevenueEvent(event);
    return {
        file: event.__file,
        event_id: event.event_id ?? event.id ?? null,
        amount: Number(event.amount) || 0,
        currency: event.currency ?? null,
        status: event.status ?? null,
        verified: verdict.verified,
        reason: verdict.reason,
        provider: verdict.provider,
        psp_id: verdict.psp_id
    };
});

if (asJson) {
    console.log(JSON.stringify({ directory: dir, summary, events: detail }, null, 2));
    process.exit(0);
}

console.log(`Revenue proof audit: ${dir}`);
console.log('='.repeat(64));
console.log(`${events.length} revenue event(s) in the ledger`);
console.log(`  verified (provider transaction id): ${summary.verified}`);
console.log(`  unverified:                        ${summary.unverified}`);

if (summary.unverified) {
    console.log('\nUnverified, never counted as revenue:');
    for (const row of detail.filter(item => !item.verified)) {
        console.log(`  ${row.amount.toFixed(2)} ${row.currency || '?'}  ${row.event_id || '(no id)'}  ${row.reason}${row.psp_id ? ` (${row.psp_id})` : ''}  [${row.file}]`);
    }
}

console.log('\nBy currency:');
for (const row of summary.by_currency) {
    console.log(`  ${row.currency}: verified ${row.verified.toFixed(2)}, unverified ${row.unverified.toFixed(2)}`);
}

if (summary.reasons && Object.keys(summary.reasons).length) {
    console.log('\nUnverified reasons:');
    for (const [reason, count] of Object.entries(summary.reasons)) console.log(`  ${reason}: ${count}`);
}
