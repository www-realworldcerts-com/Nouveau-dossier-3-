import { loadCourseCatalog, priceInCurrency } from './course-catalog.mjs';
import { getShopCurrency, listProducts, normalizeVariantPrice, productPayloadFor, upsertProduct } from './shopify.mjs';

function inspectActivePrices(priced, existing) {
    const existingByHandle = new Map(existing.map(product => [product.handle, product]));
    const activePriceChanges = [];
    const activeVariantErrors = [];

    // An active product's price belongs to shopify:reprice, which snapshots and
    // can roll back the whole batch. This is checked in dry-run and real runs.
    for (const { course, price } of priced) {
        const desired = productPayloadFor(course, price.amount, { currency: price.currency });
        const handle = desired.product.handle;
        const match = existingByHandle.get(handle);
        if (!match || String(match.status || '').toLowerCase() !== 'active') continue;

        const variant = match.variants?.[0];
        if (!variant || variant.id === undefined || variant.id === null) {
            activeVariantErrors.push({
                course_id: course.slug,
                product_id: match.id ?? null,
                handle,
                reason: 'active_product_variant_missing'
            });
            continue;
        }

        const current = normalizeVariantPrice(variant.price);
        const target = normalizeVariantPrice(desired.product.variants[0].price);
        if (current !== target) {
            activePriceChanges.push({
                course_id: course.slug,
                product_id: match.id,
                variant_id: variant.id,
                handle,
                current_price: current,
                target_price: target,
                currency: price.currency
            });
        }
    }

    return { activePriceChanges, activeVariantErrors };
}

/**
 * Publish the canonical catalog to Shopify.
 *
 * Every product is resolved from config/course-catalog.json. A caller cannot
 * supply a price: the store-currency amount is derived from the course's
 * explicit USD price and the catalog FX table. All selected courses are
 * validated before the first Shopify write, so a bad currency or missing course
 * cannot leave a half-published catalog. Products are written as drafts; use
 * shopify-activation.mjs to run the gate and activate them.
 */
export async function publishCatalogToShopify({
    catalog = loadCourseCatalog(),
    courseIds = null,
    settings,
    fetchImpl = globalThis.fetch,
    storeCurrency = null,
    dryRun = false
} = {}) {
    if (!dryRun && !settings?.domain) {
        return { status: 'blocked', reason: 'missing_shop_domain', published: false };
    }
    if (!dryRun && !settings?.token) {
        return { status: 'blocked', reason: 'missing_admin_token', published: false };
    }

    const knownSlugs = new Set(catalog.courses.map(course => course.slug));
    const missing = courseIds
        ? [...new Set(courseIds)].filter(slug => !knownSlugs.has(slug))
        : [];
    if (missing.length) {
        return {
            status: 'blocked',
            reason: 'courses_not_in_canonical_catalog',
            published: false,
            missing
        };
    }
    const selected = courseIds
        ? catalog.courses.filter(course => courseIds.includes(course.slug))
        : catalog.courses;
    if (!selected.length) {
        return { status: 'blocked', reason: 'no_courses_selected', published: false };
    }

    let currency = String(storeCurrency || '').toUpperCase();
    if (!currency && settings?.domain && settings?.token) {
        try {
            currency = String(await getShopCurrency(settings, { fetchImpl })).toUpperCase();
        } catch (error) {
            return { status: 'error', reason: `store_currency_unavailable: ${error.message}`, published: false };
        }
    }
    if (!currency) currency = catalog.currency;

    const priced = [];
    const failed = [];
    for (const course of selected) {
        try {
            priced.push({ course, price: priceInCurrency(course, currency, catalog.fx) });
        } catch (error) {
            failed.push({ course_id: course.slug, error: error.message });
        }
    }
    if (failed.length) {
        return {
            status: 'blocked',
            reason: 'invalid_catalog_prices',
            published: false,
            store_currency: currency,
            catalog_currency: catalog.currency,
            failed
        };
    }

    const preview = priced.slice(0, 5).map(row => ({
        course_id: row.course.slug,
        title: row.course.title,
        price: row.price.amount,
        currency: row.price.currency,
        rate: row.price.rate
    }));

    const canInspectExisting = Boolean(settings?.domain && settings?.token);
    let existing = [];
    if (canInspectExisting) {
        try {
            existing = await listProducts(settings, { fetchImpl });
        } catch (error) {
            if (dryRun) {
                return {
                    status: 'error',
                    reason: `products_unavailable: ${error.message}`,
                    published: false,
                    dry_run: true
                };
            }
            throw error;
        }
    }

    const { activePriceChanges, activeVariantErrors } = inspectActivePrices(priced, existing);
    const wouldBlock = activePriceChanges.length > 0 || activeVariantErrors.length > 0;

    if (dryRun) {
        return {
            status: 'dry_run',
            reason: null,
            published: false,
            dry_run: true,
            ready: !wouldBlock,
            would_block: wouldBlock,
            active_price_check: canInspectExisting ? 'evaluated' : 'skipped',
            ...(canInspectExisting ? {} : { warning: 'active_price_guard_not_evaluated' }),
            store_currency: currency,
            catalog_currency: catalog.currency,
            catalog_file: catalog.file,
            total: priced.length,
            converted: priced.some(row => row.price.converted),
            preview,
            active_price_changes: activePriceChanges,
            active_variant_errors: activeVariantErrors,
            ...(wouldBlock ? {
                next_step: 'Run `npm run shopify:reprice` to snapshot and change active product prices.'
            } : {})
        };
    }

    if (wouldBlock) {
        return {
            status: 'blocked',
            reason: 'active_product_price_change_requires_reprice',
            published: false,
            store_currency: currency,
            active_price_changes: activePriceChanges,
            active_variant_errors: activeVariantErrors,
            next_step: 'Run `npm run shopify:reprice` to snapshot and change active product prices.'
        };
    }

    const report = {
        status: 'ok',
        reason: null,
        published: true,
        draft: true,
        dry_run: false,
        store_currency: currency,
        catalog_currency: catalog.currency,
        catalog_file: catalog.file,
        total: priced.length,
        converted: priced.some(row => row.price.converted),
        created: 0,
        updated: 0,
        unchanged: 0,
        failed: []
    };

    for (const { course, price } of priced) {
        try {
            const result = await upsertProduct(course, price.amount, {
                settings,
                existing,
                fetchImpl,
                currency: price.currency
            });
            if (result.action === 'created') report.created += 1;
            else if (result.action === 'updated') report.updated += 1;
            else report.unchanged += 1;
        } catch (error) {
            report.failed.push({ course_id: course.slug, error: error.message });
        }
    }

    if (report.failed.length) report.status = 'partial';
    return report;
}
