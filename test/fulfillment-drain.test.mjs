import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    EXHAUSTED_STATUS,
    backoffDelayMs,
    drainFulfillmentQueue,
    drainState,
    exhaustedQueueEntries,
    latestQueueEntries,
    undeliveredQueueEntries
} from '../src/real/fulfillment/fulfillment-drain.mjs';

const NOW = new Date('2026-11-21T12:00:00Z');

function tempQueue(entries = []) {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fulfillment-drain-')), 'fulfillment_queue.log');
    for (const entry of entries) appendEntry(file, entry);
    return file;
}

function appendEntry(file, entry) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ timestamp: NOW.toISOString(), ...entry }) + '\n');
}

function paidOrder(id = 'ORD-1') {
    return {
        id,
        status: 'COMPLETED',
        payer: { email_address: 'buyer@example.com' },
        purchase_units: [{
            description: 'Course: Real World Cert',
            amount: { value: '49.00', currency_code: 'USD' },
            payments: {
                captures: [{
                    id: `CAP-${id}`,
                    status: 'COMPLETED',
                    amount: { value: '49.00', currency_code: 'USD' },
                    create_time: '2026-11-01T10:00:00Z'
                }]
            }
        }]
    };
}

function fakePaypal(orders = {}) {
    const calls = [];
    return {
        calls,
        api: {
            getPayPalOrderDetails: async id => {
                calls.push(id);
                if (!orders[id]) throw new Error(`order ${id} not found`);
                return orders[id];
            }
        }
    };
}

test('the last queue line for an order decides whether it was delivered', () => {
    const queueFile = tempQueue([
        { order_id: 'ORD-1', status: 'PENDING_EMAIL', customer_email: 'buyer@example.com' },
        { order_id: 'ORD-1', status: 'DELIVERED' },
        { order_id: 'ORD-2', status: 'PENDING_ACCESS_SECRET' }
    ]);
    assert.equal(latestQueueEntries(queueFile).get('ORD-1').status, 'DELIVERED');
    const undelivered = undeliveredQueueEntries(queueFile);
    assert.deepEqual(undelivered.map(entry => entry.order_id), ['ORD-2']);
    assert.equal(undelivered[0].status, 'PENDING_ACCESS_SECRET');
});

test('draining delivers a paid order stuck on PENDING_EMAIL, once', async () => {
    const queueFile = tempQueue([
        { order_id: 'ORD-1', status: 'PENDING_EMAIL', product: 'Course', customer_email: 'buyer@example.com' }
    ]);
    const paypal = fakePaypal({ 'ORD-1': paidOrder() });
    const fulfilled = [];
    const fulfill = async ({ order }) => {
        fulfilled.push(order.id);
        appendEntry(queueFile, { order_id: order.id, status: 'DELIVERED' });
        return { ok: true, delivery: 'emailed', email: { ok: true, id: 'email_1' } };
    };

    const report = await drainFulfillmentQueue({ queueFile, paypal: paypal.api, fulfill, apply: true, now: NOW });
    assert.equal(report.pending, 1);
    assert.equal(report.attempted, 1);
    assert.deepEqual(report.delivered, [{ order_id: 'ORD-1', email_id: 'email_1' }]);
    assert.equal(report.remaining, 0);
    assert.deepEqual(fulfilled, ['ORD-1']);

    const again = await drainFulfillmentQueue({ queueFile, paypal: paypal.api, fulfill, apply: true, now: NOW });
    assert.equal(again.pending, 0);
    assert.equal(again.attempted, 0);
    assert.deepEqual(fulfilled, ['ORD-1']);
});

