#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import { ProcurementAgent } from '../src/procurement/agent.mjs';

/**
 * Procurement CLI: create POs, advance them, ingest carrier scans, verify
 * delivery evidence and report what is still outstanding.
 */

function parseArgs(argv) {
    const [command = 'help', ...rest] = argv;
    const flags = {};
    const positional = [];
    for (let i = 0; i < rest.length; i += 1) {
        const token = rest[i];
        if (token.startsWith('--')) {
            const key = token.slice(2);
            const next = rest[i + 1];
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

function readJson(file) {
    if (!file) return null;
    const resolved = path.resolve(file);
    if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function buildAgent(flags) {
    return new ProcurementAgent({
        dir: flags['data-dir'] || process.env.PROCUREMENT_DATA_DIR || 'data/procurement'
    });
}

function printPos(pos, json) {
    if (json) return console.log(JSON.stringify(pos, null, 2));
    if (!pos.length) {
        console.log('No purchase orders recorded.');
        return;
    }
    console.log('PO ref                                status     supplier      recipient            total MAD  waiting');
    for (const po of pos) {
        console.log([
            po.po_ref.padEnd(36),
            po.status.padEnd(10),
            String(po.supplier).slice(0, 12).padEnd(13),
            String(po.recipient?.name || '').slice(0, 20).padEnd(20),
            String(po.subtotal_mad).padStart(9),
            po.status === 'placed' || po.status === 'shipped' || po.status === 'on_hold' ? 'yes' : '—'
        ].join(' '));
    }
}

function printReport(report, json) {
    if (json) return console.log(JSON.stringify(report, null, 2));
    console.log(`Procurement status — ${report.generated_at}`);
    console.log(`  POs: ${report.total_pos}; verified value: ${report.verified_total_mad} MAD`);
    console.log(`  counts: ${Object.entries(report.counts).map(([status, count]) => `${status}=${count}`).join(', ')}`);
    if (!report.outstanding.length) {
        console.log('  No deliveries outstanding.');
    } else {
        console.log('\n  Outstanding deliveries:');
        for (const row of report.outstanding) {
            console.log(`  ${row.po_ref} — ${row.status}, ${row.waiting_days}d — ${row.next_action}`);
            if (row.holds.length) console.log(`      holds: ${row.holds.join(', ')}`);
        }
    }
    if (report.ready_to_close.length) {
        console.log(`\n  Ready to close: ${report.ready_to_close.join(', ')}`);
    }
}

const HELP = `Procurement agent — create POs, track deliveries, verify evidence.

Usage:
  node scripts/procurement.mjs <command> [options]

Commands:
  ingest <file>                  Create POs from a request (object or { requests: [] })
  place <poRef>                  Mark a PO as placed with the supplier
  ship <poRef> --carrier AMANA --tracking <n> [--at ISO] [--scans file]
  track <file>                   Ingest AMANA scans (PICKUP/HUB/DELIVER) and advance the PO
  deliver <poRef> --evidence <file> [--receipt <file>] [--invoice <file>]
  verify <poRef> --receipt <file> --invoice <file> [--evidence <file>]
  close <poRef>                  Close a verified PO
  list [--status <status>]       List latest PO state
  status                         Outstanding deliveries and next actions
  help                           Show this help

Options:
  --data-dir <dir>   State directory (default data/procurement)
  --created-at ISO   Backfill the PO creation time (ingest only)
  --json             Machine-readable output

Exit codes: 0 success, 1 error, 2 verification failed (holds remain).`;

async function main() {
    const { command, flags, positional } = parseArgs(process.argv.slice(2));
    const json = Boolean(flags.json);
    if (command === 'help' || flags.help) return console.log(HELP);

    const agent = buildAgent(flags);

    if (command === 'ingest') {
        const payload = readJson(flags.file || positional[0]);
        const result = agent.ingestRequests(payload, { place: Boolean(flags.place), createdAt: flags['created-at'] || null });
        if (json) return console.log(JSON.stringify(result, null, 2));
        for (const po of result.created) console.log(`created ${po.po_ref} — ${po.subtotal_mad} MAD (${po.status})`);
        for (const skip of result.skipped) console.log(`skipped ${skip.external_id} — already ingested as ${skip.po_ref}`);
        return;
    }

    if (command === 'list') {
        const all = agent.list();
        const filtered = flags.status ? all.filter(po => po.status === flags.status) : all;
        return printPos(filtered, json);
    }

    if (command === 'status') {
        return printReport(agent.status(), json);
    }

    const poRef = positional[0] || flags.po;
    if (!poRef && command !== 'track') throw new Error(`${command} requires a PO reference`);

    if (command === 'place') {
        const po = agent.place(poRef);
        console.log(json ? JSON.stringify(po, null, 2) : `${po.po_ref} placed (${po.subtotal_mad} MAD)`);
        return;
    }

    if (command === 'ship') {
        const po = agent.ship(poRef, {
            carrier: flags.carrier,
            tracking: flags.tracking,
            shipped_at: flags.at,
            scans: flags.scans ? readJson(flags.scans)?.scans || [] : []
        });
        console.log(json ? JSON.stringify(po, null, 2) : `${po.po_ref} shipped via ${po.carrier} (${po.tracking.number})`);
        return;
    }

    if (command === 'track') {
        const result = agent.ingestTracking(readJson(flags.file || positional[0]));
        if (json) return console.log(JSON.stringify(result, null, 2));
        const po = result.po;
        console.log(`${po.po_ref} → ${po.status}${result.delivery?.ok ? ' (delivery evidence accepted)' : ''}`);
        if (result.delivery && !result.delivery.ok) {
            for (const hold of result.delivery.holds) console.log(`  HOLD ${hold.code}: ${hold.detail}`);
        }
        return;
    }

    if (command === 'deliver') {
        const result = agent.deliver(poRef, {
            evidence: readJson(flags.evidence),
            receipt: flags.receipt ? readJson(flags.receipt) : null,
            invoice: flags.invoice ? readJson(flags.invoice) : null
        });
        if (json) {
            console.log(JSON.stringify(result, null, 2));
            process.exitCode = result.ok ? 0 : 2;
            return;
        }
        console.log(`${result.po.po_ref} → ${result.po.status}`);
        for (const hold of result.holds) console.log(`  HOLD ${hold.code}: ${hold.detail}`);
        if (!result.ok) process.exitCode = 2;
        return;
    }

    if (command === 'verify') {
        const result = agent.verify(poRef, {
            evidence: flags.evidence ? readJson(flags.evidence) : null,
            receipt: readJson(flags.receipt),
            invoice: readJson(flags.invoice)
        });
        if (json) {
            console.log(JSON.stringify(result, null, 2));
            process.exitCode = result.ok ? 0 : 2;
            return;
        }
        console.log(`${result.po.po_ref} → ${result.po.status}`);
        for (const check of result.checks) console.log(`  ${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`);
        for (const hold of result.holds) console.log(`  HOLD ${hold.code}: ${hold.detail}`);
        if (!result.ok) process.exitCode = 2;
        return;
    }

    if (command === 'close') {
        const po = agent.close(poRef);
        console.log(json ? JSON.stringify(po, null, 2) : `${po.po_ref} closed (verified delivery ${po.subtotal_mad} MAD)`);
        return;
    }

    console.log(HELP);
}

main().catch(error => {
    console.error(`procurement: ${error.message}`);
    process.exit(1);
});
