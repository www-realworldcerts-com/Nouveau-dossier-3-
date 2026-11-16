#!/usr/bin/env node
import '../src/load-env.mjs';

import fs from 'node:fs';
import path from 'node:path';

import { loadCourseCatalog } from '../src/sales/course-catalog.mjs';
import { activateCatalog } from '../src/sales/shopify-activation.mjs';
import { launchSettingsFromArgs, parseArgs } from '../src/sales/shopify-launch-settings.mjs';

function help() {
    console.log(`Activate published Shopify drafts after the launch gate passes.

Usage:
  node scripts/activate-shopify-catalog.mjs [options]

Options:
  --catalog <file>        Canonical catalog (default config/course-catalog.json)
  --course <slug>         Activate one course (repeatable or comma-separated)
  --canary-course <slug>  Product to activate first for the checkout canary
  --canary-country <code> Two-letter country for canary shipping/tax (default US)
  --payout-attestation <file>  Owner attestation for an external payout provider
  --resume <run-id>       Resume an interrupted activation run (or "latest")
  --dry-run               Report the activation plan without writing to Shopify
  --json                  Machine-readable output
  --help                  Show this help

The command acquires an exclusive run lock, snapshots every selected product's
status and Online Store publication state, then temporarily activates one
canary product and runs the launch gate. The remaining products are activated
only when the gate passes. Any failure restores every snapshotted state. An
interrupted run can be resumed with --resume.
`);
}

async function main() {
    const flags = parseArgs(process.argv.slice(2));
    if (flags.help) return help();

    const catalog = loadCourseCatalog(flags.catalog ? path.resolve(flags.catalog) : undefined);
    const courseIds = flags.course
        ? String(flags.course).split(',').map(slug => slug.trim()).filter(Boolean)
        : null;
    const settings = launchSettingsFromArgs(flags);
    const dataDir = path.resolve(process.env.SALES_DATA_DIR || 'data/sales');
    const report = await activateCatalog({
        catalog,
        courseIds,
        settings,
        dataDir,
        resumeRunId: flags.resume || null,
        dryRun: Boolean(flags['dry-run'])
    });
    const latestReportPath = path.join(
        dataDir,
        flags['dry-run'] ? 'ShopifyActivationDryRun.json' : 'ShopifyActivationReport.json'
    );
    const reportPath = report.report_path || latestReportPath;
    fs.mkdirSync(dataDir, { recursive: true });
    report.report_path = reportPath;
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
    if (reportPath !== latestReportPath) {
        fs.writeFileSync(latestReportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
    }

    if (flags.json) {
        console.log(JSON.stringify(report, null, 2));
    } else if (report.dry_run) {
        console.log(`shopify activation dry-run: ${report.ready ? 'ready' : 'blocked'}`);
        if (report.reason) console.log(`reason: ${report.reason}`);
        if (report.selected_count !== undefined) {
            console.log(`selected: ${report.selected_count} of ${report.product_count} products`);
        }
        if (report.price_check) {
            console.log(`price check: ${report.price_check.ok ? 'ok' : 'failed'} ` +
                `(${report.price_check.checked_variants} variants)`);
        }
        if (report.publication) {
            console.log(`publication: ${report.publication.name} ` +
                `(${report.publication.action_count} to publish)`);
        }
        if (report.collection) {
            console.log(`collection: ${report.collection.action} ` +
                `(${report.collection.addition_count} additions)`);
        }
        for (const product of report.products || []) {
            console.log(`  - ${product.course_id} (${product.product_id}): ` +
                `status=${product.status}, activation=${product.activation_action}, ` +
                `publication=${product.publication_action}, collection=${product.collection_action}`);
        }
        if (report.blockers?.length) {
            console.log('readiness blockers:');
            for (const blocker of report.blockers) console.log(`  - ${blocker}`);
        }
        if (report.warnings?.length) {
            for (const warning of report.warnings) console.log(`warning: ${warning}`);
        }
        console.log(`report: ${reportPath}`);
    } else {
        console.log(`shopify activation: ${report.status}`);
        if (report.run_id) {
            console.log(`run: ${report.run_id}${report.resumed ? ' (resumed)' : ''}`);
        }
        if (report.reason) console.log(`reason: ${report.reason}`);
        if (report.activated !== undefined) console.log(`activated: ${report.activated}`);
        if (report.unchanged !== undefined) console.log(`unchanged: ${report.unchanged}`);
        if (report.canary) {
            console.log(`canary: ${report.canary.course} (${report.canary.product_id})` +
                (report.canary.reverted ? ' reverted to draft' : ''));
        }
        if (report.price_check?.mismatches?.length) {
            console.log('variant mismatches:');
            for (const row of report.price_check.mismatches) {
                const detail = row.expected !== undefined
                    ? ` (expected ${row.expected} ${row.currency || ''}, got ${row.actual})`
                    : '';
                console.log(`  - ${row.course_id || 'catalog'}: ${row.reason}${detail}`);
            }
        }
        if (report.publication_check?.failures?.length) {
            console.log('publication failures:');
            for (const row of report.publication_check.failures) {
                console.log(`  - ${row.course_id}: ${row.errors.join('; ')}`);
            }
        }
        if (report.publication_check?.unpublished?.length) {
            console.log('not published to Online Store:');
            for (const row of report.publication_check.unpublished) {
                console.log(`  - ${row.course_id} (product ${row.product_id})`);
            }
        }
        if (report.blockers?.length) {
            console.log('launch blockers:');
            for (const blocker of report.blockers) console.log(`  - ${blocker}`);
        }
        if (report.failed?.length) {
            for (const row of report.failed) console.log(`  FAILED ${row.course_id}: ${row.error}`);
        }
        if (report.rollback && !report.rollback.ok) {
            console.log('rollback incomplete:');
            for (const row of report.rollback.errors || []) {
                console.log(`  - product ${row.product_id} ${row.stage}: ${row.error}`);
            }
        }
        if (report.next_step) console.log(`next: ${report.next_step}`);
        console.log(`report: ${reportPath}`);
    }

    if (report.dry_run ? !report.ready : report.status !== 'ok') process.exitCode = 1;
}

main().catch(error => {
    console.error(`activate-shopify-catalog: ${error.message}`);
    process.exit(1);
});