test('a dry run reads the order but sends nothing', async () => {
    const queueFile = tempQueue([{ order_id: 'ORD-1', status: 'PENDING_EMAIL' }]);
    const paypal = fakePaypal({ 'ORD-1': paidOrder() });
    let calls = 0;
    const report = await drainFulfillmentQueue({
        queueFile,
        paypal: paypal.api,
        fulfill: async () => { calls += 1; return { ok: true, delivery: 'emailed' }; },
        now: NOW
    });
    assert.equal(calls, 0);
    assert.equal(report.applied, false);
    assert.equal(report.attempted, 0);
    assert.deepEqual(report.still_pending, [{ order_id: 'ORD-1', status: 'PENDING_EMAIL', reason: 'dry_run', attempts: 0, next_attempt_at: null }]);
    assert.equal(report.remaining, 1);
});

test('an unpaid order stays queued and the skip is recorded instead of writing nothing', async () => {
    const queueFile = tempQueue([{ order_id: 'ORD-1', status: 'PENDING_EMAIL' }]);
    const paypal = fakePaypal({ 'ORD-1': { id: 'ORD-1', status: 'CREATED', purchase_units: [] } });
    let calls = 0;
    const report = await drainFulfillmentQueue({
        queueFile,
        paypal: paypal.api,
        fulfill: async () => { calls += 1; return { ok: true, delivery: 'emailed' }; },
        apply: true,
        now: NOW
    });
    assert.equal(calls, 0);
    assert.deepEqual(report.skipped, [{ order_id: 'ORD-1', reason: 'not_paid: CREATED', recorded: true }]);
    assert.equal(report.remaining, 1);

    const recorded = latestQueueEntries(queueFile).get('ORD-1');
    assert.equal(recorded.status, 'PENDING_EMAIL', 'a skip does not change the delivery state');
    assert.equal(recorded.timestamp, NOW.toISOString(), 'the order must keep aging from its last real line');
    assert.equal(recorded.drain.last_skip_at, NOW.toISOString());
    assert.equal(recorded.drain.last_skip_reason, 'not_paid: CREATED');
    assert.equal(recorded.drain.attempts, undefined, 'a skip is not a failed delivery attempt');
    assert.equal(undeliveredQueueEntries(queueFile).length, 1, 'the order is still owed');
});

test('a repeated skip writes at most one heartbeat line an hour', async () => {
    const queueFile = tempQueue([{ order_id: 'ORD-1', status: 'PENDING_DELIVERY' }]);
    const paypal = fakePaypal({ 'ORD-1': { id: 'ORD-1', status: 'CREATED' } });
    const lines = () => fs.readFileSync(queueFile, 'utf8').trim().split('\n').length;
    const later = minutes => new Date(NOW.getTime() + minutes * 60000);

    await drainFulfillmentQueue({ queueFile, paypal: paypal.api, apply: true, now: NOW });
    assert.equal(lines(), 2, 'the first skip is recorded');

    const throttled = await drainFulfillmentQueue({ queueFile, paypal: paypal.api, apply: true, now: later(5) });
    assert.equal(throttled.skipped[0].recorded, false);
    assert.equal(lines(), 2, 'one line per tick would be a log, not a heartbeat');

    const heartbeat = await drainFulfillmentQueue({ queueFile, paypal: paypal.api, apply: true, now: later(61) });
    assert.equal(heartbeat.skipped[0].recorded, true);
    assert.equal(lines(), 3);
    assert.equal(latestQueueEntries(queueFile).get('ORD-1').drain.last_skip_at, later(61).toISOString());
});

test('a dry run records no skip line', async () => {
    const queueFile = tempQueue([{ order_id: 'ORD-1', status: 'PENDING_DELIVERY' }]);
    const paypal = fakePaypal({ 'ORD-1': { id: 'ORD-1', status: 'CREATED' } });
    const report = await drainFulfillmentQueue({ queueFile, paypal: paypal.api, now: NOW });
    assert.deepEqual(report.skipped, [{ order_id: 'ORD-1', reason: 'not_paid: CREATED', recorded: false }]);
    assert.equal(fs.readFileSync(queueFile, 'utf8').trim().split('\n').length, 1);
});

