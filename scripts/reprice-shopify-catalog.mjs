#!/usr/bin/env node
import '../src/load-env.mjs';

import fs from 'node:fs';
import path from 'node:path';

import { loadCourseCatalog } from '../src/sales/course-catalog.mjs';
import { repriceShopifyCatalog, rollbackShopifyReprice } from '../src/sales/shopify-reprice.mjs';
import { parseArgs } from '../src/sales/shopify-launch-settings.mjs';
import { shopifySettingsFromEnv } from '../src/sales/shopify.mjs';

function help() {
    console.log(`Safely reprice active Shopify products from the canonical catalog.

Usage:
  node scripts/reprice-shopify-catalog.mjs [options]
  node scripts/reprice-shopify-catalog.mjs --rollback <run-id|latest>

Options:
  --catalog <file>        Canonical catalog (default config/course-catalog.json)
  --course <slug>         Reprice one course (repeatable or comma-separated)
  --store-currency <ISO>  Override the currency from /shop.json
  --data-dir <dir>        Run reports and locks (default SALES_DATA_DIR or data/sales)
  --dry-run               Show the price changes without writing
  --rollback <run-id>     Restore a previous reprice snapshot (or "latest")
  --json                  Machine-readable output
  --help                  Show this help

Only active products with one variant are eligible. Draft products must use
shopify:publish and shopify:activate. Each real run snapshots every prior
price, updates the batch, verifies the result, and restores the snapshot on
failure. The command shares the catalog-mutation lock with shopify:activate.
`);
}

async function main() {
    const flags = parseArgs(process.argv.slice(2));
    if (flags.help) return help();

    const dataDir = path.resolve(
        flags['data-dir'] || process.env.SALES_DATA_DIR || 'data/sales'
    );
    const settings = shopifySettingsFromEnv();

    if (flags.rollback) {
        const report = await rollbackShopifyReprice({
            settings,
            dataDir,
            runId: flags.rollback
        });
        fs.mkdirSync(dataDir, { recursive: true });
        const reportPath = path.join(dataDir, 'ShopifyRepriceRollback.json');
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });

        if (flags.json) {
            console.log(JSON.stringify(report, null, 2));
        } else {
            console.log(`shopify reprice rollback: ${report.status}`);
            if (report.run_id) console.log(`run: ${report.run_id}`);
            if (report.reason) console.log(`reason: ${report.reason}`);
            if (report.rollback) {
                console.log(`restored: ${report.rollback.restored?.length || 0}`);
                for (const row of report.rollback.errors || []) {
                    console.log(`  FAILED product ${row.product_id}: ${row.reason}${row.error ? ` (${row.error})` : ''}`);
                }
            }
            console.log(`report: ${reportPath}`);
        }
        if (report.status !== 'rolled_back') process.exitCode = 1;
        return;
    }

    const catalog = loadCourseCatalog(flags.catalog ? path.resolve(flags.catalog) : undefined);
    const courseIds = flags.course
        ? String(flags.course).split(',').map(slug => slug.trim()).filter(Boolean)
        : null;
    const report = await repriceShopifyCatalog({
        catalog,
        courseIds,
        settings,
        storeCurrency: flags['store-currency'] || null,
        dataDir,
        dryRun: Boolean(flags['dry-run'])
    });

    const latestReportPath = path.join(
        dataDir,
        flags['dry-run'] ? 'ShopifyRepriceDryRun.json' : 'ShopifyRepriceReport.json'
    );
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(latestReportPath, JSON.stringify(report, null, 2), { mode: 0o600 });

    if (flags.json) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        console.log(`shopify reprice: ${report.status}`);
        if (report.run_id) console.log(`run: ${report.run_id}`);
        if (report.reason) console.log(`reason: ${report.reason}`);
        if (report.store_currency) console.log(`store price: ${report.store_currency}`);
        if (report.changed !== undefined) console.log(`changed: ${report.changed}`);
        if (report.unchanged !== undefined) console.log(`unchanged: ${report.unchanged}`);
        for (const row of report.changes || []) {
            console.log(`  - ${row.course_id} (${row.product_id}): ` +
                `${row.from_price} -> ${row.to_price} ${row.currency}`);
        }
        for (const row of report.errors || []) {
            console.log(`  BLOCKED ${row.course_id || 'catalog'}: ${row.reason}` +
                `${row.error ? ` (${row.error})` : ''}`);
        }
        if (report.failure) {
            console.log(`failure: ${report.failure.reason} at ${report.failure.stage}`);
        }
        if (report.rollback) {
            console.log(`rollback: ${report.rollback.ok ? 'complete' : 'incomplete'} ` +
                `(${report.rollback.restored?.length || 0} restored)`);
            for (const row of report.rollback.errors || []) {
                console.log(`  FAILED product ${row.product_id}: ${row.reason}${row.error ? ` (${row.error})` : ''}`);
            }
        }
        if (report.verification) {
            console.log(`verification: ${report.verification.ok ? 'ok' : 'failed'}`);
        }
        console.log(`report: ${report.report_path || latestReportPath}`);
    }

    const ok = report.dry_run
        ? report.ready === true
        : report.status === 'ok';
    if (!ok) process.exitCode = 1;
}

main().catch(error => {
    console.error(`reprice-shopify-catalog: ${error.message}`);
    process.exit(1);
});
