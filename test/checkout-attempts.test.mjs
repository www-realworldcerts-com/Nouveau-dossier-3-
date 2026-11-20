import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
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

const SIGNING_SECRET = 'attempt-signing-secret';

test('an in-memory registry reports that it signs nothing', () => {
    const registry = createCheckoutAttemptRegistry({ signingSecret: SIGNING_SECRET });
    assert.equal(registry.durable, false);
    assert.equal(registry.signed, false, 'memory attempts never reach a store another writer could tamper with');
});

test('a signed record replays the same order after a restart', async (t) => {
    const { dir, cleanup } = await tempStore();
    t.after(cleanup);

    const first = createCheckoutAttemptRegistry({ directory: dir, signingSecret: SIGNING_SECRET });
    assert.equal(first.signed, true);
    const created = await first.run('q_signed', async () => ({ id: 'ORDER-SIGNED', status: 'CREATED' }));
    assert.equal(created.replayed, false);
    const stored = JSON.parse(await fs.readFile(path.join(dir, `${checkoutAttemptKey('q_signed')}.json`), 'utf8'));
    assert.match(stored.sig, /^[a-f0-9]{64}$/, 'the record is signed on disk');

    const restarted = createCheckoutAttemptRegistry({ directory: dir, signingSecret: SIGNING_SECRET });
    let calls = 0;
    const replay = await restarted.run('q_signed', async () => {
        calls += 1;
        return { id: 'ORDER-OTHER' };
    });
    assert.equal(calls, 0);
    assert.equal(replay.replayed, true);
    assert.equal(replay.order.id, 'ORDER-SIGNED');
});

test('a tampered order id fails verification and is replaced by a fresh order', async (t) => {
    const { dir, cleanup } = await tempStore();
    t.after(cleanup);

    const first = createCheckoutAttemptRegistry({ directory: dir, signingSecret: SIGNING_SECRET });
    await first.run('q_tampered', async () => ({ id: 'ORDER-REAL', status: 'CREATED' }));

    // Someone with write access to the shared volume swaps the order a replay
    // would return for another one.
    const file = path.join(dir, `${checkoutAttemptKey('q_tampered')}.json`);
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    await fs.writeFile(file, JSON.stringify({ ...stored, order: { id: 'ORDER-ATTACKER' } }), 'utf8');

    const restarted = createCheckoutAttemptRegistry({ directory: dir, signingSecret: SIGNING_SECRET });
    const result = await restarted.run('q_tampered', async () => ({ id: 'ORDER-FRESH' }));

    assert.equal(result.replayed, false, 'a swapped order is never replayed');
    assert.equal(result.order.id, 'ORDER-FRESH');
});

test('an unsigned record is rejected once records are signed', async (t) => {
    const { dir, cleanup } = await tempStore();
    t.after(cleanup);
    const key = checkoutAttemptKey('q_unsigned');
    await fs.writeFile(path.join(dir, `${key}.json`), JSON.stringify({
        v: 1,
        quote_id: 'q_unsigned',
        key,
        order: { id: 'ORDER-UNSIGNED' },
        created_at: new Date().toISOString(),
        expires_at: Date.now() + 600_000
    }), 'utf8');

    const registry = createCheckoutAttemptRegistry({ directory: dir, signingSecret: SIGNING_SECRET });
    const result = await registry.run('q_unsigned', async () => ({ id: 'ORDER-NEW' }));

    assert.equal(result.replayed, false, 'stripping the signature does not skip the check');
    assert.equal(result.order.id, 'ORDER-NEW');
});

test('a record signed with a different secret is rejected', async (t) => {
    const { dir, cleanup } = await tempStore();
    t.after(cleanup);

    const writer = createCheckoutAttemptRegistry({ directory: dir, signingSecret: 'another-secret' });
    await writer.run('q_rotated', async () => ({ id: 'ORDER-OTHER-KEY' }));

    const registry = createCheckoutAttemptRegistry({ directory: dir, signingSecret: SIGNING_SECRET });
    const result = await registry.run('q_rotated', async () => ({ id: 'ORDER-CURRENT-KEY' }));

    assert.equal(result.replayed, false);
    assert.equal(result.order.id, 'ORDER-CURRENT-KEY');
});

