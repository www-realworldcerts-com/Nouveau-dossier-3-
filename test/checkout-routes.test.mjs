import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const probe = String.raw`
import handler from './api/index.mjs';

globalThis.__orderCreateCalls = 0;
globalThis.__orderBodies = [];
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
    globalThis.__orderBodies.push(JSON.parse(init.body || '{}'));
    globalThis.__orderHeaders.push(init.headers || {});
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
const quote = await call('/acp/v1/price-quote?product_id=financial-risk-manager-test-bank&return_url=' + encodeURIComponent('https://www.realworldcerts.com/buy/success') + '&cancel_url=' + encodeURIComponent('https://www.realworldcerts.com/buy/cancel'));
const quoteBody = JSON.parse(quote.body);
const badOriginQuote = await call('/acp/v1/price-quote?product_id=financial-risk-manager-test-bank&return_url=' + encodeURIComponent('https://evil.example/buy/success') + '&cancel_url=' + encodeURIComponent('https://evil.example/buy/cancel'));
const badPathQuote = await call('/acp/v1/price-quote?product_id=financial-risk-manager-test-bank&return_url=' + encodeURIComponent('https://www.realworldcerts.com/checkout/success') + '&cancel_url=' + encodeURIComponent('https://www.realworldcerts.com/buy/cancel'));
const missing = await call('/acp/v1/transactions', 'POST', JSON.stringify({
  product_id: 'financial-risk-manager-test-bank',
  amount: 19,
  currency: 'USD',
  return_url: 'https://www.realworldcerts.com/buy/success',
  cancel_url: 'https://www.realworldcerts.com/buy/cancel'
}));
const stale = await call('/acp/v1/transactions', 'POST', JSON.stringify({
  product_id: 'financial-risk-manager-test-bank',
  amount: 0.01,
  currency: 'EUR',
  price_quote: quoteBody.quote,
  return_url: 'https://www.realworldcerts.com/buy/success',
  cancel_url: 'https://www.realworldcerts.com/buy/cancel'
}));
const createBody = JSON.stringify({
  product_id: 'financial-risk-manager-test-bank',
  amount: 19,
  currency: 'USD',
  price_quote: quoteBody.quote,
  return_url: 'https://www.realworldcerts.com/buy/success',
  cancel_url: 'https://www.realworldcerts.com/buy/cancel'
});
const redirectMismatch = await call('/acp/v1/transactions', 'POST', JSON.stringify({
  product_id: 'financial-risk-manager-test-bank',
  amount: 19,
  currency: 'USD',
  price_quote: quoteBody.quote,
  return_url: 'https://evil.example/buy/success',
  cancel_url: 'https://evil.example/buy/cancel'
}));
const create = await call('/acp/v1/transactions', 'POST', createBody);
const replay = await call('/acp/v1/transactions', 'POST', createBody);
const capture = await call('/acp/v1/transactions/ORDER-TEST/capture', 'POST');
process.stdout.write(JSON.stringify({ buy, discovery, prices, quote, badOriginQuote, badPathQuote, missing, stale, redirectMismatch, create, replay, capture, order_create_calls: globalThis.__orderCreateCalls, order_bodies: globalThis.__orderBodies, order_headers: globalThis.__orderHeaders }) + '\n');
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
            OWNER_PAYPAL_EMAIL: 'owner@example.com',
            PRICE_QUOTE_SECRET: 'quote-test-secret',
            STOREFRONT_URL: 'https://www.realworldcerts.com',
            CHECKOUT_PRICE_ORIGIN_URL: '',
            PAYPAL_RETURN_URL: '',
            PAYPAL_CANCEL_URL: ''
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
    assert.match(probe.buy.body, /\/acp\/v1\/price-quote/);
    assert.match(probe.buy.body, /&return_url=/);
    assert.match(probe.buy.body, /&cancel_url=/);
    assert.match(probe.buy.body, /requestBody\.price_quote = quote\.quote/);
    assert.match(probe.buy.body, /quoteCache/);
});

test('checkout discovery and the public payload use the explicit price file', () => {
    const probe = result();
    const discovery = JSON.parse(probe.discovery.body);
    const product = discovery.products.find((row) => row.id === 'financial-risk-manager-test-bank');
    assert.equal(product.price, 19);
    assert.equal(product.currency, 'USD');
    assert.equal(JSON.parse(probe.prices.body).prices['financial-risk-manager-test-bank'], 19);
    assert.equal(discovery.endpoints.price_quote, '/acp/v1/price-quote?product_id=:id');
});

test('ACP issues a short-lived quote bound to the catalog price and version', () => {
    const probe = result();
    assert.equal(probe.quote.status, 200);
    const body = JSON.parse(probe.quote.body);
    assert.equal(body.ok, true);
    assert.equal(body.product_id, 'financial-risk-manager-test-bank');
    assert.deepEqual(body.amount, { value: '19.00', currency: 'USD' });
    assert.equal(body.key_id, 'primary');
    assert.equal(body.catalog_version, '1');
    assert.match(body.catalog_digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(body.return_url, 'https://www.realworldcerts.com/buy/success');
    assert.equal(body.cancel_url, 'https://www.realworldcerts.com/buy/cancel');
    assert.equal(typeof body.quote_id, 'string');
    assert.equal(typeof body.quote, 'string');
    assert.ok(Date.parse(body.expires_at) > Date.now());
});

test('ACP rejects checkout without a price quote before calling PayPal', () => {
    const probe = result();
    assert.equal(probe.missing.status, 400);
    const body = JSON.parse(probe.missing.body);
    assert.equal(body.code, 'PRICE_QUOTE_REQUIRED');
    assert.equal(probe.order_create_calls, 1, 'only the quoted checkout may call PayPal');
});

test('ACP rejects redirect URLs outside the allowed checkout origin or paths', () => {
    const probe = result();
    assert.equal(probe.badOriginQuote.status, 400);
    assert.equal(JSON.parse(probe.badOriginQuote.body).code, 'CHECKOUT_REDIRECT_INVALID');
    assert.match(JSON.parse(probe.badOriginQuote.body).error, /checkout_redirect_origin/);
    assert.equal(probe.badPathQuote.status, 400);
    assert.equal(JSON.parse(probe.badPathQuote.body).code, 'CHECKOUT_REDIRECT_INVALID');
    assert.match(JSON.parse(probe.badPathQuote.body).error, /checkout_redirect_path/);
    assert.equal(probe.order_create_calls, 1, 'rejected redirects never call PayPal');
});

test('ACP rejects a replayed quote with different redirect URLs', () => {
    const probe = result();
    assert.equal(probe.redirectMismatch.status, 409);
    const body = JSON.parse(probe.redirectMismatch.body);
    assert.equal(body.code, 'QUOTE_REDIRECT_MISMATCH');
    assert.equal(probe.order_create_calls, 1, 'the mismatched redirect never calls PayPal');
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
    const issued = JSON.parse(probe.quote.body);
    assert.equal(body.quote_id, issued.quote_id);
    assert.equal(body.catalog_version, '1');
    assert.equal(body.catalog_digest, issued.catalog_digest);
    const unit = probe.order_bodies[0].purchase_units[0];
    assert.match(unit.custom_id, /financial-risk-manager-test-bank\|q=q_/);
    assert.match(unit.custom_id, /\|v=1$/);
    assert.equal(unit.invoice_id, `q=${issued.quote_id}|d=${issued.catalog_digest}`);
});

test('replaying a quote returns the same PayPal order without creating another', () => {
    const probe = result();
    assert.equal(probe.create.status, 200);
    assert.equal(probe.replay.status, 200);
    assert.equal(probe.order_create_calls, 1);
    assert.equal(JSON.parse(probe.replay.body).transaction_id, JSON.parse(probe.create.body).transaction_id);
    assert.match(probe.order_headers[0]['PayPal-Request-Id'], /^acp_[a-f0-9]{32}$/);
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
