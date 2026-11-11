import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
    appendNdjson,
    latestPrices,
    mergePrices,
    readCatalog,
    readNdjson,
    writeNdjson
} from './catalog.mjs';
import {
    clampPrice,
    exceptionReasons,
    getTierConfig,
    loadPricingConfig,
    needsPricing,
    priceByRules,
    priceToEur,
    resolveConfigPath,
    resolveTier,
    roundMad
} from './pricing.mjs';
import { valuateCourse } from './llm-valuation.mjs';
import {
    checkStorefrontGate,
    listProducts,
    shopifySettingsFromEnv,
    upsertProduct
} from './shopify.mjs';
import { funnelSummary, loadIntents } from './intent-tracker.mjs';

/**
 * Autonomous sales agent: the blueprint's seven-node control loop
 * (recon → gen_matrix → triage → assemble → approval_gate → publish →
 * self_improve), implemented in Node over append-only ndjson state.
 *
 * Every node is idempotent and rebuilds its input from the job directory, so a
 * crash can be resumed by re-running with the same job id.
 */

const DECISION_YES = new Set(['approve', 'approved', 'yes', 'y', 'ok', 'lgtm', 'accept', 'accepted']);
const DECISION_NO = new Set(['reject', 'rejected', 'no', 'n', 'deny', 'denied']);

export function normalizeDecision(raw) {
    if (!raw) return { decision: 'pending', approved_courses: [], rejected_courses: [], notes: null };
    if (typeof raw === 'string') {
        const key = raw.trim().toLowerCase();
        const decision = DECISION_YES.has(key) ? 'approved' : DECISION_NO.has(key) ? 'rejected' : 'pending';
        return { decision, approved_courses: [], rejected_courses: [], notes: null };
    }
    const key = String(raw.decision ?? raw.status ?? '').trim().toLowerCase();
    const decision = DECISION_YES.has(key) ? 'approved' : DECISION_NO.has(key) ? 'rejected' : 'pending';
    const toList = value => (Array.isArray(value)
        ? value.map(String)
        : value == null || value === '' ? [] : String(value).split(',').map(item => item.trim()).filter(Boolean));
    const approved = toList(raw.approved_courses ?? raw.approve ?? raw.approved);
    const rejected = toList(raw.rejected_courses ?? raw.reject ?? raw.rejected);
    return {
        decision,
        approved_courses: approved,
        rejected_courses: rejected,
        notes: raw.notes ?? raw.feedback ?? null,
        decided_at: raw.decided_at || null,
        decided_by: raw.decided_by || null
    };
}

export function defaultDataDir() {
    return path.resolve(process.env.SALES_DATA_DIR || 'data/sales');
}

