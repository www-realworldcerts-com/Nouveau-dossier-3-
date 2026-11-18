import * as dnsPromises from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import { catalogRevisionDigest, loadCourseCatalog } from './course-catalog.mjs';
import { validateVariantPrices } from './shopify-activation.mjs';
import { getShopCurrency, listProducts, shopifySettingsFromEnv } from './shopify.mjs';

/**
 * Read-only price-drift audit.
 *
 * Compares three independently produced price views:
 *   - the canonical catalog (`config/course-catalog.json`, USD cents);
 *   - the public checkout payload served at `/data/store-prices.json`;
 *   - live Shopify product/variant prices in the store currency.
 *
 * Only a comparable amount that differs is price drift. Missing FX rates,
 * missing listings, currency gaps and unreadable sources are reported as
 * unchecked, never as a high-severity divergence. Drift is grouped by course so
 * a variant and its presentment price do not become duplicate findings.
 *
 * This module only performs GET requests. It never creates, updates or
 * activates a product, and it never changes a price.
 */

const CHECKOUT_PATH = '/data/store-prices.json';

function normalizeCurrency(value) {
    return String(value || '').trim().toUpperCase();
}

function hostKey(value) {
    return String(value || '').toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
}

function normalizeAddress(value) {
    const address = String(value || '').trim().toLowerCase();
    const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return mapped[1];
    const mappedHex = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
        const high = parseInt(mappedHex[1], 16);
        const low = parseInt(mappedHex[2], 16);
        return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
    }
    return address;
}

function isPrivateAddress(value) {
    const address = normalizeAddress(value);
    const version = net.isIP(address);
    if (version === 4) {
        const [a, b] = address.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 || a >= 224
            || (a === 169 && b === 254)
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168)
            || (a === 100 && b >= 64 && b <= 127);
    }
    if (version === 6) {
        return address === '::' || address === '::1'
            || /^f[cd]/.test(address)
            || /^fe[89ab]/.test(address)
            || /^ff/.test(address);
    }
    return true;
}

const DNS_EMPTY_CODES = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN']);

function withDnsTimeout(promise, timeoutMs, host) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const error = new Error(`DNS lookup timed out for ${host}`);
            error.code = 'ETIMEOUT';
            reject(error);
        }, timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

async function dnsLookup(method, host, resolver, timeoutMs) {
    const fn = resolver?.[method];
    if (typeof fn !== 'function') throw new Error(`DNS resolver does not support ${method}`);
    try {
        const value = await withDnsTimeout(Promise.resolve().then(() => fn.call(resolver, host)), timeoutMs, host);
        if (value == null) return [];
        return Array.isArray(value) ? value : [value];
    } catch (error) {
        if (DNS_EMPTY_CODES.has(error?.code)) return [];
        throw error;
    }
}

async function resolveHostRecords(host, resolver, timeoutMs) {
    const name = hostKey(host);
    const [cnameRecords, ipv4, ipv6] = await Promise.all([
        dnsLookup('resolveCname', name, resolver, timeoutMs),
        dnsLookup('resolve4', name, resolver, timeoutMs),
        dnsLookup('resolve6', name, resolver, timeoutMs)
    ]);
    const addresses = [...new Set([...ipv4, ...ipv6]
        .map(value => hostKey(value))
        .filter(Boolean))];
    return {
        cname: hostKey(cnameRecords[0]) || null,
        addresses
    };
}

/**
 * Prove that the configured origin is not just another CDN hostname.
 *
 * Hostname inequality alone lets an alternate CDN name pass even though it is
 * the same cache. Compare DNS instead: a CNAME to the buyer-facing host or a
 * shared CNAME target/address is the same infrastructure. Missing or failed DNS
 * is unverified, never a pass. One CNAME hop plus the resolved addresses are
 * enough to identify the shared infrastructure without walking arbitrary chains.
 */
