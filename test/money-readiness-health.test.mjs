import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

/**
 * `/health` is the only place that knows the deployment's own environment, so
 * the audit reads money readiness from here. These tests run the real handler
 * in a child process (the serverless entry point) with the environment set to
 * the two states that matter: able to take a paid order, and not.
 */
const HEALTH_PROBE = String.raw`
import handler from './api/index.mjs';

function call(url) {
  return new Promise(resolve => {
    const req = {
      method: 'GET',
      url,
      headers: { host: 'localhost', 'user-agent': 'test', accept: '*/*' },
      socket: { remoteAddress: '127.0.0.1' }
    };
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(key, value) { this.headers[key] = value; },
      getHeader(key) { return this.headers[key]; },
      writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers || {}); return this; },
      end(body) { resolve({ status: this.statusCode, body: String(body) }); }
    };
    handler(req, res).catch(error => resolve({ status: 0, error: error.message }));
  });
}

const health = await call('/health');
process.stdout.write('RESULT ' + JSON.stringify(health) + '\n');
`;

const CONTROLLED = [
    'PRICE_QUOTE_SECRET',
    'PAYPAL_CLIENT_ID',
    'PAYPAL_CLIENT_SECRET',
    'PAYPAL_ENABLE_ORDER_CREATE',
    'FULFILLMENT_ACCESS_SECRET',
    'FULFILLMENT_ENABLED',
    'RESEND_API_KEY'
];

const READY = {
    PRICE_QUOTE_SECRET: 'fake-price-quote-secret',
    PAYPAL_CLIENT_ID: 'fake-client-id',
    PAYPAL_CLIENT_SECRET: 'fake-client-secret',
    PAYPAL_ENABLE_ORDER_CREATE: 'true',
    FULFILLMENT_ACCESS_SECRET: 'fake-fulfillment-secret',
    RESEND_API_KEY: 'fake-resend-key'
};

function health(overrides = {}) {
    const env = { ...process.env, PAYPAL_WEBHOOK_ID: 'WH-TEST-123', VERCEL: '1' };
    for (const name of CONTROLLED) delete env[name];
    Object.assign(env, overrides);
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', HEALTH_PROBE], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 30000,
        env
    });
    assert.equal(run.status, 0, run.stderr);
    const line = run.stdout.split('\n').find(row => row.startsWith('RESULT '));
    assert.ok(line, run.stdout);
    const response = JSON.parse(line.slice('RESULT '.length));
    assert.equal(response.status, 200, response.body);
    return JSON.parse(response.body);
}

test('a configured deployment reports it can take a paid order', () => {
    const body = health(READY);

    assert.equal(body.money_readiness.ok, true);
    assert.equal(body.money_readiness.can_take_paid_order, true);
    assert.equal(body.money_readiness.quote_key, true);
    assert.equal(body.money_readiness.order_create, true);
    assert.equal(body.money_readiness.capture, true);
    assert.equal(body.money_readiness.fulfillment, true);
    assert.equal(body.money_readiness.resend, true);
    assert.deepEqual(body.money_readiness.missing, []);
});

test('an unconfigured deployment reports it cannot, and names what is missing', () => {
    const body = health();

    assert.equal(body.money_readiness.ok, false);
    assert.equal(body.money_readiness.can_take_paid_order, false);
    assert.equal(body.money_readiness.quote_key, false);
    assert.equal(body.money_readiness.order_create, false);
    assert.equal(body.money_readiness.capture, false);
    assert.equal(body.money_readiness.fulfillment, false);
    assert.equal(body.money_readiness.resend, false);
    assert.deepEqual(body.money_readiness.missing, [
        'PRICE_QUOTE_SECRET',
        'PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET',
        'PAYPAL_ENABLE_ORDER_CREATE',
        'FULFILLMENT_ACCESS_SECRET',
        'RESEND_API_KEY'
    ]);
});

test('credentials without the order-create switch are still not ready', () => {
    const body = health({ ...READY, PAYPAL_ENABLE_ORDER_CREATE: 'false' });

    assert.equal(body.money_readiness.can_take_paid_order, false);
    assert.equal(body.money_readiness.order_create, false);
    assert.equal(body.money_readiness.capture, false, 'capture shares the switch, so it cannot be taken either');
    assert.deepEqual(body.money_readiness.missing, ['PAYPAL_ENABLE_ORDER_CREATE']);
});

test('fulfillment switched off is not ready even with every credential set', () => {
    const body = health({ ...READY, FULFILLMENT_ENABLED: 'false' });

    assert.equal(body.money_readiness.can_take_paid_order, false);
    assert.equal(body.money_readiness.fulfillment, false);
    assert.ok(body.money_readiness.missing.includes('FULFILLMENT_ENABLED'));
});
