import { loadCourseCatalog, priceInCurrency } from './course-catalog.mjs';
import { addProductsToCollection, adminGraphql, getShopCurrency, listProducts, setProductStatus } from './shopify.mjs';
import { ensureCoursesCollection } from './shopify-setup.mjs';
import { checkShopifyLaunchReadiness, readCoursesCollection } from './shopify-launch-readiness.mjs';
import {
    acquireActivationLock,
    newActivationRunId,
    releaseActivationLock,
    resolveActivationRun,
    saveActivationRun
} from './shopify-activation-run.mjs';

/**
 * Activate a published catalog in two phases.
 *
 * `shopify:publish` writes drafts. This command then:
 *   1. validates every selected variant against the catalog price;
 *   2. verifies every selected product is published to Online Store;
 *   3. ensures every selected product is in the Courses collection;
 *   4. temporarily activates one canary product;
 *   5. runs the launch gate against the canary;
 *   6. activates the rest only if the gate passes.
 *
 * If the gate fails, a draft canary is returned to draft. Products that were
 * already active are never deactivated by this command.
 */
export function validateVariantPrices(selectedProducts, { storeCurrency, fx } = {}) {
    const currency = String(storeCurrency || '').toUpperCase();
    const mismatches = [];
    let checkedVariants = 0;

    if (!currency) {
        return {
            ok: false,
            store_currency: null,
            checked_variants: 0,
            mismatches: [{ reason: 'missing_store_currency' }]
        };
    }

    for (const { course, product } of selectedProducts) {
        let expected;
        try {
            expected = priceInCurrency(course, currency, fx);
        } catch (error) {
            mismatches.push({
                course_id: course.slug,
                product_id: product.id ?? null,
                reason: 'price_unavailable',
                error: error.message
            });
            continue;
        }

        const variants = Array.isArray(product.variants) ? product.variants : [];
        if (!variants.length) {
            mismatches.push({
                course_id: course.slug,
                product_id: product.id ?? null,
                reason: 'missing_variant'
            });
            continue;
        }

        for (const variant of variants) {
            checkedVariants += 1;
            const actual = Number(variant?.price);
            if (variant?.id === undefined || variant?.id === null || !Number.isFinite(actual)) {
                mismatches.push({
                    course_id: course.slug,
                    product_id: product.id ?? null,
                    variant_id: variant?.id ?? null,
                    reason: 'unusable_variant'
                });
                continue;
            }

            const expectedCents = Math.round(Number(expected.amount) * 100);
            const presentments = Array.isArray(variant?.presentment_prices)
                ? variant.presentment_prices
                : [];
            if (presentments.length) {
                const matching = presentments.find(row =>
                    String(row?.price?.currencyCode || '').toUpperCase() === expected.currency
                );
                if (!matching) {
                    mismatches.push({
                        course_id: course.slug,
                        product_id: product.id ?? null,
                        variant_id: variant.id,
                        reason: 'currency_mismatch',
                        expected: expected.currency,
                        actual: presentments
                            .map(row => String(row?.price?.currencyCode || '').toUpperCase())
                            .filter(Boolean)
                    });
                    continue;
                }
                const presentmentAmount = Number(matching.price?.amount);
                if (!Number.isFinite(presentmentAmount)) {
                    mismatches.push({
                        course_id: course.slug,
                        product_id: product.id ?? null,
                        variant_id: variant.id,
                        reason: 'unusable_variant',
                        source: 'presentment_price'
                    });
                    continue;
                }
                if (Math.round(presentmentAmount * 100) !== expectedCents) {
                    mismatches.push({
                        course_id: course.slug,
                        product_id: product.id ?? null,
                        variant_id: variant.id,
                        reason: 'price_mismatch',
                        source: 'presentment_price',
                        expected: Number(expected.amount).toFixed(2),
                        actual: presentmentAmount.toFixed(2),
                        currency: expected.currency
                    });
                }
            }

            if (Math.round(actual * 100) !== expectedCents) {
                mismatches.push({
                    course_id: course.slug,
                    product_id: product.id ?? null,
                    variant_id: variant.id,
                    reason: 'price_mismatch',
                    source: 'variant_price',
                    expected: Number(expected.amount).toFixed(2),
                    actual: actual.toFixed(2),
                    currency: expected.currency
                });
            }
        }
    }

    return {
        ok: mismatches.length === 0,
        store_currency: currency,
        checked_products: selectedProducts.length,
        checked_variants: checkedVariants,
        mismatches
    };
}

