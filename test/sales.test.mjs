import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    DEFAULT_PRICING_CONFIG,
    exceptionReasons,
    fallbackValuation,
    isAwkwardPrice,
    loadPricingConfig,
    priceByRules,
    resolveTier,
    roundMad
} from '../src/sales/pricing.mjs';
import {
    buildUserPrompt,
    parseValuation,
    validateValuation,
    valuateCourse
} from '../src/sales/llm-valuation.mjs';
import { mergePrices, readCatalog, slugify } from '../src/sales/catalog.mjs';
import {
    appendIntent,
    buildCheckoutIntent,
    funnelSummary,
    normalizeReferrer,
    rotateIfLarge,
    validateIntent
} from '../src/sales/intent-tracker.mjs';
import { isPasswordGate, productPayloadFor, redactToken, upsertProduct } from '../src/sales/shopify.mjs';
import { normalizeDecision, SalesAgent } from '../src/sales/sales-agent.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = path.join(here, 'fixtures', 'catalog.sample.ndjson');
const CONFIG = path.join(here, '..', 'config', 'pricing.json');

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'sales-agent-'));
}

function fakeResponse(body, ok = true, status = 200) {
    return {
        ok,
        status,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
        json: async () => (typeof body === 'string' ? JSON.parse(body) : body)
    };
}

describe('pricing rules', () => {
    it('rounds to 50 MAD below 2000 and 100 MAD at or above', () => {
        assert.equal(roundMad(1450), 1450);
        assert.equal(roundMad(1477), 1500);
        assert.equal(roundMad(1990), 2000);
        assert.equal(roundMad(3050), 3100);
        assert.equal(roundMad(4900), 4900);
        assert.throws(() => roundMad(0), /invalid price/);
    });

    it('detects awkward pre-rounding prices', () => {
        assert.equal(isAwkwardPrice(3050), true);
        assert.equal(isAwkwardPrice(3055), true);
        assert.equal(isAwkwardPrice(3000), false);
        assert.equal(isAwkwardPrice(1450), false);
        assert.equal(isAwkwardPrice(1475), true);
    });

    it('resolves tiers from explicit metadata and title keywords', () => {
        assert.equal(resolveTier({ course_id: 'a', title: 'X', tier: 'certified' }), 'certified');
        assert.equal(resolveTier({ course_id: 'b', title: 'Concours Médecine — Prépa' }), 'preptest');
        assert.equal(resolveTier({ course_id: 'c', title: 'Masterclass Finance' }), 'premium');
        assert.equal(resolveTier({ course_id: 'd', title: 'Foundational Skills' }), 'foundation');
        assert.equal(resolveTier({ course_id: 'e', title: 'Something Else' }), 'default');
    });

    it('flags exception courses per the blueprint patterns', () => {
        const acca = { course_id: 'x', title: 'ACCA Financial Reporting — Advanced', exam_board: 'ACCA' };
        const ids = exceptionReasons(acca, resolveTier(acca)).map(r => r.id);
        assert.ok(ids.includes('premium_exam_board'));
        assert.ok(ids.includes('premium_title'));

        const cheap = exceptionReasons({ course_id: 'y', title: 'Foundational Skills' }, 'foundation');
        assert.equal(cheap.length, 0, 'intentionally cheap tiers are not exceptions');

        const config = loadPricingConfig(null);
        config.tiers.custom = { baseline_mad: 3050, min_mad: 2500, max_mad: 4000 };
        const awkward = exceptionReasons({ course_id: 'z', title: 'Custom' }, 'custom', config);
        assert.ok(awkward.map(r => r.id).includes('awkward_price'));
    });

    it('prices rules courses inside tier bounds and records a trace', () => {
        const decision = priceByRules({ course_id: 'a', title: 'Certified Project Manager', tier: 'certified' });
        assert.equal(decision.price_mad, 3500);
        assert.equal(decision.source, 'rules');
        assert.match(decision.trace, /Tier map/);
        assert.equal(decision.needs_review, false);
    });

    it('clamps the deterministic fallback inside tier bounds', () => {
        const fallback = fallbackValuation(
            { course_id: 'a', title: 'PMP', level: 'expert' },
            'premium',
            [{ id: 'premium_exam_board' }]
        );
        assert.ok(fallback.price_mad >= 4000 && fallback.price_mad <= 7000);
        assert.equal(fallback.needs_review, true);
        assert.equal(fallback.source, 'fallback');
    });
});

