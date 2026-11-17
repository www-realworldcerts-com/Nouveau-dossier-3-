#!/usr/bin/env node
import { loadCourseCatalog } from '../src/sales/course-catalog.mjs';
import {
    auditCheckoutBrowser,
    resolveBuyOriginUrl,
    resolveBuyUrl
} from '../src/sales/checkout-browser-audit.mjs';
import { shopifySettingsFromEnv } from '../src/sales/shopify.mjs';

/**
 * Read-only browser checkout audit. The browser intercepts the checkout POST
 * locally and never sends it to /acp/v1/transactions, so no PayPal order can be
 * created by this command.
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

const HELP = `Read-only browser audit of the exact /buy checkout page.

Usage:
  node scripts/checkout-browser-audit.mjs [options]

Options:
  --catalog <file>          Canonical catalog (default config/course-catalog.json)
  --product-id <slug>       Product to exercise (default first active course)
  --buy-url <url>           Buyer-facing edge /buy URL
                            (default <storefront>/buy)
  --buy-origin-url <url>    Direct origin /buy URL
                            (default derived from CHECKOUT_PRICE_ORIGIN_URL)
  --timeout-ms <n>          Per-page timeout (default 30000)
  --json                    Print the full report as JSON
  --help                    Show this help

Requires Playwright and its Chromium browser in the environment running this
audit. The checkout POST is intercepted and never reaches PayPal.

Exit codes: 0 displayed and POSTed prices agree, 1 audit unchecked,
2 a displayed/POSTed price differs.`;

function formatMoney(value) {
    if (!value || value.amount === null || value.amount === undefined) return 'n/a';
    return `${Number(value.amount).toFixed(2)} ${value.currency || ''}`.trim();
}

async function main() {
    const flags = parseArgs(process.argv.slice(2));
    if (flags.help) return console.log(HELP);
    if (flags.catalog === true) throw new Error('--catalog requires a value');
    if (flags['product-id'] === true) throw new Error('--product-id requires a value');
    if (flags['buy-url'] === true) throw new Error('--buy-url requires a value');
    if (flags['buy-origin-url'] === true) throw new Error('--buy-origin-url requires a value');
    if (flags['timeout-ms'] === true) throw new Error('--timeout-ms requires a value');

    const catalog = loadCourseCatalog(typeof flags.catalog === 'string' ? flags.catalog : undefined);
    const productId = typeof flags['product-id'] === 'string'
        ? flags['product-id']
        : (catalog.courses.find(course => course.status !== 'draft') || catalog.courses[0])?.slug;
    const course = productId ? catalog.bySlug[productId] : null;
    if (!course) throw new Error(`Unknown product id: ${productId || '(none)'}`);

    const settings = shopifySettingsFromEnv();
    const report = await auditCheckoutBrowser({
        buyUrl: resolveBuyUrl(settings, typeof flags['buy-url'] === 'string' ? flags['buy-url'] : null),
        buyOriginUrl: resolveBuyOriginUrl(settings, typeof flags['buy-origin-url'] === 'string' ? flags['buy-origin-url'] : null),
        productId,
        expectedAmount: course.price_cents / 100,
        expectedCurrency: catalog.currency,
        timeoutMs: Number(flags['timeout-ms'] || 30000)
    });

    if (flags.json) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        console.log(`Browser checkout audit — ${report.status} (${report.checked_at})`);
        console.log(`  product: ${report.product_id}; expected ${formatMoney(report.expected)}`);
        for (const route of report.routes) {
            if (route.error) {
                console.log(`  ${route.route}${route.cache_bust ? ' (cache-busted)' : ''}: unavailable — ${route.error}`);
                continue;
            }
            console.log(`  ${route.route}${route.cache_bust ? ' (cache-busted)' : ''}: displayed ${formatMoney(route.displayed)}, posted ${formatMoney(route.posted)}`);
        }
        for (const row of report.drift) {
            console.log(`  DRIFT ${row.route}: ${row.reason}; expected ${formatMoney(row.expected)}, displayed ${formatMoney(row.displayed)}, posted ${formatMoney(row.posted)}`);
        }
        for (const reason of report.unavailable) console.log(`  unavailable: ${reason}`);
        if (report.status === 'ok') console.log('  Displayed and POSTed prices agree on every checked route.');
    }

    if (report.status === 'drift') return (process.exitCode = 2);
    if (report.status === 'unavailable') return (process.exitCode = 1);
}

main().catch(error => {
    console.error(`checkout-browser-audit: ${error.message}`);
    process.exit(1);
});
