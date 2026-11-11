#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import { defaultDataDir, normalizeDecision, SalesAgent } from '../src/sales/sales-agent.mjs';
import { readNdjson } from '../src/sales/catalog.mjs';
import { setupShop } from '../src/sales/shopify-setup.mjs';
import { shopifySettingsFromEnv } from '../src/sales/shopify.mjs';
import {
    appendIntent,
    buildCheckoutIntent,
    funnelSummary,
    normalizeReferrer
} from '../src/sales/intent-tracker.mjs';

function parseArgs(argv) {
    const [command = 'help', ...rest] = argv;
    const flags = {};
    const positional = [];
    for (let i = 0; i < rest.length; i += 1) {
        const token = rest[i];
        if (token.startsWith('--')) {
            const key = token.slice(2);
            const next = rest[i + 1];
            if (next === undefined || next.startsWith('--')) {
                flags[key] = true;
            } else {
                flags[key] = next;
                i += 1;
            }
        } else {
            positional.push(token);
        }
    }
    return { command, flags, positional };
}

function buildAgent(flags) {
    const catalogPath = flags.catalog || process.env.CATALOG_PATH;
    if (!catalogPath) {
        throw new Error('Missing catalog. Use --catalog <file.ndjson|file.json> or set CATALOG_PATH.');
    }
    return new SalesAgent({
        catalogPath,
        pricingPath: flags.pricing,
        dataDir: flags['data-dir'] || defaultDataDir(),
        mock: Boolean(flags.mock) || String(process.env.SALES_AGENT_MOCK || '').toLowerCase() === 'true',
        jobId: flags.job
    });
}

function printJson(value) {
    console.log(JSON.stringify(value, null, 2));
}

function printSummary(result, json) {
    if (json) return printJson(result);
    const lines = [
        `job:      ${result.job_id}`,
        `status:   ${result.status}`,
        `job dir:  ${result.job_dir || ''}`
    ];
    if (result.counts) {
        lines.push(`priced:   ${result.counts.priced}`);
        lines.push(`approved: ${result.counts.approved}`);
        lines.push(`pending:  ${result.counts.pending}`);
        lines.push(`blocked:  ${result.counts.blocked}`);
    }
    if (result.publish) {
        lines.push(`catalog writes: ${result.publish.catalog_writes} (unchanged ${result.publish.catalog_skipped})`);
        lines.push(`shopify:  ${result.publish.shopify.status}${result.publish.shopify.reason ? ` — ${result.publish.shopify.reason}` : ''}`);
        if (result.publish.storefront) {
            lines.push(`storefront: HTTP ${result.publish.storefront.status}, password gate ${result.publish.storefront.password_gate}`);
        }
        for (const warning of result.publish.warnings) lines.push(`WARNING:  ${warning}`);
    }
    if (result.request) lines.push(`request:  ${result.request}`);
    console.log(lines.join('\n'));
}

const HELP = `Autonomous sales agent — price, approve, publish, observe.

Usage:
  node scripts/sales-agent.mjs <command> --catalog <file> [options]

Commands:
  run            Run the seven-node loop (recon → publish). Stops at the approval gate unless rules auto-approve.
  price          Run recon/gen_matrix/triage/assemble only and print the proposed matrix.
  approve <job>  Write decision.json for a job (--all | --courses id1,id2 | --reject id1,id2).
  resume <job>   Continue a job from its FinalPriceMatrix + decision.json.
  self-improve   Build repricing candidates from intents, views, orders.
  intent         Record a checkout_intent event (--course, --price, --session, --referrer, --source).
  funnel         Print the conversion funnel (--days 30).
  status         Print the KPI table (priced catalog, storefront, intents, orders).
  setup-shop     Audit the Shopify shop and print the self-setup checklist (no catalog needed).
  help           Show this help.

Options:
  --catalog <file>   Catalog ndjson/json (required, or CATALOG_PATH)
  --pricing <file>   Pricing config (default config/pricing.json)
  --data-dir <dir>   State directory (default data/sales)
  --job <id>         Reuse a job id (crash-safe resume)
  --mock             No network: skip Shopify, deterministic pricing fallback
  --auto-approve     Approve every proposed price (founder override)
  --wait <seconds>   Poll for decision.json up to N seconds
  --shop-domain <d>  Shopify domain for setup-shop (default SHOPIFY_STORE_DOMAIN)
  --ensure-collection  Create the "Courses" collection when the shop is ready
  --json             Machine-readable output

Environment:
  CATALOG_PATH, SALES_PRICING_CONFIG, SALES_DATA_DIR, SALES_AGENT_MOCK,
  AUTO_APPROVE_RULES=false, OPENAI_API_KEY, SALES_LLM_BASE_URL, SALES_LLM_MODEL,
  SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN
`;