export async function verifyCheckoutOriginDns(originUrl, checkoutUrl, {
    dnsResolver = dnsPromises,
    timeoutMs = 3000
} = {}) {
    let origin;
    let edge;
    try {
        origin = new URL(String(originUrl || ''));
        edge = new URL(String(checkoutUrl || ''));
    } catch {
        return { ok: false, reason: 'checkout_origin_dns_unverified: origin or CDN URL is invalid' };
    }
    if (!origin.hostname || !edge.hostname) {
        return { ok: false, reason: 'checkout_origin_dns_unverified: origin or CDN host is missing' };
    }

    let originDns;
    let edgeDns;
    try {
        [originDns, edgeDns] = await Promise.all([
            resolveHostRecords(origin.hostname, dnsResolver, timeoutMs),
            resolveHostRecords(edge.hostname, dnsResolver, timeoutMs)
        ]);
    } catch (error) {
        return {
            ok: false,
            reason: `checkout_origin_dns_unverified: ${error?.message || String(error)}`
        };
    }

    if (!edgeDns.addresses.length) {
        return { ok: false, reason: 'checkout_origin_dns_unverified: the buyer-facing CDN host did not resolve to an address' };
    }
    if (!originDns.addresses.length) {
        return { ok: false, reason: 'checkout_origin_dns_unverified: the configured origin host did not resolve to an address' };
    }

    const edgeNames = new Set([hostKey(edge.hostname), edgeDns.cname].filter(Boolean));
    const sharedCname = originDns.cname && edgeNames.has(originDns.cname) ? originDns.cname : null;
    const sharedAddress = originDns.addresses.find(address => edgeDns.addresses.includes(address));
    const privateOrigin = originDns.addresses.find(isPrivateAddress);
    if (privateOrigin) {
        return {
            ok: false,
            reason: `checkout_origin_private_address: the configured origin resolves to the private address ${privateOrigin}`,
            origin_cname: originDns.cname,
            cdn_cname: edgeDns.cname,
            origin_addresses: originDns.addresses,
            cdn_addresses: edgeDns.addresses
        };
    }
    const privateEdge = edgeDns.addresses.find(isPrivateAddress);
    if (privateEdge) {
        return {
            ok: false,
            reason: `checkout_origin_dns_unverified: the buyer-facing CDN host resolves to the private address ${privateEdge}`,
            origin_cname: originDns.cname,
            cdn_cname: edgeDns.cname,
            origin_addresses: originDns.addresses,
            cdn_addresses: edgeDns.addresses
        };
    }

    const failure = sharedCname
        ? `checkout_origin_shared_cdn: the configured origin shares the CNAME target ${sharedCname} with the buyer-facing CDN`
        : (sharedAddress
            ? `checkout_origin_shared_cdn: the configured origin and the buyer-facing CDN resolve to the same address ${sharedAddress}`
            : null);
    if (failure) {
        return {
            ok: false,
            reason: failure,
            origin_cname: originDns.cname,
            cdn_cname: edgeDns.cname,
            origin_addresses: originDns.addresses,
            cdn_addresses: edgeDns.addresses
        };
    }

    return {
        ok: true,
        address: originDns.addresses[0],
        origin_host: origin.hostname,
        cdn_host: edge.hostname,
        origin_cname: originDns.cname,
        cdn_cname: edgeDns.cname,
        origin_addresses: originDns.addresses,
        cdn_addresses: edgeDns.addresses
    };
}

function requestPinnedUrl(url, { address, timeoutMs, headers = {} }) {
    return new Promise((resolve, reject) => {
        let target;
        try {
            target = new URL(url);
        } catch {
            reject(new Error('Invalid pinned origin URL'));
            return;
        }
        const family = net.isIP(address);
        if (!family) {
            reject(new Error('Invalid pinned origin address'));
            return;
        }
        const request = https.request({
            hostname: target.hostname,
            port: target.port || 443,
            path: `${target.pathname}${target.search}`,
            method: 'GET',
            headers: { ...headers, host: target.host },
            servername: target.hostname,
            lookup: (hostname, options, callback) => {
                if (options?.all) {
                    callback(null, [{ address, family }]);
                    return;
                }
                callback(null, address, family);
            }
        }, (response) => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({
                ok: response.statusCode >= 200 && response.statusCode < 300,
                status: response.statusCode,
                headers: response.headers,
                url: target.toString(),
                text: async () => Buffer.concat(chunks).toString('utf8')
            }));
            response.on('error', reject);
        });
        request.setTimeout(timeoutMs, () => {
            request.destroy(new Error(`origin request timed out after ${timeoutMs}ms`));
        });
        request.on('error', reject);
        request.end();
    });
}

function isPrivateHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    if (net.isIP(host)) return isPrivateAddress(host);
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
    if (host === '0.0.0.0' || host === '::1' || host === '[::1]') return true;
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
    const match = host.match(/^172\.(\d+)\./);
    if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
    return false;
}

/**
 * Validate the direct-origin target before fetching it. The origin must be a
 * public HTTPS URL for the same price route, and its host must be genuinely
 * different from the buyer-facing CDN host. Returning an invalid URL here is
 * deliberate: a malformed or same-host origin must make the audit unchecked,
 * never silently fall back to the edge response.
 */
export function validateCheckoutOriginUrl(originUrl, checkoutUrl) {
    const raw = String(originUrl || '').trim();
    if (!raw) return { ok: false, reason: 'checkout_origin_unavailable: CHECKOUT_PRICE_ORIGIN_URL is not configured' };
    let origin;
    try {
        origin = new URL(raw);
    } catch {
        return { ok: false, reason: 'checkout_origin_invalid: CHECKOUT_PRICE_ORIGIN_URL is not a valid URL' };
    }
    if (origin.protocol !== 'https:') {
        return { ok: false, reason: 'checkout_origin_insecure: CHECKOUT_PRICE_ORIGIN_URL must use HTTPS' };
    }
    if (origin.username || origin.password) {
        return { ok: false, reason: 'checkout_origin_invalid: CHECKOUT_PRICE_ORIGIN_URL must not contain credentials' };
    }
    if (origin.search || origin.hash) {
        return { ok: false, reason: 'checkout_origin_invalid: CHECKOUT_PRICE_ORIGIN_URL must not contain a query or fragment' };
    }
    if (!origin.hostname || isPrivateHost(origin.hostname)) {
        return { ok: false, reason: 'checkout_origin_invalid: CHECKOUT_PRICE_ORIGIN_URL must be a public host' };
    }
    if (origin.pathname !== '/' && origin.pathname !== CHECKOUT_PATH) {
        return { ok: false, reason: 'checkout_origin_invalid: CHECKOUT_PRICE_ORIGIN_URL must point at the origin root or /data/store-prices.json' };
    }
    origin.pathname = CHECKOUT_PATH;

    let edge;
    try {
        edge = new URL(String(checkoutUrl || ''));
    } catch {
        return { ok: false, reason: 'checkout_origin_unverified: the buyer-facing CDN URL is missing or invalid' };
    }
    if (!edge.hostname || hostKey(edge.hostname) === hostKey(origin.hostname)) {
        return {
            ok: false,
            reason: 'checkout_origin_not_distinct: CHECKOUT_PRICE_ORIGIN_URL must use a host distinct from the buyer-facing CDN'
        };
    }
    return {
        ok: true,
        url: origin.toString(),
        origin_host: origin.hostname,
        cdn_host: edge.hostname
    };
}

