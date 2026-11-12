import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    extractPaymentTransactions,
    fulfilledOrderIds,
    isPaidOrder,
    orderToFulfillment,
    reconcilePayPalOrders
} from '../src/real/fulfillment/paypal-reconciliation.mjs';

const NOW = new Date('2026-11-12T12:00:00Z');

function paidOrder(overrides = {}) {
    return {
        id: 'ORD-1',
        status: 'COMPLETED',
        payer: { email_address: 'buyer@example.com' },
        purchase_units: [{
            description: 'Course: Real World Cert',
            amount: { value: '49.00', currency_code: 'USD' },
            payments: {
                captures: [{
                    id: 'CAP-1',
                    status: 'COMPLETED',
                    amount: { value: '49.00', currency_code: 'USD' },
                    create_time: '2026-11-01T10:00:00Z'
                }]
            }
        }],
        ...overrides
    };
}

function transactionsResponse() {
    return {
        transaction_details: [
            {
                transaction_info: {
                    transaction_id: 'TXN-1',
                    transaction_status: 'S',
                    paypal_reference_id: 'ORD-1',
                    paypal_reference_id_type: 'OD',
                    transaction_amount: { value: '49.00', currency_code: 'USD' },
                    payer_info: { email_address: 'buyer@example.com' }
                }
            },
            {
                transaction_info: {
                    transaction_id: 'TXN-2',
                    transaction_status: 'D',
                    paypal_reference_id: 'ORD-DENIED',
                    paypal_reference_id_type: 'OD',
                    transaction_amount: { value: '10.00', currency_code: 'USD' }
                }
            }
        ]
    };
}

function tempQueue() {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'paypal-rec-')), 'fulfillment_queue.log');
}

function fakePaypal({ orders = {}, transactions = transactionsResponse(), failSearch = false } = {}) {
    const calls = { search: 0, details: [] };
    return {
        calls,
        api: {
            searchTransactions: async () => {
                calls.search += 1;
                if (failSearch) throw new Error('reporting unavailable');
                return transactions;
            },
            getPayPalOrderDetails: async id => {
                calls.details.push(id);
                if (!orders[id]) throw new Error(`order ${id} not found`);
                return orders[id];
            }
        }
    };
}

/** Mirrors FulfillmentManager: append a PENDING_DELIVERY entry to the queue. */
function queueFulfiller(queueFile, calls = []) {
    return async order => {
        calls.push(order);
        fs.mkdirSync(path.dirname(queueFile), { recursive: true });
        fs.appendFileSync(queueFile, JSON.stringify({
            timestamp: NOW.toISOString(),
            order_id: order.id,
            product: order.product,
            customer_email: order.customer_email,
            amount: order.revenue,
            status: 'PENDING_DELIVERY'
        }) + '\n');
        return { status: 'QUEUED' };
    };
}

test('transaction extraction keeps only successful positive payments', () => {
    const txs = extractPaymentTransactions(transactionsResponse());
    assert.equal(txs.length, 1);
    assert.equal(txs[0].reference_id, 'ORD-1');
    assert.equal(txs[0].reference_type, 'OD');
    assert.equal(txs[0].amount, 49);
});

test('paid orders map onto the existing fulfillment contract', () => {
    const order = paidOrder();
    assert.equal(isPaidOrder(order), true);
    const mapped = orderToFulfillment(order);
    assert.equal(mapped.id, 'ORD-1');
    assert.equal(mapped.product, 'Course: Real World Cert');
    assert.equal(mapped.customer_email, 'buyer@example.com');
    assert.equal(mapped.revenue, 49);
    assert.equal(mapped.capture_id, 'CAP-1');
});

test('an order without a completed capture is not paid', () => {
    assert.equal(isPaidOrder({ id: 'ORD-2', status: 'APPROVED', purchase_units: [{ amount: { value: '10.00' } }] }), false);
    assert.equal(isPaidOrder({ id: 'ORD-3', purchase_units: [{ payments: { captures: [{ status: 'PENDING' }] } }] }), false);
});

test('dry run reports missing fulfilment and writes nothing', async () => {
    const queueFile = tempQueue();
    const { api } = fakePaypal({ orders: { 'ORD-1': paidOrder() } });
    const fulfilled = [];
    const report = await reconcilePayPalOrders({
        paypal: api,
        now: NOW,
        queueFile,
        fulfill: queueFulfiller(queueFile, fulfilled)
    });

    assert.equal(report.applied, false);
    assert.equal(report.scanned_orders, 1);
    assert.equal(report.paid_orders, 1);
    assert.equal(report.missing_count, 1);
    assert.equal(report.missing[0].order_id, 'ORD-1');
    assert.equal(report.enqueued.length, 0);
    assert.equal(fulfilled.length, 0);
    assert.equal(fs.existsSync(queueFile), false);
});

