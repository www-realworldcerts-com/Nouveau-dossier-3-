#!/usr/bin/env node
import { auditShopifyPriceDrift } from '../src/sales/shopify-price-drift.mjs';

/**
 * Read-only price audit. Exit 2 means drift was found; exit 1 means the audit
 * could not verify one or more sources; exit 0 means all three agree.
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

const HELP = `Read-only Shopify price-drift audit.

Usage:
  node scripts/shopify-price-drift.mjs [options]

Options:
  --catalog <file>      Canonical catalog (default config/course-catalog.json)
  --checkout-url <url>  Checkout payload (default <storefront>/data/store-prices.json)
  --json                Print the full report as JSON
  --help                Show this help

Exit codes: 0 prices agree, 1 audit unavailable, 2 drift found.`;

async function main() {
    const flags = parseArgs(process.argv.slice(2));
    if (flags.help) return console.log(HELP);
    if (flags['checkout-url'] === true) throw new Error('--checkout-url requires a value');
    if (flags.catalog === true) throw new Error('--catalog requires a value');

    const report = await auditShopifyPriceDrift({
        catalogFile: typeof flags.catalog === 'string' ? flags.catalog : undefined,
        checkoutUrl: typeof flags['checkout-url'] === 'string' ? flags['checkout-url'] : undefined
    });

    if (flags.json) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        console.log(`Shopify price drift — ${report.status} (${report.checked_at})`);
        console.log(`  catalog: ${report.checked.catalog_courses} course(s) in ${report.catalog_currency}`);
        console.log(`  checkout: ${report.checked.checkout_prices} price(s) at ${report.checkout.url || 'not checked'}`);
        console.log(`  Shopify: ${report.checked.shopify_products} product(s), ${report.checked.shopify_variants} variant(s) in ${report.store_currency || 'unknown currency'}`);
        for (const row of report.drift) {
            const expected = row.expected === null || row.expected === undefined
                ? 'n/a'
                : (typeof row.expected === 'object'
                    ? `${row.expected.amount} ${row.expected.currency}`
                    : String(row.expected));
            const actual = row.actual === null || row.actual === undefined
                ? 'n/a'
                : (typeof row.actual === 'object'
                    ? `${row.actual.amount ?? row.actual} ${row.actual.currency || ''}`.trim()
                    : String(row.actual));
            console.log(`  [${row.source}] ${row.course_id || 'catalog'} ${row.reason}: expected ${expected}, actual ${actual}`);
        }
        for (const reason of report.unavailable) console.log(`  unavailable: ${reason}`);
        if (report.finding) console.log(`  finding: ${report.finding.code} (${report.finding.severity})`);
        else console.log('  No price drift detected.');
    }

    if (report.status === 'drift') return (process.exitCode = 2);
    if (report.status === 'unavailable') return (process.exitCode = 1);
}

main().catch(error => {
    console.error(`shopify-price-drift: ${error.message}`);
    process.exit(1);
});
