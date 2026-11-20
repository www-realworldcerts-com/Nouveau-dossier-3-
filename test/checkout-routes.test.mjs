import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const probe = String.raw`
import handler from './api/index.mjs';
import fs from 'node:fs/promises';
import { checkoutAttemptKey } from './src/sales/checkout-attempts.mjs';
import { encodePayPalCustomId, encodePayPalInvoiceId } from './src/sales/price-quote.mjs';

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
  if (target.includes('/v2/checkout/orders/ORDER-NEW/capture')) {
    return new Response(JSON.stringify({
      id: 'ORDER-NEW',
      status: 'COMPLETED',
      purchase_units: [{
        custom_id: encodePayPalCustomId({
          productId: 'financial-risk-manager-test-bank',
          quoteId: quoteBody.quote_id,
          catalogVersion: quoteBody.catalog_version
        }),
        invoice_id: encodePayPalInvoiceId({
          quoteId: quoteBody.quote_id,
          catalogDigest: quoteBody.catalog_digest
        }),
        amount: { value: '19.00', currency_code: 'USD' },
        payments: {
          captures: [{
            id: 'CAP-NEW',
            status: 'COMPLETED',
            final_capture: true,
            amount: { value: '19.00', currency_code: 'USD' }
          }]
        }
      }]
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
const orderCallsAfterReplay = globalThis.__orderCreateCalls;

// A second quote for the same cart belongs to a different customer just as
// easily as to a reload, so it is its own attempt and must not replay the order
// and approval link the first quote created.
const dupQuote = await call('/acp/v1/price-quote?product_id=financial-risk-manager-test-bank&return_url=' + encodeURIComponent('https://www.realworldcerts.com/buy/success') + '&cancel_url=' + encodeURIComponent('https://www.realworldcerts.com/buy/cancel'));
const dupQuoteBody = JSON.parse(dupQuote.body);
const duplicate = await call('/acp/v1/transactions', 'POST', JSON.stringify({
  product_id: 'financial-risk-manager-test-bank',
  amount: 19,
  currency: 'USD',
  price_quote: dupQuoteBody.quote,
  return_url: 'https://www.realworldcerts.com/buy/success',
  cancel_url: 'https://www.realworldcerts.com/buy/cancel'
}));
const duplicateOrderCalls = globalThis.__orderCreateCalls;
const capture = await call('/acp/v1/transactions/ORDER-TEST/capture', 'POST');
// ORDER-NEW was created from a signed quote, so its capture can be compared
// with the quote facts stored in the attempt record for that quote.
const captureCreated = await call('/acp/v1/transactions/ORDER-NEW/capture', 'POST');
const orderCallsBeforeBusy = globalThis.__orderCreateCalls;

// Another instance holds the claim for a different cart: the store directory
// has its lock file but no published order yet. A different course keeps this
// independent from the cart already ordered above.
const busyProduct = 'certified-blockchain-expert-cbe-preptest-2025';
const busyQuote = await call('/acp/v1/price-quote?product_id=' + busyProduct + '&return_url=' + encodeURIComponent('https://www.realworldcerts.com/buy/success') + '&cancel_url=' + encodeURIComponent('https://www.realworldcerts.com/buy/cancel'));
const busyQuoteBody = JSON.parse(busyQuote.body);
const busyLock = process.env.CHECKOUT_ATTEMPT_STORE_DIR + '/' + checkoutAttemptKey(busyQuoteBody.quote_id) + '.lock';
await fs.mkdir(process.env.CHECKOUT_ATTEMPT_STORE_DIR, { recursive: true });
await fs.writeFile(busyLock, '424242');
const busyBody = JSON.stringify({
  product_id: busyProduct,
  amount: 19,
  currency: 'USD',
  price_quote: busyQuoteBody.quote,
  return_url: 'https://www.realworldcerts.com/buy/success',
  cancel_url: 'https://www.realworldcerts.com/buy/cancel'
});
const busy = await call('/acp/v1/transactions', 'POST', busyBody);
const busyOrderCalls = globalThis.__orderCreateCalls;
await fs.unlink(busyLock);
const busyRetry = await call('/acp/v1/transactions', 'POST', busyBody);

process.stdout.write(JSON.stringify({ buy, discovery, prices, quote, badOriginQuote, badPathQuote, missing, stale, redirectMismatch, create, replay, duplicate, dup_quote_id: dupQuoteBody.quote_id, duplicate_order_calls: duplicateOrderCalls, order_calls_after_replay: orderCallsAfterReplay, capture, capture_created: captureCreated, busy, busy_quote_id: busyQuoteBody.quote_id, busy_order_calls: busyOrderCalls, busy_retry: busyRetry, busy_retry_order_calls: globalThis.__orderCreateCalls, order_create_calls: orderCallsBeforeBusy, order_bodies: globalThis.__orderBodies, order_headers: globalThis.__orderHeaders }) + '\n');
`;

