import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    drainFulfillmentQueue,
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
    assert.deepEqual(report.still_pending, [{ order_id: 'ORD-1', status: 'PENDING_EMAIL', reason: 'dry_run' }]);
    assert.equal(report.remaining, 1);
});

test('an unpaid order stays queued and is never delivered', async () => {
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
    assert.deepEqual(report.skipped, [{ order_id: 'ORD-1', reason: 'not_paid: CREATED' }]);
    assert.equal(report.remaining, 1);
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
    assert.equal(report.failed.length, 2);
    assert.match(report.failed[0].error, /order_lookup_failed: order ORD-LOOKUP not found/);
    assert.match(report.failed[1].error, /resend exploded/);
    // Both failures and the not-yet-attempted order stay in the queue.
    assert.equal(report.remaining, 2);
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
