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
    reconcileOrderPrice,
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

function pricedOrder({ id = 'ORD-PRICE', productId = 'course-one', amount = '18.00', currency = 'USD', quoteId = null, invoiceQuoteId = null, catalogVersion = null, catalogDigest = null } = {}) {
    return {
        id,
        status: 'COMPLETED',
        payer: { email_address: 'buyer@example.com' },
        purchase_units: [{
            custom_id: productId,
            ...(quoteId ? { custom_id: `${productId}|q=${quoteId}|v=${catalogVersion ?? 1}` } : {}),
            ...(catalogDigest ? { invoice_id: `q=${invoiceQuoteId || quoteId || 'q_test'}|d=${catalogDigest}` } : {}),
            description: 'Course One',
            amount: { value: amount, currency_code: currency },
            payments: {
                captures: [{
                    id: 'CAP-PRICE',
                    status: 'COMPLETED',
                    amount: { value: amount, currency_code: currency },
                    create_time: '2026-11-01T10:00:00Z'
                }]
            }
        }]
    };
}

const CATALOG_DIGEST = `sha256:${'b'.repeat(64)}`;
const priceCatalog = {
    version: 1,
    digest: CATALOG_DIGEST,
    currency: 'USD',
    fx: { USD: 1, MAD: 10 },
    bySlug: {
        'course-one': { slug: 'course-one', title: 'Course One', price_cents: 1900 },
        'course-two': { slug: 'course-two', title: 'Course Two', price_cents: 2900 }
    }
};

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

test('a captured amount is compared with the canonical catalog without changing prices', () => {
    const mismatch = reconcileOrderPrice(pricedOrder(), { catalog: priceCatalog });
    assert.equal(mismatch.status, 'mismatch');
    assert.equal(mismatch.product_id, 'course-one');
    assert.equal(mismatch.expected, 19);
    assert.equal(mismatch.actual, 18);
    assert.equal(mismatch.delta, -1);

    const matching = reconcileOrderPrice(pricedOrder({ amount: '19.00' }), { catalog: priceCatalog });
    assert.equal(matching.status, 'ok');
    assert.equal(matching.expected, 19);
    assert.equal(matching.actual, 19);

    const noFx = reconcileOrderPrice(pricedOrder({ currency: 'EUR', amount: '17.48' }), { catalog: priceCatalog });
    assert.equal(noFx.status, 'unchecked');
    assert.equal(noFx.reason, 'price_unavailable');
});

test('captured orders prove the catalog revision they were created from', () => {
    const matching = reconcileOrderPrice(pricedOrder({
        amount: '19.00',
        quoteId: 'q_match',
        catalogVersion: 1,
        catalogDigest: CATALOG_DIGEST
    }), { catalog: priceCatalog });
    assert.equal(matching.status, 'ok');
    assert.equal(matching.quote_id, 'q_match');
    assert.equal(matching.catalog_version, '1');
    assert.equal(matching.catalog_digest, CATALOG_DIGEST);
    assert.equal(matching.catalog_digest_expected, CATALOG_DIGEST);
    assert.equal(matching.catalog_revision, 'ok');

    const stale = reconcileOrderPrice(pricedOrder({
        amount: '19.00',
        quoteId: 'q_stale',
        catalogVersion: 1,
        catalogDigest: `sha256:${'c'.repeat(64)}`
    }), { catalog: priceCatalog });
    assert.equal(stale.status, 'ok');
    assert.equal(stale.catalog_revision, 'mismatch');

    const legacy = reconcileOrderPrice(pricedOrder({ amount: '19.00' }), { catalog: priceCatalog });
    assert.equal(legacy.status, 'ok');
    assert.equal(legacy.catalog_revision, 'unchecked');
});

test('quote metadata is reported as missing, malformed, stale or legacy without changing prices', () => {
    const missing = reconcileOrderPrice(pricedOrder({ amount: '19.00' }), { catalog: priceCatalog });
    assert.equal(missing.quote_metadata_status, 'missing');
    assert.equal(missing.quote_metadata_reason, 'missing_quote_metadata');

    const legacy = reconcileOrderPrice(pricedOrder({ amount: '19.00' }), {
        catalog: priceCatalog,
        legacyQuoteOrderIds: ['ORD-PRICE']
    });
    assert.equal(legacy.quote_metadata_status, 'legacy');
    assert.equal(legacy.quote_metadata_reason, 'legacy_quote_metadata_allowlisted');

    const cutoffLegacy = reconcileOrderPrice(pricedOrder({ amount: '19.00' }), {
        catalog: priceCatalog,
        quoteRequiredAfter: '2026-11-02T00:00:00Z'
    });
    assert.equal(cutoffLegacy.quote_metadata_status, 'legacy');

    const malformed = reconcileOrderPrice(pricedOrder({
        amount: '19.00',
        quoteId: 'q_partial',
        catalogVersion: 1
    }), { catalog: priceCatalog });
    assert.equal(malformed.quote_metadata_status, 'malformed');
    assert.match(malformed.quote_metadata_reason, /incomplete_invoice/);

    const quoteIdMismatch = reconcileOrderPrice(pricedOrder({
        amount: '19.00',
        quoteId: 'q_custom',
        invoiceQuoteId: 'q_invoice',
        catalogVersion: 1,
        catalogDigest: CATALOG_DIGEST
    }), { catalog: priceCatalog });
    assert.equal(quoteIdMismatch.quote_metadata_status, 'malformed');
    assert.match(quoteIdMismatch.quote_metadata_reason, /quote_id_mismatch/);

    const invalidDigest = reconcileOrderPrice(pricedOrder({
        amount: '19.00',
        quoteId: 'q_bad',
        catalogVersion: 1,
        catalogDigest: 'not-a-digest'
    }), { catalog: priceCatalog });
    assert.equal(invalidDigest.quote_metadata_status, 'malformed');
    assert.match(invalidDigest.quote_metadata_reason, /invalid_catalog_digest/);

    const staleDigest = reconcileOrderPrice(pricedOrder({
        amount: '19.00',
        quoteId: 'q_stale',
        catalogVersion: 1,
        catalogDigest: `sha256:${'e'.repeat(64)}`
    }), { catalog: priceCatalog });
    assert.equal(staleDigest.quote_metadata_status, 'stale');
    assert.equal(staleDigest.quote_metadata_reason, 'catalog_digest_mismatch');

    const staleVersion = reconcileOrderPrice(pricedOrder({
        amount: '19.00',
        quoteId: 'q_old_version',
        catalogVersion: 2,
        catalogDigest: CATALOG_DIGEST
    }), { catalog: priceCatalog });
    assert.equal(staleVersion.quote_metadata_status, 'stale');
    assert.equal(staleVersion.quote_metadata_reason, 'catalog_version_mismatch');

    const untouched = pricedOrder({ amount: '19.00' });
    reconcileOrderPrice(untouched, { catalog: priceCatalog, legacyQuoteOrderIds: ['ORD-PRICE'] });
    assert.equal(untouched.purchase_units[0].amount.value, '19.00');
    assert.equal(untouched.purchase_units[0].custom_id, 'course-one');
    assert.equal(missing.actual, 19);
    assert.equal(staleDigest.actual, 19);
});

