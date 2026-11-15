#!/usr/bin/env node
import '../src/load-env.mjs';

import path from 'node:path';

import { publishCatalogToShopify } from '../src/sales/catalog-publisher.mjs';
import { loadCourseCatalog } from '../src/sales/course-catalog.mjs';
import { shopifySettingsFromEnv } from '../src/sales/shopify.mjs';

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

function help() {
    console.log(`Publish the canonical catalog to Shopify.

Usage:
  node scripts/publish-shopify-catalog.mjs [options]

Options:
  --catalog <file>        Canonical catalog (default config/course-catalog.json)
  --course <slug>         Publish one course (repeatable or comma-separated)
  --store-currency <ISO>  Override the currency from /shop.json
  --dry-run               Validate and show prices without writing products
  --json                  Machine-readable output

Prices always come from the catalog. The store-currency amount is derived from
the catalog FX table; there is no CLI price override.
`);
}

async function main() {
    const flags = parseArgs(process.argv.slice(2));
    if (flags.help) return help();

    const catalog = loadCourseCatalog(flags.catalog ? path.resolve(flags.catalog) : undefined);
    const courseIds = flags.course
        ? String(flags.course).split(',').map(slug => slug.trim()).filter(Boolean)
        : null;
    const settings = shopifySettingsFromEnv();
    const result = await publishCatalogToShopify({
        catalog,
        courseIds,
        settings,
        storeCurrency: flags['store-currency'] || null,
        dryRun: Boolean(flags['dry-run'])
    });

    if (flags.json) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        console.log(`catalog:       ${catalog.file}`);
        console.log(`catalog price: ${catalog.currency}`);
        console.log(`status:        ${result.status}`);
        if (result.reason) console.log(`reason:        ${result.reason}`);
        if (result.store_currency) {
            console.log(`store price:   ${result.store_currency}${result.converted ? ' (converted)' : ''}`);
        }
        if (result.total) console.log(`courses:       ${result.total}`);
        if (result.dry_run) {
            for (const row of result.preview || []) {
                console.log(`  ${row.course_id}: ${row.price} ${row.currency}`);
            }
        } else if (result.published) {
            console.log(`created:       ${result.created}`);
            console.log(`updated:       ${result.updated}`);
            console.log(`unchanged:     ${result.unchanged}`);
            console.log(`failed:        ${result.failed.length}`);
        }
        if (result.failed?.length) {
            for (const row of result.failed) console.log(`  FAILED ${row.course_id}: ${row.error}`);
        }
    }

    if (!['ok', 'dry_run'].includes(result.status)) process.exitCode = 1;
    else if (result.status === 'partial') process.exitCode = 1;
}

main().catch(error => {
    console.error(`publish-shopify-catalog: ${error.message}`);
    process.exit(1);
});