async function main() {
    const { command, flags, positional } = parseArgs(process.argv.slice(2));
    const json = Boolean(flags.json);
    const dataDir = flags['data-dir'] || defaultDataDir();

    if (command === 'help' || flags.help) {
        console.log(HELP);
        return;
    }

    if (command === 'intent') {
        const intent = buildCheckoutIntent({
            courseId: flags.course,
            priceMad: flags.price,
            priceEur: flags.eur,
            sessionId: flags.session,
            referrer: flags.referrer,
            source: flags.source || 'crypto_checkout'
        });
        appendIntent(intent, path.join(dataDir, 'course-intents.ndjson'));
        if (json) printJson(intent);
        else console.log(`recorded checkout_intent ${intent.course_id} ${intent.price_mad} MAD (${intent.referrer})`);
        return;
    }

    if (command === 'funnel') {
        const summary = funnelSummary(path.join(dataDir, 'course-intents.ndjson'), {
            days: Number(flags.days || 30)
        });
        if (json) return printJson(summary);
        console.log(`Funnel — last ${summary.window_days} days`);
        for (const [name, count] of Object.entries(summary.counts)) {
            console.log(`  ${name.padEnd(16)} ${count}`);
        }
        console.log(`  intent→paid      ${(summary.intent_to_paid_rate * 100).toFixed(1)}%`);
        if (summary.by_referrer.length) {
            console.log('  referrers:');
            for (const row of summary.by_referrer) console.log(`    ${row.referrer.padEnd(12)} ${row.intents}`);
        }
        return;
    }

    if (command === 'approve') {
        const jobId = flags.job || positional[0];
        if (!jobId) throw new Error('approve requires a job id: approve <jobId>');
        const jobDir = path.join(dataDir, 'jobs', jobId);
        const requestPath = path.join(jobDir, 'REQUEST.json');
        if (!fs.existsSync(requestPath)) throw new Error(`No approval request at ${requestPath}`);
        const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
        const reject = flags.reject ? String(flags.reject).split(',').map(s => s.trim()).filter(Boolean) : [];
        const approved = flags.all || !flags.courses
            ? request.exceptions.map(row => row.course_id)
            : String(flags.courses).split(',').map(s => s.trim()).filter(Boolean);
        const decision = normalizeDecision({
            decision: reject.length && !flags.all && !flags.courses ? 'rejected' : 'approved',
            approved_courses: approved,
            rejected_courses: reject,
            decided_by: process.env.USER || 'founder',
            decided_at: new Date().toISOString(),
            notes: flags.notes || null
        });
        fs.writeFileSync(path.join(jobDir, 'decision.json'), JSON.stringify(decision, null, 2));
        if (json) printJson(decision);
        else console.log(`decision written: ${decision.decision} (${approved.length - reject.length} approved, ${reject.length} rejected)`);
        return;
    }

    if (command === 'setup-shop') {
        const base = shopifySettingsFromEnv();
        const settings = {
            ...base,
            domain: flags['shop-domain'] || process.env.SHOPIFY_STORE_DOMAIN || base.domain
        };
        const report = await setupShop(settings, { ensureCollection: Boolean(flags['ensure-collection']) });
        const reportPath = path.join(dataDir, 'ShopifySetupReport.json');
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

        if (json) {
            printJson(report);
            process.exitCode = report.ready ? 0 : 2;
            return;
        }
        console.log(`Shopify self-setup — ${report.domain || report.requested_domain || 'unknown shop'}`);
        console.log(`  ready: ${report.ready ? 'YES' : 'NO'}`);
        if (report.shop) {
            console.log(`  shop: ${report.shop.name} (currency ${report.shop.currency}, plan ${report.shop.plan || 'unknown'})`);
        }
        if (report.currency) {
            console.log(`  currency: catalog ${report.currency.catalog} → store ${report.currency.store || 'unknown'}`);
        }
        console.log(`  products: ${report.product_count}; password gate: ${report.storefront?.password_gate || 'unknown'}`);
        if (report.collection) {
            console.log(`  collection: ${report.collection.action} ${report.collection.handle || ''}`.trim());
        }
        if (report.blockers.length) {
            console.log('\nBlockers:');
            for (const blocker of report.blockers) console.log(`  - ${blocker}`);
        }
        if (report.warnings.length) {
            console.log('\nWarnings:');
            for (const warning of report.warnings) console.log(`  - ${warning}`);
        }
        if (report.next_step) console.log(`\nNext: ${report.next_step}`);
        console.log('\nManual steps (Shopify does not expose these to apps):');
        report.manual_actions.forEach((action, index) => {
            console.log(`  ${index + 1}. ${action.title} — ${action.url}`);
            console.log(`     ${action.why}`);
        });
        console.log(`\nReport: ${reportPath}`);
        process.exitCode = report.ready ? 0 : 2;
        return;
    }

    const needsCatalog = !['status', 'self-improve'].includes(command) || flags.catalog || process.env.CATALOG_PATH;
    if (needsCatalog && command !== 'status' && command !== 'self-improve' && !flags.catalog && !process.env.CATALOG_PATH) {
        throw new Error(`Missing --catalog for "${command}". See --help.`);
    }

    const agent = buildAgent(flags);

    if (command === 'run') {
        const result = await agent.run({
            autoApprove: Boolean(flags['auto-approve']),
            waitMs: Number(flags.wait || 0) * 1000
        });
        return printSummary(result, json);
    }

    if (command === 'price') {
        const manifest = await agent.recon();
        let matrix = await agent.genMatrix(manifest);
        let triage = await agent.triage(matrix);
        let iteration = 0;
        while (triage.failures.length && iteration < 5) {
            iteration += 1;
            matrix = agent.repairFailures(matrix, triage.failures);
            triage = await agent.triage(matrix);
        }
        const { final, blocked } = await agent.assemble(matrix, triage.failures);
        if (json) return printJson({ job_id: agent.jobId, matrix: final, blocked });
        console.log(`\nProposed prices (job ${agent.jobId})`);
        for (const row of final) {
            console.log(`  ${row.course_id.padEnd(16)} ${String(row.price_mad).padStart(5)} MAD  ${row.tier.padEnd(12)} ${row.source}${row.needs_review ? '  [founder review]' : ''}`);
        }
        console.log(`\n${final.length} priced, ${blocked.length} blocked. Review: node scripts/sales-agent.mjs run --job ${agent.jobId}`);
        return;
    }

    if (command === 'resume') {
        const jobId = flags.job || positional[0];
        if (!jobId) throw new Error('resume requires a job id: resume <jobId> --catalog <file>');
        const result = await agent.resume({ jobId });
        return printSummary(result, json);
    }

    if (command === 'self-improve') {
        const result = await agent.selfImprove({ days: Number(flags.days || 30) });
        if (json) return printJson(result);
        console.log(`Repricing candidates (${result.candidates.length})`);
        for (const row of result.candidates) {
            console.log(`  ${row.course_id.padEnd(16)} ${row.action.padEnd(13)} ${row.current_price_mad} → ${row.suggested_price_mad} MAD  ${row.reason}`);
        }
        return;
    }

    if (command === 'status') {
        const status = await agent.status();
        if (json) return printJson(status);
        console.log('KPI status');
        console.log(`  courses priced      ${status.courses_priced}/${status.courses_total}`);
        console.log(`  shopify products    ${status.shopify_products}`);
        console.log(`  password gate       ${status.password_gate}`);
        console.log(`  checkout intents    ${status.checkout_intents} (30d)`);
        console.log(`  paid orders         ${status.paid_orders}`);
        console.log(`  intent→paid         ${(status.intent_to_paid_rate * 100).toFixed(1)}%`);
        return;
    }

    console.log(HELP);
}

main().catch(error => {
    console.error(`sales-agent: ${error.message}`);
    process.exit(1);
});
