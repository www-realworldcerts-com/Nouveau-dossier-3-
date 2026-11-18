import assert from 'node:assert/strict';
import test from 'node:test';

import { checkoutAttemptKey, createCheckoutAttemptRegistry } from '../src/sales/checkout-attempts.mjs';

test('quote ids produce stable, distinct PayPal request ids', () => {
    const first = checkoutAttemptKey('q_first');
    assert.match(first, /^acp_[a-f0-9]{32}$/);
    assert.equal(checkoutAttemptKey('q_first'), first);
    assert.notEqual(checkoutAttemptKey('q_second'), first);
    assert.equal(checkoutAttemptKey(''), null);
});

test('replaying a quote returns the original order and creates only once', async () => {
    const registry = createCheckoutAttemptRegistry();
    let calls = 0;
    const create = async () => {
        calls += 1;
        return { id: 'ORDER-1', status: 'CREATED' };
    };

    const first = await registry.run('q_replay', create);
    const replay = await registry.run('q_replay', create);

    assert.equal(calls, 1);
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.order.id, 'ORDER-1');
    assert.equal(replay.key, first.key);
});

test('concurrent replays share one in-flight order creation', async () => {
    const registry = createCheckoutAttemptRegistry();
    let calls = 0;
    let finish;
    const pending = new Promise((resolve) => { finish = resolve; });
    const create = async () => {
        calls += 1;
        return pending;
    };

    const first = registry.run('q_concurrent', create);
    const second = registry.run('q_concurrent', create);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    finish({ id: 'ORDER-CONCURRENT' });

    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.order.id, 'ORDER-CONCURRENT');
    assert.equal(b.order.id, 'ORDER-CONCURRENT');
    assert.equal(b.replayed, true);
});

test('a failed attempt is released so a retry can create the order', async () => {
    const registry = createCheckoutAttemptRegistry();
    let calls = 0;
    const create = async () => {
        calls += 1;
        if (calls === 1) throw new Error('PAYPAL_NETWORK_FAILURE');
        return { id: 'ORDER-RETRY' };
    };

    await assert.rejects(registry.run('q_retry', create), /PAYPAL_NETWORK_FAILURE/);
    assert.equal(registry.size(), 0);

    const retry = await registry.run('q_retry', create);
    assert.equal(calls, 2);
    assert.equal(retry.replayed, false);
    assert.equal(retry.order.id, 'ORDER-RETRY');
});

test('different quotes create separate orders and expired attempts are pruned', async () => {
    let current = Date.parse('2026-11-17T12:00:00Z');
    const registry = createCheckoutAttemptRegistry({ ttlMs: 60_000, now: () => current });
    let calls = 0;
    const create = async () => ({ id: `ORDER-${++calls}` });

    const first = await registry.run('q_one', create, { expiresAt: new Date(current + 60_000).toISOString() });
    const second = await registry.run('q_two', create, { expiresAt: new Date(current + 60_000).toISOString() });
    assert.notEqual(first.order.id, second.order.id);
    assert.notEqual(first.key, second.key);
    assert.equal(calls, 2);

    current += 61_000;
    const afterExpiry = await registry.run('q_one', create);
    assert.equal(afterExpiry.replayed, false);
    assert.equal(calls, 3);
});