const rateLimitProbe = String.raw`
import handler from './api/index.mjs';

globalThis.__orderCreateCalls = 0;
globalThis.fetch = async (url) => {
  if (String(url).includes('/v2/checkout/orders')) {
    globalThis.__orderCreateCalls += 1;
    return new Response(JSON.stringify({ id: 'ORDER-RATE', status: 'CREATED', links: [] }), {
      status: 201,
      headers: { 'content-type': 'application/json' }
    });
  }
  throw new Error('unexpected fetch: ' + url);
};

function call(body, clientIp) {
  return new Promise((resolve) => {
    const req = {
      method: 'POST',
      url: '/acp/v1/transactions',
      headers: { host: 'localhost', 'x-forwarded-for': clientIp, 'user-agent': 'test' },
      socket: { remoteAddress: '10.0.0.7' },
      readableEnded: true,
      rawBody: body
    };
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(key, value) { this.headers[key] = value; },
      getHeader(key) { return this.headers[key]; },
      writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers || {}); return this; },
      end(payload) { resolve({ status: this.statusCode, headers: this.headers, body: String(payload) }); }
    };
    handler(req, res).catch((error) => resolve({ status: 0, error: error.message }));
  });
}

// These attempts carry no price quote, so they fail before PayPal is called, and
// they still count against the client: an endless loop is cut off either way.
const body = JSON.stringify({ product_id: 'financial-risk-manager-test-bank', amount: 19, currency: 'USD' });
const first = await call(body, '203.0.113.9');
const second = await call(body, '203.0.113.9');
const limited = await call(body, '203.0.113.9');
// A buyer on another address keeps a bucket of their own.
const other = await call(body, '203.0.113.10');

process.stdout.write(JSON.stringify({ first, second, limited, other, order_create_calls: globalThis.__orderCreateCalls }) + '\n');
`;

function runProbe(script = probe, envOverrides = {}) {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-routes-'));
    try {
        return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: process.cwd(),
            encoding: 'utf8',
            timeout: 30000,
            env: {
                ...process.env,
                CHECKOUT_ATTEMPT_STORE_DIR: store,
                CHECKOUT_ATTEMPT_CLAIM_TIMEOUT_MS: '250',
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
                PAYPAL_CANCEL_URL: '',
                ...envOverrides
            }
        });
    } finally {
        fs.rmSync(store, { recursive: true, force: true });
    }
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
    assert.equal(probe.order_calls_after_replay, 1, 'only the quoted checkout may call PayPal');
});

test('ACP rejects redirect URLs outside the allowed checkout origin or paths', () => {
    const probe = result();
    assert.equal(probe.badOriginQuote.status, 400);
    assert.equal(JSON.parse(probe.badOriginQuote.body).code, 'CHECKOUT_REDIRECT_INVALID');
    assert.match(JSON.parse(probe.badOriginQuote.body).error, /checkout_redirect_origin/);
    assert.equal(probe.badPathQuote.status, 400);
    assert.equal(JSON.parse(probe.badPathQuote.body).code, 'CHECKOUT_REDIRECT_INVALID');
    assert.match(JSON.parse(probe.badPathQuote.body).error, /checkout_redirect_path/);
    assert.equal(probe.order_calls_after_replay, 1, 'rejected redirects never call PayPal');
});

test('ACP rejects a replayed quote with different redirect URLs', () => {
    const probe = result();
    assert.equal(probe.redirectMismatch.status, 409);
    const body = JSON.parse(probe.redirectMismatch.body);
    assert.equal(body.code, 'QUOTE_REDIRECT_MISMATCH');
    assert.equal(probe.order_calls_after_replay, 1, 'the mismatched redirect never calls PayPal');
});