async function onlineStorePublication(settings, { fetchImpl }) {
    const data = await adminGraphql(settings, `query LaunchPublications {
        publications(first: 50) {
            nodes { id catalog { title } }
        }
    }`, { fetchImpl });
    return (data?.publications?.nodes || []).find(publication =>
        /online\s*store/i.test(String(publication.catalog?.title || ''))
    ) || null;
}

async function productPublishedOnPublication(settings, product, publication, { fetchImpl }) {
    const productId = String(product.id);
    const gid = productId.startsWith('gid://') ? productId : `gid://shopify/Product/${productId}`;
    const data = await adminGraphql(settings, `query LaunchProductPublication($id: ID!, $publicationId: ID!) {
        product(id: $id) {
            publishedOnPublication(publicationId: $publicationId)
        }
    }`, {
        variables: { id: gid, publicationId: publication.id },
        fetchImpl
    });
    return data?.product?.publishedOnPublication === true;
}

async function readPublicationStates(settings, selectedProducts, publication, { fetchImpl }) {
    const states = new Map();
    for (const { product } of selectedProducts) {
        states.set(String(product.id), await productPublishedOnPublication(
            settings,
            product,
            publication,
            { fetchImpl }
        ));
    }
    return states;
}

async function setProductPublication(settings, productId, publicationId, published, { fetchImpl }) {
    const id = String(productId).startsWith('gid://') ? String(productId) : `gid://shopify/Product/${productId}`;
    const mutation = published
        ? `mutation LaunchPublishProduct($id: ID!, $publicationId: ID!) {
            publishablePublish(id: $id, input: [{ publicationId: $publicationId }]) {
                userErrors { field message }
            }
        }`
        : `mutation LaunchUnpublishProduct($id: ID!, $publicationId: ID!) {
            publishableUnpublish(id: $id, input: [{ publicationId: $publicationId }]) {
                userErrors { field message }
            }
        }`;
    const data = await adminGraphql(settings, mutation, {
        variables: { id, publicationId },
        fetchImpl
    });
    const result = published ? data?.publishablePublish : data?.publishableUnpublish;
    const userErrors = result?.userErrors || [];
    if (userErrors.length) {
        throw new Error(userErrors.map(error => error.message).join('; '));
    }
    return { product_id: productId, published };
}

async function setOnlineStorePublication(settings, selectedProducts, publication, publicationStates, { fetchImpl }) {
    const failures = [];
    const published = [];
    let skippedPublished = 0;
    for (const { course, product } of selectedProducts) {
        if (publicationStates.get(String(product.id)) === true) {
            skippedPublished += 1;
            continue;
        }
        try {
            await setProductPublication(settings, product.id, publication.id, true, { fetchImpl });
            published.push({ course_id: course.slug, product_id: product.id });
        } catch (error) {
            failures.push({
                course_id: course.slug,
                product_id: product.id,
                errors: [error.message]
            });
        }
    }

    return {
        ok: failures.length === 0,
        publication: { id: publication.id, name: publication.catalog?.title || null },
        skipped_published: skippedPublished,
        published,
        failures
    };
}

async function buildActivationSnapshot(settings, selectedProducts, publication, { fetchImpl }) {
    const publicationStates = await readPublicationStates(settings, selectedProducts, publication, { fetchImpl });
    return selectedProducts.map(({ course, product }) => ({
        course_id: course.slug,
        product_id: product.id,
        status: String(product.status || 'draft').toLowerCase(),
        online_store_published: publicationStates.get(String(product.id)) === true
    }));
}