describe('llm valuation worker', () => {
    const config = DEFAULT_PRICING_CONFIG;
    const tier = config.tiers.preptest;

    it('parses fenced JSON and validates the reasoning trace', () => {
        const parsed = parseValuation('```json\n{"price_mad": 1750, "confidence": 0.7, "reasoning": "Strong exam-board demand and premium positioning justify this price."}\n```');
        assert.equal(parsed.price_mad, 1750);
        assert.equal(validateValuation(parsed, tier).ok, true);
        assert.throws(() => parseValuation('{"price_mad": 1750, "confidence": 0.7, "reasoning": "short"}'), /reasoning/);
        assert.equal(validateValuation({ price_mad: 3500, confidence: 0.5, reasoning: 'x' }, tier).ok, false);
        assert.equal(validateValuation({ price_mad: 1755, confidence: 0.5, reasoning: 'x' }, tier).ok, false);
    });

    it('fills the Appendix A user prompt with tier bounds', () => {
        const prompt = buildUserPrompt({ course_id: 'crs_1', title: 'PMP Prep' }, 'preptest', 'premium exam board PMP', config);
        assert.match(prompt, /Tier baseline: 1500 MAD/);
        assert.match(prompt, /Tier bounds: 1000 to 2500 MAD/);
        assert.match(prompt, /premium exam board PMP/);
    });

    it('retries after an out-of-bounds answer and accepts a valid one', async () => {
        let calls = 0;
        const fetchImpl = async () => {
            calls += 1;
            const content = calls === 1
                ? JSON.stringify({ price_mad: 99999, confidence: 0.9, reasoning: 'Absurd hallucinated price for this premium exam course.' })
                : JSON.stringify({ price_mad: 1800, confidence: 0.8, reasoning: 'Exam-board premium supports a price above the base tier.' });
            return fakeResponse({ choices: [{ message: { content } }] });
        };
        const result = await valuateCourse({
            course: { course_id: 'crs_1', title: 'ACCA Prep', exam_board: 'ACCA' },
            tierName: 'preptest',
            reason: 'premium exam board ACCA',
            config,
            fetchImpl,
            settings: { apiKey: 'test-key', baseUrl: 'http://llm.local', model: 'test', timeoutMs: 1000 }
        });
        assert.equal(result.source, 'llm');
        assert.equal(result.price_mad, 1800);
        assert.equal(result.attempts, 2);
        assert.equal(calls, 2);
    });

    it('falls back deterministically when no key is configured', async () => {
        const result = await valuateCourse({
            course: { course_id: 'crs_1', title: 'ACCA Prep', level: 'advanced' },
            tierName: 'preptest',
            reason: 'premium exam board ACCA',
            config,
            settings: { apiKey: '', baseUrl: '', model: '' }
        });
        assert.equal(result.source, 'fallback');
        assert.equal(result.needs_review, true);
    });
});

describe('catalog', () => {
    it('reads and normalizes the ndjson catalog', () => {
        const courses = readCatalog(CATALOG);
        assert.equal(courses.length, 6);
        assert.equal(courses[0].course_id, 'crs_101');
        assert.equal(courses[0].price_mad, null);
        assert.equal(courses[5].price_mad, 2500);
    });

    it('merges the latest price per course', () => {
        const dir = tempDir();
        const log = path.join(dir, 'prices.ndjson');
        fs.writeFileSync(log, [
            JSON.stringify({ course_id: 'crs_1', price_mad: 1500, source: 'rules' }),
            JSON.stringify({ course_id: 'crs_1', price_mad: 1650, source: 'llm' })
        ].join('\n'));
        const courses = mergePrices([{ course_id: 'crs_1', price_mad: null, price_status: 'quote_required' }], log);
        assert.equal(courses[0].price_mad, 1650);
        assert.equal(courses[0].price_status, 'priced');
        assert.equal(courses[0].price_source, 'llm');
    });

    it('slugifies titles for Shopify handles', () => {
        assert.equal(slugify('Concours Médecine — Prépa Intensive'), 'concours-medecine-prepa-intensive');
    });
});