function responseHeader(headers, name) {
    return headerValue(headers, name);
}

function protectionReason(response, text, requestUrl) {
    const status = Number(response?.status);
    const headers = response?.headers;
    const location = responseHeader(headers, 'location');
    if (status >= 300 && status < 400) {
        return `origin_redirected: HTTP ${status}${location ? ` to ${String(location).slice(0, 160)}` : ''}`;
    }
    if ([401, 403, 407, 511].includes(status)) {
        return `origin_protected: HTTP ${status} (authentication or access protection is enabled)`;
    }
    if (responseHeader(headers, 'x-vercel-protection')
        || responseHeader(headers, 'x-vercel-sso')
        || responseHeader(headers, 'www-authenticate')
        || responseHeader(headers, 'proxy-authenticate')) {
        return 'origin_protected: the response is a deployment authentication/SSO challenge';
    }
    const cookies = String(responseHeader(headers, 'set-cookie') || '');
    if (/_vercel_jwt|__Host-next-auth|__session/i.test(cookies)) {
        return 'origin_protected: the response set an authentication/SSO session cookie';
    }
    if (response?.url && requestUrl) {
        try {
            const requested = new URL(requestUrl);
            const final = new URL(response.url);
            if (hostKey(requested.hostname) !== hostKey(final.hostname)) {
                return `origin_redirected: the origin redirected to ${final.hostname}`;
            }
        } catch { /* the response URL is optional; malformed values are ignored */ }
    }
    const contentType = String(responseHeader(headers, 'content-type') || '').toLowerCase();
    const body = String(text || '').slice(0, 2000);
    if (/text\/html/i.test(contentType) || /<!doctype html|<html/i.test(body)) {
        if (/vercel authentication|sign in|single sign-on|sso|authentication required|access denied|log in|login/i.test(body)) {
            return 'origin_sso: the origin returned a protection or SSO login page instead of the price payload';
        }
        return 'origin_html: the origin returned HTML instead of the price payload';
    }
    return null;
}

function cacheStatus(headers, name) {
    return String(responseHeader(headers, name) || '').trim();
}

function cacheState(value, pattern) {
    return pattern.test(value);
}

/**
 * The cache-busted edge read is only useful as a freshness oracle if it
 * actually missed the CDN cache. A cache status that says HIT/STALE, or any
 * non-zero Age, means the CDN ignored the buster and served another cached
 * copy. Missing cache-status evidence is also not proof of a miss.
 */
function edgeCacheFreshness(headers) {
    const age = Number(responseHeader(headers, 'age'));
    if (Number.isFinite(age) && age > 0) {
        return { ok: false, reason: `edge_fresh_cache_hit: Age is ${age}` };
    }
    const statuses = [
        ['x-vercel-cache', cacheStatus(headers, 'x-vercel-cache')],
        ['cf-cache-status', cacheStatus(headers, 'cf-cache-status')],
        ['x-cache', cacheStatus(headers, 'x-cache')]
    ].filter(([, value]) => value);
    const hitPattern = /(^|[^A-Z])(HIT|STALE|REVALIDATED|UPDATING)([^A-Z]|$)/i;
    const missPattern = /(^|[^A-Z])(MISS|BYPASS|PASS|DYNAMIC)([^A-Z]|$)/i;
    for (const [name, value] of statuses) {
        if (cacheState(value, hitPattern)) {
            return { ok: false, reason: `edge_fresh_cache_hit: ${name}=${value}` };
        }
    }
    for (const [name, value] of statuses) {
        if (cacheState(value, missPattern)) {
            return { ok: true, evidence: { header: name, value } };
        }
    }
    return { ok: false, reason: 'edge_fresh_unverified: the response did not prove a cache miss' };
}

function originCacheReason(headers) {
    const vercel = String(responseHeader(headers, 'x-vercel-cache') || '').toUpperCase();
    const cloudflare = String(responseHeader(headers, 'cf-cache-status') || '').toUpperCase();
    const xCache = String(responseHeader(headers, 'x-cache') || '').toUpperCase();
    if (/(^|\b)(HIT|STALE)(\b|$)/.test(vercel)
        || /(^|\b)(HIT|STALE)(\b|$)/.test(cloudflare)
        || /(^|\b)HIT(\b|$)/.test(xCache)) {
        return 'origin_cache_hit: the response came from a CDN cache, not the direct origin';
    }
    const age = Number(responseHeader(headers, 'age'));
    if (Number.isFinite(age) && age > 0) {
        return 'origin_cache_hit: the response has a non-zero cache age';
    }
    return null;
}

function normalizeCheckoutPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Checkout payload must be a JSON object');
    }
    const currency = normalizeCurrency(payload.currency);
    if (!currency) throw new Error('Checkout payload is missing its currency');
    if (!payload.prices || typeof payload.prices !== 'object' || Array.isArray(payload.prices)) {
        throw new Error('Checkout payload is missing its prices object');
    }
    return { currency, prices: payload.prices };
}