async function verifyOnlineStorePublication(settings, selectedProducts, publication, { fetchImpl }) {
    const unpublished = [];
    for (const { course, product } of selectedProducts) {
        if (!await productPublishedOnPublication(settings, product, publication, { fetchImpl })) {
            unpublished.push({ course_id: course.slug, product_id: product.id });
        }
    }

    return {
        ok: unpublished.length === 0,
        reason: unpublished.length ? 'products_not_published_to_online_store' : null,
        publication: { id: publication.id, name: publication.catalog?.title || null },
        unpublished
    };
}

async function restoreActivationSnapshot(settings, snapshot, publication, { fetchImpl }) {
    const statuses = [];
    const publications = [];
    const errors = [];
    for (const row of snapshot) {
        try {
            if (!['active', 'draft'].includes(row.status)) {
                throw new Error(`Unsupported snapshot status: ${row.status}`);
            }
            await setProductStatus(settings, row.product_id, row.status, { fetchImpl });
            statuses.push(row.product_id);
        } catch (error) {
            errors.push({ product_id: row.product_id, stage: 'status', error: error.message });
        }
        try {
            await setProductPublication(
                settings,
                row.product_id,
                publication.id,
                row.online_store_published === true,
                { fetchImpl }
            );
            publications.push(row.product_id);
        } catch (error) {
            errors.push({ product_id: row.product_id, stage: 'publication', error: error.message });
        }
    }
    return {
        ok: errors.length === 0,
        statuses,
        publications,
        errors
    };
}

