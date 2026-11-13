#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ProcurementAgent } from '../src/procurement/agent.mjs';
import { buildContentieuxCases } from '../src/procurement/contentieux.mjs';
import { parseAmanaScans } from '../src/procurement/carriers/amana.mjs';

/**
 * Safe bootstrap for existing procurement orders and carrier evidence.
 *
 * - Dry-run by default. `--apply` is required to write to the real store.
 * - Orders are normal validated requests; `created_at` backdates both creation
 *   and placement so aging is truthful.
 * - Evidence is read as supplied. The existing AMANA/timeline/POD rules decide
 *   whether a delivery is recorded or the PO goes on hold; this script never
 *   creates a POD or invents a scan.
 * - Unmatched or unsupported evidence is reported, never attached by guesswork.
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

const HELP = `Procurement import — existing orders + real carrier evidence

Usage:
  node scripts/import-procurement.mjs --orders orders.json [--evidence scans.json|dir] [--apply] [--json]

Options:
  --orders <file>      JSON array, a single request, or { "orders": [] }
  --evidence <path>    AMANA scan JSON file or a directory of *.json files
  --data-dir <dir>     Procurement store (default data/procurement)
  --min-days <n>       Contentieux threshold for the post-import summary (default 7)
  --apply              Write to the real store; without it everything runs in a temp copy
  --json               Print the full report as JSON
  --help               Show this help

Order entry shape:
  { "created_at": "2026-09-27T09:00:00+01:00", "place": true, "request": { ... } }
  (a plain request object is also accepted; it is created as a draft and is not placed)

Safety:
  - A PO is never marked delivered unless the scan file itself contains a valid
    carrier-prefixed POD, sufficient weight, matching destination city and a
    coherent timeline. Invalid evidence produces an explicit on_hold case.
  - Re-running is idempotent by external_id for orders. Evidence is only applied
    while the PO is shipped; already delivered/held POs are reported, not changed.
  - The importer never contacts a supplier or carrier and never moves money.`;

function readJson(file) {
    const resolved = path.resolve(file);
    if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function orderEntries(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.orders)) return payload.orders;
    return [payload];
}

function evidenceFiles(target) {
    if (!target) return [];
    const resolved = path.resolve(target);
    if (!fs.existsSync(resolved)) throw new Error(`Evidence path not found: ${resolved}`);
    if (fs.statSync(resolved).isDirectory()) {
        return fs.readdirSync(resolved)
            .filter(name => name.toLowerCase().endsWith('.json'))
            .sort()
            .map(name => path.join(resolved, name));
    }
    return [resolved];
}

function outcomeOf(po) {
    if (po.status === 'on_hold') return 'held';
    if (po.status === 'delivered') return 'delivered';
    if (po.status === 'shipped') return 'shipped';
    return po.status;
}

function importInto({ agent, orders, evidence, now, minDays = 7 }) {
    const report = {
        created_at: now.toISOString(),
        orders: { created: [], skipped: [], errors: [] },
        evidence: { files: 0, accepted: [], held: [], skipped: [], unmatched: [], errors: [] }
    };

    for (const entry of orders) {
        const request = entry?.request || entry;
        const createdAt = entry?.created_at || entry?.createdAt || null;
        const place = entry?.place === true;
        try {
            const result = agent.ingestRequests(request, { place, createdAt });
            for (const po of result.created) {
                report.orders.created.push({
                    po_ref: po.po_ref,
                    external_id: po.external_id,
                    status: po.status,
                    created_at: po.created_at,
                    placed_at: po.placed_at || null
                });
            }
            for (const skip of result.skipped) report.orders.skipped.push(skip);
        } catch (error) {
            report.orders.errors.push({
                external_id: request?.external_id || null,
                error: error.message
            });
        }
    }

    for (const file of evidence) {
        report.evidence.files += 1;
        let payload;
        try {
            payload = readJson(file);
        } catch (error) {
            report.evidence.errors.push({ file, error: error.message });
            continue;
        }
        const parsed = parseAmanaScans(payload);
        const carrier = String(payload?.carrier || parsed.carrier || 'AMANA').toUpperCase();
        if (carrier !== 'AMANA') {
            report.evidence.skipped.push({ file, reason: `unsupported carrier ${carrier}` });
            continue;
        }
        if (!parsed.shipment && !parsed.delivery) {
            report.evidence.skipped.push({ file, reason: 'no actionable shipment or delivery scan' });
            continue;
        }
        const poRef = payload?.po_ref
            || agent.list().find(po => po.tracking?.number === parsed.tracking)?.po_ref
            || null;
        if (!poRef) {
            report.evidence.unmatched.push({
                file,
                tracking: parsed.tracking,
                scans: parsed.scans.length
            });
            continue;
        }
        let before;
        try {
            before = agent.require(poRef);
        } catch (error) {
            report.evidence.unmatched.push({ file, po_ref: poRef, error: error.message });
            continue;
        }
        try {
            const result = agent.ingestTracking(payload);
            const po = result.po;
            const item = {
                file,
                po_ref: po.po_ref,
                tracking: parsed.tracking,
                status: po.status,
                outcome: outcomeOf(po),
                holds: (po.holds || []).map(hold => hold.code)
            };
            if (po.status === 'on_hold') report.evidence.held.push(item);
            else if (po.status === before.status) report.evidence.skipped.push({ ...item, reason: `already ${before.status}` });
            else report.evidence.accepted.push(item);
        } catch (error) {
            report.evidence.errors.push({ file, po_ref: poRef, error: error.message });
        }
    }

    const contentieux = buildContentieuxCases(agent.list(), { now, minDays });
    report.contentieux = {
        cases: contentieux.totals.cases,
        amount_mad: contentieux.totals.amount_mad,
        high: contentieux.totals.high,
        case_ids: contentieux.cases.map(item => item.case_id)
    };
    report.errors = report.orders.errors.length + report.evidence.errors.length;
    return report;
}

export function run(argv = process.argv.slice(2), { stdout = console.log } = {}) {
    const flags = parseArgs(argv);
    if (flags.help) {
        stdout(HELP);
        return null;
    }
    const ordersFile = flags.orders;
    if (!ordersFile) throw new Error('Missing --orders <file>');
    const dataDir = path.resolve(flags['data-dir'] || process.env.PROCUREMENT_DATA_DIR || 'data/procurement');
    const apply = Boolean(flags.apply);
    const orders = orderEntries(readJson(ordersFile));
    const evidence = evidenceFiles(flags.evidence);
    const now = new Date();

    let targetDir = dataDir;
    let tempDir = null;
    if (!apply) {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'procurement-import-'));
        if (fs.existsSync(dataDir)) fs.cpSync(dataDir, tempDir, { recursive: true });
        targetDir = tempDir;
    }

    try {
        const agent = new ProcurementAgent({ dir: targetDir, now: () => now });
        const report = importInto({
            agent,
            orders,
            evidence,
            now,
            minDays: flags['min-days'] === undefined ? 7 : Number(flags['min-days'])
        });
        report.mode = apply ? 'apply' : 'dry-run';
        report.data_dir = dataDir;

        if (flags.json) {
            stdout(JSON.stringify(report, null, 2));
        } else {
            const prefix = apply ? 'APPLIED' : 'DRY RUN (no files written)';
            stdout(`${prefix} — orders: ${report.orders.created.length} created, ${report.orders.skipped.length} skipped, ${report.orders.errors.length} errors`);
            for (const po of report.orders.created) stdout(`  created ${po.po_ref} — ${po.status} (${po.created_at})`);
            stdout(`  evidence: ${report.evidence.files} file(s), ${report.evidence.accepted.length} advanced, ${report.evidence.held.length} held, ${report.evidence.unmatched.length} unmatched, ${report.evidence.errors.length} errors`);
            for (const item of report.evidence.held) {
                stdout(`  HELD ${item.po_ref}: ${item.holds.join(', ')}`);
            }
            stdout(`  contentieux: ${report.contentieux.cases} case(s), ${report.contentieux.amount_mad} MAD at stake`);
            if (!apply) stdout('  Re-run with --apply to write this result.');
        }
        return report;
    } finally {
        if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        const report = run();
        if (report?.errors) process.exitCode = 1;
    } catch (error) {
        console.error(`procurement-import: ${error.message}`);
        process.exitCode = 1;
    }
}