function withCacheBuster(url, nonce) {
    try {
        const parsed = new URL(url);
        parsed.searchParams.set('_price_audit', nonce);
        return parsed.toString();
    } catch {
        return `${url}${url.includes('?') ? '&' : '?'}_price_audit=${encodeURIComponent(nonce)}`;
    }
}

function headerValue(headers, name) {
    if (!headers) return null;
    if (typeof headers.get === 'function') return headers.get(name);
    const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name);
    return key ? headers[key] : null;
}

function cacheSummary(headers) {
    const summary = {};
    for (const [key, name] of Object.entries({
        age: 'age',
        cache_control: 'cache-control',
        etag: 'etag',
        x_vercel_cache: 'x-vercel-cache',
        cf_cache_status: 'cf-cache-status',
        x_cache: 'x-cache',
        via: 'via'
    })) {
        const value = headerValue(headers, name);
        if (value !== null && value !== undefined && value !== '') summary[key] = String(value);
    }
    return summary;
}

async function readCheckoutView(name, url, {
    fetchImpl,
    timeoutMs,
    cacheBust,
    nonce,
    directOrigin = false,
    pinnedAddress = null,
    originRequestImpl = requestPinnedUrl
}) {
    if (!url) {
        return {
            name,
            ok: false,
            requested_url: null,
            url: null,
            cache_bust: Boolean(cacheBust),
            skipped: true,
            error: 'No checkout payload URL was provided'
        };
    }
    const requestUrl = cacheBust ? withCacheBuster(url, nonce) : url;
    const headers = {
        accept: 'application/json',
        ...(cacheBust ? { 'cache-control': 'no-cache' } : {})
    };
    try {
        if (directOrigin && !pinnedAddress) throw new Error('origin_pin_missing: no verified origin address');
        const response = directOrigin
            ? await originRequestImpl(requestUrl, { address: pinnedAddress, timeoutMs, headers })
            : await fetchImpl(requestUrl, {
                method: 'GET',
                redirect: 'follow',
                headers,
                signal: AbortSignal.timeout(timeoutMs)
            });
        const text = await response.text();
        const protection = protectionReason(response, text, requestUrl);
        if (protection) throw new Error(protection);
        if (directOrigin) {
            const cacheIssue = originCacheReason(response.headers);
            if (cacheIssue) throw new Error(cacheIssue);
        }
        const freshness = cacheBust && name === 'edge_fresh' ? edgeCacheFreshness(response.headers) : null;
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${String(text || '').slice(0, 300)}`);
        }
        let raw;
        try {
            raw = JSON.parse(text);
        } catch {
            throw new Error('response is not valid JSON');
        }
        const payload = normalizeCheckoutPayload(raw);
        return {
            name,
            ok: true,
            requested_url: url,
            url: requestUrl,
            cache_bust: Boolean(cacheBust),
            http_status: response.status,
            currency: payload.currency,
            count: Object.keys(payload.prices).length,
            cache: cacheSummary(response.headers),
            ...(freshness ? { freshness } : {}),
            payload
        };
    } catch (error) {
        return {
            name,
            ok: false,
            requested_url: url,
            url: requestUrl,
            cache_bust: Boolean(cacheBust),
            error: error.message
        };
    }
}

const QUOTE_PATH = '/acp/v1/price-quote';

function normalizeQuoteUrl(value) {
    const parsed = new URL(String(value || ''));
    if (!parsed.pathname || parsed.pathname === '/') parsed.pathname = QUOTE_PATH;
    if (parsed.search || parsed.hash) throw new Error('Quote URL must not contain a query or fragment');
    return parsed.toString();
}

export function resolveQuoteUrl(settings = shopifySettingsFromEnv(), checkoutUrl = null, override = null) {
    const raw = String(override || settings.quoteUrl || '').trim();
    if (raw) {
        try {
            return normalizeQuoteUrl(raw);
        } catch {
            return raw;
        }
    }
    if (checkoutUrl) {
        try {
            return new URL(QUOTE_PATH, checkoutUrl).toString();
        } catch {
            return null;
        }
    }
    const base = String(settings.storefrontUrl || '').replace(/\/+$/, '');
    return base ? `${base}${QUOTE_PATH}` : null;
}

function quoteRedirects(settings, quoteUrl) {
    let origin;
    try {
        origin = new URL(String(settings?.storefrontUrl || quoteUrl)).origin;
    } catch {
        origin = new URL(quoteUrl).origin;
    }
    return {
        returnUrl: new URL('/buy/success', origin).toString(),
        cancelUrl: new URL('/buy/cancel', origin).toString()
    };
}

async function readQuote(url, { fetchImpl, timeoutMs }) {
    const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { accept: 'application/json', 'cache-control': 'no-cache' },
        signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    if (response.status >= 300 && response.status < 400) {
        throw new Error(`quote endpoint redirected with HTTP ${response.status}`);
    }
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${String(text || '').slice(0, 300)}`);
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new Error('quote response is not valid JSON');
    }
}