export async function planCatalogActivation({
    catalog = loadCourseCatalog(),
    courseIds = null,
    settings,
    fetchImpl = globalThis.fetch,
    storeCurrency = null,
    checkReadiness = checkShopifyLaunchReadiness
} = {}) {
    const base = {
        status: 'dry_run',
        dry_run: true,
        activated: false,
        ready: false,
        blockers: [],
        selected_count: 0,
        product_count: 0
    };
    const blocked = (reason, extra = {}) => ({
        ...base,
        ...extra,
        reason,
        blockers: [...new Set([...(extra.blockers || []), reason])]
    });

    if (!settings?.domain) return blocked('missing_shop_domain');
    if (!settings?.token) return blocked('missing_admin_token');

    const knownSlugs = new Set(catalog.courses.map(course => course.slug));
    const missingCourses = courseIds
        ? [...new Set(courseIds)].filter(slug => !knownSlugs.has(slug))
        : [];
    if (missingCourses.length) {
        return blocked('courses_not_in_canonical_catalog', { missing: missingCourses });
    }

    const selectedCourses = (courseIds
        ? catalog.courses.filter(course => courseIds.includes(course.slug))
        : catalog.courses)
        .filter(course => String(course.status || 'active').toLowerCase() !== 'draft');
    if (!selectedCourses.length) return blocked('no_courses_selected');

    let products;
    try {
        products = await listProducts(settings, { fetchImpl });
    } catch (error) {
        return blocked('product_list_failed', { error: error.message });
    }
    const productsByHandle = new Map(products.map(product => [product.handle, product]));
    const missingProducts = selectedCourses
        .filter(course => !productsByHandle.has(course.slug))
        .map(course => course.slug);
    if (missingProducts.length) {
        return blocked('products_not_published', {
            missing: missingProducts,
            next_step: 'Run `npm run shopify:publish` to create the drafts first.'
        });
    }

    const selectedProducts = selectedCourses.map(course => ({
        course,
        product: productsByHandle.get(course.slug)
    }));
    const blockers = [];

    let currency = String(storeCurrency || '').toUpperCase();
    if (!currency) {
        try {
            currency = String(await getShopCurrency(settings, { fetchImpl })).toUpperCase();
        } catch (error) {
            blockers.push('store_currency_unavailable');
        }
    }

    let priceCheck = null;
    if (currency) {
        priceCheck = validateVariantPrices(selectedProducts, {
            storeCurrency: currency,
            fx: catalog.fx
        });
        if (!priceCheck.ok) blockers.push('variant_validation_failed');
    }

    let publication = null;
    try {
        publication = await onlineStorePublication(settings, { fetchImpl });
    } catch (error) {
        blockers.push('publication_check_failed');
    }
    if (!publication) blockers.push('online_store_publication_missing');

    let publicationStates = new Map();
    if (publication) {
        try {
            publicationStates = await readPublicationStates(settings, selectedProducts, publication, { fetchImpl });
        } catch (error) {
            blockers.push('publication_check_failed');
        }
    }

    let collection = null;
    let memberIds = new Set();
    try {
        const membership = await readCoursesCollection(settings, { fetchImpl });
        collection = membership.collection;
        memberIds = new Set(membership.productIds.map(String));
    } catch (error) {
        blockers.push('collection_membership_check_failed');
    }
    if (!collection) blockers.push('collection_missing');

    const rows = selectedProducts.map(({ course, product }) => {
        const productId = String(product.id);
        const status = String(product.status || 'draft').toLowerCase();
        const published = publicationStates.get(productId) === true;
        const member = memberIds.has(productId);
        return {
            course_id: course.slug,
            title: course.title,
            product_id: product.id,
            handle: product.handle,
            status,
            variants: Array.isArray(product.variants) ? product.variants.length : 0,
            activation_action: status === 'active' ? 'none' : 'activate',
            publication_action: !publication ? 'blocked' : published ? 'none' : 'publish',
            collection_action: member ? 'none' : 'add'
        };
    });

    const canary = selectedCourses.find(course => course.slug === settings.canaryCourse)
        || selectedCourses[0];
    const canaryProduct = productsByHandle.get(canary.slug);

    let readiness = null;
    try {
        readiness = await checkReadiness(
            { ...settings, canaryCourse: canary.slug },
            {
                catalog,
                courseIds: selectedCourses.map(course => course.slug),
                fetchImpl,
                dryRun: true
            }
        );
        blockers.push(...(readiness?.blockers || []));
    } catch (error) {
        blockers.push('readiness_check_failed');
        readiness = { ready: false, blockers: ['readiness_check_failed'], error: error.message };
    }

    const uniqueBlockers = [...new Set(blockers)];
    return {
        ...base,
        ready: uniqueBlockers.length === 0,
        blockers: uniqueBlockers,
        selected_count: selectedCourses.length,
        product_count: products.length,
        currency: { catalog: catalog.currency, store: currency || null },
        price_check: priceCheck,
        publication: publication
            ? {
                id: publication.id,
                name: publication.catalog?.title || null,
                action_count: rows.filter(row => row.publication_action === 'publish').length
            }
            : null,
        collection: {
            exists: Boolean(collection),
            id: collection?.id || null,
            handle: collection?.handle || 'courses',
            action: collection ? 'reuse' : 'create',
            addition_count: rows.filter(row => row.collection_action === 'add').length
        },
        canary: { course: canary.slug, product_id: canaryProduct.id },
        products: rows,
        activation_actions: rows.filter(row => row.activation_action === 'activate').map(row => row.course_id),
        publication_actions: rows.filter(row => row.publication_action === 'publish').map(row => row.course_id),
        collection_actions: rows.filter(row => row.collection_action === 'add').map(row => row.course_id),
        readiness,
        warnings: readiness?.warnings || []
    };
}

