import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { planCheckoutReplayProtection } from '../src/sales/checkout-attempts.mjs';

const PRODUCT = 'financial-risk-manager-test-bank';
const RETURN_URL = encodeURIComponent('https://www.realworldcerts.com/buy/success');
const CANCEL_URL = encodeURIComponent('https://www.realworldcerts.com/buy/cancel');

const PROBE = String.raw`
import handler from './api/index.mjs';

globalThis.__orderCreateCalls = 0;
globalThis.__orderHeaders = [];
globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  if (target.includes('/v1/oauth2/token')) {
    return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }
  if (target.endsWith('/v2/checkout/orders')) {
    globalThis.__orderCreateCalls += 1;
    globalThis.__orderHeaders.push(init.headers || {});
    return new Response(JSON.stringify({
      id: 'ORDER-GATE',
      status: 'CREATED',
      links: [{ rel: 'approve', href: 'https://www.paypal.com/approve' }]
    }), { status: 201, headers: { 'content-type': 'application/json' } });
  }
  throw new Error('unexpected fetch: ' + target);
};

function call(url, method = 'GET', body = '{}') {
  return new Promise(resolve => {
    const req = {
      method,
      url,
      headers: { host: 'localhost', 'x-forwarded-for': '127.0.0.1', 'user-agent': 'test', accept: '*/*' },
      socket: { remoteAddress: '127.0.0.1' },
      readableEnded: true,
      rawBody: method === 'POST' ? body : ''
    };
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(key, value) { this.headers[key] = value; },
      getHeader(key) { return this.headers[key]; },
      writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers || {}); return this; },
      end(payload) { resolve({ status: this.statusCode, headers: this.headers, body: String(payload) }); }
    };
    handler(req, res).catch(error => resolve({ status: 0, error: error.message }));
  });
}

const quote = await call('/acp/v1/price-quote?product_id=${PRODUCT}&return_url=${RETURN_URL}&cancel_url=${CANCEL_URL}');
const quoteBody = JSON.parse(quote.body);
const create = await call('/acp/v1/transactions', 'POST', JSON.stringify({
  product_id: '${PRODUCT}',
  amount: 19,
  currency: 'USD',
  price_quote: quoteBody.quote,
  return_url: 'https://www.realworldcerts.com/buy/success',
  cancel_url: 'https://www.realworldcerts.com/buy/cancel'
}));

process.stdout.write(JSON.stringify({
  quote_status: quote.status,
  create,
  order_create_calls: globalThis.__orderCreateCalls,
  order_headers: globalThis.__orderHeaders
}) + '\n');
`;

function baseEnv() {
    const env = { ...process.env };
    delete env.CHECKOUT_ATTEMPT_STORE_DIR;
    delete env.CHECKOUT_ATTEMPT_SIGNING_SECRET;
    delete env.CHECKOUT_ATTEMPT_CLAIM_TIMEOUT_MS;
    delete env.PRICE_QUOTE_SECRET;
    return {
        ...env,
        PAYPAL_WEBHOOK_ID: 'WH-GATE',
        PAYPAL_CLIENT_ID: 'gate-client',
        PAYPAL_CLIENT_SECRET: 'gate-secret',
        PAYPAL_ENABLE_ORDER_CREATE: 'true',
        PAYPAL_MODE: 'live',
        SWARM_LIVE: 'true',
        NO_PLATFORM_WALLET: 'true',
        OWNER_PAYPAL_EMAIL: 'owner@example.com',
        PRICE_QUOTE_SECRET: 'quote-gate-secret',
        STOREFRONT_URL: 'https://www.realworldcerts.com',
        CHECKOUT_PRICE_ORIGIN_URL: '',
        PAYPAL_RETURN_URL: '',
        PAYPAL_CANCEL_URL: '',
        FULFILLMENT_ENABLED: 'false',
        VERCEL: '1'
    };
}

function runProbe(env) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 30000,
        env
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

