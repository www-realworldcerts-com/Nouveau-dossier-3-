import assert from 'node:assert/strict';
import test from 'node:test';

import {
    WEBHOOK_AUTO_CAPTURE_FAILED,
    WEBHOOK_FULFILLMENT_FAILED,
    captureApprovedOrderWebhook,
    fulfillCaptureWebhook,
    fulfillVerifiedWebhookEvent,
    isWebhookFulfillmentEvent
} from '../src/financial/webhook-fulfillment.mjs';

const ORDER_ID = 'ORDER-CAP-1';
const CAPTURE_ID = '3C679366HH908993F';
const BUYER = 'buyer@example.com';

function completedOrder(overrides = {}) {
    return {
        id: ORDER_ID,
        status: 'COMPLETED',
        intent: 'CAPTURE',
        payer: { email_address: BUYER },
        purchase_units: [{
            custom_id: 'real-world-cert',
            description: 'Real World Cert',
            payments: {
                captures: [{
                    id: CAPTURE_ID,
                    status: 'COMPLETED',
                    amount: { value: '19.00', currency_code: 'USD' }
                }]
            }
        }],
        ...overrides
    };
}

function captureEvent({ orderId = ORDER_ID } = {}) {
    return {
        id: 'WH-CAPTURE-1',
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: {
            id: CAPTURE_ID,
            status: 'COMPLETED',
            amount: { value: '19.00', currency_code: 'USD' },
            supplementary_data: { related_ids: { order_id: orderId } }
        }
    };
}

function approvedEvent(order = {}) {
    return {
        id: 'WH-APPROVED-1',
        event_type: 'CHECKOUT.ORDER.APPROVED',
        resource: {
            id: ORDER_ID,
            status: 'APPROVED',
            intent: 'CAPTURE',
            payer: { email_address: BUYER },
            purchase_units: [{ custom_id: 'real-world-cert', amount: { value: '19.00', currency_code: 'USD' } }],
            ...order
        }
    };
}

function recorder(result = { ok: true, delivery: 'emailed' }) {
    const calls = [];
    const fulfill = async (args) => {
        calls.push(args);
        return result;
    };
    fulfill.calls = calls;
    return fulfill;
}

test('a verified PAYMENT.CAPTURE.COMPLETED delivers the paid order', async () => {
    const fulfill = recorder();
    const looked = [];
    const out = await fulfillCaptureWebhook({
        evt: captureEvent(),
        lookupOrder: async (orderId) => {
            looked.push(orderId);
            return completedOrder();
        },
        fulfill,
        resolveProduct: (productId) => ({ id: productId, name: 'Real World Cert' })
    });

    assert.equal(looked[0], ORDER_ID, 'the order is read back for the buyer email');
    assert.equal(fulfill.calls.length, 1);
    assert.equal(fulfill.calls[0].order.id, ORDER_ID);
    assert.equal(fulfill.calls[0].product.id, 'real-world-cert');
    assert.deepEqual(out, {
        attempted: true,
        ok: true,
        order_id: ORDER_ID,
        product_id: 'real-world-cert',
        delivery: 'emailed',
        reason: null,
        duplicate: false,
        email: null,
        capture_id: CAPTURE_ID
    });
});

test('a capture whose order cannot be read back is a loud finding, never a throw', async () => {
    const fulfill = recorder();
    const out = await fulfillCaptureWebhook({
        evt: captureEvent(),
        lookupOrder: async () => {
            throw new Error('paypal 503');
        },
        fulfill
    });

    assert.equal(out.attempted, true);
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'ORDER_LOOKUP_FAILED');
    assert.equal(out.finding.code, WEBHOOK_FULFILLMENT_FAILED);
    assert.equal(out.finding.severity, 'critical');
    assert.match(out.finding.detail, /has paid and has no access pass/);
    assert.equal(fulfill.calls.length, 0);
});

test('a capture without an order id says so instead of guessing', async () => {
    const out = await fulfillCaptureWebhook({
        evt: captureEvent({ orderId: null }),
        lookupOrder: async () => completedOrder(),
        fulfill: recorder()
    });
    assert.equal(out.attempted, false);
    assert.equal(out.reason, 'NO_ORDER_ID');
});