describe('checkout intent observability', () => {
    it('normalizes referrers into campaign sources', () => {
        assert.equal(normalizeReferrer(''), 'direct');
        assert.equal(normalizeReferrer('https://www.google.com/search?q=courses'), 'google');
        assert.equal(normalizeReferrer('https://m.facebook.com/ads'), 'meta');
        assert.equal(normalizeReferrer('https://example.org/blog'), 'referral');
        assert.equal(normalizeReferrer('not a url'), 'referral');
    });

    it('builds and validates the blueprint event schema', () => {
        const intent = buildCheckoutIntent({
            courseId: 'crs_204',
            priceMad: 1500,
            priceEur: 138,
            sessionId: 'sess_abc123',
            referrer: 'https://google.com/'
        });
        assert.equal(intent.event, 'checkout_intent');
        assert.equal(intent.referrer, 'google');
        assert.equal(intent.price_mad, 1500);
        assert.equal(validateIntent(intent).ok, true);
        assert.equal(validateIntent({ event: 'checkout_intent' }).ok, false);
        assert.throws(() => buildCheckoutIntent({ courseId: 'x', priceMad: 0 }), /positive priceMad/);
    });

    it('summarizes the funnel per course and referrer', () => {
        const dir = tempDir();
        const log = path.join(dir, 'intents.ndjson');
        appendIntent(buildCheckoutIntent({ courseId: 'crs_1', priceMad: 1500, referrer: 'https://google.com' }), log);
        appendIntent(buildCheckoutIntent({ courseId: 'crs_1', priceMad: 1500, referrer: 'direct' }), log);
        appendIntent({ event: 'paid_order', timestamp: new Date().toISOString(), session_id: 's1', course_id: 'crs_1', price_mad: 1500, referrer: 'google' }, log);
        const summary = funnelSummary(log, { days: 30 });
        assert.equal(summary.counts.checkout_intent, 2);
        assert.equal(summary.counts.paid_order, 1);
        assert.equal(summary.intent_to_paid_rate, 0.5);
        const course = summary.by_course.find(row => row.course_id === 'crs_1');
        assert.equal(course.intents, 2);
        assert.equal(summary.by_referrer.find(row => row.referrer === 'google').intents, 1);
    });

    it('rotates an oversized intent log', () => {
        const dir = tempDir();
        const log = path.join(dir, 'intents.ndjson');
        fs.writeFileSync(log, 'x'.repeat(200));
        const archive = rotateIfLarge(log, 100);
        assert.ok(archive && fs.existsSync(archive));
        assert.equal(fs.readFileSync(log, 'utf8'), '');
    });
});

describe('shopify publisher', () => {
    const settings = { domain: 'shop.myshopify.com', token: 'shpat_secret123', apiVersion: '2024-10' };
    const course = { course_id: 'crs_1', title: 'Test Course', description: 'A course.' };

    it('builds a MAD-priced product payload with the tier handle', () => {
        const payload = productPayloadFor(course, 1500);
        assert.equal(payload.product.variants[0].price, '1500.00');
        assert.equal(payload.product.variants[0].sku, 'RWC-crs_1');
        assert.equal(payload.product.handle, 'test-course-crs-1');
    });

    it('creates, then leaves unchanged, then updates a product', async () => {
        let calls = 0;
        const fetchImpl = async (url, options) => {
            calls += 1;
            if (options?.method === 'POST') return fakeResponse({ product: { id: 42 } });
            return fakeResponse({ variant: { id: 7 } });
        };
        const created = await upsertProduct(course, 1500, { settings, existing: [], fetchImpl });
        assert.equal(created.action, 'created');
        assert.equal(created.product_id, 42);

        calls = 0;
        const unchanged = await upsertProduct(course, 1500, {
            settings,
            existing: [{ id: 42, handle: 'test-course-crs-1', variants: [{ id: 7, price: '1500.00' }] }],
            fetchImpl
        });
        assert.equal(unchanged.action, 'unchanged');
        assert.equal(calls, 0, 'unchanged products must not hit the API');

        const updated = await upsertProduct(course, 1800, {
            settings,
            existing: [{ id: 42, handle: 'test-course-crs-1', variants: [{ id: 7, price: '1500.00' }] }],
            fetchImpl
        });
        assert.equal(updated.action, 'updated');
        assert.equal(calls, 1);
    });

    it('detects the password gate and redacts tokens', () => {
        assert.equal(isPasswordGate('<html><body class="password-page">'), true);
        assert.equal(isPasswordGate('<html><body>catalog</body></html>'), false);
        assert.equal(redactToken('failed with shpat_secret123', settings.token), 'failed with [REDACTED]');
    });
});

describe('decision protocol', () => {
    it('normalizes founder vocabulary', () => {
        assert.equal(normalizeDecision('approve').decision, 'approved');
        assert.equal(normalizeDecision('APPROVED').decision, 'approved');
        assert.equal(normalizeDecision('reject').decision, 'rejected');
        assert.equal(normalizeDecision('maybe').decision, 'pending');
        assert.equal(normalizeDecision(null).decision, 'pending');
        const parsed = normalizeDecision({ decision: 'approve', rejected_courses: 'crs_2' });
        assert.deepEqual(parsed.rejected_courses, ['crs_2']);
    });
});