test('ACP checkout rejects a stale displayed amount before creating a PayPal order', () => {
    const probe = result();
    assert.equal(probe.stale.status, 409);
    const body = JSON.parse(probe.stale.body);
    assert.equal(body.ok, false);
    assert.equal(body.code, 'PRICE_CHANGED');
    assert.deepEqual(body.expected, { value: '19.00', currency: 'USD' });
    assert.deepEqual(body.submitted, { value: '0.01', currency: 'EUR' });
    assert.equal(probe.order_calls_after_replay, 1, 'only the matching checkout may call PayPal');
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
    assert.equal(probe.order_calls_after_replay, 1);
    assert.equal(JSON.parse(probe.replay.body).transaction_id, JSON.parse(probe.create.body).transaction_id);
    assert.match(probe.order_headers[0]['PayPal-Request-Id'], /^acp_[a-f0-9]{32}$/);
});

test('a client over the checkout rate limit gets a retryable 429 without reaching PayPal', () => {
    const run = runProbe(rateLimitProbe, {
        CHECKOUT_RATE_LIMIT_MAX: '2',
        CHECKOUT_RATE_LIMIT_WINDOW_MS: '60000'
    });
    assert.equal(run.status, 0, run.stderr);
    const limited = JSON.parse(run.stdout.trim().split('\n').at(-1));

    assert.equal(limited.first.status, 400, 'the first two attempts are still served');
    assert.equal(limited.second.status, 400);
    assert.equal(limited.limited.status, 429);
    const body = JSON.parse(limited.limited.body);
    assert.equal(body.ok, false);
    assert.equal(body.code, 'CHECKOUT_RATE_LIMITED');
    assert.equal(body.retryable, true);
    assert.ok(body.retry_after_ms > 0, 'the client is told when to retry');
    assert.match(limited.limited.headers['Retry-After'], /^[0-9]+$/);
    assert.equal(limited.order_create_calls, 0, 'a limited client never creates a PayPal order');
    assert.equal(limited.other.status, 400, 'another address keeps its own allowance');
});

test('the default allowance does not block normal checkout traffic from one address', () => {
    const probe = result();
    for (const response of [probe.missing, probe.stale, probe.create, probe.replay, probe.duplicate]) {
        assert.notEqual(response.status, 429, 'shared-NAT buyers are not rate limited by default');
    }
});

test('a second quote for the same cart is a separate attempt, not a replay', () => {
    const probe = result();
    assert.equal(probe.duplicate.status, 200);
    const body = JSON.parse(probe.duplicate.body);
    assert.equal(body.ok, true);
    assert.notEqual(probe.dup_quote_id, JSON.parse(probe.quote.body).quote_id, 'the two quotes are distinct');
    assert.equal(
        probe.duplicate_order_calls,
        probe.order_calls_after_replay + 1,
        'the second buyer gets an order of their own, not the first buyer\'s approval link'
    );
});

test('a checkout whose order another instance is still creating returns a retryable conflict', () => {
    const probe = result();
    assert.equal(probe.busy.status, 409, 'an in-flight creation is a conflict, not a server error');
    const body = JSON.parse(probe.busy.body);
    assert.equal(body.ok, false);
    assert.equal(body.code, 'CHECKOUT_IN_PROGRESS');
    assert.equal(body.retryable, true);
    assert.equal(body.quote_id, probe.busy_quote_id);
    assert.equal(body.error, 'Another checkout is already creating this order for this quote. Retry the same request shortly.');
    assert.match(probe.busy.headers['Retry-After'], /^[0-9]+$/);
    assert.equal(probe.busy_order_calls, probe.order_calls_after_replay + 1, 'the conflict never creates another order');
});

test('retrying after the competing creator releases the claim creates the order', () => {
    const probe = result();
    assert.equal(probe.busy_retry.status, 200);
    assert.equal(JSON.parse(probe.busy_retry.body).transaction_id, 'ORDER-NEW');
    assert.equal(probe.busy_retry_order_calls, probe.busy_order_calls + 1, 'the retry creates exactly one order');
});

function pageElement() {
    return {
        innerHTML: '',
        textContent: '',
        value: '',
        disabled: false,
        style: {},
        children: [],
        appendChild(child) { this.children.push(child); },
        addEventListener(type, listener) { this.listeners = { ...(this.listeners || {}), [type]: listener }; }
    };
}

