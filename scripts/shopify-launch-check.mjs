#!/usr/bin/env node
import '../src/load-env.mjs';

import fs from 'node:fs';
import path from 'node:path';

import { loadCourseCatalog } from '../src/sales/course-catalog.mjs';
import { checkShopifyLaunchReadiness } from '../src/sales/shopify-launch-readiness.mjs';
import { launchSettingsFromArgs, parseArgs } from '../src/sales/shopify-launch-settings.mjs';

function help() {
    console.log(`Verify the Shopify store can accept money before products go active.

Usage:
  node scripts/shopify-launch-check.mjs [options]

Options:
  --catalog <file>        Canonical catalog (default config/course-catalog.json)
  --shop-domain <domain>  Override SHOPIFY_STORE_DOMAIN
  --expected-domain <d>   Override SHOPIFY_PRIMARY_DOMAIN
  --canary-course <slug>  Override SHOPIFY_CANARY_COURSE
  --payout-attestation <file>  Owner attestation for an external payout provider
  --course <slug>         Check selected course(s), repeatable/comma-separated
  --json                  Machine-readable output
  --help                  Show this help

Required environment:
  SHOPIFY_ADMIN_TOKEN, SHOPIFY_STORE_DOMAIN,
  SHOPIFY_STOREFRONT_ACCESS_TOKEN, SHOPIFY_STOREFRONT_URL.

The check creates a Storefront cart and fetches its checkout URL. It does not
complete a payment or create an order.`);
}

async function main() {
    const flags = parseArgs(process.argv.slice(2));
    if (flags.help) return help();

    const settings = launchSettingsFromArgs(flags);
    const catalog = loadCourseCatalog(flags.catalog ? path.resolve(flags.catalog) : undefined);
    const courseIds = flags.course
        ? String(flags.course).split(',').map(slug => slug.trim()).filter(Boolean)
        : null;
    const report = await checkShopifyLaunchReadiness(settings, { catalog, courseIds });
    const dataDir = path.resolve(process.env.SALES_DATA_DIR || 'data/sales');
    const reportPath = path.join(dataDir, 'ShopifyLaunchReport.json');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    if (flags.json) {
        console.log(JSON.stringify({ ...report, report_path: reportPath }, null, 2));
    } else {
        console.log(`Shopify launch readiness — ${report.expected_domain || settings.domain || 'unknown shop'}`);
        for (const row of report.checks || []) {
            const payoutDetail = row.id === 'payouts' && row.mode === 'external_attestation'
                ? ` provider=${row.provider} destination=${row.destination}`
                : '';
            console.log(`  [${row.ok ? 'PASS' : 'FAIL'}] ${row.id.padEnd(20)} ${row.reason || 'ok'}${payoutDetail}`);
        }
        console.log(`  selected products: ${report.selected_count ?? 0}`);
        if (report.blockers?.length) {
            console.log('\nBlockers:');
            for (const blocker of report.blockers) console.log(`  - ${blocker}`);
        }
        if (report.warnings?.length) {
            console.log('\nWarnings:');
            for (const warning of report.warnings) console.log(`  - ${warning}`);
        }
        console.log(`\nReport: ${reportPath}`);
    }

    process.exitCode = report.ready ? 0 : 2;
}

main().catch(error => {
    console.error(`shopify-launch-check: ${error.message}`);
    process.exit(1);
});