test('one failing order does not stop the others and stays queued', async () => {
    const queueFile = tempQueue([
        { order_id: 'ORD-LOOKUP', status: 'PENDING_EMAIL' },
        { order_id: 'ORD-THROW', status: 'PENDING_EMAIL' },
        { order_id: 'ORD-OK', status: 'PENDING_EMAIL' }
    ]);
    const paypal = fakePaypal({ 'ORD-THROW': paidOrder('ORD-THROW'), 'ORD-OK': paidOrder('ORD-OK') });
    const fulfill = async ({ order }) => {
        if (order.id === 'ORD-THROW') throw new Error('resend exploded');
        appendEntry(queueFile, { order_id: order.id, status: 'DELIVERED' });
        return { ok: true, delivery: 'emailed' };
    };

    const report = await drainFulfillmentQueue({ queueFile, paypal: paypal.api, fulfill, apply: true, now: NOW });
    assert.equal(report.attempted, 2);
    assert.deepEqual(report.delivered.map(item => item.order_id), ['ORD-OK']);
    assert.equal(report.still_pending.length, 2);
    assert.equal(report.still_pending[0].reason, 'order_lookup_failed: order ORD-LOOKUP not found');
    assert.equal(report.still_pending[1].reason, 'resend exploded');
    // Both failures and the not-yet-attempted order stay in the queue.
    assert.equal(report.remaining, 2);
});

test('a ledger-deduplicated delivery marks the queue delivered instead of retrying forever', async () => {
    // The ledger says the email already went out, so the fulfilment path
    // returns without queueing anything. The drain must still close the order.
    const queueFile = tempQueue([{ order_id: 'ORD-1', status: 'PENDING_EMAIL', customer_email: 'buyer@example.com' }]);
    const paypal = fakePaypal({ 'ORD-1': paidOrder() });
    let sent = 0;
    const fulfill = async () => {
        sent += 1;
        return { ok: true, duplicate: true, delivery: 'emailed', email: { ok: true, id: 'email_prior' } };
    };

    const first = await drainFulfillmentQueue({ queueFile, paypal: paypal.api, fulfill, apply: true, now: NOW });
    assert.deepEqual(first.delivered, [{ order_id: 'ORD-1', email_id: 'email_prior' }]);
    assert.equal(first.remaining, 0);
    assert.equal(latestQueueEntries(queueFile).get('ORD-1').status, 'DELIVERED');

    const second = await drainFulfillmentQueue({ queueFile, paypal: paypal.api, fulfill, apply: true, now: NOW });
    assert.equal(second.pending, 0);
    assert.equal(paypal.calls.length, 1, 'a delivered order is not looked up again');
    assert.equal(sent, 1);
});

test('the limit caps one run and leaves the rest for the next tick', async () => {
    const queueFile = tempQueue([
        { order_id: 'ORD-1', status: 'PENDING_EMAIL' },
        { order_id: 'ORD-2', status: 'PENDING_EMAIL' }
    ]);
    const paypal = fakePaypal({ 'ORD-1': paidOrder('ORD-1'), 'ORD-2': paidOrder('ORD-2') });
    const report = await drainFulfillmentQueue({
        queueFile,
        paypal: paypal.api,
        fulfill: async ({ order }) => {
            appendEntry(queueFile, { order_id: order.id, status: 'DELIVERED' });
            return { ok: true, delivery: 'emailed' };
        },
        apply: true,
        limit: 1,
        now: NOW
    });
    assert.equal(report.attempted, 1);
    assert.equal(report.unattempted, 1);
    assert.equal(report.remaining, 1);
});

test('a host without the queue reports a skip, not a clean drain', async () => {
    const queueFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fulfillment-drain-')), 'missing.log');
    const paypal = fakePaypal({});
    const report = await drainFulfillmentQueue({
        queueFile,
        paypal: paypal.api,
        fulfill: async () => {
            throw new Error('nothing must be delivered from a queue this host cannot see');
        },
        apply: true,
        now: NOW
    });
    assert.equal(report.queue_present, false);
    assert.equal(report.skipped_run, 'queue_missing');
    assert.equal(report.attempted, 0);
    assert.equal(report.pending, 0);
    assert.deepEqual(paypal.calls, []);
});

