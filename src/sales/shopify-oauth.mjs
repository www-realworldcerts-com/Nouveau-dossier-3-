import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { normalizeShopDomain } from './shopify-setup.mjs';

/**
 * One-time Shopify OAuth bootstrap so the admin token configures itself
 * instead of being pasted by hand. Requires a custom app in the Shopify admin
 * (Settings -> Apps -> Develop apps) with client id/secret and the callback
 * `http://127.0.0.1:<port>/callback` whitelisted.
 *
 * The access token is written to a gitignored env file with mode 0600 and is
 * never printed, logged or returned to a browser response.
 */

export const DEFAULT_SCOPES = ['read_products', 'write_products', 'read_orders'];
export const DEFAULT_PORT = 3456;

export function scopesFromEnv(env = process.env) {
    const configured = String(env.SHOPIFY_OAUTH_SCOPES || '').trim();
    return configured ? configured.split(',').map(scope => scope.trim()).filter(Boolean) : [...DEFAULT_SCOPES];
}

export function redirectUriFor(port = DEFAULT_PORT) {
    return `http://127.0.0.1:${port}/callback`;
}

export function buildAuthorizeUrl({ shop, apiKey, scopes = DEFAULT_SCOPES, redirectUri, state }) {
    const domain = normalizeShopDomain(shop);
    if (!domain) throw new Error('OAuth requires the *.myshopify.com store domain');
    if (!apiKey) throw new Error('SHOPIFY_API_KEY is required');
    if (!state) throw new Error('A state value is required');
    const params = new URLSearchParams({
        client_id: apiKey,
        scope: scopes.join(','),
        redirect_uri: redirectUri,
        state
    });
    return `https://${domain}/admin/oauth/authorize?${params.toString()}`;
}

/** Shopify signs the sorted query string (excluding hmac/signature) with the app secret. */
export function computeOAuthHmac(params, apiSecret) {
    const message = Object.entries(params)
        .filter(([key]) => !['hmac', 'signature'].includes(key))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : value}`)
        .join('&');
    return crypto.createHmac('sha256', apiSecret).update(message).digest('hex');
}

export function verifyOAuthHmac(params, apiSecret) {
    const provided = String(params?.hmac || '').toLowerCase();
    if (!provided || !apiSecret) return false;
    const expected = computeOAuthHmac(params, apiSecret);
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function exchangeCodeForToken({ shop, apiKey, apiSecret, code, fetchImpl = globalThis.fetch } = {}) {
    const domain = normalizeShopDomain(shop);
    if (!domain) throw new Error('Invalid shop domain for token exchange');
    if (!code) throw new Error('Missing OAuth code');
    const response = await fetchImpl(`https://${domain}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ client_id: apiKey, client_secret: apiSecret, code })
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(`Token exchange failed (HTTP ${response.status})`);
    }
    const payload = JSON.parse(text);
    const token = String(payload.access_token || '');
    if (!token.startsWith('shp')) throw new Error('Token exchange returned an unexpected token format');
    return { access_token: token, scope: payload.scope || null };
}

/** Upsert KEY=value lines, preserving comments and unrelated settings. */
export function upsertEnvValues(envText, entries) {
    const lines = String(envText || '').split('\n');
    for (const [key, value] of Object.entries(entries)) {
        const pattern = new RegExp(`^\\s*${key}\\s*=`);
        const index = lines.findIndex(line => pattern.test(line));
        const next = `${key}=${value}`;
        if (index >= 0) lines[index] = next;
        else {
            if (lines.length && lines[lines.length - 1] === '') lines.pop();
            lines.push(next);
        }
    }
    return lines.join('\n').replace(/\n*$/, '\n');
}

export function writeTokenToEnv({ file = '.env', domain, token }) {
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const next = upsertEnvValues(existing, {
        SHOPIFY_STORE_DOMAIN: domain,
        SHOPIFY_ADMIN_TOKEN: token
    });
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, next, { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* best-effort on platforms without chmod */ }
    return { file, keys: ['SHOPIFY_STORE_DOMAIN', 'SHOPIFY_ADMIN_TOKEN'] };
}

export function createState() {
    return crypto.randomBytes(16).toString('hex');
}

/**
 * Start the local callback listener, exchange the code and resolve with the
 * token. Resolves only after a valid, HMAC-verified callback.
 */
export async function runLocalOAuth({
    shop,
    apiKey,
    apiSecret,
    port = DEFAULT_PORT,
    scopes = DEFAULT_SCOPES,
    timeoutMs = 300000,
    fetchImpl = globalThis.fetch,
    log = () => {}
} = {}) {
    const domain = normalizeShopDomain(shop);
    if (!domain) throw new Error('OAuth requires the *.myshopify.com store domain');
    if (!apiKey || !apiSecret) throw new Error('SHOPIFY_API_KEY and SHOPIFY_API_SECRET are required');

    const state = createState();
    const redirectUri = redirectUriFor(port);
    const authorizeUrl = buildAuthorizeUrl({ shop: domain, apiKey, scopes, redirectUri, state });

    const token = await new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            try {
                const url = new URL(req.url, `http://127.0.0.1:${port}`);
                if (url.pathname !== '/callback') {
                    res.writeHead(404).end('Not found');
                    return;
                }
                const query = Object.fromEntries(url.searchParams.entries());
                if (!verifyOAuthHmac(query, apiSecret) || query.state !== state || query.shop !== domain) {
                    res.writeHead(403).end('OAuth verification failed');
                    reject(new Error('OAuth callback failed verification (hmac, state or shop mismatch)'));
                    return;
                }
                const result = await exchangeCodeForToken({ shop: domain, apiKey, apiSecret, code: query.code, fetchImpl });
                res.writeHead(200, { 'content-type': 'text/html' }).end(
                    '<!doctype html><body style="font-family:system-ui;padding:2rem">'
                    + '<h2>Shopify connected</h2><p>You can close this tab and return to the terminal.</p></body>'
                );
                resolve(result);
            } catch (error) {
                try { res.writeHead(500).end('OAuth exchange failed'); } catch { /* already sent */ }
                reject(error);
            } finally {
                server.close();
            }
        });
        const timer = setTimeout(() => {
            server.close();
            reject(new Error(`OAuth timed out after ${Math.round(timeoutMs / 60000)} minute(s)`));
        }, timeoutMs);
        timer.unref?.();
        server.on('error', error => {
            clearTimeout(timer);
            reject(error);
        });
        server.listen(port, '127.0.0.1', () => log({ authorizeUrl, redirectUri }));
    });

    return { ...token, authorizeUrl, redirectUri, domain };
}
