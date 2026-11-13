#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import { ProcurementAgent } from '../src/procurement/agent.mjs';
import { buildContentieuxCases, renderContentieuxMarkdown } from '../src/procurement/contentieux.mjs';

/**
 * Build a contentieux (dispute) case file for late or held purchase orders.
 * Read-only: it never advances a PO or records delivery evidence.
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

const HELP = `Procurement contentieux — compile late or held POs into a case file.

Usage:
  node scripts/contentieux.mjs [--min-days 7] [--data-dir data/procurement] [--out exports/contentieux.md] [--json]

Options:
  --min-days <n>     Include non-held POs waiting at least n days (default 7)
  --data-dir <dir>   Procurement state directory (default data/procurement)
  --out <file>       Write the Markdown case file to this path
  --json             Print JSON instead of Markdown
  --help             Show this help

On-hold POs are always included, whatever their age. Exit code 0 even when
cases exist: this report is informational and must not block a tick.`;

export function run(argv = process.argv.slice(2), { stdout = console.log } = {}) {
    const flags = parseArgs(argv);
    if (flags.help) {
        stdout(HELP);
        return null;
    }
    const agent = new ProcurementAgent({
        dir: flags['data-dir'] || process.env.PROCUREMENT_DATA_DIR || 'data/procurement'
    });
    const report = buildContentieuxCases(agent.list(), {
        minDays: flags['min-days'] === undefined ? 7 : Number(flags['min-days'])
    });

    if (flags.json) {
        const payload = JSON.stringify(report, null, 2);
        if (flags.out) fs.writeFileSync(path.resolve(flags.out), `${payload}\n`);
        stdout(payload);
        return report;
    }

    const markdown = renderContentieuxMarkdown(report);
    if (flags.out) {
        fs.mkdirSync(path.dirname(path.resolve(flags.out)), { recursive: true });
        fs.writeFileSync(path.resolve(flags.out), `${markdown}\n`);
        stdout(`Wrote ${flags.out} (${report.cases.length} cases, ${report.totals.amount_mad} MAD at stake)`);
    } else {
        stdout(markdown);
    }
    return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run();
}