test('an empty but present queue is a real run, not a skip', async () => {
    const queueFile = tempQueue();
    fs.writeFileSync(queueFile, '');
    const report = await drainFulfillmentQueue({
        queueFile,
        paypal: fakePaypal({}).api,
        apply: true,
        now: NOW
    });
    assert.equal(report.queue_present, true);
    assert.equal(report.skipped_run, undefined);
    assert.equal(report.pending, 0);
});

test('backoff doubles per failure and is capped', () => {
    assert.equal(backoffDelayMs(1), 15 * 60000);
    assert.equal(backoffDelayMs(2), 30 * 60000);
    assert.equal(backoffDelayMs(3), 60 * 60000);
    assert.equal(backoffDelayMs(10, { maxBackoffMs: 2 * 3600000 }), 2 * 3600000);
});

test('a failed attempt records an attempt count and a backoff time in the queue', async () => {
    const queueFile = tempQueue([{ order_id: 'ORD-1', status: 'PENDING_EMAIL' }]);
    const paypal = fakePaypal({ 'ORD-1': paidOrder() });
    const fulfill = async () => ({ ok: true, delivery: 'queued', reason: 'MISSING_PAYER_EMAIL' });

    const first = await drainFulfillmentQueue({ queueFile, paypal: paypal.api, fulfill, apply: true, now: NOW });
    assert.equal(first.attempted, 1);
    assert.equal(first.escalated.length, 0);
    assert.equal(first.still_pending[0].attempts, 1);
    assert.equal(first.still_pending[0].reason, 'MISSING_PAYER_EMAIL');

    const recorded = latestQueueEntries(queueFile).get('ORD-1');
    assert.equal(recorded.status, 'PENDING_EMAIL', 'the delivery state is preserved');
    assert.equal(drainState(recorded).attempts, 1);
    assert.equal(recorded.drain.next_attempt_at, new Date(NOW.getTime() + 15 * 60000).toISOString());

    // The retry is not due yet, so the next tick must not touch PayPal again.
    const second = await drainFulfillmentQueue({
        queueFile,
        paypal: paypal.api,
        fulfill,
        apply: true,
        now: new Date(NOW.getTime() + 60000)
    });
    assert.equal(second.due, 0);
    assert.equal(second.waiting_for_backoff, 1);
    assert.equal(second.attempted, 0);
    assert.equal(paypal.calls.length, 1, 'a backed-off order is not looked up again');
});

test('the last allowed failure exhausts the order and stops retrying it forever', async () => {
    const queueFile = tempQueue([{ order_id: 'ORD-1', status: 'PENDING_EMAIL' }]);
    const paypal = fakePaypal({ 'ORD-1': paidOrder() });
    let deliveries = 0;
    const fulfill = async () => {
        deliveries += 1;
        throw new Error('address rejected by provider');
    };

    const first = await drainFulfillmentQueue({ queueFile, paypal: paypal.api, fulfill, apply: true, maxAttempts: 2, now: NOW });
    assert.equal(first.still_pending[0].attempts, 1);
    assert.equal(first.exhausted, 0);

    // Retry once the backoff has elapsed: this is the last allowed attempt.
    const second = await drainFulfillmentQueue({
        queueFile,
        paypal: paypal.api,
        fulfill,
        apply: true,
        maxAttempts: 2,
        now: new Date(NOW.getTime() + 16 * 60000)
    });
    assert.equal(second.attempted, 1);
    assert.deepEqual(second.escalated.map(item => item.order_id), ['ORD-1']);
    assert.equal(second.escalated[0].attempts, 2);
    assert.equal(second.exhausted, 1);
    assert.equal(second.remaining, 0, 'an exhausted order is no longer owed by the drain');

    const stopped = latestQueueEntries(queueFile).get('ORD-1');
    assert.equal(stopped.status, EXHAUSTED_STATUS);
    assert.match(stopped.action_required, /deliver manually or refund/);
    assert.equal(stopped.drain.attempts, 2);

    // Once exhausted, later ticks never look it up or email it again.
    const third = await drainFulfillmentQueue({
        queueFile,
        paypal: paypal.api,
        fulfill,
        apply: true,
        maxAttempts: 2,
        now: new Date(NOW.getTime() + 10 * 3600000)
    });
    assert.equal(third.pending, 0);
    assert.equal(third.attempted, 0);
    assert.equal(paypal.calls.length, 2);
    assert.equal(deliveries, 2);
    assert.deepEqual(exhaustedQueueEntries(queueFile).map(item => item.order_id), ['ORD-1']);
    assert.deepEqual(undeliveredQueueEntries(queueFile), []);
});