describe('sales agent control loop', () => {
    it('prices the catalog, gates exceptions, publishes idempotently and learns', async () => {
        const dataDir = tempDir();
        const agent = new SalesAgent({ catalogPath: CATALOG, pricingPath: CONFIG, dataDir, mock: true });
        const run = await agent.run();

        assert.equal(run.status, 'published_partial');
        assert.deepEqual(
            { priced: run.counts.priced, approved: run.counts.approved, pending: run.counts.pending },
            { priced: 6, approved: 4, pending: 2 }
        );
        assert.ok(fs.existsSync(path.join(run.job_dir, 'REQUEST.json')));
        assert.ok(fs.existsSync(path.join(run.job_dir, 'TriageReport.ndjson')));

        const priceLog = path.join(dataDir, 'prices.ndjson');
        let rows = fs.readFileSync(priceLog, 'utf8').trim().split('\n').map(JSON.parse);
        assert.equal(rows.length, 4);
        const byId = Object.fromEntries(rows.map(row => [row.course_id, row]));
        assert.equal(byId.crs_101.price_mad, 1500);
        assert.equal(byId.crs_103.price_mad, 3500);
        assert.equal(byId.crs_104.price_mad, 900);
        assert.equal(byId.crs_106.price_mad, 2500);
        assert.equal(rows.some(row => row.course_id === 'crs_102'), false);

        const request = JSON.parse(fs.readFileSync(path.join(run.job_dir, 'REQUEST.json'), 'utf8'));
        assert.deepEqual(request.exceptions.map(row => row.course_id).sort(), ['crs_102', 'crs_105']);
        assert.ok(request.exceptions.every(row => row.trace));

        // Founder approval releases the LLM/fallback exception prices.
        const resumeAgent = new SalesAgent({ catalogPath: CATALOG, pricingPath: CONFIG, dataDir, mock: true, jobId: run.job_id });
        const resumed = await resumeAgent.resume({ jobId: run.job_id, decision: { decision: 'approve' } });
        assert.equal(resumed.status, 'published');
        assert.equal(resumed.publish.catalog_writes, 2);
        rows = fs.readFileSync(priceLog, 'utf8').trim().split('\n').map(JSON.parse);
        assert.equal(rows.length, 6);

        // Same matrix again: no duplicate writes.
        const again = await new SalesAgent({ catalogPath: CATALOG, pricingPath: CONFIG, dataDir, mock: true, jobId: run.job_id })
            .resume({ jobId: run.job_id, decision: { decision: 'approve' } });
        assert.equal(again.publish.catalog_writes, 0);
        assert.equal(again.publish.catalog_skipped, 6);

        // Self-improve flags a viewed-but-never-clicked course, and the next
        // pricing pass applies the hint (held for founder review).
        fs.writeFileSync(
            path.join(dataDir, 'course-views.ndjson'),
            JSON.stringify({ course_id: 'crs_103', views: 220 }) + '\n'
        );
        const learnAgent = new SalesAgent({ catalogPath: CATALOG, pricingPath: CONFIG, dataDir, mock: true });
        const improvement = await learnAgent.selfImprove({ days: 30 });
        assert.equal(improvement.candidates.length, 1);
        assert.equal(improvement.candidates[0].course_id, 'crs_103');
        assert.equal(improvement.candidates[0].action, 'lower_price');
        assert.equal(improvement.candidates[0].suggested_price_mad, 3000);

        const hinted = new SalesAgent({ catalogPath: CATALOG, pricingPath: CONFIG, dataDir, mock: true });
        const manifest = await hinted.recon();
        const matrix = await hinted.genMatrix(manifest);
        const hintedRow = matrix.find(row => row.course_id === 'crs_103');
        assert.equal(hintedRow.source, 'self_improve');
        assert.equal(hintedRow.price_mad, 3000);
        assert.equal(hintedRow.needs_review, true);

        const status = await hinted.status();
        assert.equal(status.courses_priced, 6);
        assert.equal(status.courses_total, 6);
    });

    it('blocks impossible prices by triage instead of publishing them', async () => {
        const dataDir = tempDir();
        const agent = new SalesAgent({ catalogPath: CATALOG, pricingPath: CONFIG, dataDir, mock: true });
        const manifest = await agent.recon();
        const matrix = await agent.genMatrix(manifest);
        const broken = matrix.map((row, index) => (index === 0 ? { ...row, price_mad: 99999, trace: '' } : row));
        const triage = await agent.triage(broken);
        assert.equal(triage.failures.length, 1);
        assert.ok(triage.failures[0].problems.some(problem => problem.includes('outside tier bounds')));
        const repaired = agent.repairFailures(broken, triage.failures);
        const retriage = await agent.triage(repaired);
        assert.equal(retriage.failures.length, 0);
        assert.equal(repaired[0].source, 'triage_repair');
    });
});