test('apply enqueues the missing order and a second run is idempotent', async () => {
    const queueFile = tempQueue();
    const { api } = fakePaypal({ orders: { 'ORD-1': paidOrder() } });
    const fulfilled = [];
    const fulfill = queueFulfiller(queueFile, fulfilled);

    const first = await reconcilePayPalOrders({ paypal: api, now: NOW, queueFile, apply: true, fulfill });
    assert.equal(first.missing_count, 1);
    assert.deepEqual(first.enqueued, ['ORD-1']);
    assert.equal(fulfilled.length, 1);
    assert.deepEqual([...fulfilledOrderIds(queueFile)], ['ORD-1']);

    const second = await reconcilePayPalOrders({ paypal: api, now: NOW, queueFile, apply: true, fulfill });
    assert.equal(second.paid_orders, 1);
    assert.equal(second.already_fulfilled, 1);
    assert.equal(second.missing_count, 0);
    assert.deepEqual(second.enqueued, []);
    assert.equal(fulfilled.length, 1, 'must not enqueue the same order twice');
});

test('orders already in the queue are never re-enqueued', async () => {
    const queueFile = tempQueue();
    fs.mkdirSync(path.dirname(queueFile), { recursive: true });
    fs.writeFileSync(queueFile, JSON.stringify({ order_id: 'ORD-1', status: 'PENDING_DELIVERY' }) + '\n');

    const { api } = fakePaypal({ orders: { 'ORD-1': paidOrder() } });
    const fulfilled = [];
    const report = await reconcilePayPalOrders({ paypal: api, now: NOW, queueFile, apply: true, fulfill: queueFulfiller(queueFile, fulfilled) });
    assert.equal(report.missing_count, 0);
    assert.equal(fulfilled.length, 0);
});

test('explicit order ids work without the transaction search', async () => {
    const queueFile = tempQueue();
    const { api, calls } = fakePaypal({ orders: { 'ORD-1': paidOrder() } });
    const report = await reconcilePayPalOrders({
        paypal: api,
        orderIds: ['ORD-1'],
        search: false,
        now: NOW,
        queueFile,
        fulfill: queueFulfiller(queueFile)
    });
    assert.equal(calls.search, 0);
    assert.equal(report.missing_count, 1);
    assert.equal(report.searched_transactions, false);
});

test('unpaid and unknown orders are skipped with a reason', async () => {
    const queueFile = tempQueue();
    const { api } = fakePaypal({
        orders: {
            'ORD-1': paidOrder(),
            'ORD-2': { id: 'ORD-2', status: 'APPROVED', purchase_units: [{ amount: { value: '10.00' } }] }
        }
    });
    const report = await reconcilePayPalOrders({
        paypal: api,
        orderIds: ['ORD-2', 'ORD-NOPE'],
        search: false,
        now: NOW,
        queueFile,
        fulfill: queueFulfiller(queueFile)
    });
    assert.equal(report.missing_count, 0);
    assert.ok(report.skipped.some(skip => skip.order_id === 'ORD-2' && skip.reason.startsWith('not_paid')));
    assert.ok(report.skipped.some(skip => skip.order_id === 'ORD-NOPE' && skip.reason.startsWith('lookup_failed')));
});

test('a paid order without a payer email is enqueued but warned about', async () => {
    const queueFile = tempQueue();
    const order = paidOrder();
    delete order.payer;
    const { api } = fakePaypal({ orders: { 'ORD-1': order } });
    const report = await reconcilePayPalOrders({ paypal: api, now: NOW, queueFile, apply: true, fulfill: queueFulfiller(queueFile) });
    assert.equal(report.enqueued.length, 1);
    assert.deepEqual(report.warnings, ['missing_email:ORD-1']);
});

test('search failure is surfaced, and fatal only without explicit ids', async () => {
    const queueFile = tempQueue();
    const { api } = fakePaypal({ orders: { 'ORD-1': paidOrder() }, failSearch: true });

    const withIds = await reconcilePayPalOrders({
        paypal: api,
        orderIds: ['ORD-1'],
        now: NOW,
        queueFile,
        fulfill: queueFulfiller(queueFile)
    });
    assert.match(withIds.search_error, /reporting unavailable/);
    assert.equal(withIds.missing_count, 1);

    await assert.rejects(
        () => reconcilePayPalOrders({ paypal: api, now: NOW, queueFile, fulfill: queueFulfiller(queueFile) }),
        /transaction search failed/
    );
});

test('a leading flag is parsed as a flag, not as the command', () => {
    const cli = path.join(process.cwd(), 'scripts', 'reconcile-paypal.mjs');
    const run = spawnSync(process.execPath, [cli, '--no-search', '--order-id', 'ORD-TEST', '--json'], {
        encoding: 'utf8'
    });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.searched_transactions, false);
    assert.equal(report.search_error, null);
    assert.equal(report.scanned_orders, 1);
});

test('a fulfillment failure is reported and not recorded as enqueued', async () => {
    const queueFile = tempQueue();
    const { api } = fakePaypal({ orders: { 'ORD-1': paidOrder() } });
    const report = await reconcilePayPalOrders({
        paypal: api,
        now: NOW,
        queueFile,
        apply: true,
        fulfill: async () => { throw new Error('disk full'); }
    });
    assert.deepEqual(report.enqueued, []);
    assert.equal(report.failed[0].order_id, 'ORD-1');
    assert.match(report.failed[0].error, /disk full/);
});
