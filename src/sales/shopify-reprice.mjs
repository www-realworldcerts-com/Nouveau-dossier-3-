import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { loadCourseCatalog, priceInCurrency } from './course-catalog.mjs';
import { acquireActivationLock, releaseActivationLock } from './shopify-activation-run.mjs';
import {
    getShopCurrency,
    listProducts,
    normalizeVariantPrice,
    updateVariantPrice
} from './shopify.mjs';

const RUNS_DIR = 'ShopifyRepriceRuns';

function iso(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error('Invalid reprice timestamp');
    return date.toISOString();
}

export function repriceRunsDirectory(dataDir) {
    if (!dataDir) throw new Error('Reprice runs require a data directory');
    return path.join(path.resolve(dataDir), RUNS_DIR);
}

export function normalizeRepriceRunId(value) {
    const runId = String(value || '').trim().replace(/\.json$/i, '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
        throw new Error('Invalid reprice run id');
    }
    return runId;
}

export function repriceRunPath(dataDir, runId) {
    return path.join(repriceRunsDirectory(dataDir), `${normalizeRepriceRunId(runId)}.json`);
}

export function newRepriceRunId(now = new Date()) {
    const stamp = iso(now).replace(/[-:.TZ]/g, '').slice(0, 14);
    return `${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

export function saveRepriceRun(dataDir, report) {
    const reportPath = repriceRunPath(dataDir, report.run_id);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    const payload = {
        ...report,
        report_path: reportPath,
        updated_at: report.updated_at || iso(report.updated_at)
    };
    const temporary = `${reportPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), { mode: 0o600 });
        fs.renameSync(temporary, reportPath);
    } catch (error) {
        try {
            fs.unlinkSync(temporary);
        } catch {
            // Best-effort cleanup only.
        }
        throw error;
    }
    return reportPath;
}

