import { slugify } from './catalog.mjs';

/**
 * Shopify Admin API publisher. Read-only lookups make publishing idempotent:
 * a product is matched by handle (course slug), created once, then updated only
 * when its price actually changes.
 *
 * Tokens come from the environment and are redacted from every error we surface.
 */

export function shopifySettingsFromEnv() {
    return {
        domain: process.env.SHOPIFY_STORE_DOMAIN || 'realworldcerts.myshopify.com',
        token: process.env.SHOPIFY_ADMIN_TOKEN || process.env.SHOPIFY_SHpat_TOKEN || '',
        apiVersion: process.env.SHOPIFY_API_VERSION || '2024-10',
        storefrontUrl: process.env.SHOPIFY_STOREFRONT_URL || 'https://www.realworldcerts.com'
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

async function adminRequest(settings, method, endpoint, { body, fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
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

export function productPayloadFor(course, priceMad, { currency = 'MAD' } = {}) {
    const handle = course.shopify_handle || slugify(`${course.title}-${course.course_id}`);
    return {
        product: {
            title: course.title,
            handle,
            body_html: course.description
                ? `<p>${String(course.description).replace(/</g, '&lt;')}</p>`
                : `<p>${course.title} — RealWorldCerts course.</p>`,
            vendor: course.vendor || 'RealWorldCerts',
            product_type: course.category || 'Course',
            tags: ['course', course.tier || 'default', course.exam_board || ''].filter(Boolean).join(', '),
            status: 'active',
            variants: [{
                price: Number(priceMad).toFixed(2),
                sku: `RWC-${course.course_id}`,
                inventory_management: null,
                requires_shipping: false,
                taxable: true
            }]
        }
    };
}

/**
 * Create or update one product. Returns {action, product_id, handle}.
 * `existing` is the product list already fetched once per publish run.
 */
export async function upsertProduct(course, priceMad, { settings, existing = [], fetchImpl, currency = 'MAD' } = {}) {
    const payload = productPayloadFor(course, priceMad, { currency });
    const handle = payload.product.handle;
    const match = existing.find(product => product.handle === handle);
    const variantPrice = payload.product.variants[0].price;

    if (!match) {
        const created = await adminRequest(settings, 'POST', 'products.json', { body: payload, fetchImpl });
        return { action: 'created', product_id: created.product?.id, handle };
    }

    const currentPrice = String(match.variants?.[0]?.price ?? '');
    if (currentPrice === variantPrice) {
        return { action: 'unchanged', product_id: match.id, handle };
    }
    const variantId = match.variants?.[0]?.id;
    if (!variantId) {
        throw new Error(`Product ${handle} has no variant to update`);
    }
    await adminRequest(settings, 'PUT', `variants/${variantId}.json`, {
        body: { variant: { id: variantId, price: variantPrice } },
        fetchImpl
    });
    return { action: 'updated', product_id: match.id, handle };
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
            status: response.status,
            password_gate: gated ? 'on' : 'off'
        };
    } catch (error) {
        return {
            url: settings.storefrontUrl,
            status: 0,
            password_gate: 'unknown',
            error: redactToken(error.message, settings.token)
        };
    }
}