async function auditPriceQuotes(canonical, catalogDigest, {
    quoteUrl = null,
    settings = {},
    fetchImpl = globalThis.fetch,
    timeoutMs = 15000,
    now = Date.now()
} = {}) {
    const quote = {
        url: quoteUrl || null,
        checked_products: 0,
        failed_products: 0,
        drift_products: 0,
        unchecked_products: 0
    };
    const drift = [];
    const unchecked = [];
    const unavailable = [];
    if (!quoteUrl) {
        unavailable.push('quote_audit_unavailable: no quote URL is configured');
        return { quote, drift, unchecked, unavailable };
    }

    let redirects;
    try {
        redirects = quoteRedirects(settings, quoteUrl);
    } catch (error) {
        unavailable.push(`quote_audit_unavailable: invalid quote URL (${error.message})`);
        return { quote, drift, unchecked, unavailable };
    }

    const expectedCurrency = normalizeCurrency(canonical.currency);
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const results = await Promise.all((canonical.courses || []).map(async course => {
        const productId = String(course.slug || '').trim();
        if (!productId) return null;
        let url;
        try {
            url = new URL(quoteUrl);
            url.searchParams.set('product_id', productId);
            url.searchParams.set('return_url', redirects.returnUrl);
            url.searchParams.set('cancel_url', redirects.cancelUrl);
            url.searchParams.set('_quote_audit', nonce);
        } catch (error) {
            return { productId, failure: `invalid quote URL (${error.message})` };
        }

        let body;
        try {
            body = await readQuote(url.toString(), { fetchImpl, timeoutMs });
        } catch (error) {
            return { productId, failure: error.message };
        }
        if (!body || body.ok !== true) {
            return { productId, failure: body?.error || 'quote endpoint returned ok=false' };
        }

        const issues = [];
        if (!body.quote) issues.push({ reason: 'quote_token_missing' });
        if (String(body.product_id || '') !== productId) {
            issues.push({ reason: 'quote_product_mismatch', expected: productId, actual: body.product_id ?? null });
        }

        const currency = normalizeCurrency(body.amount?.currency || body.currency);
        if (currency !== expectedCurrency) {
            issues.push({ reason: 'quote_currency_mismatch', expected: expectedCurrency, actual: currency || null });
        }

        const actualAmount = Number(body.amount?.value);
        let amountDrift = null;
        if (!Number.isFinite(actualAmount) || actualAmount <= 0) {
            issues.push({ reason: 'quote_amount_missing' });
        } else {
            const actualCents = Math.round(actualAmount * 100);
            if (actualCents !== Number(course.price_cents)) {
                amountDrift = {
                    source: 'quote',
                    course_id: productId,
                    product_id: productId,
                    reason: 'price_mismatch',
                    detail_source: 'quote_amount',
                    expected: { amount: Number(course.price_cents) / 100, currency: expectedCurrency },
                    actual: { amount: actualCents / 100, currency: currency || expectedCurrency }
                };
            }
        }

        if (String(body.catalog_digest || '') !== String(catalogDigest)) {
            issues.push({
                reason: 'quote_catalog_digest_mismatch',
                expected: catalogDigest,
                actual: body.catalog_digest ?? null
            });
        }

        const expiresAt = Date.parse(body.expires_at);
        if (!Number.isFinite(expiresAt) || expiresAt <= now) {
            issues.push({ reason: 'quote_expired', expected: 'future expires_at', actual: body.expires_at ?? null });
        }

        if (body.return_url !== redirects.returnUrl) {
            issues.push({ reason: 'quote_redirect_mismatch', field: 'return_url', expected: redirects.returnUrl, actual: body.return_url ?? null });
        }
        if (body.cancel_url !== redirects.cancelUrl) {
            issues.push({ reason: 'quote_redirect_mismatch', field: 'cancel_url', expected: redirects.cancelUrl, actual: body.cancel_url ?? null });
        }

        return { productId, issues, amountDrift };
    }));

    for (const result of results.filter(Boolean)) {
        if (result.failure) {
            quote.failed_products += 1;
            unavailable.push(`quote_unavailable: ${result.productId}: ${result.failure}`);
            continue;
        }
        if (result.amountDrift) {
            quote.drift_products += 1;
            drift.push(result.amountDrift);
        }
        const issues = result.issues || [];
        if (issues.length) quote.unchecked_products += 1;
        for (const issue of issues) {
            unchecked.push({ source: 'quote', course_id: result.productId, ...issue });
        }
        if (issues.length === 0) quote.checked_products += 1;
    }
    quote.unchecked_issues = unchecked.length;
    return { quote, drift, unchecked, unavailable };
}

function checkoutDrift(catalog, payload, route = 'checkout') {
    const routeFields = route === 'checkout' ? {} : { route };
    const detailSource = route === 'checkout' ? 'checkout_price' : `${route}_price`;
    const drift = [];
    const unchecked = [];
    const expectedCurrency = normalizeCurrency(catalog.currency);
    if (payload.currency !== expectedCurrency) {
        unchecked.push({
            source: 'checkout',
            ...routeFields,
            reason: 'currency_mismatch',
            expected: expectedCurrency,
            actual: payload.currency
        });
        return { drift, unchecked };
    }

    const seen = new Set();
    for (const course of catalog.courses) {
        seen.add(course.slug);
        const raw = payload.prices[course.slug];
        const actual = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
        if (!Number.isFinite(actual)) {
            unchecked.push({
                source: 'checkout',
                ...routeFields,
                course_id: course.slug,
                reason: 'missing_checkout_price',
                expected: {
                    amount: course.price_cents / 100,
                    currency: expectedCurrency
                },
                actual: null
            });
            continue;
        }
        const actualCents = Math.round(actual * 100);
        if (actualCents !== course.price_cents) {
            drift.push({
                source: 'checkout',
                ...routeFields,
                course_id: course.slug,
                reason: 'price_mismatch',
                detail_source: detailSource,
                expected: {
                    amount: course.price_cents / 100,
                    currency: expectedCurrency
                },
                actual: {
                    amount: actual,
                    currency: payload.currency
                }
            });
        }
    }

    for (const slug of Object.keys(payload.prices)) {
        if (!seen.has(slug)) {
            const amount = Number(payload.prices[slug]);
            unchecked.push({
                source: 'checkout',
                ...routeFields,
                course_id: slug,
                reason: 'unknown_checkout_course',
                expected: null,
                actual: {
                    amount: Number.isFinite(amount) ? amount : null,
                    currency: payload.currency
                }
            });
        }
    }

    return { drift, unchecked };
}

