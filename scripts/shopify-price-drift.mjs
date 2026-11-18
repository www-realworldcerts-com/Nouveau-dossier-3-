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
  --catalog <file>              Canonical catalog (default config/course-catalog.json)
  --checkout-url <url>          Buyer-facing edge payload (default <storefront>/data/store-prices.json)
  --checkout-origin-url <url>   Direct origin payload or origin base URL
                                (default CHECKOUT_PRICE_ORIGIN_URL)
  --quote-url <url>             Quote endpoint (default checkout origin +
                                /acp/v1/price-quote, or CHECKOUT_QUOTE_URL)
  --json                        Print the full report as JSON
  --help                        Show this help

Exit codes: 0 prices agree, 1 audit unchecked, 2 real price drift found.`;

function formatAmount(value) {
    if (value === null || value === undefined) return 'n/a';
    if (typeof value !== 'object') return String(value);
    return `${value.amount ?? 'n/a'} ${value.currency || ''}`.trim();
}

async function main() {
    const flags = parseArgs(process.argv.slice(2));
    if (flags.help) return console.log(HELP);
    if (flags['checkout-url'] === true) throw new Error('--checkout-url requires a value');
    if (flags['checkout-origin-url'] === true) throw new Error('--checkout-origin-url requires a value');
    if (flags['quote-url'] === true) throw new Error('--quote-url requires a value');
    if (flags.catalog === true) throw new Error('--catalog requires a value');

    const report = await auditShopifyPriceDrift({
        catalogFile: typeof flags.catalog === 'string' ? flags.catalog : undefined,
        checkoutUrl: typeof flags['checkout-url'] === 'string' ? flags['checkout-url'] : undefined,
        checkoutOriginUrl: typeof flags['checkout-origin-url'] === 'string' ? flags['checkout-origin-url'] : undefined,
        quoteUrl: typeof flags['quote-url'] === 'string' ? flags['quote-url'] : undefined
    });

    if (flags.json) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        console.log(`Shopify price drift — ${report.status} (${report.checked_at})`);
        console.log(`  catalog: ${report.checked.catalog_courses} course(s) in ${report.catalog_currency}`);
        console.log(`  checkout: ${report.checked.checkout_prices} price(s) at ${report.checkout.url || 'not checked'}`);
        for (const name of ['edge', 'edge_fresh', 'origin']) {
            const view = report.checkout[name];
            if (!view) continue;
            const state = view.ok ? `${view.count} price(s)` : `unchecked (${view.error || 'unavailable'})`;
            const stale = view.stale
                ? ' — STALE against the cache-busted response'
                : (view.differs_from_origin || view.differs_from_fresh
                    ? ' — DIFFERS from the other route'
                    : '');
            console.log(`    ${name}${view.cache_bust ? ' (cache-busted)' : ''}: ${state} at ${view.url || 'not checked'}${stale}`);
        }
        console.log(`  quotes: ${report.quote.checked_products} checked, ${report.quote.failed_products} unavailable at ${report.quote.url || 'not checked'}`);
        console.log(`  Shopify: ${report.checked.shopify_products} product(s), ${report.checked.shopify_variants} variant(s) in ${report.store_currency || 'unknown currency'}`);
        for (const row of report.drift) {
            console.log(`  ${row.course_id || 'catalog'} [${row.sources.join(', ')}]: ${row.reasons.join(', ')}`);
            for (const observation of row.observations) {
                const source = observation.detail_source || observation.reason;
                console.log(`      ${observation.source}/${source}: expected ${formatAmount(observation.expected)}, actual ${formatAmount(observation.actual)}`);
            }
        }
        for (const row of report.unchecked) {
            console.log(`  unchecked: ${row.source}:${row.course_id || 'catalog'} ${row.reason}`);
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
