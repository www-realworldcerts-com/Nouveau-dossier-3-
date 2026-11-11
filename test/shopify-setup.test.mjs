import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    adminLinks,
    assessShop,
    ensureCoursesCollection,
    manualActions,
    normalizeShopDomain,
    setupShop
} from '../src/sales/shopify-setup.mjs';
import {
    buildAuthorizeUrl,
    computeOAuthHmac,
    exchangeCodeForToken,
    redirectUriFor,
    upsertEnvValues,
    verifyOAuthHmac,
    writeTokenToEnv
} from '../src/sales/shopify-oauth.mjs';
import { DEFAULT_PRICING_CONFIG, storePriceFor } from '../src/sales/pricing.mjs';

const SHOP = 'realworldcerts-test.myshopify.com';
const TOKEN = 'shpat_testtoken123';

function response(body, status = 200) {
    return {
        ok: status < 400,
        status,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
        json: async () => (typeof body === 'string' ? JSON.parse(body) : body)
    };
}

function shopFetch({ products = [{ id: 1, handle: 'x', variants: [{ id: 2, price: '1500.00' }] }], gate = false, scopes } = {}) {
    return async (url, options = {}) => {
        const target = String(url);
        if (target.includes('/shop.json')) {
            return response({ shop: { name: 'RealWorldCerts', currency: 'MAD', domain: SHOP, plan_display_name: 'Basic' } });
        }
        if (target.includes('/access_scopes.json')) {
            return response({ access_scopes: (scopes || ['read_products', 'write_products']).map(handle => ({ handle })) });
        }
        if (target.includes('custom_collections.json')) {
            if (options.method === 'POST') return response({ custom_collection: { id: 99 } });
            return response({ custom_collections: [] });
        }
        if (target.includes('/products.json')) return response({ products });
        if (target.includes('realworldcerts.com')) {
            return response(gate ? '<html><body class="password-page">password</body></html>' : '<html><body>catalog</body></html>');
        }
        return response({}, 404);
    };
}

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'shopify-setup-'));
}

describe('shop domain and links', () => {
    it('normalizes only real myshopify admin domains', () => {
        assert.equal(normalizeShopDomain('HTTPS://RealWorldCerts.myshopify.com/admin'), 'realworldcerts.myshopify.com');
        assert.equal(normalizeShopDomain('realworldcerts.myshopify.com'), 'realworldcerts.myshopify.com');
        assert.equal(normalizeShopDomain('realworldcerts.com'), null, 'custom domains cannot use the Admin API');
        assert.equal(normalizeShopDomain(''), null);
        assert.match(adminLinks(SHOP).payments, /admin\.shopify\.com\/store\/realworldcerts-test\/settings\/payments/);
    });
});

describe('store currency conversion', () => {
    it('publishes MAD prices unchanged into a MAD store', () => {
        assert.deepEqual(storePriceFor(1500, 'MAD'), { amount: 1500, currency: 'MAD', converted: false, rate: 1 });
    });

    it('converts into EUR and USD stores instead of writing MAD as USD', () => {
        assert.equal(storePriceFor(1500, 'EUR').amount, 138);
        assert.equal(storePriceFor(1500, 'usd').amount, 150);
        assert.equal(storePriceFor(1500, 'USD').converted, true);
    });

    it('throws rather than guessing an unsupported currency', () => {
        assert.throws(() => storePriceFor(1500, 'GBP'), /No FX rate for GBP/);
        assert.throws(() => storePriceFor(0, 'MAD'), /invalid price/);
    });
});