function shopifyDrift(catalog, products, storeCurrency) {
    const drift = [];
    const unchecked = [];
    const byHandle = new Map();
    for (const product of products) {
        const handle = String(product?.handle || '').trim();
        if (handle && !byHandle.has(handle)) byHandle.set(handle, product);
    }

    const selectedProducts = [];
    for (const course of catalog.courses) {
        const handle = course.shopify_handle || course.slug;
        const product = byHandle.get(handle);
        if (!product) {
            unchecked.push({
                source: 'shopify',
                course_id: course.slug,
                handle,
                reason: 'product_missing',
                expected: {
                    amount: course.price_cents / 100,
                    currency: normalizeCurrency(catalog.currency)
                },
                actual: null
            });
            continue;
        }
        selectedProducts.push({ course, product });
    }

    const validation = validateVariantPrices(selectedProducts, {
        storeCurrency,
        fx: catalog.fx
    });
    for (const mismatch of validation.mismatches) {
        const course = catalog.bySlug[mismatch.course_id];
        const product = selectedProducts.find(row => row.course.slug === mismatch.course_id)?.product;
        const expectedAmount = Number(mismatch.expected);
        const actualAmount = Number(mismatch.actual);
        const amountMismatch = mismatch.reason === 'price_mismatch'
            && Number.isFinite(expectedAmount)
            && Number.isFinite(actualAmount);
        const row = {
            source: 'shopify',
            course_id: mismatch.course_id,
            handle: course?.shopify_handle || course?.slug || null,
            product_id: mismatch.product_id ?? product?.id ?? null,
            variant_id: mismatch.variant_id ?? null,
            reason: mismatch.reason,
            ...(mismatch.source ? { detail_source: mismatch.source } : {}),
            ...(mismatch.expected !== undefined ? { expected: mismatch.expected } : {}),
            ...(mismatch.actual !== undefined ? { actual: mismatch.actual } : {}),
            ...(mismatch.currency ? { currency: mismatch.currency } : {}),
            ...(mismatch.error ? { error: mismatch.error } : {})
        };

        if (amountMismatch) {
            drift.push({
                ...row,
                expected: {
                    amount: expectedAmount,
                    currency: mismatch.currency || normalizeCurrency(catalog.currency)
                },
                actual: {
                    amount: actualAmount,
                    currency: mismatch.currency || normalizeCurrency(catalog.currency)
                }
            });
        } else {
            unchecked.push(row);
        }
    }

    return {
        drift,
        unchecked,
        checked_products: selectedProducts.length,
        checked_variants: validation.checked_variants,
        store_currency: validation.store_currency
    };
}

function payloadFingerprint(payload) {
    if (!payload) return null;
    const prices = Object.keys(payload.prices)
        .sort()
        .map(slug => `${slug}=${String(payload.prices[slug])}`)
        .join('&');
    return `${payload.currency}|${prices}`;
}

function summarizeView(view) {
    if (!view) return null;
    const summary = {
        name: view.name,
        requested_url: view.requested_url || view.url || null,
        url: view.url || null,
        ok: Boolean(view.ok),
        cache_bust: Boolean(view.cache_bust)
    };
    if (view.skipped) summary.skipped = true;
    if (view.http_status !== undefined) summary.http_status = view.http_status;
    if (view.currency) summary.currency = view.currency;
    if (view.ok) summary.count = view.count;
    if (view.cache && Object.keys(view.cache).length) summary.cache = view.cache;
    if (view.freshness) summary.freshness = view.freshness;
    if (view.error) summary.error = view.error;
    return summary;
}

function groupDrift(observations) {
    const groups = new Map();
    for (const observation of observations) {
        const courseId = observation.course_id;
        if (!groups.has(courseId)) {
            groups.set(courseId, {
                course_id: courseId,
                handle: observation.handle || null,
                product_id: observation.product_id ?? null,
                sources: [],
                reasons: [],
                observations: []
            });
        }
        const group = groups.get(courseId);
        if (!group.handle && observation.handle) group.handle = observation.handle;
        if (observation.source && !group.sources.includes(observation.source)) {
            group.sources.push(observation.source);
        }
        const detail = observation.source === 'checkout'
            ? observation.reason
            : (observation.detail_source || observation.reason);
        const reason = `${observation.source}:${detail}`;
        if (!group.reasons.includes(reason)) group.reasons.push(reason);
        group.observations.push(observation);
        if (group.product_id === null && observation.product_id !== undefined) {
            group.product_id = observation.product_id;
        }
    }
    return [...groups.values()].sort((a, b) => String(a.course_id).localeCompare(String(b.course_id)));
}

function uncheckedReasons(report) {
    const reasons = [...(report.unavailable || [])];
    for (const row of report.unchecked || []) {
        reasons.push(`${row.source}:${row.course_id || 'catalog'} ${row.reason}`);
    }
    return reasons;
}

