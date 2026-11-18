import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkoutAttemptKey, createCheckoutAttemptRegistry } from '../src/sales/checkout-attempts.mjs';

async function tempStore() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'checkout-attempts-'));
    return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

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

test('a durable attempt survives a restart and replays the stored order', async (t) => {
    const { dir, cleanup } = await tempStore();
    t.after(cleanup);

    const first = createCheckoutAttemptRegistry({ directory: dir });
    assert.equal(first.durable, true);
    const created = await first.run('q_restart', async () => ({ id: 'ORDER-RESTART', status: 'CREATED' }));
    assert.equal(created.replayed, false);

    // A fresh registry shares no memory with the first one: this is the state a
    // restarted process starts from.
    const restarted = createCheckoutAttemptRegistry({ directory: dir });
    let calls = 0;
    const replay = await restarted.run('q_restart', async () => {
        calls += 1;
        return { id: 'ORDER-DUPLICATE' };
    });

    assert.equal(calls, 0, 'the restarted registry does not create a second order');
    assert.equal(replay.replayed, true);
    assert.equal(replay.order.id, 'ORDER-RESTART');
    assert.equal(replay.key, created.key);
    assert.equal(restarted.size(), 1);
});

test('an order created by another process is replayed after a real restart', async (t) => {
    const { dir, cleanup } = await tempStore();
    t.after(cleanup);

    const moduleUrl = new URL('../src/sales/checkout-attempts.mjs', import.meta.url).href;
    const script = `
        import { createCheckoutAttemptRegistry } from ${JSON.stringify(moduleUrl)};
        const registry = createCheckoutAttemptRegistry({ directory: process.env.STORE_DIR });
        const result = await registry.run('q_process', async () => ({ id: 'ORDER-PROCESS', status: 'CREATED' }));
        process.stdout.write(JSON.stringify(result));
    `;
    const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        env: { ...process.env, STORE_DIR: dir },
        encoding: 'utf8'
    });
    const child = JSON.parse(output);
    assert.equal(child.replayed, false);
    assert.equal(child.order.id, 'ORDER-PROCESS');

    const registry = createCheckoutAttemptRegistry({ directory: dir });
    let calls = 0;
    const replay = await registry.run('q_process', async () => {
        calls += 1;
        return { id: 'ORDER-NEW' };
    });

    assert.equal(calls, 0);
    assert.equal(replay.replayed, true);
    assert.equal(replay.order.id, 'ORDER-PROCESS');
});

test('a second instance replays an order another instance created', async (t) => {
    const { dir, cleanup } = await tempStore();
    t.after(cleanup);

    const firstInstance = createCheckoutAttemptRegistry({ directory: dir });
    const secondInstance = createCheckoutAttemptRegistry({ directory: dir });

    const created = await firstInstance.run('q_instances', async () => ({ id: 'ORDER-FIRST' }));
    assert.equal(created.replayed, false);

    let calls = 0;
    const replay = await secondInstance.run('q_instances', async () => {
        calls += 1;
        return { id: 'ORDER-SECOND' };
    });

    assert.equal(calls, 0);
    assert.equal(replay.replayed, true);
    assert.equal(replay.order.id, 'ORDER-FIRST');
});

test('concurrent instances create one order for the same quote', async (t) => {
    const { dir, cleanup } = await tempStore();
    t.after(cleanup);

    const firstInstance = createCheckoutAttemptRegistry({ directory: dir });
    const secondInstance = createCheckoutAttemptRegistry({ directory: dir });
    let calls = 0;
    const create = async () => {
        calls += 1;
        await sleep(40);
        return { id: 'ORDER-SHARED' };
    };

    const [a, b] = await Promise.all([
        firstInstance.run('q_shared', create),
        secondInstance.run('q_shared', create)
    ]);

    assert.equal(calls, 1);
    assert.deepEqual([a.replayed, b.replayed].sort(), [false, true]);
    assert.equal(a.order.id, 'ORDER-SHARED');
    assert.equal(b.order.id, 'ORDER-SHARED');
    assert.equal(firstInstance.size(), 1);
});

test('a claim left behind by a crashed creator is recovered after the stale window', async (t) => {
    const { dir, cleanup } = await tempStore();
    t.after(cleanup);

    // A creator that died mid-create leaves its claim file behind with an old
    // mtime and no order record. Without takeover every retry of this quote
    // would fail as in progress for the attempt's whole lifetime.
    const key = checkoutAttemptKey('q_crashed');
    const claimPath = path.join(dir, `${key}.lock`);
    await fs.writeFile(claimPath, '999999', 'utf8');
    const longAgo = new Date(Date.now() - 10 * 60_000);
    await fs.utimes(claimPath, longAgo, longAgo);

    const registry = createCheckoutAttemptRegistry({
        directory: dir,
        claimStaleMs: 60_000,
        claimTimeoutMs: 2_000,
        pollIntervalMs: 5
    });
    let calls = 0;
    const recovered = await registry.run('q_crashed', async () => {
        calls += 1;
        return { id: 'ORDER-RECOVERED' };
    });

    assert.equal(calls, 1, 'the stale claim is taken over and the order is created once');
    assert.equal(recovered.replayed, false);
    assert.equal(recovered.order.id, 'ORDER-RECOVERED');
    await assert.rejects(fs.access(claimPath), { code: 'ENOENT' }, 'the recovered claim is released');

    let replays = 0;
    const replay = await registry.run('q_crashed', async () => {
        replays += 1;
        return { id: 'ORDER-DUPLICATE' };
    });
    assert.equal(replays, 0);
    assert.equal(replay.replayed, true);
    assert.equal(replay.order.id, 'ORDER-RECOVERED');
});

test('a live claim inside the stale window is not stolen', async (t) => {
    const { dir, cleanup } = await tempStore();
    t.after(cleanup);

    const key = checkoutAttemptKey('q_live');
    const claimPath = path.join(dir, `${key}.lock`);
    await fs.writeFile(claimPath, String(process.pid), 'utf8');

    const registry = createCheckoutAttemptRegistry({
        directory: dir,
        claimStaleMs: 60_000,
        claimTimeoutMs: 120,
        pollIntervalMs: 5
    });
    let calls = 0;

    await assert.rejects(
        registry.run('q_live', async () => {
            calls += 1;
            return { id: 'ORDER-INTERLEAVED' };
        }),
        {
            name: 'CheckoutAttemptInProgressError',
            code: 'CHECKOUT_ATTEMPT_IN_PROGRESS',
            retryable: true
        }
    );

    assert.equal(calls, 0, 'a claim that may still be live must block a second creation');
    await fs.access(claimPath);
});

test('a failed durable creation releases the claim for a retry', async (t) => {
    const { dir, cleanup } = await tempStore();
    t.after(cleanup);

    const registry = createCheckoutAttemptRegistry({ directory: dir });
    let calls = 0;
    const create = async () => {
        calls += 1;
        if (calls === 1) throw new Error('PAYPAL_NETWORK_FAILURE');
        return { id: 'ORDER-RETRY' };
    };

    await assert.rejects(registry.run('q_retry', create), /PAYPAL_NETWORK_FAILURE/);
    assert.equal(registry.size(), 0, 'a failed attempt leaves no order record');

    const retry = await registry.run('q_retry', create);
    assert.equal(calls, 2);
    assert.equal(retry.replayed, false);
    assert.equal(retry.order.id, 'ORDER-RETRY');
});