describe('shop readiness assessment', () => {
    const readyInputs = {
        shop: { currency: 'MAD' },
        scopes: ['read_products', 'write_products'],
        storefront: { password_gate: 'off' },
        productCount: 3
    };

    it('passes a configured MAD shop with products and no gate', () => {
        const result = assessShop(readyInputs);
        assert.equal(result.ready, true);
        assert.deepEqual(result.blockers, []);
        assert.deepEqual(result.warnings, []);
        assert.equal(result.currency.store, 'MAD');
    });

    it('warns instead of blocking when the store currency is convertible', () => {
        const result = assessShop({ ...readyInputs, shop: { currency: 'USD' } });
        assert.equal(result.ready, true);
        assert.ok(result.warnings.includes('currency_conversion:MAD->USD@0.1'));
        assert.equal(result.currency.conversion.amount, 100);
    });

    it('blocks on an unsupported store currency or missing scopes', () => {
        const gbp = assessShop({ ...readyInputs, shop: { currency: 'GBP' } });
        assert.equal(gbp.ready, false);
        assert.ok(gbp.blockers.includes('unsupported_store_currency:GBP'));

        const scopes = assessShop({ ...readyInputs, scopes: ['read_products'] });
        assert.ok(scopes.blockers.includes('missing_scopes:write_products'));

        const unreachable = assessShop({ ...readyInputs, shop: null });
        assert.ok(unreachable.blockers.includes('shop_unreachable'));
    });

    it('surfaces gate and empty-catalog problems as warnings and manual steps', () => {
        const result = assessShop({ ...readyInputs, storefront: { password_gate: 'on' }, productCount: 0 });
        assert.ok(result.warnings.includes('password_gate_on'));
        assert.ok(result.warnings.includes('no_products_published'));

        const actions = manualActions(SHOP, { passwordGate: 'on', productCount: 0 });
        const ids = actions.map(action => action.id);
        assert.ok(ids.includes('disable_password_gate'));
        assert.ok(ids.includes('choose_payment_provider'));
        assert.ok(ids.includes('publish_products'));
        assert.equal(actions.find(action => action.id === 'disable_password_gate').automated, false);
        assert.equal(manualActions(SHOP, { productCount: 5 }).find(action => action.id === 'publish_products'), undefined, 'no publish step when products already exist');
    });
});

describe('collection setup', () => {
    it('creates the Courses collection only when absent', async () => {
        const created = await ensureCoursesCollection({ domain: SHOP, token: TOKEN }, { fetchImpl: shopFetch() });
        assert.equal(created.action, 'created');
        assert.equal(created.handle, 'courses');

        const exists = await ensureCoursesCollection({ domain: SHOP, token: TOKEN }, {
            fetchImpl: async () => response({ custom_collections: [{ id: 5, handle: 'courses' }] })
        });
        assert.equal(exists.action, 'exists');
        assert.equal(exists.id, 5);
    });

    it('degrades to unsupported instead of throwing', async () => {
        const result = await ensureCoursesCollection({ domain: SHOP, token: TOKEN }, {
            fetchImpl: async () => {
                throw new Error('HTTP 405');
            }
        });
        assert.equal(result.action, 'unsupported');
        assert.match(result.error, /405/);
    });
});

describe('setupShop audit', () => {
    it('reports the missing token and the next command without any network call', async () => {
        let called = false;
        const report = await setupShop(
            { domain: SHOP, token: '', storefrontUrl: 'https://www.realworldcerts.com' },
            { fetchImpl: async () => { called = true; return response({}); } }
        );
        assert.equal(report.ready, false);
        assert.ok(report.blockers.includes('missing_admin_token'));
        assert.match(report.next_step, /shopify:oauth/);
        assert.equal(called, false);
        assert.ok(report.manual_actions.length >= 4);
    });

    it('rejects a non-myshopify domain', async () => {
        const report = await setupShop({ domain: 'https://realworldcerts.com', token: TOKEN }, { fetchImpl: shopFetch() });
        assert.equal(report.ready, false);
        assert.deepEqual(report.blockers, ['invalid_shop_domain']);
    });

    it('audits a healthy shop and optionally ensures the collection', async () => {
        const report = await setupShop(
            { domain: SHOP, token: TOKEN, storefrontUrl: 'https://www.realworldcerts.com', apiVersion: '2024-10' },
            { fetchImpl: shopFetch(), ensureCollection: true }
        );
        assert.equal(report.ready, true);
        assert.deepEqual(report.blockers, []);
        assert.equal(report.shop.currency, 'MAD');
        assert.equal(report.product_count, 1);
        assert.equal(report.storefront.password_gate, 'off');
        assert.equal(report.collection.action, 'created');
        assert.equal(report.currency.catalog, 'MAD');
        assert.equal(report.assessment.currency.conversion, null);
    });

    it('turns API failures into warnings and keeps the checklist', async () => {
        const report = await setupShop(
            { domain: SHOP, token: TOKEN, storefrontUrl: 'https://www.realworldcerts.com' },
            { fetchImpl: async (url) => {
                if (String(url).includes('/shop.json')) return response({ shop: { name: 'X', currency: 'MAD', domain: SHOP } });
                throw new Error('HTTP 403 Forbidden shpat_testtoken123');
            } }
        );
        assert.ok(report.warnings.some(warning => warning.startsWith('api_error:')));
        assert.ok(report.warnings.every(warning => !warning.includes(TOKEN)), 'token must be redacted');
        assert.ok(report.manual_actions.length >= 4);
    });
});