test('an approved order is captured automatically, then delivered', async () => {
    const captured = [];
    const fulfill = recorder();
    const out = await captureApprovedOrderWebhook({
        evt: approvedEvent(),
        captureOrder: async (orderId) => {
            captured.push(orderId);
            return completedOrder();
        },
        lookupOrder: async () => {
            throw new Error('must not look up an order it just captured');
        },
        fulfill,
        resolveProduct: () => ({ id: 'real-world-cert', name: 'Real World Cert' })
    });

    assert.deepEqual(captured, [ORDER_ID]);
    assert.equal(fulfill.calls.length, 1);
    assert.equal(fulfill.calls[0].order.status, 'COMPLETED');
    assert.equal(out.captured, true);
    assert.equal(out.ok, true);
    assert.equal(out.delivery, 'emailed');
});

test('an approval replayed after capture is delivered without capturing again', async () => {
    let captured = 0;
    const fulfill = recorder();
    const out = await captureApprovedOrderWebhook({
        evt: approvedEvent({ status: 'COMPLETED' }),
        captureOrder: async () => {
            captured += 1;
            return completedOrder();
        },
        fulfill
    });

    assert.equal(captured, 0);
    assert.equal(fulfill.calls.length, 1);
    assert.equal(out.captured, false);
    assert.equal(out.ok, true);
});

test('losing the capture race to the browser falls back to the captured order', async () => {
    const looked = [];
    const fulfill = recorder();
    const out = await captureApprovedOrderWebhook({
        evt: approvedEvent(),
        captureOrder: async () => {
            throw new Error('ORDER_ALREADY_CAPTURED: order was captured by another request');
        },
        lookupOrder: async (orderId) => {
            looked.push(orderId);
            return completedOrder();
        },
        fulfill
    });

    assert.deepEqual(looked, [ORDER_ID]);
    assert.equal(fulfill.calls.length, 1);
    assert.equal(out.ok, true);
});

test('a failed auto-capture is a loud finding and delivers nothing', async () => {
    const fulfill = recorder();
    const out = await captureApprovedOrderWebhook({
        evt: approvedEvent(),
        captureOrder: async () => {
            throw new Error('INSTRUMENT_DECLINED');
        },
        fulfill
    });

    assert.equal(out.ok, false);
    assert.equal(out.reason, 'CAPTURE_FAILED');
    assert.equal(out.finding.code, WEBHOOK_AUTO_CAPTURE_FAILED);
    assert.match(out.finding.detail, /approved order ORDER-CAP-1/);
    assert.equal(fulfill.calls.length, 0);
});

test('an approved order with no capture call configured is reported, not silently dropped', async () => {
    const out = await captureApprovedOrderWebhook({ evt: approvedEvent(), fulfill: recorder() });
    assert.equal(out.reason, 'CAPTURE_NOT_AVAILABLE');
    assert.equal(out.finding.severity, 'critical');
});

test('an order that is neither approved nor captured is not touched', async () => {
    let captured = 0;
    const out = await captureApprovedOrderWebhook({
        evt: approvedEvent({ status: 'CREATED' }),
        captureOrder: async () => {
            captured += 1;
            return completedOrder();
        },
        fulfill: recorder()
    });
    assert.equal(captured, 0);
    assert.equal(out.attempted, false);
    assert.equal(out.reason, 'ORDER_NOT_APPROVED');
});

test('only the two delivery events are routed', async () => {
    assert.equal(isWebhookFulfillmentEvent(captureEvent()), true);
    assert.equal(isWebhookFulfillmentEvent(approvedEvent()), true);
    assert.equal(isWebhookFulfillmentEvent({ event_type: 'PAYMENT.CAPTURE.REFUNDED' }), false);
    const out = await fulfillVerifiedWebhookEvent({ evt: { event_type: 'PAYMENT.CAPTURE.REFUNDED' } });
    assert.deepEqual(out, { attempted: false, reason: 'NOT_A_FULFILLMENT_EVENT' });
});

test('the dispatcher sends a verified capture down the delivery path', async () => {
    const fulfill = recorder();
    const out = await fulfillVerifiedWebhookEvent({
        evt: captureEvent(),
        lookupOrder: async () => completedOrder(),
        fulfill
    });
    assert.equal(out.ok, true);
    assert.equal(fulfill.calls.length, 1);
});