test('a delivered order clears any earlier attempt record', async () => {
    const queueFile = tempQueue([{ order_id: 'ORD-1', status: 'PENDING_EMAIL' }]);
    const paypal = fakePaypal({ 'ORD-1': paidOrder() });
    let attempt = 0;
    const fulfill = async () => {
        attempt += 1;
        if (attempt === 1) { appendEntry(queueFile, { order_id: 'ORD-1', status: 'PENDING_EMAIL', drain: { attempts: 1, next_attempt_at: null } }); return { ok: false, reason: 'EMAIL_HTTP_500' }; }
        appendEntry(queueFile, { order_id: 'ORD-1', status: 'DELIVERED' });
        return { ok: true, delivery: 'emailed', email: { ok: true, id: 'email_2' } };
    };

    await drainFulfillmentQueue({ queueFile, paypal: paypal.api, fulfill, apply: true, now: NOW });
    const retry = await drainFulfillmentQueue({
        queueFile,
        paypal: paypal.api,
        fulfill,
        apply: true,
        now: new Date(NOW.getTime() + 20 * 60000)
    });
    assert.deepEqual(retry.delivered, [{ order_id: 'ORD-1', email_id: 'email_2' }]);
    assert.equal(retry.remaining, 0);
    assert.equal(retry.exhausted, 0);
});

test('the CLI reports an empty queue without touching PayPal', () => {
    const queueFile = tempQueue();
    fs.writeFileSync(queueFile, '');
    const cli = path.join(process.cwd(), 'scripts', 'drain-fulfillment.mjs');
    const run = spawnSync(process.execPath, [cli, '--json', '--queue', queueFile], {
        encoding: 'utf8',
        env: { ...process.env, PAYPAL_CLIENT_ID: '', PAYPAL_CLIENT_SECRET: '' }
    });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.applied, false);
    assert.equal(report.queue_present, true);
    assert.equal(report.pending, 0);
    assert.equal(report.remaining, 0);
});

test('the CLI reads the queue the webhook writes, including its env override', () => {
    const queueFile = tempQueue();
    fs.writeFileSync(queueFile, '');
    const cli = path.join(process.cwd(), 'scripts', 'drain-fulfillment.mjs');
    const run = spawnSync(process.execPath, [cli, '--json'], {
        encoding: 'utf8',
        env: { ...process.env, FULFILLMENT_QUEUE_FILE: queueFile, PAYPAL_CLIENT_ID: '', PAYPAL_CLIENT_SECRET: '' }
    });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.queue_file, queueFile, 'FULFILLMENT_QUEUE_FILE must be honoured, not just the default path');
    assert.equal(report.queue_present, true);
});

test('the CLI says a missing queue was skipped instead of printing a clean drain', () => {
    const queueFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fulfillment-drain-')), 'missing.log');
    const cli = path.join(process.cwd(), 'scripts', 'drain-fulfillment.mjs');
    const run = spawnSync(process.execPath, [cli, '--apply', '--queue', queueFile], {
        encoding: 'utf8',
        env: { ...process.env, PAYPAL_CLIENT_ID: '', PAYPAL_CLIENT_SECRET: '' }
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /skipped: no fulfilment queue at this path/);
    assert.doesNotMatch(run.stdout, /delivered 0/);
});
