import { slugify } from './catalog.mjs';

/**
 * Shopify Admin API publisher. Read-only lookups make publishing idempotent:
 * a product is matched by handle (course slug), created once, then updated only
 * when its price actually changes.
 *
 * Tokens come from the environment and are redacted from every error we surface.
 */

export function shopifySettingsFromEnv(env = process.env) {
    return {
        domain: env.SHOPIFY_STORE_DOMAIN || '',
        token: env.SHOPIFY_ADMIN_TOKEN || env.SHOPIFY_SHpat_TOKEN || '',
        apiVersion: env.SHOPIFY_API_VERSION || '2024-10',
        storefrontUrl: env.SHOPIFY_STOREFRONT_URL || 'https://www.realworldcerts.com',
        checkoutOriginUrl: env.CHECKOUT_PRICE_ORIGIN_URL || '',
        quoteUrl: env.CHECKOUT_QUOTE_URL || '',
        storefrontToken: env.SHOPIFY_STOREFRONT_ACCESS_TOKEN || '',
        expectedDomain: env.SHOPIFY_PRIMARY_DOMAIN || '',
        canaryCourse: env.SHOPIFY_CANARY_COURSE || '',
        canaryCountryCode: env.SHOPIFY_CANARY_COUNTRY_CODE || '',
        canaryAddress1: env.SHOPIFY_CANARY_ADDRESS1 || '',
        canaryCity: env.SHOPIFY_CANARY_CITY || '',
        canaryProvinceCode: env.SHOPIFY_CANARY_PROVINCE_CODE || '',
        canaryPostalCode: env.SHOPIFY_CANARY_POSTAL_CODE || '',
        payoutAttestationFile: env.SHOPIFY_PAYOUT_ATTESTATION_FILE || ''
    };
}

export function redactToken(text, token) {
    let output = String(text ?? '');
    if (token) output = output.split(token).join('[REDACTED]');
    return output.replace(/shpat_[A-Za-z0-9]+/g, 'shpat_[REDACTED]');
}

function authHeaders(token) {
    return {
        'content-type': 'application/json',
        'x-shopify-access-token': token
    };
}

export async function adminRequest(settings, method, endpoint, { body, fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
    if (!settings.token) throw new Error('Shopify admin token missing (SHOPIFY_ADMIN_TOKEN)');
    const url = `https://${settings.domain}/admin/api/${settings.apiVersion}/${endpoint}`;
    let response;
    try {
        response = await fetchImpl(url, {
            method,
            headers: authHeaders(settings.token),
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(timeoutMs)
        });
    } catch (error) {
        throw new Error(`Shopify request failed: ${redactToken(error.message, settings.token)}`);
    }
    const text = await response.text();
    if (!response.ok) {
        throw new Error(`Shopify HTTP ${response.status}: ${redactToken(text, settings.token).slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : {};
}

export async function adminGraphql(settings, query, { variables, fetchImpl = globalThis.fetch } = {}) {
    const payload = await adminRequest(settings, 'POST', 'graphql.json', {
        body: { query, variables },
        fetchImpl
    });
    if (Array.isArray(payload.errors) && payload.errors.length) {
        throw new Error(`Shopify GraphQL: ${redactToken(payload.errors.map(error => error.message).join('; '), settings.token)}`);
    }
    return payload.data || {};
}

/** Storefront calls use a public/private Storefront token, never the Admin token. */
export async function storefrontGraphql(settings, query, { variables, fetchImpl = globalThis.fetch } = {}) {
    if (!settings.storefrontToken) throw new Error('Shopify Storefront access token missing (SHOPIFY_STOREFRONT_ACCESS_TOKEN)');
    let response;
    try {
        response = await fetchImpl(`https://${settings.domain}/api/${settings.apiVersion}/graphql.json`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-shopify-storefront-access-token': settings.storefrontToken
            },
            body: JSON.stringify({ query, variables }),
            signal: AbortSignal.timeout(30000)
        });
    } catch (error) {
        throw new Error(`Shopify Storefront request failed: ${redactToken(error.message, settings.storefrontToken)}`);
    }
    const text = await response.text();
    if (!response.ok) throw new Error(`Shopify Storefront HTTP ${response.status}`);
    const payload = JSON.parse(text);
    if (Array.isArray(payload.errors) && payload.errors.length) {
        throw new Error(`Shopify Storefront GraphQL: ${payload.errors.map(error => error.message).join('; ')}`);
    }
    return payload.data || {};
}

export async function getShopCurrency(settings, { fetchImpl } = {}) {
    const payload = await adminRequest(settings, 'GET', 'shop.json', { fetchImpl });
    const currency = String(payload?.shop?.currency || '').toUpperCase();
    if (!currency) throw new Error('Shopify /shop.json did not return a currency');
    return currency;
}

export async function listProducts(settings, { fetchImpl } = {}) {
    const products = [];
    let sinceId = null;
    for (let page = 0; page < 20; page += 1) {
        const query = `products.json?limit=250${sinceId ? `&since_id=${sinceId}` : ''}`;
        const payload = await adminRequest(settings, 'GET', query, { fetchImpl });
        const batch = payload.products || [];
        products.push(...batch);
        if (batch.length < 250) break;
        sinceId = batch[batch.length - 1].id;
    }
    return products;
}

