import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const probe = String.raw`
import handler from './api/index.mjs';

globalThis.__orderCreateCalls = 0;
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
    return new Response(JSON.stringify({
      id: 'ORDER-NEW',
      status: 'CREATED',
      links: [{ rel: 'approve', href: 'https://www.paypal.com/approve' }]
    }), { status: 201, headers: { 'content-type': 'application/json' } });
  }
  if (target.includes('/v2/checkout/orders/ORDER-TEST/capture')) {
    return new Response(JSON.stringify({
      id: 'ORDER-TEST',
      status: 'COMPLETED',
      purchase_units: [{
        amount: { value: '19.00', currency_code: 'USD' },
        payments: { captures: [{ id: 'CAP-TEST', status: 'COMPLETED', final_capture: true }] }
      }]
    }), { status: 201, headers: { 'content-type': 'application/json' } });
  }
  throw new Error('unexpected fetch: ' + target);
};

function call(url, method = 'GET', body = '{}') {
  return new Promise((resolve) => {
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
      end(body) { resolve({ status: this.statusCode, headers: this.headers, body: String(body) }); }
    };
    handler(req, res).catch((error) => resolve({ status: 0, error: error.message }));
  });
}

const buy = await call('/buy');
const discovery = await call('/acp/v1/discovery');
const prices = await call('/data/store-prices.json');
const stale = await call('/acp/v1/transactions', 'POST', JSON.stringify({
  product_id: 'financial-risk-manager-test-bank',
  amount: 0.01,
  currency: 'EUR',
  return_url: 'https://www.realworldcerts.com/buy/success',
  cancel_url: 'https://www.realworldcerts.com/buy/cancel'
}));
const create = await call('/acp/v1/transactions', 'POST', JSON.stringify({
  product_id: 'financial-risk-manager-test-bank',
  amount: 19,
  currency: 'USD',
  return_url: 'https://www.realworldcerts.com/buy/success',
  cancel_url: 'https://www.realworldcerts.com/buy/cancel'
}));
const capture = await call('/acp/v1/transactions/ORDER-TEST/capture', 'POST');
process.stdout.write(JSON.stringify({ buy, discovery, prices, stale, create, capture, order_create_calls: globalThis.__orderCreateCalls }) + '\n');
`;

function runProbe() {
    return spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 30000,
        env: {
            ...process.env,
            VERCEL: '1',
            PAYPAL_WEBHOOK_ID: 'WH-TEST',
            PAYPAL_CLIENT_ID: 'test-client',
            PAYPAL_CLIENT_SECRET: 'test-secret',
            PAYPAL_ENABLE_ORDER_CREATE: 'true',
            FULFILLMENT_ENABLED: 'false',
            PAYPAL_MODE: 'live',
            SWARM_LIVE: 'true',
            NO_PLATFORM_WALLET: 'true',
            OWNER_PAYPAL_EMAIL: 'owner@example.com'
        }
    });
}

function result() {
    const run = runProbe();
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout.trim().split('\n').at(-1));
}

test('the checkout page is reachable and calls the order API', () => {
    const probe = result();
    assert.equal(probe.buy.status, 200);
    assert.match(probe.buy.headers['Content-Type'], /text\/html/);
    assert.match(probe.buy.headers['Content-Security-Policy'], /script-src 'self' 'unsafe-inline'/);
    assert.match(probe.buy.body, /\/acp\/v1\/transactions/);
    assert.match(probe.buy.body, /Continue to PayPal/);
    assert.match(probe.buy.body, /Checkout could not start/);
    assert.match(probe.buy.body, /requestBody\.amount = Number/);
    assert.match(probe.buy.body, /requestBody\.currency = String/);
});

test('checkout discovery and the public payload use the explicit price file', () => {
    const probe = result();
    const discovery = JSON.parse(probe.discovery.body);
    const product = discovery.products.find((row) => row.id === 'financial-risk-manager-test-bank');
    assert.equal(product.price, 19);
    assert.equal(product.currency, 'USD');
    assert.equal(JSON.parse(probe.prices.body).prices['financial-risk-manager-test-bank'], 19);
});

test('ACP checkout rejects a stale displayed amount before creating a PayPal order', () => {
    const probe = result();
    assert.equal(probe.stale.status, 409);
    const body = JSON.parse(probe.stale.body);
    assert.equal(body.ok, false);
    assert.equal(body.code, 'PRICE_CHANGED');
    assert.deepEqual(body.expected, { value: '19.00', currency: 'USD' });
    assert.deepEqual(body.submitted, { value: '0.01', currency: 'EUR' });
    assert.equal(probe.order_create_calls, 1, 'only the matching checkout may call PayPal');
});

test('ACP checkout accepts the displayed amount when it matches the catalog', () => {
    const probe = result();
    assert.equal(probe.create.status, 200);
    const body = JSON.parse(probe.create.body);
    assert.deepEqual(body.amount, { value: '19.00', currency: 'USD' });
});

test('an approved PayPal order can be captured and reports COMPLETED', () => {
    const probe = result();
    assert.equal(probe.capture.status, 200);
    const body = JSON.parse(probe.capture.body);
    assert.equal(body.ok, true);
    assert.equal(body.status, 'COMPLETED');
    assert.equal(body.transaction_id, 'ORDER-TEST');
    assert.deepEqual(body.amount, { value: '19.00', currency: 'USD' });
    assert.equal(body.captures[0].id, 'CAP-TEST');
});