function matrixHash(rows) {
    const canonical = rows
        .map(row => [row.course_id, row.price_mad, row.source, row.tier])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export class SalesAgent {
    constructor(options = {}) {
        this.config = options.config || loadPricingConfig(options.pricingPath || resolveConfigPath());
        this.catalogPath = path.resolve(options.catalogPath || process.env.CATALOG_PATH || '');
        this.dataDir = path.resolve(options.dataDir || defaultDataDir());
        this.mock = Boolean(options.mock);
        this.fetchImpl = options.fetchImpl || globalThis.fetch;
        this.logger = options.logger || ((...args) => console.log(...args));
        this.now = options.now || (() => new Date());
        this.shopify = options.shopify || shopifySettingsFromEnv();
        this.llmSettings = options.llmSettings || this.buildLlmSettings();
        this.jobId = options.jobId || this.newJobId();
        this.applyHints = options.applyHints !== false;
        this.dir = path.join(this.dataDir, 'jobs', this.jobId);
        fs.mkdirSync(this.dir, { recursive: true });
    }

    buildLlmSettings() {
        if (this.mock) return { apiKey: '', baseUrl: '', model: 'mock', timeoutMs: 1000 };
        return {
            apiKey: process.env.OPENAI_API_KEY || process.env.SALES_LLM_API_KEY || '',
            baseUrl: (process.env.SALES_LLM_BASE_URL || process.env.OPENAI_BASE_URL || 'https://freebuff.com/api/v1/paid').replace(/\/+$/, ''),
            model: process.env.SALES_LLM_MODEL || 'gpt-4o-mini',
            timeoutMs: Number(process.env.SALES_LLM_TIMEOUT_MS || 30000)
        };
    }

    newJobId() {
        const stamp = this.now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
        return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
    }

    /** Paths used by the loop; all state lives under the job directory. */
    paths(jobId = this.jobId) {
        const dir = path.join(this.dataDir, 'jobs', jobId);
        return {
            dir,
            manifest: path.join(dir, 'CatalogManifest.ndjson'),
            priceMatrix: path.join(dir, 'PriceMatrix.ndjson'),
            triage: path.join(dir, 'TriageReport.ndjson'),
            finalMatrix: path.join(dir, 'FinalPriceMatrix.ndjson'),
            publishReport: path.join(dir, 'PublishReport.ndjson'),
            request: path.join(dir, 'REQUEST.json'),
            decision: path.join(dir, 'decision.json'),
            summary: path.join(dir, 'job.json'),
            priceLog: path.join(this.dataDir, 'prices.ndjson'),
            intents: path.join(this.dataDir, 'course-intents.ndjson'),
            views: path.join(this.dataDir, 'course-views.ndjson'),
            orders: path.join(this.dataDir, 'orders.ndjson'),
            candidates: path.join(this.dataDir, 'RepricingCandidates.ndjson')
        };
    }

    requireCatalog() {
        if (!this.catalogPath) {
            throw new Error('No catalog configured. Pass --catalog <file> or set CATALOG_PATH.');
        }
        return readCatalog(this.catalogPath);
    }

    // ---------------------------------------------------------------- recon
    async recon() {
        const courses = mergePrices(this.requireCatalog(), this.paths().priceLog);
        const entries = courses.map(course => {
            const tier = resolveTier(course, this.config);
            const reasons = exceptionReasons(course, tier, this.config);
            return {
                course_id: course.course_id,
                title: course.title,
                tier,
                exam_board: course.exam_board || null,
                level: course.level || null,
                duration_hours: course.duration_hours ?? null,
                price_mad: course.price_mad ?? null,
                price_status: course.price_status || 'quote_required',
                needs_pricing: needsPricing(course),
                exception_reasons: reasons.map(r => r.id),
                shopify_product_id: course.shopify_product_id || null
            };
        });
        const byTier = entries.reduce((acc, entry) => {
            acc[entry.tier] = (acc[entry.tier] || 0) + 1;
            return acc;
        }, {});
        const manifest = {
            job_id: this.jobId,
            generated_at: this.now().toISOString(),
            chat: 'recon',
            catalog_path: this.catalogPath,
            totals: {
                courses: entries.length,
                unpriced: entries.filter(entry => entry.needs_pricing).length,
                exception_candidates: entries.filter(entry => entry.exception_reasons.length > 0).length,
                by_tier: byTier
            },
            courses: entries
        };
        writeNdjson(this.paths().manifest, entries);
        this.logger(`recon: ${entries.length} courses, ${manifest.totals.unpriced} unpriced, ${manifest.totals.exception_candidates} exception candidates`);
        return manifest;
    }

    loadManifest(jobId = this.jobId) {
        const rows = readNdjson(this.paths(jobId).manifest);
        if (!rows.length) throw new Error(`No CatalogManifest for job ${jobId}; run recon first.`);
        return { courses: rows };
    }

    loadCandidates() {
        const rows = readNdjson(this.paths().candidates);
        const latest = new Map();
        for (const row of rows) {
            if (row?.course_id) latest.set(row.course_id, row);
        }
        return latest;
    }

    // ------------------------------------------------------------ gen_matrix
    async genMatrix(manifest) {
        const hints = this.applyHints ? this.loadCandidates() : new Map();
        const courses = this.requireCatalog();
        const byId = new Map(courses.map(course => [course.course_id, course]));
        const matrix = [];

        for (const entry of manifest.courses) {
            const course = byId.get(entry.course_id);
            if (!course) continue;
            const tierName = entry.tier || resolveTier(course, this.config);
            const reasons = exceptionReasons(course, tierName, this.config);
            const tier = getTierConfig(tierName, this.config);
            const hint = hints.get(entry.course_id);

            if (hint?.action === 'lower_price' && Number.isFinite(Number(hint.suggested_price_mad))) {
                const price = clampPrice(roundMad(Number(hint.suggested_price_mad), this.config), tier);
                matrix.push({
                    course_id: entry.course_id,
                    title: entry.title,
                    tier: tierName,
                    price_mad: price,
                    source: 'self_improve',
                    confidence: 0.6,
                    reasons: [hint.reason || 'self_improve repricing candidate'],
                    trace: `Self-improve hint from ${hint.generated_at || 'previous run'}: current ${hint.current_price_mad} MAD, suggested ${hint.suggested_price_mad} MAD (${hint.reason || 'no intent on meaningful views'}), applied within tier bounds.`,
                    needs_review: true
                });
                continue;
            }

            if (reasons.length) {
                const valuation = await valuateCourse({
                    course,
                    tierName,
                    reason: reasons.map(r => r.reason).join('; '),
                    config: this.config,
                    fetchImpl: this.fetchImpl,
                    settings: this.llmSettings
                });
                matrix.push({
                    course_id: entry.course_id,
                    title: entry.title,
                    tier: tierName,
                    price_mad: valuation.price_mad,
                    source: valuation.source,
                    confidence: valuation.confidence,
                    reasons: reasons.map(r => r.reason),
                    trace: valuation.trace,
                    attempts: valuation.attempts ?? 0,
                    needs_review: true,
                    price_eur: priceToEur(valuation.price_mad, this.config)
                });
            } else {
                const decision = priceByRules(course, this.config);
                matrix.push({
                    ...decision,
                    title: entry.title,
                    price_eur: priceToEur(decision.price_mad, this.config)
                });
            }
        }

        writeNdjson(this.paths().priceMatrix, matrix);
        const bySource = matrix.reduce((acc, row) => {
            acc[row.source] = (acc[row.source] || 0) + 1;
            return acc;
        }, {});
        this.logger(`gen_matrix: ${matrix.length} priced (${Object.entries(bySource).map(([k, v]) => `${k}=${v}`).join(', ')})`);
        return matrix;
    }

    // ---------------------------------------------------------------- triage
    async triage(matrix) {
        const seen = new Set();
        const rows = matrix.map(row => {
            const problems = [];
            const tier = getTierConfig(row.tier, this.config);
            const price = Number(row.price_mad);
            if (!Number.isInteger(price) || price <= 0) {
                problems.push('price_mad must be a positive integer');
            } else {
                if (price < tier.min_mad || price > tier.max_mad) {
                    problems.push(`price ${price} outside tier bounds ${tier.min_mad}-${tier.max_mad}`);
                }
                const step = price < this.config.rounding.below_mad
                    ? this.config.rounding.step_below
                    : this.config.rounding.step_above;
                if (price % step !== 0) problems.push(`price ${price} violates ${step} MAD rounding`);
            }
            if (seen.has(row.course_id)) problems.push('duplicate course_id in matrix');
            seen.add(row.course_id);
            if (row.source !== 'rules' && !String(row.trace || '').trim()) {
                problems.push('non-rules price missing reasoning trace');
            }
            if (row.source === 'llm' && !(Number(row.confidence) > 0)) {
                problems.push('llm price missing confidence score');
            }
            return {
                course_id: row.course_id,
                tier: row.tier,
                source: row.source,
                price_mad: row.price_mad,
                status: problems.length ? 'fail' : 'pass',
                problems
            };
        });
        const failures = rows.filter(row => row.status === 'fail');
        writeNdjson(this.paths().triage, rows);
        this.logger(`triage: ${rows.length - failures.length} pass, ${failures.length} fail`);
        return { rows, failures };
    }

    /** Re-price the courses triage rejected; valid rows are left untouched. */
    repairFailures(matrix, failures = []) {
        const failingIds = new Set(failures.map(row => row.course_id));
        return matrix.map(row => {
            if (!failingIds.has(row.course_id) || row.repaired) return row;
            const tier = getTierConfig(row.tier, this.config);
            const price = clampPrice(roundMad(tier.baseline_mad, this.config), tier);
            return {
                ...row,
                price_mad: price,
                price_eur: priceToEur(price, this.config),
                source: 'triage_repair',
                confidence: 0.8,
                trace: `Triage repair: replaced ${row.price_mad} MAD with tier baseline ${tier.baseline_mad} MAD clamped to ${tier.min_mad}-${tier.max_mad}.`,
                reasons: [...(row.reasons || []), 'triage repair'],
                needs_review: true,
                repaired: true
            };
        });
    }

    // -------------------------------------------------------------- assemble
    async assemble(matrix, failures) {
        const failedIds = new Set(failures.map(row => row.course_id));
        const final = matrix.filter(row => !failedIds.has(row.course_id));
        writeNdjson(this.paths().finalMatrix, final);
        this.logger(`assemble: ${final.length} prices ready, ${failedIds.size} blocked by triage`);
        return { final, blocked: [...failedIds] };
    }

    // --------------------------------------------------------- approval_gate
    async approvalGate(final, { autoApprove = false, waitMs = 0, decision = null } = {}) {
        const { request: requestPath, decision: decisionPath } = this.paths();
        const exceptions = final.filter(row => row.needs_review || row.source !== 'rules');
        const requests = {
            job_id: this.jobId,
            created_at: this.now().toISOString(),
            matrix_hash: matrixHash(final),
            counts: {
                total: final.length,
                exceptions: exceptions.length,
                rules_only: final.length - exceptions.length
            },
            exceptions: exceptions.map(row => ({
                course_id: row.course_id,
                title: row.title,
                tier: row.tier,
                price_mad: row.price_mad,
                price_eur: row.price_eur,
                source: row.source,
                confidence: row.confidence ?? null,
                reasons: row.reasons || [],
                trace: row.trace || null
            }))
        };
        fs.writeFileSync(requestPath, JSON.stringify(requests, null, 2));

        let effective = normalizeDecision(decision);
        if (effective.decision === 'pending' && fs.existsSync(decisionPath)) {
            effective = normalizeDecision(JSON.parse(fs.readFileSync(decisionPath, 'utf8')));
        }

        const autoRulesAllowed = this.config.approval.auto_approve_rules
            && String(process.env.AUTO_APPROVE_RULES || 'true').toLowerCase() !== 'false';

        if (effective.decision === 'pending' && autoApprove) {
            effective = {
                decision: 'approved',
                approved_courses: final.map(row => row.course_id),
                rejected_courses: [],
                decided_by: 'auto_approve_flag',
                decided_at: this.now().toISOString()
            };
            fs.writeFileSync(decisionPath, JSON.stringify(effective, null, 2));
        } else if (effective.decision === 'pending' && autoRulesAllowed) {
            // Bulk tier-map prices never need founder review; LLM and
            // self_improve prices always do (blueprint §4.7).
            const rulesIds = final
                .filter(row => row.source === 'rules' && !row.needs_review)
                .map(row => row.course_id);
            if (rulesIds.length) {
                effective = {
                    decision: 'approved',
                    approved_courses: rulesIds,
                    rejected_courses: [],
                    decided_by: 'auto_rules',
                    decided_at: this.now().toISOString()
                };
                fs.writeFileSync(decisionPath, JSON.stringify(effective, null, 2));
            }
        } else if (effective.decision === 'pending' && waitMs > 0) {
            effective = await this.waitForDecision(decisionPath, waitMs);
        }

        const allIds = final.map(row => row.course_id);
        const rejected = new Set(effective.rejected_courses);
        let approvedIds = [];
        if (effective.decision === 'approved') {
            approvedIds = (effective.approved_courses.length ? effective.approved_courses : allIds)
                .filter(id => allIds.includes(id) && !rejected.has(id));
        }

        const pendingIds = allIds.filter(id => !approvedIds.includes(id));
        const status = approvedIds.length === 0
            ? 'awaiting_approval'
            : pendingIds.length > 0 ? 'partially_approved' : 'approved';
        this.logger(`approval_gate: ${status} (${approvedIds.length}/${allIds.length} approved)`);
        return {
            status,
            decision: effective,
            requestPath,
            exceptions,
            approvedIds,
            pendingIds,
            rejectedIds: [...rejected]
        };
    }

    async waitForDecision(decisionPath, waitMs) {
        const deadline = Date.now() + waitMs;
        while (Date.now() < deadline) {
            if (fs.existsSync(decisionPath)) {
                try {
                    return normalizeDecision(JSON.parse(fs.readFileSync(decisionPath, 'utf8')));
                } catch {
                    /* keep polling until the file is fully written */
                }
            }
            await new Promise(resolve => setTimeout(resolve, Math.min(2000, this.config.approval.poll_interval_ms)));
        }
        return normalizeDecision(null);
    }

    // --------------------------------------------------------------- publish
    async publish(final, approval) {
        const paths = this.paths();
        const approved = final.filter(row => approval.approvedIds.includes(row.course_id));
        const existing = latestPrices(paths.priceLog);
        const writes = [];
        const skipped = [];

        for (const row of approved) {
            const current = existing.get(row.course_id);
            if (current && Number(current.price_mad) === Number(row.price_mad) && current.source === row.source) {
                skipped.push(row.course_id);
                continue;
            }
            writes.push({
                course_id: row.course_id,
                title: row.title,
                tier: row.tier,
                price_mad: row.price_mad,
                price_eur: row.price_eur,
                currency: this.config.currency,
                source: row.source,
                approved_by: approval.decision.decided_by || 'founder',
                job_id: this.jobId,
                published_at: this.now().toISOString()
            });
        }
        appendNdjson(paths.priceLog, writes);

        const report = {
            job_id: this.jobId,
            generated_at: this.now().toISOString(),
            dry_run: this.mock,
            catalog_writes: writes.length,
            catalog_skipped: skipped.length,
            approved: approval.approvedIds.length,
            pending_approval: approval.pendingIds.length,
            warnings: [],
            shopify: { status: 'skipped', reason: null, created: 0, updated: 0, unchanged: 0, failed: [] },
            storefront: null
        };

        const tokenPresent = Boolean(this.shopify.token);
        if (this.mock) {
            report.shopify.reason = 'mock mode';
        } else if (!tokenPresent) {
            report.shopify.reason = 'no SHOPIFY_ADMIN_TOKEN; prices written locally only';
            report.warnings.push(report.shopify.reason);
        } else if (writes.length || skipped.length) {
            try {
                const products = await listProducts(this.shopify, { fetchImpl: this.fetchImpl });
                const byId = new Map(approved.map(row => [row.course_id, row]));
                for (const courseId of [...writes.map(w => w.course_id), ...skipped]) {
                    const row = byId.get(courseId);
                    if (!row) continue;
                    try {
                        const result = await upsertProduct({ course_id: row.course_id, title: row.title, description: '' }, row.price_mad, {
                            settings: this.shopify,
                            existing: products,
                            fetchImpl: this.fetchImpl
                        });
                        if (result.action === 'created') report.shopify.created += 1;
                        else if (result.action === 'updated') report.shopify.updated += 1;
                        else report.shopify.unchanged += 1;
                    } catch (error) {
                        report.shopify.failed.push({ course_id: courseId, error: error.message });
                    }
                }
                report.shopify.status = report.shopify.failed.length ? 'partial' : 'ok';
            } catch (error) {
                report.shopify.status = 'error';
                report.shopify.reason = error.message;
                report.warnings.push(`Shopify publish failed: ${error.message}`);
            }
        } else {
            report.shopify.reason = 'nothing approved to publish';
        }

        if (!this.mock) {
            report.storefront = await checkStorefrontGate(this.shopify, { fetchImpl: this.fetchImpl });
            if (report.storefront.password_gate === 'on') {
                report.warnings.push('Shopify password gate is ON: buyers hit a password page, not the catalog.');
            }
        }

        appendNdjson(paths.publishReport, [report]);
        fs.writeFileSync(paths.summary, JSON.stringify({
            job_id: this.jobId,
            catalog_path: this.catalogPath,
            generated_at: report.generated_at,
            approval: { status: approval.status, decided_by: approval.decision.decided_by || null },
            counts: {
                priced: final.length,
                approved: approval.approvedIds.length,
                published: writes.length,
                skipped: skipped.length,
                pending: approval.pendingIds.length
            },
            shopify: report.shopify,
            storefront: report.storefront,
            warnings: report.warnings
        }, null, 2));
        this.logger(`publish: ${writes.length} written, ${skipped.length} unchanged, shopify=${report.shopify.status}`);
        return report;
    }

    // ---------------------------------------------------------- self_improve
    async selfImprove({ days = this.config.self_improve.window_days } = {}) {
        const paths = this.paths();
        const courses = mergePrices(this.requireCatalog(), paths.priceLog);
        const intents = loadIntents(paths.intents);
        const viewsRows = readNdjson(paths.views);
        const orders = readNdjson(paths.orders);
        const cutoff = this.now().getTime() - days * 86400000;

        const inWindow = row => Number.isFinite(Date.parse(row.timestamp || row.created_at)) && Date.parse(row.timestamp || row.created_at) >= cutoff;
        const intentsByCourse = new Map();
        for (const intent of intents.filter(row => row.event === 'checkout_intent' && inWindow(row))) {
            intentsByCourse.set(intent.course_id, (intentsByCourse.get(intent.course_id) || 0) + 1);
        }
        const ordersByCourse = new Map();
        for (const order of orders.filter(inWindow)) {
            const id = order.course_id;
            if (id) ordersByCourse.set(id, (ordersByCourse.get(id) || 0) + 1);
        }
        const viewsByCourse = new Map();
        for (const row of viewsRows) {
            if (!row?.course_id) continue;
            viewsByCourse.set(row.course_id, Math.max(viewsByCourse.get(row.course_id) || 0, Number(row.views) || 0));
        }

        const candidates = [];
        for (const course of courses) {
            const current = Number(course.price_mad);
            if (!Number.isFinite(current) || current <= 0) continue;
            const tier = getTierConfig(resolveTier(course, this.config), this.config);
            const courseViews = viewsByCourse.get(course.course_id) || 0;
            const courseIntents = intentsByCourse.get(course.course_id) || 0;
            const courseOrders = ordersByCourse.get(course.course_id) || 0;
            const row = {
                course_id: course.course_id,
                title: course.title,
                tier: course.tier,
                current_price_mad: current,
                views: courseViews,
                intents: courseIntents,
                orders: courseOrders,
                window_days: days,
                generated_at: this.now().toISOString()
            };
            if (courseViews >= this.config.self_improve.min_views && courseIntents === 0) {
                const discounted = Math.max(
                    tier.min_mad,
                    roundMad(current * (1 - this.config.self_improve.price_cut_pct / 100), this.config)
                );
                candidates.push({
                    ...row,
                    action: 'lower_price',
                    suggested_price_mad: discounted,
                    reason: `${courseViews} views and zero checkout intents in ${days} days`
                });
            } else if (courseIntents >= 5 && courseOrders === 0) {
                candidates.push({
                    ...row,
                    action: 'review_offer',
                    suggested_price_mad: current,
                    reason: `${courseIntents} intents and zero paid orders: inspect checkout friction and payment rails`
                });
            }
        }

        appendNdjson(paths.candidates, candidates);
        writeNdjson(path.join(this.dir, 'RepricingCandidates.ndjson'), candidates);
        this.logger(`self_improve: ${candidates.length} candidate(s) from ${intents.length} intent event(s)`);
        return {
            job_id: this.jobId,
            generated_at: this.now().toISOString(),
            window_days: days,
            candidates
        };
    }

    // ------------------------------------------------------------------ loop
    async run({ autoApprove = false, waitMs = 0, maxIterations = 5 } = {}) {
        const manifest = await this.recon();
        let matrix = await this.genMatrix(manifest);
        let triage = await this.triage(matrix);

        let iteration = 0;
        while (triage.failures.length && iteration < maxIterations) {
            iteration += 1;
            this.logger(`triage iteration ${iteration}: repairing ${triage.failures.length} price(s)`);
            matrix = this.repairFailures(matrix, triage.failures);
            triage = await this.triage(matrix);
        }

        const { final, blocked } = await this.assemble(matrix, triage.failures);
        const approval = await this.approvalGate(final, { autoApprove, waitMs });
        if (approval.status === 'awaiting_approval') {
            this.logger(`approval required: ${approval.requestPath}`);
            return {
                job_id: this.jobId,
                status: approval.status,
                job_dir: this.paths().dir,
                request: approval.requestPath,
                exceptions: approval.exceptions.length,
                blocked,
                triage_iterations: iteration,
                approval
            };
        }

        const publish = await this.publish(final, approval);
        return {
            job_id: this.jobId,
            status: approval.pendingIds.length ? 'published_partial' : 'published',
            job_dir: this.paths().dir,
            request: approval.requestPath,
            blocked,
            triage_iterations: iteration,
            counts: {
                priced: final.length,
                approved: approval.approvedIds.length,
                pending: approval.pendingIds.length,
                blocked: blocked.length
            },
            publish
        };
    }

    async resume({ jobId = this.jobId, decision = null } = {}) {
        const paths = this.paths(jobId);
        const final = readNdjson(paths.finalMatrix);
        if (!final.length) throw new Error(`No FinalPriceMatrix for job ${jobId}`);
        const approval = await this.approvalGate(final, { decision, waitMs: 0 });
        if (approval.status === 'awaiting_approval') {
            return { job_id: jobId, status: 'awaiting_approval', request: paths.request, approval };
        }
        const publish = await this.publish(final, approval);
        return { job_id: jobId, status: 'published', publish, approval };
    }

    /** Blueprint KPI table: priced catalog, storefront, intents, orders. */
    async status() {
        const paths = this.paths();
        const courses = mergePrices(this.requireCatalog(), paths.priceLog);
        const priced = courses.filter(course => Number(course.price_mad) > 0).length;
        const publishReports = readNdjson(paths.publishReport);
        const lastPublish = publishReports.at(-1) || null;
        const funnel = funnelSummary(paths.intents, { days: 30, now: this.now() });
        const orders = readNdjson(paths.orders);
        return {
            generated_at: this.now().toISOString(),
            courses_total: courses.length,
            courses_priced: priced,
            courses_unpriced: courses.length - priced,
            shopify_products: lastPublish
                ? lastPublish.shopify.created + lastPublish.shopify.unchanged + lastPublish.shopify.updated
                : 0,
            password_gate: lastPublish?.storefront?.password_gate || 'unknown',
            checkout_intents: funnel.counts.checkout_intent,
            paid_orders: orders.length || funnel.counts.paid_order,
            intent_to_paid_rate: funnel.intent_to_paid_rate,
            funnel,
            last_publish: lastPublish
        };
    }
}