function configCheck(env) {
    const result = spawnSync(process.execPath, ['src/paypal-webhook-server.mjs', '--check'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 30000,
        env
    });
    assert.equal(result.status, 0, result.stderr);
    return { stderr: result.stderr, config: JSON.parse(result.stdout.trim().split('\n').at(-1)).config };
}

function withoutServerlessMarker(env) {
    const copy = { ...env };
    delete copy.VERCEL;
    delete copy.VERCEL_ENV;
    delete copy.AWS_LAMBDA_FUNCTION_NAME;
    delete copy.NETLIFY;
    return copy;
}

test('production on a long-lived host refuses to create an order without a store', () => {
    const probe = runProbe(withoutServerlessMarker(baseEnv()));

    assert.equal(probe.quote_status, 200, 'quoting still works; only order creation is refused');
    assert.equal(probe.create.status, 503);
    const body = JSON.parse(probe.create.body);
    assert.equal(body.ok, false);
    assert.equal(body.code, 'CHECKOUT_ATTEMPT_STORE_NOT_DURABLE');
    assert.match(body.error, /CHECKOUT_ATTEMPT_STORE_DIR is not set/);
    assert.equal(body.checkout_attempts.blocks_checkout, true);
    assert.equal(body.checkout_attempts.production, true);
    assert.equal(body.checkout_attempts.replay_protection, 'store');
    assert.equal(probe.order_create_calls, 0, 'no PayPal order is created without replay protection');
});

test('the same production checkout creates an order once the store is configured', () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-gate-'));
    try {
        const env = withoutServerlessMarker(baseEnv());
        env.CHECKOUT_ATTEMPT_STORE_DIR = store;
        env.CHECKOUT_ATTEMPT_SIGNING_SECRET = 'gate-signing-secret';
        const probe = runProbe(env);

        assert.equal(probe.create.status, 200, probe.create.body);
        assert.equal(JSON.parse(probe.create.body).ok, true);
        assert.equal(probe.order_create_calls, 1);
        const headers = probe.order_headers[0] || {};
        const requestId = headers['PayPal-Request-Id'] || headers['paypal-request-id'];
        assert.ok(requestId, 'the order carries a quote-derived PayPal request id');
        assert.match(String(requestId), /^acp_/);
    } finally {
        fs.rmSync(store, { recursive: true, force: true });
    }
});

test('a serverless production deployment can name provider idempotency as the durable layer', () => {
    const env = baseEnv();
    env.CHECKOUT_REPLAY_PROTECTION = 'provider';
    const probe = runProbe(env);

    assert.equal(probe.create.status, 200, probe.create.body);
    assert.equal(probe.order_create_calls, 1);
    const headers = probe.order_headers[0] || {};
    assert.ok(headers['PayPal-Request-Id'] || headers['paypal-request-id']);

    const { stderr, config } = configCheck(env);
    assert.equal(config.checkout_attempts.replay_protection, 'provider');
    assert.equal(config.checkout_attempts.replay_protection_auto, false, 'explicitly chosen, not inferred');
    assert.equal(config.checkout_attempts.blocks_checkout, false);
    assert.equal(config.checkout_attempts.durable, false, 'no store means no local durability, and the report says so');
    assert.match(stderr, /PayPal-Request-Id/);
    assert.match(stderr, /returns the same order/);
    assert.equal(config.ok, true);
});

test('a serverless production deploy uses provider dedupe automatically instead of blocking', () => {
    const env = baseEnv();
    const probe = runProbe(env);

    assert.equal(probe.create.status, 200, probe.create.body);
    assert.equal(probe.order_create_calls, 1);
    const headers = probe.order_headers[0] || {};
    assert.ok(headers['PayPal-Request-Id'] || headers['paypal-request-id']);

    const { stderr, config } = configCheck(env);
    assert.equal(config.checkout_attempts.replay_protection, 'provider');
    assert.equal(config.checkout_attempts.replay_protection_auto, true);
    assert.equal(config.checkout_attempts.blocks_checkout, false);
    assert.match(stderr, /mount no shared filesystem/);
    assert.match(stderr, /returns the same order/);
    assert.match(stderr, /Checkout order creation stays enabled/);
    assert.equal(config.ok, true);
});

