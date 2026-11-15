import {
    DEFAULT_COURSE_CATALOG_FILE,
    loadCourseCatalog,
    loadCoursePrices as loadCoursePricesFromCanonical,
    productsFromCatalog,
    storefrontPricePayload as canonicalStorefrontPricePayload
} from './course-catalog.mjs';

/**
 * Compatibility facade for the checkout server.
 *
 * The canonical source is config/course-catalog.json. COURSE_CATALOG_FILE and
 * the older COURSE_PRICES_FILE variable both point at that catalog; there is no
 * second price file.
 */

export const DEFAULT_COURSE_PRICES_FILE = DEFAULT_COURSE_CATALOG_FILE;

export function catalogFile(file) {
    return file || process.env.COURSE_CATALOG_FILE || process.env.COURSE_PRICES_FILE || DEFAULT_COURSE_CATALOG_FILE;
}

export function loadCoursePrices(file) {
    return loadCoursePricesFromCanonical(catalogFile(file));
}

export function productsFromCoursePrices(file) {
    return productsFromCatalog(catalogFile(file));
}

export function storefrontPricePayload(file) {
    return canonicalStorefrontPricePayload(catalogFile(file));
}

export { loadCourseCatalog };
