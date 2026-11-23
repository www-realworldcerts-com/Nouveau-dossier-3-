import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

/**
 * The whole paid-order path, end to end, with no secrets and no live money:
 * quote -> PayPal order create -> capture -> access email -> access link.
 *
 * PayPal and Resend are real HTTP servers on loopback (`scripts/lib/http-stub.mjs`)
 * and the credentials are fake. The probe also fails if anything tries to fetch
 * a host that is not the stub, so a regression that reaches the real PayPal or
 * sends real mail is a test failure rather than a charge.
 */
const STUB_HREF = pathToFileURL(path.join(process.cwd(), 'scripts', 'lib', 'http-stub.mjs')).href;
const PRODUCT_ID = 'financial-risk-manager-test-bank';
const BUYER_EMAIL = 'buyer@example.com';

const probe = String.raw`
import fs from 'node:fs';
import { startStub } from '${STUB_HREF}';

let orderBody = null;
const hits = [];
const stub = await startStub((hit) => {
  hits.push({ method: hit.method, url: hit.url });
  if (hit.url === '/v1/oauth2/token') {
    return { status: 200, body: { access_token: 'stub-access-token', expires_in: 3600 } };
  }
  if (hit.url === '/v2/checkout/orders' && hit.method === 'POST') {
    orderBody = JSON.parse(hit.body || '{}');
    return {
      status: 201,
      body: {
        id: 'ORDER-E2E',
        status: 'CREATED',
        links: [{ rel: 'approve', href: 'https://www.paypal.com/checkoutnow?token=ORDER-E2E' }]
      }
    };
  }
  if (hit.url === '/v2/checkout/orders/ORDER-E2E/capture' && hit.method === 'POST') {
    const unit = orderBody?.purchase_units?.[0] ?? {};
    return {
      status: 201,
      body: {
        id: 'ORDER-E2E',
        status: 'COMPLETED',
        payer: { email_address: '${BUYER_EMAIL}' },
        purchase_units: [{
          ...unit,
          payments: {
            captures: [{
              id: 'CAP-E2E',
              status: 'COMPLETED',
              final_capture: true,
              amount: unit.amount
            }]
          }
        }]
      }
    };
  }
  if (hit.url === '/emails' && hit.method === 'POST') {
    return { status: 200, body: { id: 'email-e2e-1' } };
  }
  return null;
});

// Loaded only after the base URLs exist: paypal-api captures its base URL at
// import time.
process.env.PAYPAL_API_BASE_URL = stub.url;
process.env.RESEND_API_BASE_URL = stub.url;

const external = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = String(typeof input === 'string' ? input : input?.url ?? input);
  if (!url.startsWith('http://127.0.0.1:')) external.push(url);
  return realFetch(input, init);
};

const handler = (await import('./api/index.mjs')).default;

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
      setHeader(key, value) { this.headers[key] = value; return this; },
      getHeader(key) { return this.headers[key]; },
      writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers || {}); return this; },
      end(payload) { resolve({ status: this.statusCode, headers: this.headers, body: String(payload) }); }
    };
    handler(req, res).catch((error) => resolve({ status: 0, error: error.message }));
  });
}

const redirect = 'return_url=' + encodeURIComponent('https://www.realworldcerts.com/buy/success')
  + '&cancel_url=' + encodeURIComponent('https://www.realworldcerts.com/buy/cancel');
const quote = await call('/acp/v1/price-quote?product_id=${PRODUCT_ID}&' + redirect);
const quoteBody = JSON.parse(quote.body);
const create = await call('/acp/v1/transactions', 'POST', JSON.stringify({
  product_id: '${PRODUCT_ID}',
  amount: 19,
  currency: 'USD',
  price_quote: quoteBody.quote,
  return_url: 'https://www.realworldcerts.com/buy/success',
  cancel_url: 'https://www.realworldcerts.com/buy/cancel'
}));
const capture = await call('/acp/v1/transactions/ORDER-E2E/capture', 'POST');

const emailHit = stub.hits.find((hit) => hit.url === '/emails');
const emailBody = emailHit ? JSON.parse(emailHit.body) : null;
const passHtml = emailBody?.attachments?.[0]?.content
  ? Buffer.from(emailBody.attachments[0].content, 'base64').toString('utf8')
  : '';
const tokenMatch = (passHtml + '\n' + String(emailBody?.text ?? '') + '\n' + String(emailBody?.html ?? ''))
  .match(/\/access\/([A-Za-z0-9._~%=-]+)/);
const accessToken = tokenMatch ? decodeURIComponent(tokenMatch[1]) : null;
const access = accessToken ? await call('/access/' + encodeURIComponent(accessToken)) : null;
const tampered = accessToken ? await call('/access/' + encodeURIComponent(accessToken.slice(0, -2) + 'xy')) : null;

const queue = process.env.FULFILLMENT_QUEUE_FILE;
const queued = queue && fs.existsSync(queue)
  ? fs.readFileSync(queue, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  : [];

process.stdout.write(JSON.stringify({
  quote, create, capture, access, tampered,
  quote_body: quoteBody,
  order_body: orderBody,
  email: emailBody,
  email_authorization: emailHit ? emailHit.headers.authorization : null,
  pass_html: passHtml,
  access_token: accessToken,
  hits,
  external,
  queued
}) + '\n');
process.exit(0);
`;

