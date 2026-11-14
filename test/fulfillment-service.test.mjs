import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAccessToken,
  fulfillPaidOrder,
  verifyAccessToken
} from '../src/financial/fulfillment-service.mjs';

function paidOrder(overrides = {}) {
  return {
    id: 'ORDER-1',
    status: 'COMPLETED',
    payer: { email_address: 'buyer@example.com' },
    purchase_units: [{
      custom_id: 'course-1',
      description: 'Risk Management',
      amount: { value: '19.00', currency_code: 'USD' },
      payments: {
        captures: [{
          id: 'CAP-1',
          status: 'COMPLETED',
          amount: { value: '19.00', currency_code: 'USD' }
        }]
      }
    }],
    ...overrides
  };
}

function successfulLedger() {
  return {
    calls: [],
    async prepayFulfillment(input) {
      this.calls.push(input);
      return {
        ok: true,
        duplicate: false,
        costCents: 200,
        availableCents: 1700,
        transaction: { id: 'ful_ORDER-1' }
      };
    }
  };
}

test('access tokens are signed, scoped to an order, and expire', () => {
  const now = new Date('2026-11-14T12:00:00Z');
  const token = createAccessToken({ orderId: 'ORDER-1', productId: 'course-1', now }, 'test-secret');
  const valid = verifyAccessToken(token, 'test-secret', { now });
  assert.equal(valid.ok, true);
  assert.equal(valid.orderId, 'ORDER-1');
  assert.equal(valid.productId, 'course-1');
  assert.equal(verifyAccessToken(token, 'wrong-secret', { now }).ok, false);
  assert.equal(verifyAccessToken(token, 'test-secret', { now: new Date('2038-01-01T00:00:00Z') }).reason, 'EXPIRED_TOKEN');
});

test('a captured order is prepaid from swarm revenue and emailed access', async () => {
  const ledger = successfulLedger();
  const queued = [];
  const requests = [];
  const result = await fulfillPaidOrder({
    order: paidOrder(),
    product: { id: 'course-1', name: 'Risk Management', fulfillment_cost_cents: 200 },
    ledger,
    queue: async (entry) => queued.push(entry),
    secret: 'test-secret',
    baseUrl: 'https://www.realworldcerts.com',
    emailApiKey: 're_test',
    emailFrom: 'billing@realworldcerts.com',
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ id: 'email-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.delivery, 'emailed');
  assert.equal(result.email.ok, true);
  assert.equal(ledger.calls.length, 1);
  assert.equal(ledger.calls[0].orderId, 'ORDER-1');
  assert.equal(ledger.calls[0].revenueAmount, 19);
  assert.equal(ledger.calls[0].costCents, 200);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.resend.com/emails');
  const emailBody = JSON.parse(requests[0].init.body);
  assert.deepEqual(emailBody.to, ['buyer@example.com']);
  assert.match(emailBody.text, /https:\/\/www\.realworldcerts\.com\/access\//);

  assert.equal(queued.length, 1);
  assert.equal(queued[0].status, 'DELIVERED');
  assert.equal(queued[0].funding.prepaid_by, 'swarm');
  assert.equal(queued[0].funding.funding_source, 'swarm_revenue');
  const token = queued[0].access_url.split('/access/')[1];
  assert.equal(verifyAccessToken(token, 'test-secret').ok, true);
});

test('a retried capture does not send a second access email', async () => {
  let emailed = false;
  const result = await fulfillPaidOrder({
    order: paidOrder(),
    product: { id: 'course-1', name: 'Risk Management' },
    ledger: {
      async prepayFulfillment() {
        return {
          ok: true,
          duplicate: true,
          emailStatus: 'sent',
          emailId: 'email-1',
          costCents: 0,
          availableCents: 1900,
          transaction: { id: 'ful_ORDER-1' }
        };
      }
    },
    queue: async () => {},
    secret: 'test-secret',
    emailApiKey: 're_test',
    fetchImpl: async () => {
      emailed = true;
      return new Response('{}', { status: 200 });
    }
  });
  assert.equal(result.delivery, 'emailed');
  assert.equal(result.duplicate, true);
  assert.equal(emailed, false);
});

test('an unpaid fulfillment cost blocks delivery instead of giving access away', async () => {
  const queued = [];
  let emailed = false;
  const result = await fulfillPaidOrder({
    order: paidOrder(),
    product: { id: 'course-1', name: 'Risk Management', fulfillment_cost_cents: 5000 },
    ledger: {
      async prepayFulfillment() {
        return { ok: false, reason: 'INSUFFICIENT_SWARM_REVENUE', availableCents: 1900, costCents: 5000 };
      }
    },
    queue: async (entry) => queued.push(entry),
    secret: 'test-secret',
    fetchImpl: async () => {
      emailed = true;
      return new Response('{}', { status: 200 });
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'INSUFFICIENT_SWARM_REVENUE');
  assert.equal(emailed, false);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].status, 'BLOCKED_PREPAYMENT');
});

test('a missing payer email leaves a queued obligation instead of claiming delivery', async () => {
  const queued = [];
  const result = await fulfillPaidOrder({
    order: paidOrder({ payer: {} }),
    product: { id: 'course-1', name: 'Risk Management' },
    ledger: successfulLedger(),
    queue: async (entry) => queued.push(entry),
    secret: 'test-secret',
    emailApiKey: 're_test',
    fetchImpl: async () => {
      throw new Error('email must not be sent without an address');
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.delivery, 'queued');
  assert.equal(result.reason, 'MISSING_PAYER_EMAIL');
  assert.equal(queued[0].status, 'PENDING_EMAIL');
});