function buildFinding(report) {
    if (report.status === 'drift') {
        const affected = report.affected_courses;
        const preview = report.drift.slice(0, 3).map(row =>
            `${row.course_id} (${row.reasons.join(', ')})`
        ).join('; ');
        const suffix = report.drift.length > 3 ? ` (+${report.drift.length - 3} more)` : '';
        return {
            code: 'SHOPIFY_PRICE_DRIFT',
            severity: 'high',
            detail: `${affected} course(s) with a real price divergence between the catalog, edge/origin checkout, quotes and Shopify: ${preview}${suffix}`,
            evidence: {
                checked_at: report.checked_at,
                catalog_file: report.catalog_file,
                catalog_digest: report.catalog_digest,
                store_currency: report.store_currency,
                checkout_url: report.checkout.url,
                checkout: report.checkout,
                quote: report.quote,
                checked: report.checked,
                affected_courses: affected,
                drift: report.drift,
                unchecked: report.unchecked,
                unavailable: report.unavailable
            }
        };
    }
    if (report.status === 'unavailable') {
        const reasons = uncheckedReasons(report);
        return {
            code: 'SHOPIFY_PRICE_DRIFT_UNCHECKED',
            severity: 'medium',
            detail: `Price drift could not be fully checked: ${reasons.join('; ') || 'no reason was reported'}`,
            evidence: {
                checked_at: report.checked_at,
                catalog_file: report.catalog_file,
                catalog_digest: report.catalog_digest,
                store_currency: report.store_currency,
                checkout_url: report.checkout.url,
                checkout: report.checkout,
                quote: report.quote,
                checked: report.checked,
                unchecked: report.unchecked,
                unavailable: report.unavailable
            }
        };
    }
    return null;
}

export function resolveCheckoutUrl(settings = shopifySettingsFromEnv(), override = null) {
    if (override) return String(override);
    const base = String(settings.storefrontUrl || '').replace(/\/+$/, '');
    return base ? `${base}${CHECKOUT_PATH}` : null;
}

export function resolveCheckoutOriginUrl(settings = shopifySettingsFromEnv(), override = null) {
    const raw = String(override || settings.checkoutOriginUrl || '').trim();
    if (!raw) return null;
    const base = raw.replace(/\/+$/, '');
    return base.endsWith(CHECKOUT_PATH) ? base : `${base}${CHECKOUT_PATH}`;
}