async function waitFor(check, label) {
    for (let i = 0; i < 400; i += 1) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${label}`);
}

// Runs the /buy page script as served, so the retry path is exercised the way a
// browser would run it, not by pattern-matching the HTML.
test('the checkout page keeps its quote and retries a retryable in-progress conflict', async () => {
    const html = result().buy.body;
    const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
    assert.match(script, /CHECKOUT_IN_PROGRESS/, 'the page must recognise the retryable conflict');

    const elements = {};
    for (const id of ['product', 'pay', 'error', 'checkout']) elements[id] = pageElement();
    const document = { getElementById: (id) => elements[id], createElement: () => pageElement() };
    const location = { search: '?product_id=course-one', origin: 'https://store.example', href: 'https://store.example/buy' };

    const quoteCalls = [];
    const posts = [];
    const fetch = async (url, init = {}) => {
        const target = String(url);
        if (target.startsWith('/acp/v1/discovery')) {
            return {
                status: 200,
                json: async () => ({ products: [{ id: 'course-one', name: 'Course One', price: 19, currency: 'USD' }] })
            };
        }
        if (target.startsWith('/acp/v1/price-quote')) {
            quoteCalls.push(target);
            return {
                status: 200,
                json: async () => ({ ok: true, quote: 'QUOTE-ONE', expires_at: new Date(Date.now() + 600000).toISOString() })
            };
        }
        if (target === '/acp/v1/transactions') {
            posts.push({ at: Date.now(), body: JSON.parse(init.body) });
            if (posts.length === 1) {
                return {
                    status: 409,
                    json: async () => ({
                        ok: false,
                        code: 'CHECKOUT_IN_PROGRESS',
                        retryable: true,
                        retry_after_ms: 40,
                        error: 'Another checkout is already creating this order for this quote. Retry the same request shortly.'
                    })
                };
            }
            return {
                status: 200,
                json: async () => ({ ok: true, payment_instructions: { approval_url: 'https://www.paypal.com/approve' } })
            };
        }
        throw new Error('unexpected fetch: ' + target);
    };

    vm.runInNewContext(script, { document, location, fetch, URLSearchParams, setTimeout, clearTimeout });
    await waitFor(() => elements.product.value === 'course-one', 'course discovery');
    elements.checkout.listeners.submit({ preventDefault() {} });
    await waitFor(() => location.href.includes('paypal.com/approve') || elements.error.textContent, 'checkout result');

    assert.equal(posts.length, 2, 'the conflict is retried once');
    assert.deepEqual(posts[1].body, posts[0].body, 'the retry sends the identical request');
    assert.equal(posts[1].body.price_quote, 'QUOTE-ONE', 'the retry keeps the same signed quote');
    assert.equal(quoteCalls.length, 1, 'the page never re-quotes the buyer mid-conflict');
    assert.ok(posts[1].at - posts[0].at >= 30, 'the retry waits for retry_after_ms');
    assert.equal(location.href, 'https://www.paypal.com/approve');
    assert.equal(elements.error.textContent, '');
});

test('a capture of an order created from a quote is reconciled against its signed quote', () => {
    const probe = result();
    assert.equal(probe.capture_created.status, 200);
    const body = JSON.parse(probe.capture_created.body);
    const reconciliation = body.reconciliation;

    assert.equal(reconciliation.status, 'ok', JSON.stringify(reconciliation));
    assert.equal(reconciliation.quote_id, JSON.parse(probe.quote.body).quote_id);
    assert.equal(reconciliation.captured.value_cents, 1900);
    assert.equal(reconciliation.captured.currency, 'USD');
    assert.equal(reconciliation.quoted.value_cents, 1900);
    assert.equal(reconciliation.quoted.catalog_digest, JSON.parse(probe.quote.body).catalog_digest);
    assert.equal(reconciliation.delta_cents, 0);
    assert.equal(reconciliation.catalog_revision, 'ok');
});

test('a capture without quote metadata reports reconciliation as unchecked', () => {
    const probe = result();
    const body = JSON.parse(probe.capture.body);
    assert.equal(body.reconciliation.status, 'unchecked');
    assert.equal(body.reconciliation.reason, 'quote_reference_missing');
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
