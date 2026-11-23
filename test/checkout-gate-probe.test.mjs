import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { probeCheckoutGate, resolveCheckoutGateUrl } from '../src/resilience/checkout-gate-probe.mjs';

async function withGate(response, t, status = 200) {
    const server = http.createServer((req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(response));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    return `http://127.0.0.1:${server.address().port}/health`;
}

test('the gate URL comes from the flag, then CHECKOUT_HEALTH_URL, then APP_ORIGIN', () => {
    assert.equal(resolveCheckoutGateUrl({ flag: 'https://flag/health', env: { CHECKOUT_HEALTH_URL: 'https://env/health' } }), 'https://flag/health');
    assert.equal(resolveCheckoutGateUrl({ env: { CHECKOUT_HEALTH_URL: 'https://env/health', APP_ORIGIN: 'https://origin' } }), 'https://env/health');
    assert.equal(resolveCheckoutGateUrl({ env: { APP_ORIGIN: 'https://origin/' } }), 'https://origin/health');
    assert.equal(resolveCheckoutGateUrl({ env: {} }), null);
});

test('a gate that reports itself blocked is read as blocked', async (t) => {
    const url = await withGate({
        config: {
            checkout_attempts: {
                blocks_checkout: true,
                block_reason: 'CHECKOUT_ATTEMPT_STORE_NOT_DURABLE',
                replay_protection: 'store'
            }
        }
    }, t);

    const gate = await probeCheckoutGate(url);
    assert.equal(gate.status, 200);
    assert.equal(gate.reported, true);
    assert.equal(gate.blocks, true);
    assert.equal(gate.block_reason, 'CHECKOUT_ATTEMPT_STORE_NOT_DURABLE');
    assert.equal(gate.error, null);
});

test('an open gate reports its replay protection', async (t) => {
    const url = await withGate({ config: { checkout_attempts: { blocks_checkout: false, replay_protection: 'provider' } } }, t);

    const gate = await probeCheckoutGate(url);
    assert.equal(gate.reported, true);
    assert.equal(gate.blocks, false);
    assert.equal(gate.replay_protection, 'provider');
});

test('money readiness is read from the same response', async (t) => {
    const url = await withGate({
        config: { checkout_attempts: { blocks_checkout: false } },
        money_readiness: {
            ok: false,
            can_take_paid_order: false,
            missing: ['PAYPAL_ENABLE_ORDER_CREATE', 'RESEND_API_KEY']
        }
    }, t);

    const gate = await probeCheckoutGate(url);
    assert.equal(gate.money.reported, true);
    assert.equal(gate.money.can_take_paid_order, false);
    assert.deepEqual(gate.money.missing, ['PAYPAL_ENABLE_ORDER_CREATE', 'RESEND_API_KEY']);
});

test('a ready deployment is not reported as unable to take a paid order', async (t) => {
    const url = await withGate({
        config: { checkout_attempts: { blocks_checkout: false } },
        money_readiness: { ok: true, can_take_paid_order: true, missing: [] }
    }, t);

    const gate = await probeCheckoutGate(url);
    assert.equal(gate.money.reported, true);
    assert.equal(gate.money.can_take_paid_order, true);
});

test('an older deployment without money readiness is unreported, not unready', async (t) => {
    const url = await withGate({ config: { checkout_attempts: { blocks_checkout: false } } }, t);
    const gate = await probeCheckoutGate(url);
    assert.equal(gate.money.reported, false);
    assert.equal(gate.money.can_take_paid_order, false);
});

test('a response without a gate verdict is unreported, never open', async (t) => {
    const staticPage = await withGate({ status: 'ok' }, t);
    const gate = await probeCheckoutGate(staticPage);
    assert.equal(gate.reported, false);
    assert.equal(gate.blocks, false);

    const missing = await withGate({ error: 'not found' }, t, 404);
    const notFound = await probeCheckoutGate(missing);
    assert.equal(notFound.reported, false);
    assert.equal(notFound.status, 404);
});

test('an unreadable gate carries the transport error', async () => {
    const gate = await probeCheckoutGate('https://checkout.example/health', {
        fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); }
    });
    assert.equal(gate.reported, false);
    assert.match(gate.error, /ENOTFOUND/);

    const invalid = await probeCheckoutGate('not a url');
    assert.equal(invalid.reported, false);
    assert.match(invalid.error, /invalid URL/);
});