test('captured price mismatches are reported by reconciliation and never auto-corrected', async () => {
    const queueFile = tempQueue();
    const { api } = fakePaypal({ orders: { 'ORD-PRICE': pricedOrder() } });
    const report = await reconcilePayPalOrders({
        paypal: api,
        orderIds: ['ORD-PRICE'],
        search: false,
        now: NOW,
        queueFile,
        catalog: priceCatalog,
        fulfill: queueFulfiller(queueFile)
    });

    assert.equal(report.price_checked, 1);
    assert.equal(report.price_mismatch_count, 1);
    assert.equal(report.price_mismatches[0].order_id, 'ORD-PRICE');
    assert.equal(report.price_mismatches[0].expected, 19);
    assert.equal(report.price_mismatches[0].actual, 18);
    assert.equal(report.catalog_digest, CATALOG_DIGEST);
    assert.equal(report.catalog_revision_checked, 0);
    assert.equal(report.catalog_revision_mismatch_count, 0);
    assert.equal(report.missing_count, 1);
    assert.equal(fs.existsSync(queueFile), false);
});

test('reconciliation reports catalog revision mismatches separately from price mismatches', async () => {
    const queueFile = tempQueue();
    const { api } = fakePaypal({
        orders: {
            'ORD-REVISION': pricedOrder({
                id: 'ORD-REVISION',
                amount: '19.00',
                quoteId: 'q_revision',
                catalogVersion: 1,
                catalogDigest: `sha256:${'d'.repeat(64)}`
            })
        }
    });
    const report = await reconcilePayPalOrders({
        paypal: api,
        orderIds: ['ORD-REVISION'],
        search: false,
        now: NOW,
        queueFile,
        catalog: priceCatalog,
        fulfill: queueFulfiller(queueFile)
    });

    assert.equal(report.price_mismatch_count, 0);
    assert.equal(report.catalog_revision_checked, 1);
    assert.equal(report.catalog_revision_mismatch_count, 1);
    assert.equal(report.catalog_revision_mismatches[0].quote_id, 'q_revision');
    assert.equal(report.catalog_revision_mismatches[0].catalog_revision, 'mismatch');
    assert.equal(report.catalog_revision_unchecked.length, 0);
});

test('reconciliation separates quote metadata findings from price and fulfillment checks', async () => {
    const queueFile = tempQueue();
    const { api } = fakePaypal({
        orders: {
            'ORD-MISSING': pricedOrder({ id: 'ORD-MISSING', amount: '19.00' }),
            'ORD-LEGACY': pricedOrder({ id: 'ORD-LEGACY', amount: '19.00' }),
            'ORD-MALFORMED': pricedOrder({ id: 'ORD-MALFORMED', amount: '19.00', quoteId: 'q_partial', catalogVersion: 1 }),
            'ORD-STALE': pricedOrder({
                id: 'ORD-STALE',
                amount: '19.00',
                quoteId: 'q_stale',
                catalogVersion: 1,
                catalogDigest: `sha256:${'f'.repeat(64)}`
            })
        }
    });
    const report = await reconcilePayPalOrders({
        paypal: api,
        orderIds: ['ORD-MISSING', 'ORD-LEGACY', 'ORD-MALFORMED', 'ORD-STALE'],
        search: false,
        now: NOW,
        queueFile,
        catalog: priceCatalog,
        legacyQuoteOrderIds: ['ORD-LEGACY'],
        fulfill: queueFulfiller(queueFile)
    });

    assert.equal(report.price_mismatch_count, 0);
    assert.equal(report.catalog_revision_mismatch_count, 1);
    assert.equal(report.quote_metadata_finding_count, 3);
    assert.deepEqual(report.quote_metadata_findings.map(row => `${row.order_id}:${row.quote_metadata_status}`).sort(), [
        'ORD-MALFORMED:malformed',
        'ORD-MISSING:missing',
        'ORD-STALE:stale'
    ]);
    assert.deepEqual(report.quote_metadata_legacy.map(row => row.order_id), ['ORD-LEGACY']);
    assert.equal(report.missing_count, 4);
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