test('the config check marks checkout as blocked, without failing the webhook config', () => {
    const { stderr, config } = configCheck(withoutServerlessMarker(baseEnv()));

    assert.equal(config.checkout_attempts.blocks_checkout, true);
    assert.equal(config.checkout_attempts.production, true);
    assert.equal(config.checkout_attempts.durable, false);
    assert.equal(config.ok, true, 'the webhook must keep accepting paid events');
    assert.match(stderr, /"severity":"critical"/);
    assert.match(stderr, /Production checkout order creation is refused until a durable replay layer is configured/);
});

test('a configured store clears the production block', () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-gate-config-'));
    try {
        const env = withoutServerlessMarker(baseEnv());
        env.CHECKOUT_ATTEMPT_STORE_DIR = store;
        env.CHECKOUT_ATTEMPT_SIGNING_SECRET = 'gate-signing-secret';
        const { config } = configCheck(env);

        assert.equal(config.checkout_attempts.blocks_checkout, false);
        assert.equal(config.checkout_attempts.production, true);
        assert.equal(config.ok, true);
    } finally {
        fs.rmSync(store, { recursive: true, force: true });
    }
});

test('the measured storage decides when a directory is configured, not the runtime marker', () => {
    const shared = planCheckoutReplayProtection({
        store: { configured: true, ok: true, directory: '/mnt/attempts' },
        storage: { storage: 'shared', runtime: 'vercel' },
        env: { VERCEL: '1', SWARM_LIVE: 'true' }
    });
    assert.equal(shared.mode, 'store', 'a proved network mount wins over the serverless fallback');
    assert.equal(shared.auto, false);
    assert.equal(shared.block_reason, null);

    const serverlessLocal = planCheckoutReplayProtection({
        store: { configured: true, ok: true, directory: '/tmp/attempts' },
        storage: { storage: 'instance_local', runtime: 'vercel' },
        env: { VERCEL: '1', SWARM_LIVE: 'true' }
    });
    assert.equal(serverlessLocal.mode, 'store', 'a claimed directory is judged by what it is');
    assert.equal(serverlessLocal.auto, false);
    assert.equal(serverlessLocal.block_reason, 'CHECKOUT_ATTEMPT_STORE_INSTANCE_LOCAL');

    const tmpfs = planCheckoutReplayProtection({
        store: { configured: true, ok: true, directory: '/tmp/attempts' },
        storage: { storage: 'instance_local', runtime: null },
        env: { SWARM_LIVE: 'true' }
    });
    assert.equal(tmpfs.mode, 'store');
    assert.equal(tmpfs.block_reason, 'CHECKOUT_ATTEMPT_STORE_INSTANCE_LOCAL', 'tmpfs is refused on any host');
});

test('the runtime marker only decides when no directory is configured', () => {
    const unconfigured = { configured: false, ok: false, directory: null };

    const serverless = planCheckoutReplayProtection({
        store: unconfigured,
        storage: {},
        env: { VERCEL: '1', SWARM_LIVE: 'true' }
    });
    assert.equal(serverless.mode, 'provider');
    assert.equal(serverless.auto, true);
    assert.equal(serverless.block_reason, null);

    const host = planCheckoutReplayProtection({ store: unconfigured, storage: {}, env: { SWARM_LIVE: 'true' } });
    assert.equal(host.mode, 'store');
    assert.equal(host.auto, false);
    assert.equal(host.block_reason, 'CHECKOUT_ATTEMPT_STORE_NOT_DURABLE');
});

test('a per-process store stays allowed outside the production money path', () => {
    const env = baseEnv();
    delete env.SWARM_LIVE;
    delete env.VERCEL;
    const { config } = configCheck(env);

    assert.equal(config.checkout_attempts.production, false);
    assert.equal(config.checkout_attempts.blocks_checkout, false);
});