describe('OAuth bootstrap', () => {
    const secret = 'app-secret';

    it('builds an authorize URL with scopes, redirect and state', () => {
        const url = new URL(buildAuthorizeUrl({
            shop: SHOP,
            apiKey: 'client-key',
            scopes: ['read_products', 'write_products'],
            redirectUri: redirectUriFor(3456),
            state: 'state-123'
        }));
        assert.equal(url.hostname, SHOP);
        assert.equal(url.searchParams.get('client_id'), 'client-key');
        assert.equal(url.searchParams.get('scope'), 'read_products,write_products');
        assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:3456/callback');
        assert.equal(url.searchParams.get('state'), 'state-123');
        assert.throws(() => buildAuthorizeUrl({ shop: 'realworldcerts.com', apiKey: 'k', state: 's' }), /myshopify/);
        assert.throws(() => buildAuthorizeUrl({ shop: SHOP, apiKey: 'k', state: 's', scopes: [] }) && buildAuthorizeUrl({ shop: SHOP, state: 's' }), /API_KEY/);
    });

    it('verifies the callback HMAC and rejects tampering', () => {
        const params = { shop: SHOP, code: 'abc', state: 'st', timestamp: '1700000000' };
        const hmac = computeOAuthHmac(params, secret);
        assert.equal(verifyOAuthHmac({ ...params, hmac }, secret), true);
        assert.equal(verifyOAuthHmac({ ...params, code: 'tampered', hmac }, secret), false);
        assert.equal(verifyOAuthHmac({ ...params, hmac: '' }, secret), false);
        assert.equal(verifyOAuthHmac({ ...params, hmac }, ''), false);
    });

    it('exchanges a code for a token and rejects malformed responses', async () => {
        const ok = await exchangeCodeForToken({
            shop: SHOP,
            apiKey: 'k',
            apiSecret: 's',
            code: 'code',
            fetchImpl: async () => response({ access_token: 'shpat_abc', scope: 'read_products' })
        });
        assert.equal(ok.access_token, 'shpat_abc');

        await assert.rejects(() => exchangeCodeForToken({
            shop: SHOP, apiKey: 'k', apiSecret: 's', code: 'code',
            fetchImpl: async () => response({ access_token: 'not-a-token' })
        }), /unexpected token/);

        await assert.rejects(() => exchangeCodeForToken({
            shop: SHOP, apiKey: 'k', apiSecret: 's', code: 'code',
            fetchImpl: async () => response({}, 401)
        }), /HTTP 401/);
    });

    it('upserts env values without losing comments or other settings', () => {
        const existing = '# Shopify\nSHOPIFY_ADMIN_TOKEN=old\nOTHER=keep\n';
        const next = upsertEnvValues(existing, {
            SHOPIFY_ADMIN_TOKEN: 'shpat_new',
            SHOPIFY_STORE_DOMAIN: SHOP
        });
        assert.match(next, /^# Shopify$/m);
        assert.match(next, /^SHOPIFY_ADMIN_TOKEN=shpat_new$/m);
        assert.match(next, /^OTHER=keep$/m);
        assert.match(next, new RegExp(`^SHOPIFY_STORE_DOMAIN=${SHOP}$`, 'm'));
        assert.equal(next.includes('shpat_old'), false);
        assert.equal(next.endsWith('\n'), true);
    });

    it('writes the token to a 0600 env file and never returns it', () => {
        const dir = tempDir();
        const file = path.join(dir, '.env');
        const result = writeTokenToEnv({ file, domain: SHOP, token: TOKEN });
        assert.deepEqual(result, { file, keys: ['SHOPIFY_STORE_DOMAIN', 'SHOPIFY_ADMIN_TOKEN'] });
        const contents = fs.readFileSync(file, 'utf8');
        assert.match(contents, new RegExp(`^SHOPIFY_ADMIN_TOKEN=${TOKEN}$`, 'm'));
        if (process.platform !== 'win32') {
            assert.equal(fs.statSync(file).mode & 0o777, 0o600);
        }
        assert.equal(JSON.stringify(result).includes(TOKEN), false);
    });
});

describe('pricing config', () => {
    it('ships the USD rate the publisher needs', () => {
        assert.equal(DEFAULT_PRICING_CONFIG.fx.usd_per_mad, 0.1);
    });
});