export function loadRepriceRun(dataDir, runId) {
    try {
        return JSON.parse(fs.readFileSync(repriceRunPath(dataDir, runId), 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

export function latestRepriceRun(dataDir) {
    let files;
    try {
        files = fs.readdirSync(repriceRunsDirectory(dataDir));
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
    const runs = files
        .filter(file => file.endsWith('.json'))
        .map(file => {
            const filePath = path.join(repriceRunsDirectory(dataDir), file);
            try {
                return {
                    report: JSON.parse(fs.readFileSync(filePath, 'utf8')),
                    modified: fs.statSync(filePath).mtimeMs
                };
            } catch {
                return null;
            }
        })
        .filter(Boolean)
        .sort((left, right) => {
            const leftTime = Date.parse(left.report.started_at || '') || left.modified;
            const rightTime = Date.parse(right.report.started_at || '') || right.modified;
            return rightTime - leftTime;
        });
    return runs[0]?.report || null;
}

export function resolveRepriceRun(dataDir, value) {
    if (value === true || value === 'latest') return latestRepriceRun(dataDir);
    return loadRepriceRun(dataDir, value);
}

function comparePrice(current, target) {
    return normalizeVariantPrice(current) === normalizeVariantPrice(target);
}

async function buildRepricePlan({ catalog, selected, settings, fetchImpl, storeCurrency }) {
    let currency = String(storeCurrency || '').toUpperCase();
    if (!currency) {
        try {
            currency = String(await getShopCurrency(settings, { fetchImpl })).toUpperCase();
        } catch (error) {
            return {
                ok: false,
                store_currency: null,
                errors: [{ reason: 'store_currency_unavailable', error: error.message }],
                changes: [],
                unchanged: 0
            };
        }
    }

    let products;
    try {
        products = await listProducts(settings, { fetchImpl });
    } catch (error) {
        return {
            ok: false,
            store_currency: currency,
            errors: [{ reason: 'products_unavailable', error: error.message }],
            changes: [],
            unchanged: 0
        };
    }

    const productsByHandle = new Map(products.map(product => [product.handle, product]));
    const errors = [];
    const changes = [];
    let unchanged = 0;

    for (const course of selected) {
        let expected;
        try {
            expected = priceInCurrency(course, currency, catalog.fx);
        } catch (error) {
            errors.push({ course_id: course.slug, reason: 'price_unavailable', error: error.message });
            continue;
        }

        const handle = course.shopify_handle || course.slug;
        const product = productsByHandle.get(handle);
        if (!product) {
            errors.push({ course_id: course.slug, handle, reason: 'product_not_published' });
            continue;
        }
        if (String(product.status || '').toLowerCase() !== 'active') {
            errors.push({
                course_id: course.slug,
                product_id: product.id ?? null,
                handle,
                reason: 'product_not_active',
                status: product.status ?? null
            });
            continue;
        }

        const variants = Array.isArray(product.variants) ? product.variants : [];
        if (variants.length !== 1) {
            errors.push({
                course_id: course.slug,
                product_id: product.id ?? null,
                handle,
                reason: variants.length ? 'unsupported_variant_count' : 'missing_variant',
                variant_count: variants.length
            });
            continue;
        }

        const variant = variants[0];
        if (variant.id === undefined || variant.id === null || !Number.isFinite(Number(variant.price))) {
            errors.push({
                course_id: course.slug,
                product_id: product.id ?? null,
                handle,
                reason: 'unusable_variant',
                variant_id: variant.id ?? null
            });
            continue;
        }

        const fromPrice = normalizeVariantPrice(variant.price);
        const toPrice = normalizeVariantPrice(expected.amount);
        if (comparePrice(fromPrice, toPrice)) {
            unchanged += 1;
            continue;
        }

        changes.push({
            course_id: course.slug,
            title: course.title,
            handle,
            product_id: product.id,
            variant_id: variant.id,
            status: String(product.status || '').toLowerCase(),
            from_price: fromPrice,
            to_price: toPrice,
            currency: expected.currency
        });
    }

    return {
        ok: errors.length === 0,
        store_currency: currency,
        errors,
        changes,
        unchanged
    };
}

async function restoreSnapshot(settings, snapshot, { fetchImpl = globalThis.fetch } = {}) {
    const restored = [];
    const skipped = [];
    const errors = [];
    let products;
    try {
        products = await listProducts(settings, { fetchImpl });
    } catch (error) {
        return {
            ok: false,
            restored,
            skipped,
            errors: [{ reason: 'products_unavailable', error: error.message }]
        };
    }
    const productsById = new Map(products.map(product => [String(product.id), product]));

    for (const row of [...snapshot].reverse()) {
        const product = productsById.get(String(row.product_id));
        const variant = product?.variants?.find(item => String(item.id) === String(row.variant_id));
        if (!product || !variant) {
            errors.push({
                product_id: row.product_id,
                variant_id: row.variant_id,
                reason: 'snapshot_target_missing'
            });
            continue;
        }

        const current = normalizeVariantPrice(variant.price);
        if (comparePrice(current, row.from_price)) {
            skipped.push({ product_id: row.product_id, variant_id: row.variant_id, price: current });
            continue;
        }
        if (!comparePrice(current, row.to_price)) {
            errors.push({
                product_id: row.product_id,
                variant_id: row.variant_id,
                reason: 'price_changed_outside_reprice_run',
                expected_current: row.to_price,
                actual_current: current
            });
            continue;
        }

        try {
            await updateVariantPrice(settings, row.variant_id, row.from_price, {
                fetchImpl,
                handle: row.handle
            });
            restored.push({
                product_id: row.product_id,
                variant_id: row.variant_id,
                price: row.from_price
            });
        } catch (error) {
            errors.push({
                product_id: row.product_id,
                variant_id: row.variant_id,
                reason: 'restore_failed',
                error: error.message
            });
        }
    }

    return { ok: errors.length === 0, restored, skipped, errors };
}

async function verifyAppliedPrices(settings, changes, { fetchImpl = globalThis.fetch } = {}) {
    const products = await listProducts(settings, { fetchImpl });
    const productsById = new Map(products.map(product => [String(product.id), product]));
    const mismatches = [];
    for (const row of changes) {
        const product = productsById.get(String(row.product_id));
        const variant = product?.variants?.find(item => String(item.id) === String(row.variant_id));
        if (!variant) {
            mismatches.push({
                product_id: row.product_id,
                variant_id: row.variant_id,
                reason: 'variant_missing_after_update'
            });
            continue;
        }
        const actual = normalizeVariantPrice(variant.price);
        if (!comparePrice(actual, row.to_price)) {
            mismatches.push({
                product_id: row.product_id,
                variant_id: row.variant_id,
                reason: 'price_mismatch_after_update',
                expected: row.to_price,
                actual
            });
        }
    }
    return { ok: mismatches.length === 0, mismatches };
}

/**
 * Safely reprice active Shopify products from the canonical catalog.
 *
 * The whole selection is validated before any write. A run takes the shared
 * Shopify catalog-mutation lock, snapshots every prior variant price, updates
 * only active one-variant products, verifies the resulting prices, and restores
 * the snapshot if any write or verification fails.
 */
export async function repriceShopifyCatalog({
    catalog = loadCourseCatalog(),
    courseIds = null,
    settings,
    fetchImpl = globalThis.fetch,
    storeCurrency = null,
    dataDir = null,
    dryRun = false,
    now = new Date()
} = {}) {
    if (!dryRun && !settings?.domain) {
        return { status: 'blocked', reason: 'missing_shop_domain', changed: 0 };
    }
    if (!dryRun && !settings?.token) {
        return { status: 'blocked', reason: 'missing_admin_token', changed: 0 };
    }
    if (!dryRun && !dataDir) {
        return { status: 'blocked', reason: 'missing_data_dir', changed: 0 };
    }

    const knownSlugs = new Set(catalog.courses.map(course => course.slug));
    const missing = courseIds
        ? [...new Set(courseIds)].filter(slug => !knownSlugs.has(slug))
        : [];
    if (missing.length) {
        return {
            status: 'blocked',
            reason: 'courses_not_in_canonical_catalog',
            changed: 0,
            missing
        };
    }
    const selected = courseIds
        ? catalog.courses.filter(course => courseIds.includes(course.slug))
        : catalog.courses;
    if (!selected.length) {
        return { status: 'blocked', reason: 'no_courses_selected', changed: 0 };
    }

    const plan = await buildRepricePlan({ catalog, selected, settings, fetchImpl, storeCurrency });
    if (!plan.ok) {
        return {
            status: 'blocked',
            reason: 'reprice_preflight_failed',
            changed: 0,
            store_currency: plan.store_currency,
            errors: plan.errors,
            changes: plan.changes,
            unchanged: plan.unchanged
        };
    }

    if (dryRun) {
        return {
            status: 'dry_run',
            ready: true,
            reason: null,
            dry_run: true,
            changed: plan.changes.length,
            unchanged: plan.unchanged,
            store_currency: plan.store_currency,
            catalog_currency: catalog.currency,
            catalog_file: catalog.file,
            changes: plan.changes
        };
    }

    if (!plan.changes.length) {
        return {
            status: 'ok',
            reason: null,
            changed: 0,
            unchanged: plan.unchanged,
            store_currency: plan.store_currency,
            catalog_currency: catalog.currency,
            catalog_file: catalog.file,
            snapshot: []
        };
    }

    const runId = newRepriceRunId(now);
    const lock = acquireActivationLock({
        dataDir,
        runId,
        domain: settings.domain,
        now
    });
    if (!lock.ok) {
        return {
            status: 'blocked',
            reason: 'catalog_mutation_locked',
            changed: 0,
            run_id: runId,
            lock: lock.lock || null
        };
    }

    const snapshot = plan.changes.map(row => ({
        course_id: row.course_id,
        handle: row.handle,
        product_id: row.product_id,
        variant_id: row.variant_id,
        from_price: row.from_price,
        to_price: row.to_price,
        currency: row.currency
    }));
    const report = {
        schema_version: 1,
        kind: 'reprice',
        run_id: runId,
        status: 'in_progress',
        phase: 'snapshot',
        domain: settings.domain,
        course_ids: selected.map(course => course.slug),
        store_currency: plan.store_currency,
        catalog_currency: catalog.currency,
        catalog_file: catalog.file,
        started_at: iso(now),
        snapshot,
        applied: [],
        changed: 0,
        unchanged: plan.unchanged,
        reason: null,
        errors: []
    };

    try {
        try {
            report.report_path = saveRepriceRun(dataDir, report);
        } catch (error) {
            return {
                status: 'blocked',
                reason: 'reprice_run_report_unwritable',
                changed: 0,
                run_id: runId,
                error: error.message
            };
        }

        let failure = null;
        for (const row of plan.changes) {
            try {
                await updateVariantPrice(settings, row.variant_id, row.to_price, {
                    fetchImpl,
                    handle: row.handle
                });
                report.applied.push({
                    course_id: row.course_id,
                    product_id: row.product_id,
                    variant_id: row.variant_id,
                    from_price: row.from_price,
                    to_price: row.to_price
                });
            } catch (error) {
                failure = {
                    stage: 'update',
                    reason: 'price_update_failed',
                    failed: [{
                        course_id: row.course_id,
                        product_id: row.product_id,
                        variant_id: row.variant_id,
                        error: error.message
                    }]
                };
                break;
            }
        }

        if (!failure) {
            report.phase = 'verify';
            try {
                const verification = await verifyAppliedPrices(settings, plan.changes, { fetchImpl });
                report.verification = verification;
                if (!verification.ok) {
                    failure = {
                        stage: 'verify',
                        reason: 'post_update_verification_failed',
                        mismatches: verification.mismatches
                    };
                }
            } catch (error) {
                failure = {
                    stage: 'verify',
                    reason: 'post_update_verification_failed',
                    error: error.message
                };
            }
        }

        if (failure) {
            report.phase = 'rollback';
            let rollback;
            try {
                rollback = await restoreSnapshot(settings, snapshot, { fetchImpl });
            } catch (error) {
                rollback = {
                    ok: false,
                    restored: [],
                    skipped: [],
                    errors: [{ reason: 'rollback_failed', error: error.message }]
                };
            }
            report.status = rollback.ok ? 'rolled_back' : 'rollback_failed';
            report.reason = failure.reason;
            report.failure = failure;
            report.rollback = rollback;
            report.changed = 0;
            report.finished_at = iso(new Date());
            try {
                report.report_path = saveRepriceRun(dataDir, report);
            } catch (error) {
                report.report_error = error.message;
            }
            return report;
        }

        report.status = 'ok';
        report.phase = 'complete';
        report.changed = plan.changes.length;
        report.finished_at = iso(new Date());
        try {
            report.report_path = saveRepriceRun(dataDir, report);
        } catch (error) {
            report.report_error = error.message;
        }
        return report;
    } finally {
        releaseActivationLock(lock);
    }
}

/** Restore the snapshot from a completed or interrupted reprice run. */
export async function rollbackShopifyReprice({
    settings,
    dataDir,
    runId = 'latest',
    fetchImpl = globalThis.fetch,
    now = new Date()
} = {}) {
    if (!settings?.domain) return { status: 'blocked', reason: 'missing_shop_domain' };
    if (!settings?.token) return { status: 'blocked', reason: 'missing_admin_token' };
    if (!dataDir) return { status: 'blocked', reason: 'missing_data_dir' };

    let report;
    try {
        report = resolveRepriceRun(dataDir, runId);
    } catch (error) {
        return { status: 'blocked', reason: 'reprice_run_unreadable', error: error.message };
    }
    if (!report) return { status: 'blocked', reason: 'reprice_run_not_found' };
    if (report.kind !== 'reprice' || !Array.isArray(report.snapshot)) {
        return { status: 'blocked', reason: 'not_a_reprice_run', run_id: report.run_id ?? null };
    }
    if (report.domain && report.domain !== settings.domain) {
        return { status: 'blocked', reason: 'reprice_run_domain_mismatch', run_id: report.run_id };
    }

    const lock = acquireActivationLock({
        dataDir,
        runId: `rollback-${report.run_id}`,
        domain: settings.domain,
        now
    });
    if (!lock.ok) {
        return {
            status: 'blocked',
            reason: 'catalog_mutation_locked',
            run_id: report.run_id,
            lock: lock.lock || null
        };
    }

    try {
        const rollback = await restoreSnapshot(settings, report.snapshot, { fetchImpl });
        report.status = rollback.ok ? 'rolled_back' : 'rollback_failed';
        report.manual_rollback = {
            requested_at: iso(now),
            rollback,
            ...(rollback.ok ? {} : { reason: 'manual_rollback_failed' })
        };
        report.updated_at = iso(now);
        try {
            report.report_path = saveRepriceRun(dataDir, report);
        } catch (error) {
            report.report_error = error.message;
        }
        return { ...report, rollback };
    } finally {
        releaseActivationLock(lock);
    }
}