export function productPayloadFor(course, price, { currency = 'USD', status = 'draft' } = {}) {
    const identifier = String(course.slug || course.course_id || course.id || '').trim();
    if (!identifier) throw new Error('Shopify product requires a course slug');
    const handle = course.shopify_handle || course.slug || slugify(`${course.title}-${identifier}`);
    const description = String(course.description || '').trim();
    const image = String(course.image || '').trim();
    const imageUrl = image.startsWith('/') ? `https://www.realworldcerts.com${image}` : image;
    return {
        product: {
            title: course.title,
            handle,
            body_html: description || `<p>${course.title} — RealWorldCerts course.</p>`,
            vendor: course.vendor || 'RealWorldCerts',
            product_type: course.category || 'Course',
            tags: ['course', course.category, course.language].filter(Boolean).join(', '),
            status,
            ...(imageUrl ? { images: [{ src: imageUrl }] } : {}),
            variants: [{
                price: Number(price).toFixed(2),
                sku: `RWC-${identifier}`,
                inventory_management: null,
                requires_shipping: false,
                taxable: true
            }]
        }
    };
}

function priceCents(value) {
    const amount = Number(value);
    return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

export function normalizeVariantPrice(value) {
    const cents = priceCents(value);
    return cents === null ? String(value ?? '') : (cents / 100).toFixed(2);
}

/**
 * Create or update one product. Returns {action, product_id, handle}.
 * `existing` is the product list already fetched once per publish run.
 *
 * A publish run may create drafts and update draft prices. It must never
 * reprice an active product: that requires shopify:reprice, which snapshots
 * the prior prices and can roll the whole batch back.
 */
export async function upsertProduct(course, price, { settings, existing = [], fetchImpl, currency = 'USD' } = {}) {
    const payload = productPayloadFor(course, price, { currency });
    const handle = payload.product.handle;
    const match = existing.find(product => product.handle === handle);
    const variantPrice = payload.product.variants[0].price;

    if (!match) {
        const created = await adminRequest(settings, 'POST', 'products.json', { body: payload, fetchImpl });
        return { action: 'created', product_id: created.product?.id, handle };
    }

    const currentPrice = String(match.variants?.[0]?.price ?? '');
    if (priceCents(currentPrice) === priceCents(variantPrice)) {
        return { action: 'unchanged', product_id: match.id, handle };
    }
    if (String(match.status || '').toLowerCase() === 'active') {
        throw new Error(
            `ACTIVE_PRODUCT_PRICE_CHANGE_BLOCKED: ${handle} is active at ${currentPrice}; ` +
            'use shopify:reprice to snapshot and change active prices'
        );
    }
    await updateVariantPrice(settings, match.variants?.[0]?.id, variantPrice, {
        fetchImpl,
        handle
    });
    return { action: 'updated', product_id: match.id, handle };
}

/** Write one variant price without changing product status or publication. */
export async function updateVariantPrice(settings, variantId, price, { fetchImpl, handle = null } = {}) {
    if (variantId === undefined || variantId === null || variantId === '') {
        throw new Error(`Product ${handle || variantId || 'unknown'} has no variant to update`);
    }
    const normalized = normalizeVariantPrice(price);
    await adminRequest(settings, 'PUT', `variants/${variantId}.json`, {
        body: { variant: { id: variantId, price: normalized } },
        fetchImpl
    });
    return { variant_id: variantId, price: normalized };
}

/** Change a product's publication status without touching its price. */
export async function setProductStatus(settings, productId, status, { fetchImpl } = {}) {
    if (!['active', 'draft'].includes(status)) throw new Error(`Unsupported product status: ${status}`);
    await adminRequest(settings, 'PUT', `products/${productId}.json`, {
        body: { product: { id: productId, status } },
        fetchImpl
    });
    return { product_id: productId, status };
}

/** Add products to a custom collection; the caller filters out existing members. */
export async function addProductsToCollection(settings, collectionId, productIds, { fetchImpl } = {}) {
    const added = [];
    for (const productId of productIds) {
        await adminRequest(settings, 'POST', 'collects.json', {
            body: { collect: { collection_id: collectionId, product_id: productId } },
            fetchImpl
        });
        added.push(productId);
    }
    return added;
}

/**
 * Detect the Shopify password gate. Any of these markers in the storefront HTML
 * means a buyer hits a password page instead of the catalog.
 */
export function isPasswordGate(html) {
    const body = String(html || '').toLowerCase();
    return body.includes('password-page')
        || body.includes('enter store password')
        || body.includes('opening soon')
        || body.includes('shopify-password');
}

export async function checkStorefrontGate(settings, { fetchImpl = globalThis.fetch } = {}) {
    try {
        const response = await fetchImpl(settings.storefrontUrl, {
            redirect: 'follow',
            signal: AbortSignal.timeout(15000)
        });
        const html = await response.text();
        const gated = response.status === 401 || response.status === 403 || isPasswordGate(html);
        return {
            url: settings.storefrontUrl,
            final_url: response.url || settings.storefrontUrl,
            status: response.status,
            password_gate: gated ? 'on' : 'off'
        };
    } catch (error) {
        return {
            url: settings.storefrontUrl,
            final_url: null,
            status: 0,
            password_gate: 'unknown',
            error: redactToken(error.message, settings.token)
        };
    }
}