export async function activateCatalog({
    catalog = loadCourseCatalog(),
    courseIds = null,
    settings,
    fetchImpl = globalThis.fetch,
    storeCurrency = null,
    checkReadiness = checkShopifyLaunchReadiness,
    dataDir = null,
    resumeRunId = null,
    now = () => new Date(),
    dryRun = false
} = {}) {
    const timestamp = () => new Date(now()).toISOString();
    if (dryRun) {
        if (resumeRunId) {
            return {
                status: 'blocked',
                reason: 'dry_run_resume_unsupported',
                dry_run: true,
                activated: false
            };
        }
        return planCatalogActivation({
            catalog,
            courseIds,
            settings,
            fetchImpl,
            storeCurrency,
            checkReadiness
        });
    }
    if (!settings?.domain) {
        return { status: 'blocked', reason: 'missing_shop_domain', activated: false };
    }
    if (!settings?.token) {
        return { status: 'blocked', reason: 'missing_admin_token', activated: false };
    }

    let resumedReport = null;
    if (resumeRunId) {
        if (!dataDir) {
            return {
                status: 'blocked',
                reason: 'resume_requires_data_dir',
                activated: false
            };
        }
        try {
            resumedReport = resolveActivationRun(dataDir, resumeRunId);
        } catch (error) {
            return {
                status: 'blocked',
                reason: 'activation_run_unreadable',
                activated: false,
                error: error.message
            };
        }
        if (!resumedReport) {
            return {
                status: 'blocked',
                reason: 'activation_run_not_found',
                activated: false
            };
        }
        if (resumedReport.status === 'ok' || resumedReport.completed_at) {
            return {
                status: 'blocked',
                reason: 'activation_run_completed',
                activated: false,
                run_id: resumedReport.run_id
            };
        }
        if (resumedReport.status !== 'in_progress' && resumedReport.rollback?.ok !== false) {
            return {
                status: 'blocked',
                reason: 'activation_run_not_resumable',
                activated: false,
                run_id: resumedReport.run_id
            };
        }
        if (resumedReport.domain && resumedReport.domain !== settings.domain) {
            return {
                status: 'blocked',
                reason: 'activation_run_shop_mismatch',
                activated: false,
                run_id: resumedReport.run_id
            };
        }
        if (Array.isArray(resumedReport.course_ids) && resumedReport.course_ids.length) {
            if (courseIds === null) courseIds = resumedReport.course_ids;
            const requested = new Set(courseIds.map(String));
            const saved = new Set(resumedReport.course_ids.map(String));
            if (requested.size !== saved.size || [...requested].some(slug => !saved.has(slug))) {
                return {
                    status: 'blocked',
                    reason: 'activation_run_course_mismatch',
                    activated: false,
                    run_id: resumedReport.run_id
                };
            }
        }
    }

    const knownSlugs = new Set(catalog.courses.map(course => course.slug));
    const missingCourses = courseIds
        ? [...new Set(courseIds)].filter(slug => !knownSlugs.has(slug))
        : [];
    if (missingCourses.length) {
        return {
            status: 'blocked',
            reason: 'courses_not_in_canonical_catalog',
            activated: false,
            missing: missingCourses
        };
    }

    const selectedCourses = (courseIds
        ? catalog.courses.filter(course => courseIds.includes(course.slug))
        : catalog.courses)
        .filter(course => String(course.status || 'active').toLowerCase() !== 'draft');
    if (!selectedCourses.length) {
        return { status: 'blocked', reason: 'no_courses_selected', activated: false };
    }
    if (resumedReport?.course_ids?.length) {
        const selected = new Set(selectedCourses.map(course => course.slug));
        const saved = new Set(resumedReport.course_ids.map(String));
        if (selected.size !== saved.size || [...saved].some(slug => !selected.has(slug))) {
            return {
                status: 'blocked',
                reason: 'activation_run_course_selection_changed',
                activated: false,
                run_id: resumedReport.run_id
            };
        }
    }

    let lock = null;
    let runReport = null;
    let snapshot = null;
    let publication = null;

    const finish = (result, phase = 'finished') => {
        const final = { ...result };
        if (snapshot) final.snapshot = snapshot;
        if (runReport) {
            final.run_id = runReport.run_id;
            final.report_path = runReport.report_path;
            final.resumed = Number(runReport.resume_count || 0) > 0;
            runReport.status = final.status;
            runReport.phase = phase;
            runReport.updated_at = timestamp();
            runReport.completed_at = timestamp();
            runReport.rollback = final.rollback || null;
            runReport.result = final;
            try {
                runReport.report_path = saveActivationRun(dataDir, runReport);
                final.report_path = runReport.report_path;
            } catch (error) {
                final.run_report_error = error.message;
            }
        }
        return final;
    };

    const saveProgress = (phase, extra = {}) => {
        if (!runReport) return;
        Object.assign(runReport, extra, { phase, updated_at: timestamp() });
        try {
            runReport.report_path = saveActivationRun(dataDir, runReport);
        } catch (error) {
            runReport.report_error = error.message;
        }
    };

    const rollbackAndFinish = async ({ status = 'blocked', reason, ...extra }) => {
        let rollback = { ok: true, statuses: [], publications: [], errors: [], skipped: true };
        if (snapshot && publication) {
            rollback = await restoreActivationSnapshot(settings, snapshot, publication, { fetchImpl });
        }
        return finish({
            ...extra,
            status,
            reason,
            activated: false,
            rolled_back: rollback.statuses,
            rollback
        }, 'rolled_back');
    };

    try {
        if (dataDir) {
            const runId = resumedReport?.run_id || newActivationRunId(new Date(now()));
            lock = acquireActivationLock({
                dataDir,
                runId,
                domain: settings.domain,
                now: new Date(now())
            });
            if (!lock.ok) {
                return {
                    status: 'blocked',
                    reason: lock.reason,
                    activated: false,
                    run_id: runId,
                    lock: lock.lock || null
                };
            }
            runReport = resumedReport
                ? {
                    ...resumedReport,
                    status: 'in_progress',
                    phase: 'preflight',
                    resumed_at: timestamp(),
                    resume_count: Number(resumedReport.resume_count || 0) + 1,
                    completed_at: null,
                    result: null
                }
                : {
                    schema_version: 1,
                    run_id: runId,
                    status: 'in_progress',
                    phase: 'preflight',
                    domain: settings.domain,
                    course_ids: selectedCourses.map(course => course.slug),
                    canary_course: settings.canaryCourse || null,
                    started_at: timestamp(),
                    resume_count: 0
                };
            runReport.domain = settings.domain;
            runReport.course_ids = selectedCourses.map(course => course.slug);
            runReport.updated_at = timestamp();
            try {
                runReport.report_path = saveActivationRun(dataDir, runReport);
            } catch (error) {
                return {
                    status: 'blocked',
                    reason: 'activation_run_report_unwritable',
                    activated: false,
                    run_id: runId,
                    error: error.message
                };
            }
        }

        const products = await listProducts(settings, { fetchImpl });
        const productsByHandle = new Map(products.map(product => [product.handle, product]));
        const missingProducts = selectedCourses
            .filter(course => !productsByHandle.has(course.slug))
            .map(course => course.slug);
        if (missingProducts.length) {
            return finish({
                status: 'blocked',
                reason: 'products_not_published',
                activated: false,
                missing: missingProducts,
                next_step: 'Run `npm run shopify:publish` to create the drafts first.'
            }, 'blocked');
        }

        const selectedProducts = selectedCourses.map(course => ({
            course,
            product: productsByHandle.get(course.slug)
        }));
        const statuses = new Map(selectedProducts.map(({ product }) => [
            String(product.id),
            String(product.status || 'draft').toLowerCase()
        ]));

        let currency = String(storeCurrency || '').toUpperCase();
        if (!currency) {
            try {
                currency = String(await getShopCurrency(settings, { fetchImpl })).toUpperCase();
            } catch (error) {
                return finish({
                    status: 'blocked',
                    reason: 'store_currency_unavailable',
                    activated: false,
                    error: error.message
                }, 'blocked');
            }
        }

        const priceCheck = validateVariantPrices(selectedProducts, {
            storeCurrency: currency,
            fx: catalog.fx
        });
        if (!priceCheck.ok) {
            return finish({
                status: 'blocked',
                reason: 'variant_validation_failed',
                activated: false,
                price_check: priceCheck
            }, 'blocked');
        }

        try {
            publication = await onlineStorePublication(settings, { fetchImpl });
        } catch (error) {
            return finish({
                status: 'blocked',
                reason: 'publication_check_failed',
                activated: false,
                error: error.message
            }, 'blocked');
        }
        if (!publication) {
            return finish({
                status: 'blocked',
                reason: 'online_store_publication_missing',
                activated: false,
                publication_check: { publication: null, unpublished: [] }
            }, 'blocked');
        }

        try {
            if (resumedReport?.snapshot?.length) {
                if (resumedReport.publication?.id
                    && resumedReport.publication.id !== publication.id) {
                    return finish({
                        status: 'blocked',
                        reason: 'activation_run_publication_changed',
                        activated: false
                    }, 'blocked');
                }
                snapshot = resumedReport.snapshot;
                const snapshotIds = new Set(snapshot.map(row => String(row.product_id)));
                const missingSnapshots = selectedProducts
                    .filter(({ product }) => !snapshotIds.has(String(product.id)))
                    .map(({ course }) => course.slug);
                if (missingSnapshots.length) {
                    return finish({
                        status: 'blocked',
                        reason: 'activation_run_snapshot_mismatch',
                        activated: false,
                        missing: missingSnapshots
                    }, 'blocked');
                }
            } else {
                snapshot = await buildActivationSnapshot(settings, selectedProducts, publication, { fetchImpl });
            }
            const invalidSnapshot = snapshot.find(row => !['active', 'draft'].includes(row.status));
            if (invalidSnapshot) {
                return finish({
                    status: 'blocked',
                    reason: 'activation_snapshot_invalid',
                    activated: false,
                    snapshot
                }, 'blocked');
            }
            saveProgress('snapshot', { snapshot, publication: publicationSetPublication(publication) });
        } catch (error) {
            return finish({
                status: 'blocked',
                reason: 'activation_snapshot_failed',
                activated: false,
                error: error.message
            }, 'blocked');
        }

        let publicationStates;
        try {
            publicationStates = await readPublicationStates(settings, selectedProducts, publication, { fetchImpl });
        } catch (error) {
            return finish({
                status: 'blocked',
                reason: 'publication_check_failed',
                activated: false,
                error: error.message
            }, 'blocked');
        }

        const snapshotById = new Map(snapshot.map(row => [String(row.product_id), row]));
        for (const { course, product } of selectedProducts) {
            const saved = snapshotById.get(String(product.id));
            if (saved.status !== 'active' || statuses.get(String(product.id)) === 'active') continue;
            try {
                await setProductStatus(settings, product.id, 'active', { fetchImpl });
                statuses.set(String(product.id), 'active');
            } catch (error) {
                return rollbackAndFinish({
                    reason: 'activation_baseline_failed',
                    failed: [{ course_id: course.slug, error: error.message }]
                });
            }
        }

        let publicationSet;
        try {
            publicationSet = await setOnlineStorePublication(
                settings,
                selectedProducts,
                publication,
                publicationStates,
                { fetchImpl }
            );
        } catch (error) {
            return rollbackAndFinish({
                reason: 'publication_set_failed',
                error: error.message
            });
        }
        if (!publicationSet.ok) {
            return rollbackAndFinish({
                reason: 'publication_set_failed',
                publication_check: publicationSet
            });
        }
        saveProgress('publication', { publication: publicationSet.publication });

        let collection;
        try {
            collection = await ensureCoursesCollection(settings, { fetchImpl });
        } catch (error) {
            return rollbackAndFinish({
                reason: 'courses_collection_unavailable',
                error: error.message
            });
        }
        if (!collection?.id) {
            return rollbackAndFinish({
                reason: 'courses_collection_unavailable',
                collection
            });
        }

        let membership;
        try {
            membership = await readCoursesCollection(settings, { fetchImpl });
        } catch (error) {
            return rollbackAndFinish({
                reason: 'collection_membership_failed',
                error: error.message,
                collection
            });
        }
        const memberIds = new Set(membership.productIds.map(String));
        const missingMembers = selectedProducts
            .map(row => row.product)
            .filter(product => !memberIds.has(String(product.id)));
        if (missingMembers.length) {
            try {
                await addProductsToCollection(
                    settings,
                    collection.id,
                    missingMembers.map(product => product.id),
                    { fetchImpl }
                );
            } catch (error) {
                return rollbackAndFinish({
                    reason: 'collection_membership_failed',
                    error: error.message,
                    collection
                });
            }
        }
        saveProgress('collection', { collection: { id: collection.id, added: missingMembers.length } });

        const canary = selectedCourses.find(course => course.slug === settings.canaryCourse)
            || selectedCourses[0];
        const canaryProduct = productsByHandle.get(canary.slug);
        const canarySnapshot = snapshotById.get(String(canaryProduct.id));
        const canaryWasActive = canarySnapshot.status === 'active';

        try {
            if (statuses.get(String(canaryProduct.id)) !== 'active') {
                await setProductStatus(settings, canaryProduct.id, 'active', { fetchImpl });
                statuses.set(String(canaryProduct.id), 'active');
            }
        } catch (error) {
            return rollbackAndFinish({
                reason: 'canary_activation_failed',
                error: error.message,
                canary: { course: canary.slug, product_id: canaryProduct.id }
            });
        }
        saveProgress('canary', { canary: { course: canary.slug, product_id: canaryProduct.id } });

        let readiness;
        try {
            readiness = await checkReadiness(
                { ...settings, canaryCourse: canary.slug },
                { catalog, courseIds: selectedCourses.map(course => course.slug), fetchImpl }
            );
        } catch (error) {
            return rollbackAndFinish({
                status: 'error',
                reason: 'launch_check_failed',
                error: error.message,
                canary: { course: canary.slug, product_id: canaryProduct.id }
            });
        }
        saveProgress('readiness', { readiness });

        if (!readiness.ready) {
            const rollback = snapshot && publication
                ? await restoreActivationSnapshot(settings, snapshot, publication, { fetchImpl })
                : { ok: true, statuses: [], publications: [], errors: [], skipped: true };
            return finish({
                status: 'blocked',
                reason: 'launch_not_ready',
                activated: false,
                blockers: readiness.blockers,
                canary: {
                    course: canary.slug,
                    product_id: canaryProduct.id,
                    reverted: !canaryWasActive && rollback.statuses.includes(canaryProduct.id)
                },
                readiness,
                rolled_back: rollback.statuses,
                rollback
            }, 'rolled_back');
        }

        const failed = [];
        for (const { course, product } of selectedProducts) {
            if (statuses.get(String(product.id)) === 'active') continue;
            try {
                await setProductStatus(settings, product.id, 'active', { fetchImpl });
                statuses.set(String(product.id), 'active');
            } catch (error) {
                failed.push({ course_id: course.slug, error: error.message });
            }
        }
        if (failed.length) {
            return rollbackAndFinish({
                reason: 'activation_partial',
                failed
            });
        }
        saveProgress('activation', {
            activated_courses: selectedProducts.map(({ course }) => course.slug)
        });

        let publicationCheck;
        try {
            publicationCheck = await verifyOnlineStorePublication(
                settings,
                selectedProducts,
                publication,
                { fetchImpl }
            );
        } catch (error) {
            publicationCheck = {
                ok: false,
                reason: 'publication_check_failed',
                publication: publicationSet.publication,
                unpublished: []
            };
        }
        if (!publicationCheck.ok) {
            return rollbackAndFinish({
                reason: publicationCheck.reason || 'products_not_published_to_online_store',
                publication_check: publicationCheck,
                canary: { course: canary.slug, product_id: canaryProduct.id }
            });
        }

        const activatedCourses = snapshot
            .filter(row => row.status !== 'active')
            .map(row => row.course_id);
        const unchangedCourses = snapshot
            .filter(row => row.status === 'active')
            .map(row => row.course_id);

        return finish({
            status: 'ok',
            reason: null,
            activated: activatedCourses.length,
            unchanged: unchangedCourses.length,
            activated_courses: activatedCourses,
            unchanged_courses: unchangedCourses,
            canary: { course: canary.slug, product_id: canaryProduct.id },
            collection: { id: collection.id, added: missingMembers.length },
            publication_check: publicationCheck,
            price_check: priceCheck,
            readiness
        }, 'completed');
    } catch (error) {
        return rollbackAndFinish({
            status: 'error',
            reason: 'activation_failed',
            error: error.message
        });
    } finally {
        if (lock) releaseActivationLock(lock);
    }
}

function publicationSetPublication(publication) {
    return { id: publication.id, name: publication.catalog?.title || null };
}