test('two quotes for the same cart stay separate attempts', async () => {
    // A quote carries no buyer identity: two customers buying the same course at
    // the same price produce identical product, amount, currency and redirect
    // URLs. A cart-derived key would make the second buyer replay the first one's
    // order and approval link, so the attempt must stay per quote.
    const registry = createCheckoutAttemptRegistry();
    let calls = 0;
    const create = async () => ({ id: `ORDER-${++calls}` });

    const first = await registry.run('q_buyer_one', create);
    const second = await registry.run('q_buyer_two', create);

    assert.notEqual(first.key, second.key);
    assert.notEqual(first.order.id, second.order.id);
    assert.equal(second.replayed, false);
    assert.equal(calls, 2);
});

const QUOTE_FACTS = {
    amount_cents: 1900,
    currency: 'usd',
    catalog_version: '1',
    catalog_digest: 'sha256:abc123'
};

function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        const fields = Object.keys(value).sort()
            .map(field => `${JSON.stringify(field)}:${stableStringify(value[field])}`);
        return `{${fields.join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}

function legacySignature(record) {
    const signingKey = crypto.createHmac('sha256', SIGNING_SECRET).update('acp-attempt-record:v1').digest();
    return crypto.createHmac('sha256', signingKey).update(stableStringify(record)).digest('hex');
}

test('stored quote facts are signed with the record and readable without replay', async (t) => {
    const { dir, cleanup } = await tempStore();
    t.after(cleanup);

    const registry = createCheckoutAttemptRegistry({ directory: dir, signingSecret: SIGNING_SECRET });
    await registry.run('q_facts', async () => ({ id: 'ORDER-FACTS' }), { quote: QUOTE_FACTS });

    const found = await registry.lookup('q_facts');
    assert.deepEqual(found.quote, {
        amount_cents: 1900,
        currency: 'USD',
        catalog_version: '1',
        catalog_digest: 'sha256:abc123'
    });
    assert.equal(found.order.id, 'ORDER-FACTS');
    assert.equal(found.quote_id, 'q_facts');

    const stored = JSON.parse(await fs.readFile(path.join(dir, `${checkoutAttemptKey('q_facts')}.json`), 'utf8'));
    assert.equal(stored.quote.amount_cents, 1900, 'the quote facts are on disk');
    assert.match(stored.sig, /^[a-f0-9]{64}$/);

    const restarted = createCheckoutAttemptRegistry({ directory: dir, signingSecret: SIGNING_SECRET });
    assert.equal((await restarted.lookup('q_facts')).quote.amount_cents, 1900);
    assert.equal(await restarted.lookup('q_absent'), null);
});

test('an in-memory registry exposes quote facts without a store', async () => {
    const registry = createCheckoutAttemptRegistry();
    await registry.run('q_memory_facts', async () => ({ id: 'ORDER-MEMORY' }), { quote: QUOTE_FACTS });

    const found = await registry.lookup('q_memory_facts');
    assert.equal(found.quote.amount_cents, 1900);
    assert.equal(found.quote.currency, 'USD');
    assert.equal(await registry.lookup('q_memory_absent'), null);
});

test('tampering with the stored quoted amount invalidates the record', async (t) => {
    const { dir, cleanup } = await tempStore();
    t.after(cleanup);

    const first = createCheckoutAttemptRegistry({ directory: dir, signingSecret: SIGNING_SECRET });
    await first.run('q_quote_tamper', async () => ({ id: 'ORDER-REAL' }), { quote: QUOTE_FACTS });

    // A writer on the shared volume lowers the quoted amount so a capture check
    // would believe the buyer owed less.
    const file = path.join(dir, `${checkoutAttemptKey('q_quote_tamper')}.json`);
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    await fs.writeFile(file, JSON.stringify({ ...stored, quote: { ...stored.quote, amount_cents: 1 } }), 'utf8');

    const registry = createCheckoutAttemptRegistry({ directory: dir, signingSecret: SIGNING_SECRET });
    assert.equal(await registry.lookup('q_quote_tamper'), null, 'a swapped amount is never reported');

    const result = await registry.run('q_quote_tamper', async () => ({ id: 'ORDER-FRESH' }));
    assert.equal(result.replayed, false);
    assert.equal(result.order.id, 'ORDER-FRESH');
});

test('a record signed before quote facts were added still replays', async (t) => {
    const { dir, cleanup } = await tempStore();
    t.after(cleanup);

    // Exact shape written by the previous version: no `quote` field, signed over
    // the older payload. It belongs to an in-flight checkout during the upgrade.
    const key = checkoutAttemptKey('q_legacy');
    const record = {
        v: 1,
        quote_id: 'q_legacy',
        key,
        order: { id: 'ORDER-LEGACY' },
        created_at: new Date().toISOString(),
        expires_at: Date.now() + 600_000
    };
    record.sig = legacySignature(record);
    await fs.writeFile(path.join(dir, `${key}.json`), JSON.stringify(record), 'utf8');

    const registry = createCheckoutAttemptRegistry({ directory: dir, signingSecret: SIGNING_SECRET });
    let calls = 0;
    const replay = await registry.run('q_legacy', async () => {
        calls += 1;
        return { id: 'ORDER-DUPLICATE' };
    });

    assert.equal(calls, 0, 'the older record is still trusted');
    assert.equal(replay.replayed, true);
    assert.equal(replay.order.id, 'ORDER-LEGACY');

    const found = await registry.lookup('q_legacy');
    assert.equal(found.quote, null, 'the older record has no quote facts to compare');
});

test('a sweep removes expired records and abandoned artifacts but not live ones', async (t) => {
    const { dir, cleanup } = await tempStore();
    t.after(cleanup);

    const nowMs = Date.now();
    const record = (expiresAt) => JSON.stringify({ v: 1, order: { id: 'ORDER-OLD' }, expires_at: expiresAt });
    const expired = path.join(dir, `${checkoutAttemptKey('q_old')}.json`);
    const fresh = path.join(dir, `${checkoutAttemptKey('q_new')}.json`);
    const staleLock = path.join(dir, `${checkoutAttemptKey('q_lock')}.lock`);
    const staleTmp = path.join(dir, `${checkoutAttemptKey('q_tmp')}.json.123.abc.tmp`);
    const liveLock = path.join(dir, `${checkoutAttemptKey('q_live_lock')}.lock`);
    const orphan = path.join(dir, `${checkoutAttemptKey('q_orphan')}.json`);
    await fs.writeFile(expired, record(nowMs - 60_000), 'utf8');
    await fs.writeFile(fresh, record(nowMs + 600_000), 'utf8');
    await fs.writeFile(staleLock, '1', 'utf8');
    await fs.writeFile(staleTmp, '{}', 'utf8');
    await fs.writeFile(liveLock, '2', 'utf8');
    // A record with no usable expiry is never replayable, so it is garbage.
    await fs.writeFile(orphan, '{not json', 'utf8');
    const longAgo = new Date(nowMs - 10 * 60_000);
    await fs.utimes(staleLock, longAgo, longAgo);
    await fs.utimes(staleTmp, longAgo, longAgo);
    await fs.utimes(orphan, longAgo, longAgo);

    const registry = createCheckoutAttemptRegistry({ directory: dir, ttlMs: 60_000, claimStaleMs: 60_000 });
    assert.equal(typeof registry.sweep, 'function');
    const result = await registry.sweep();

    assert.equal(result.removed, 4);
    await assert.rejects(fs.access(expired), { code: 'ENOENT' });
    await assert.rejects(fs.access(staleLock), { code: 'ENOENT' });
    await assert.rejects(fs.access(staleTmp), { code: 'ENOENT' });
    await assert.rejects(fs.access(orphan), { code: 'ENOENT' });
    await fs.access(fresh);
    await fs.access(liveLock);
});