function runProbe() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-e2e-'));
    try {
        const run = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
            cwd: process.cwd(),
            encoding: 'utf8',
            timeout: 60000,
            env: {
                ...process.env,
                CHECKOUT_ATTEMPT_STORE_DIR: dir,
                CHECKOUT_INTENTS_FILE: path.join(dir, 'course-intents.ndjson'),
                SETTLEMENT_LEDGER_PATH: path.join(dir, 'settlement_ledger.json'),
                FULFILLMENT_QUEUE_FILE: path.join(dir, 'fulfillment_queue.log'),
                // Fake credentials, deliberately of the right shape for the guards.
                PAYPAL_CLIENT_ID: 'fake-client-id',
                PAYPAL_CLIENT_SECRET: 'fake-client-secret',
                PAYPAL_ENABLE_ORDER_CREATE: 'true',
                PAYPAL_MODE: 'live',
                SWARM_LIVE: 'true',
                NO_PLATFORM_WALLET: 'true',
                OWNER_PAYPAL_EMAIL: 'younestsouli2019@gmail.com',
                PRICE_QUOTE_SECRET: 'fake-price-quote-secret',
                FULFILLMENT_ACCESS_SECRET: 'fake-fulfillment-access-secret',
                FULFILLMENT_ACCESS_LINK_ENABLED: 'true',
                RESEND_API_KEY: 'fake-resend-api-key',
                FULFILLMENT_FROM_EMAIL: 'billing@realworldcerts.com',
                FULFILLMENT_COST_CENTS: '0',
                APP_ORIGIN: 'https://www.realworldcerts.com',
                STOREFRONT_URL: 'https://www.realworldcerts.com',
                CHECKOUT_PRICE_ORIGIN_URL: '',
                PAYPAL_RETURN_URL: '',
                PAYPAL_CANCEL_URL: '',
                PAYPAL_WEBHOOK_ID: 'WH-TEST',
                VERCEL: ''
            }
        });
        assert.equal(run.status, 0, run.stderr);
        return JSON.parse(run.stdout.trim().split('\n').at(-1));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// One probe run serves every assertion: the flow is a single customer journey,
// and re-running it would only re-test the same stub.
const result = runProbe();

test('the quote is signed for the catalog price', () => {
    assert.equal(result.quote.status, 200, result.quote.body);
    assert.equal(result.quote_body.ok, true);
    assert.deepEqual(result.quote_body.amount, { value: '19.00', currency: 'USD' });
    assert.equal(result.quote_body.key_id, 'primary');
    assert.match(result.quote_body.catalog_digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(typeof result.quote_body.quote, 'string');
});

test('the order is created from the signed quote with the quoted amount', () => {
    assert.equal(result.create.status, 200, result.create.body);
    const created = JSON.parse(result.create.body);
    assert.equal(created.transaction_id, 'ORDER-E2E');
    assert.equal(created.payment_instructions.approval_url, 'https://www.paypal.com/checkoutnow?token=ORDER-E2E');
    assert.deepEqual(created.amount, { value: '19.00', currency: 'USD' });
    assert.equal(created.quote_id, result.quote_body.quote_id);

    const unit = result.order_body.purchase_units[0];
    assert.equal(unit.amount.value, '19.00');
    assert.equal(unit.amount.currency_code, 'USD');
    assert.match(unit.custom_id, new RegExp(PRODUCT_ID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(unit.invoice_id, new RegExp('q=' + result.quote_body.quote_id));
});

test('the capture is completed and reconciled against the quoted facts', () => {
    assert.equal(result.capture.status, 200, result.capture.body);
    const captured = JSON.parse(result.capture.body);
    assert.equal(captured.status, 'COMPLETED');
    assert.deepEqual(captured.amount, { value: '19.00', currency: 'USD' });
    assert.equal(captured.quote_id, result.quote_body.quote_id);
    assert.equal(captured.captures[0].id, 'CAP-E2E');
    assert.equal(captured.captures[0].status, 'COMPLETED');
    assert.equal(captured.fulfillment.ok, true);
    assert.equal(captured.fulfillment.delivery, 'emailed');
});

test('the buyer receives one access email with a pass that unlocks the course', () => {
    assert.ok(result.email, 'the stub received no email');
    assert.equal(result.email_authorization, 'Bearer fake-resend-api-key');
    assert.deepEqual(result.email.to, [BUYER_EMAIL]);
    assert.match(result.email.subject, /access pass/i);
    assert.equal(result.email.attachments.length, 1);
    assert.match(result.email.attachments[0].filename, /\.html$/);
    assert.match(result.pass_html, /ORDER-E2E/);

    assert.ok(result.access_token, 'the pass carries no access link');
    assert.equal(result.access.status, 200);
    assert.match(result.access.headers['Content-Type'], /text\/html/);
    assert.doesNotMatch(result.access.body, /Access link unavailable/);
    assert.equal(result.tampered.status, 401, 'a tampered token must not unlock anything');
});

test('delivery is recorded for reconciliation', () => {
    const delivered = result.queued.filter((entry) => entry.order_id === 'ORDER-E2E');
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].status, 'DELIVERED');
    assert.equal(delivered[0].customer_email, BUYER_EMAIL);
    assert.equal(delivered[0].capture_id, 'CAP-E2E');
    assert.equal(delivered[0].email.ok, true);
});

test('every network call went to the loopback stubs, in order, and nothing else', () => {
    assert.deepEqual(result.external, [], 'a call escaped to a non-loopback host');
    assert.deepEqual(result.hits.map((hit) => `${hit.method} ${hit.url}`), [
        'POST /v1/oauth2/token',
        'POST /v2/checkout/orders',
        'POST /v2/checkout/orders/ORDER-E2E/capture',
        'POST /emails'
    ]);
});