export async function auditShopifyPriceDrift({
    catalog,
    catalogFile,
    settings = shopifySettingsFromEnv(),
    checkoutPayload,
    checkoutUrl = resolveCheckoutUrl(settings),
    checkoutOriginUrl = resolveCheckoutOriginUrl(settings),
    quoteUrl = resolveQuoteUrl(settings, checkoutUrl),
    fetchImpl = globalThis.fetch,
    timeoutMs = 15000,
    dnsResolver = dnsPromises,
    dnsTimeoutMs = 3000,
    originRequestImpl = requestPinnedUrl
} = {}) {
    const canonical = catalog || loadCourseCatalog(catalogFile);
    const catalogDigest = canonical.digest || catalogRevisionDigest(canonical);
    const unavailable = [];
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const views = [];
    const urlValidation = validateCheckoutOriginUrl(checkoutOriginUrl, checkoutUrl);
    const dnsValidation = checkoutUrl && urlValidation.ok
        ? await verifyCheckoutOriginDns(urlValidation.url, checkoutUrl, { dnsResolver, timeoutMs: dnsTimeoutMs })
        : null;
    const originValidation = dnsValidation
        ? { ...urlValidation, ...dnsValidation, url: urlValidation.url }
        : urlValidation;
    let checkout = {
        url: checkoutUrl || null,
        origin_url: originValidation.ok ? originValidation.url : (checkoutOriginUrl || null),
        origin_validation: originValidation,
        currency: null,
        count: 0,
        edge: null,
        edge_fresh: null,
        origin: null,
        routes: []
    };

    if (checkoutPayload !== undefined && checkoutPayload !== null) {
        const payload = normalizeCheckoutPayload(checkoutPayload);
        views.push({
            name: 'checkout',
            ok: true,
            requested_url: checkoutUrl || null,
            url: checkoutUrl || null,
            cache_bust: false,
            currency: payload.currency,
            count: Object.keys(payload.prices).length,
            payload,
            injected: true
        });
        if (checkoutOriginUrl && !originValidation.ok) unavailable.push(originValidation.reason);
    } else if (!checkoutUrl) {
        unavailable.push('checkout_unavailable: No checkout payload URL was provided');
    } else {
        const requests = [
            readCheckoutView('edge', checkoutUrl, {
                fetchImpl,
                timeoutMs,
                cacheBust: false,
                nonce
            }),
            readCheckoutView('edge_fresh', checkoutUrl, {
                fetchImpl,
                timeoutMs,
                cacheBust: true,
                nonce
            })
        ];
        if (!checkoutOriginUrl) {
            unavailable.push('checkout_origin_unavailable: CHECKOUT_PRICE_ORIGIN_URL is not configured');
        } else if (!originValidation.ok) {
            unavailable.push(originValidation.reason);
            views.push({
                name: 'origin',
                ok: false,
                skipped: true,
                requested_url: checkoutOriginUrl,
                url: null,
                cache_bust: true,
                error: originValidation.reason
            });
        } else {
            requests.push(readCheckoutView('origin', originValidation.url, {
                fetchImpl,
                timeoutMs,
                cacheBust: true,
                nonce,
                directOrigin: true,
                pinnedAddress: originValidation.address,
                originRequestImpl
            }));
        }
        views.push(...await Promise.all(requests));
    }

    const edge = views.find(view => view.name === 'edge');
    const edgeFresh = views.find(view => view.name === 'edge_fresh');
    const origin = views.find(view => view.name === 'origin');
    const edgeFreshVerified = Boolean(edgeFresh?.ok && edgeFresh.freshness?.ok === true);
    const readable = views.filter(view => view.ok && (view.name !== 'edge_fresh' || edgeFreshVerified));
    const primary = edge?.ok ? edge : (edgeFreshVerified ? edgeFresh : (origin?.ok ? origin : (readable[0] || null)));
    if (edgeFresh?.ok && !edgeFreshVerified) {
        unavailable.push(`checkout_fresh_unverified: ${edgeFresh.freshness?.reason || 'the cache-busted edge response did not prove a cache miss'}`);
    }

    const failureName = view => view.name === 'edge'
        ? 'checkout_unavailable'
        : (view.name === 'edge_fresh' ? 'checkout_fresh_unavailable' : 'checkout_origin_unavailable');
    for (const view of views) {
        if (!view.ok && !view.skipped) unavailable.push(`${failureName(view)}: ${view.error}`);
    }

    checkout = {
        url: checkoutUrl || null,
        origin_url: originValidation.ok ? originValidation.url : (checkoutOriginUrl || null),
        origin_validation: originValidation,
        currency: primary?.currency || null,
        count: primary?.count || 0,
        edge: summarizeView(edge),
        edge_fresh: summarizeView(edgeFresh),
        origin: summarizeView(origin),
        routes: views.filter(view => view.name === 'checkout' || view.name === 'edge' || view.name === 'edge_fresh' || view.name === 'origin').map(view => view.name)
    };
    if (checkoutPayload !== undefined && checkoutPayload !== null) {
        checkout.edge = summarizeView(views[0]);
    }
    if (edge?.ok && edgeFreshVerified) {
        const edgeDiffers = payloadFingerprint(edge.payload) !== payloadFingerprint(edgeFresh.payload);
        checkout.edge.stale = edgeDiffers;
        checkout.edge.stale_vs_fresh = edgeDiffers;
    }
    if (edge?.ok && origin?.ok) {
        checkout.edge.differs_from_origin = payloadFingerprint(edge.payload) !== payloadFingerprint(origin.payload);
    }
    if (edgeFreshVerified && origin?.ok) {
        const originDiffers = payloadFingerprint(edgeFresh.payload) !== payloadFingerprint(origin.payload);
        checkout.origin.differs_from_fresh = originDiffers;
        checkout.fresh_matches_origin = !originDiffers;
    }

    const checkoutResult = { drift: [], unchecked: [] };
    const compared = new Set();
    for (const view of readable) {
        const fingerprint = payloadFingerprint(view.payload);
        if (compared.has(fingerprint)) continue;
        compared.add(fingerprint);
        const result = checkoutDrift(canonical, view.payload, view.name);
        checkoutResult.drift.push(...result.drift);
        checkoutResult.unchecked.push(...result.unchecked);
    }
    const quoteResult = await auditPriceQuotes(canonical, catalogDigest, {
        quoteUrl,
        settings,
        fetchImpl,
        timeoutMs
    });
    unavailable.push(...quoteResult.unavailable);

    let shopify = {
        checked_products: 0,
        checked_variants: 0,
        store_currency: null
    };
    let shopifyResult = { drift: [], unchecked: [] };

    if (!settings.domain || !settings.token) {
        unavailable.push('missing_shopify_admin_credentials');
    } else {
        try {
            const storeCurrency = await getShopCurrency(settings, { fetchImpl });
            const products = await listProducts(settings, { fetchImpl });
            shopifyResult = shopifyDrift(canonical, products, storeCurrency);
            shopify = {
                checked_products: shopifyResult.checked_products,
                checked_variants: shopifyResult.checked_variants,
                store_currency: shopifyResult.store_currency
            };
        } catch (error) {
            unavailable.push(`shopify_unavailable: ${error.message}`);
        }
    }

    const drift = groupDrift([...checkoutResult.drift, ...quoteResult.drift, ...shopifyResult.drift]);
    const unchecked = [...checkoutResult.unchecked, ...quoteResult.unchecked, ...shopifyResult.unchecked];
    const status = drift.length
        ? 'drift'
        : ((unavailable.length || unchecked.length) ? 'unavailable' : 'ok');
    const report = {
        read_only: true,
        status,
        checked_at: new Date().toISOString(),
        catalog_file: canonical.file || catalogFile || null,
        catalog_digest: catalogDigest,
        catalog_currency: normalizeCurrency(canonical.currency),
        store_currency: shopify.store_currency,
        checkout,
        quote: quoteResult.quote,
        checked: {
            catalog_courses: canonical.courses.length,
            checkout_prices: checkout.count,
            checkout_routes: checkout.routes.length,
            quote_products: quoteResult.quote.checked_products,
            shopify_products: shopify.checked_products,
            shopify_variants: shopify.checked_variants
        },
        affected_courses: drift.length,
        drift,
        unchecked,
        unavailable
    };
    return {
        ...report,
        finding: buildFinding(report)
    };
}
