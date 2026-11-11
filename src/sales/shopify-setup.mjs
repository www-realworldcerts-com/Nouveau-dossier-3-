import { adminRequest, checkStorefrontGate, listProducts, redactToken } from './shopify.mjs';
import { storePriceFor } from './pricing.mjs';

/**
 * Shopify self-setup for the RealWorldCerts shop.
 *
 * A Shopify store must exist already — store creation is a Shopify signup flow,
 * not an Admin API operation. This module configures what the API allows
 * (collection, scopes, currency readiness, storefront gate detection) and emits
 * the exact manual steps for the three settings Shopify does not expose to apps:
 * password protection, payment provider and payouts.
 */

export const REQUIRED_SCOPES = ['read_products', 'write_products'];

export function normalizeShopDomain(value) {
    const raw = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '');
    if (!raw) return null;
    return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(raw) ? raw : null;
}

export function storeHandle(domain) {
    return String(domain || '').replace(/\.myshopify\.com$/, '');
}

export function adminLinks(domain) {
    const handle = storeHandle(domain);
    return {
        password: `https://admin.shopify.com/store/${handle}/online_store/preferences`,
        payments: `https://admin.shopify.com/store/${handle}/settings/payments`,
        payouts: `https://admin.shopify.com/store/${handle}/settings/payments/payouts`,
        domains: `https://admin.shopify.com/store/${handle}/settings/domains`,
        products: `https://admin.shopify.com/store/${handle}/products`,
        collections: `https://admin.shopify.com/store/${handle}/collections`,
        apps: `https://admin.shopify.com/store/${handle}/settings/apps`
    };
}

export function manualActions(domain, { passwordGate = 'unknown', productCount = 0 } = {}) {
    const links = adminLinks(domain);
    const actions = [
        {
            id: 'disable_password_gate',
            title: 'Turn off storefront password protection',
            why: passwordGate === 'on'
                ? 'A buyer currently hits a password page instead of the catalog.'
                : 'Verify the gate is off before announcing the catalog.',
            url: links.password,
            automated: false
        },
        {
            id: 'choose_payment_provider',
            title: 'Choose and activate a payment provider',
            why: 'Even a checkout intent cannot complete until a provider is configured.',
            url: links.payments,
            automated: false
        },
        {
            id: 'configure_payouts',
            title: 'Configure the payout bank account',
            why: 'Revenue cannot settle to the owner until payouts are set up.',
            url: links.payouts,
            automated: false
        },
        {
            id: 'connect_domain',
            title: 'Point realworldcerts.com at the Shopify store',
            why: 'Buyers must reach the store on the branded domain, not a myshopify URL.',
            url: links.domains,
            automated: false
        }
    ];
    if (!productCount) {
        actions.push({
            id: 'publish_products',
            title: 'Publish priced courses to the Online Store channel',
            why: 'The store currently shows no products, so there is nothing to buy.',
            url: links.products,
            automated: true,
            command: 'npm run sales -- run --catalog <catalog.ndjson>'
        });
    }
    return actions;
}

/**
 * Decide whether the shop is ready for the sales agent to publish into.
 * Pure function so the checklist can be tested without network access.
 */
export function assessShop({
    shop = null,
    scopes = null,
    storefront = null,
    productCount = 0,
    requiredScopes = REQUIRED_SCOPES,
    catalogCurrency = 'MAD',
    storeCurrency = null,
    config
} = {}) {
    const blockers = [];
    const warnings = [];

    if (!shop) blockers.push('shop_unreachable');

    const store = String(storeCurrency || shop?.currency || '').toUpperCase();
    let conversion = null;
    if (store && store !== catalogCurrency) {
        try {
            conversion = storePriceFor(1000, store, config);
            warnings.push(`currency_conversion:${catalogCurrency}->${store}@${conversion.rate}`);
        } catch (error) {
            blockers.push(`unsupported_store_currency:${store}`);
        }
    }

    if (Array.isArray(scopes)) {
        const missing = requiredScopes.filter(scope => !scopes.includes(scope));
        if (missing.length) blockers.push(`missing_scopes:${missing.join('|')}`);
    } else {
        warnings.push('scopes_unverified');
    }

    const gate = storefront?.password_gate || 'unknown';
    if (gate === 'on') warnings.push('password_gate_on');
    else if (gate === 'unknown') warnings.push('password_gate_unknown');

    if (!productCount) warnings.push('no_products_published');

    return {
        ready: blockers.length === 0,
        blockers,
        warnings,
        currency: {
            catalog: catalogCurrency,
            store: store || null,
            conversion
        },
        password_gate: gate,
        product_count: productCount
    };
}

