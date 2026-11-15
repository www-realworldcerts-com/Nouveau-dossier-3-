import fs from 'node:fs';
import path from 'node:path';

/**
 * Canonical course catalog and price book.
 *
 * `config/course-catalog.json` is the only product source used by checkout and
 * Shopify. Prices are explicit USD cents; store-currency amounts are derived
 * from the catalog's fixed FX table, never from a tier-pricing guess or a
 * browser-supplied amount.
 */

export const DEFAULT_COURSE_CATALOG_FILE = path.join(process.cwd(), 'config', 'course-catalog.json');

function normalizeCurrency(value) {
    return String(value || '').trim().toUpperCase();
}

function normalizeCourse(raw, index) {
    if (!raw || typeof raw !== 'object') {
        throw new Error(`Course record ${index} is not an object`);
    }
    const slug = String(raw.slug || raw.course_id || raw.id || '').trim();
    if (!slug) throw new Error(`Course record ${index} is missing slug`);
    const title = String(raw.title || raw.name || slug).trim();
    if (!title) throw new Error(`Course ${slug} is missing title`);
    const priceCents = Number(raw.price_cents);
    if (!Number.isInteger(priceCents) || priceCents <= 0) {
        throw new Error(`Course ${slug} has an invalid price_cents`);
    }
    return {
        ...raw,
        slug,
        title,
        description: String(raw.description || ''),
        category: String(raw.category || ''),
        image: raw.image || null,
        language: raw.language || null,
        price_cents: priceCents,
        status: raw.status || 'active'
    };
}

export function loadCourseCatalog(file = process.env.COURSE_CATALOG_FILE || DEFAULT_COURSE_CATALOG_FILE) {
    const resolved = path.resolve(file);
    const raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    const currency = normalizeCurrency(raw?.currency);
    if (!currency) throw new Error('Course catalog is missing a currency');
    if (!Array.isArray(raw?.courses)) throw new Error('Course catalog must contain a courses array');

    const courses = [];
    const bySlug = {};
    for (const [index, entry] of raw.courses.entries()) {
        const course = normalizeCourse(entry, index);
        if (bySlug[course.slug]) throw new Error(`Duplicate course slug: ${course.slug}`);
        bySlug[course.slug] = course;
        courses.push(course);
    }
    if (!courses.length) throw new Error('Course catalog has no courses');

    const fulfillmentCostCents = Math.max(0, Math.round(Number(raw?.fulfillment_cost_cents ?? 0)));
    const fx = { ...(raw?.fx || {}) };
    for (const [target, rate] of Object.entries(fx)) {
        if (!Number.isFinite(Number(rate)) || Number(rate) <= 0) {
            throw new Error(`Invalid FX rate for ${target}`);
        }
        fx[target] = Number(rate);
    }
    if (!Number.isFinite(fx[currency])) fx[currency] = 1;

    return {
        file: resolved,
        version: raw.version ?? 1,
        currency,
        fulfillmentCostCents,
        fx,
        courses,
        bySlug
    };
}

/**
 * Convert a canonical course price into a Shopify store currency.
 * `fx` is expressed as 1 unit of the catalog currency -> N units of target.
 */
export function priceInCurrency(course, targetCurrency, fx) {
    const target = normalizeCurrency(targetCurrency);
    const priceCents = Number(course?.price_cents);
    if (!Number.isInteger(priceCents) || priceCents <= 0) {
        throw new Error(`Course ${course?.slug || '(unknown)'} has an invalid price_cents`);
    }
    const rate = Number(fx?.[target]);
    if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error(`No FX rate for ${target}; add ${target} to the catalog fx table`);
    }
    return {
        amount: Math.round(priceCents * rate) / 100,
        currency: target,
        converted: target !== 'USD',
        rate
    };
}

export function productsFromCatalog(file) {
    const catalog = loadCourseCatalog(file);
    return catalog.courses.map(course => ({
        id: course.slug,
        name: course.title,
        price: course.price_cents / 100,
        currency: catalog.currency,
        fulfillment_cost_cents: catalog.fulfillmentCostCents
    }));
}

/** Compact payload served to the static checkout pages. */
export function storefrontPricePayload(file) {
    const catalog = loadCourseCatalog(file);
    return {
        currency: catalog.currency,
        prices: Object.fromEntries(catalog.courses.map(course => [course.slug, course.price_cents / 100]))
    };
}