export async function ensureCoursesCollection(settings, { fetchImpl = globalThis.fetch } = {}) {
    try {
        const existing = await adminRequest(settings, 'GET', 'custom_collections.json?handle=courses&limit=1', { fetchImpl });
        const found = existing?.custom_collections?.[0];
        if (found) return { action: 'exists', id: found.id, handle: 'courses' };
        const created = await adminRequest(settings, 'POST', 'custom_collections.json', {
            fetchImpl,
            body: {
                custom_collection: {
                    title: 'Courses',
                    handle: 'courses',
                    body_html: '<p>All RealWorldCerts courses.</p>'
                }
            }
        });
        return { action: 'created', id: created?.custom_collection?.id, handle: 'courses' };
    } catch (error) {
        return { action: 'unsupported', error: redactToken(error.message, settings.token) };
    }
}

/**
 * Run the self-setup audit. Never throws: each step degrades into a blocker or
 * warning so the operator always gets a checklist back.
 */
export async function setupShop(settings, {
    fetchImpl = globalThis.fetch,
    ensureCollection = false,
    config = undefined
} = {}) {
    const domain = normalizeShopDomain(settings.domain);
    const base = {
        generated_at: new Date().toISOString(),
        requested_domain: settings.domain || null,
        domain: domain || settings.domain || null,
        links: adminLinks(domain || settings.domain),
        shop: null,
        scopes: null,
        storefront: null,
        product_count: 0,
        collection: null,
        ready: false,
        blockers: [],
        warnings: [],
        manual_actions: manualActions(domain || settings.domain)
    };

    if (!domain) {
        return { ...base, blockers: ['invalid_shop_domain'], manual_actions: manualActions(settings.domain) };
    }
    if (!settings.token) {
        return {
            ...base,
            blockers: ['missing_admin_token'],
            next_step: 'Run `npm run shopify:oauth -- --shop <store>.myshopify.com` (writes .env) or paste a shpat_ token into SHOPIFY_ADMIN_TOKEN.'
        };
    }

    const scopedSettings = { ...settings, domain };
    let shop = null;
    let scopes = null;
    let storefront = null;
    let products = [];
    const errors = [];

    try {
        shop = (await adminRequest(scopedSettings, 'GET', 'shop.json', { fetchImpl }))?.shop || null;
    } catch (error) {
        errors.push(redactToken(error.message, settings.token));
    }

    if (shop) {
        try {
            const payload = await adminRequest(scopedSettings, 'GET', 'access_scopes.json', { fetchImpl });
            const rows = payload?.access_scopes || [];
            scopes = rows.map(row => row.handle).filter(Boolean);
        } catch (error) {
            errors.push(redactToken(error.message, settings.token));
        }
        try {
            products = await listProducts(scopedSettings, { fetchImpl });
        } catch (error) {
            errors.push(redactToken(error.message, settings.token));
        }
        storefront = await checkStorefrontGate(scopedSettings, { fetchImpl });
    }

    const assessment = assessShop({
        shop,
        scopes,
        storefront,
        productCount: products.length,
        storeCurrency: shop?.currency || null,
        config
    });

    let collection = null;
    if (ensureCollection && shop && assessment.ready) {
        collection = await ensureCoursesCollection(scopedSettings, { fetchImpl });
        if (collection.action === 'unsupported') {
            assessment.warnings.push('collection_endpoint_unsupported');
        }
    }

    return {
        ...base,
        shop: shop ? { name: shop.name, domain: shop.domain, currency: shop.currency, plan: shop.plan_display_name || shop.plan_name || null, country: shop.country_name || null } : null,
        scopes,
        storefront,
        product_count: products.length,
        collection,
        ready: assessment.ready,
        blockers: [...new Set([...base.blockers, ...assessment.blockers])],
        warnings: [...assessment.warnings, ...errors.map(error => `api_error:${error}`)],
        manual_actions: manualActions(domain, { passwordGate: assessment.password_gate, productCount: products.length }),
        currency: assessment.currency,
        assessment
    };
}
