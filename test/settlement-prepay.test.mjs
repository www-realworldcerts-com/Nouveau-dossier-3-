import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('settlement ledger credits revenue, prepays fulfillment, and blocks uncovered costs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settlement-prepay-'));
  const ledgerPath = path.join(dir, 'settlement_ledger.json');
  process.env.SETTLEMENT_LEDGER_PATH = ledgerPath;
  try {
    const { SettlementLedger } = await import(`../src/financial/SettlementLedger.mjs?test=${Date.now()}`);
    const ledger = new SettlementLedger();

    const first = await ledger.prepayFulfillment({
      orderId: 'ORDER-1',
      revenueAmount: 19,
      currency: 'USD',
      costCents: 200,
      productId: 'course-1'
    });
    assert.equal(first.ok, true);
    assert.equal(first.availableCents, 1700);
    assert.equal(first.costCents, 200);

    const duplicate = await ledger.prepayFulfillment({
      orderId: 'ORDER-1',
      revenueAmount: 19,
      currency: 'USD',
      costCents: 200
    });
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.availableCents, 1700);

    const insufficient = await ledger.prepayFulfillment({
      orderId: 'ORDER-2',
      revenueAmount: 1,
      currency: 'USD',
      costCents: 5000
    });
    assert.equal(insufficient.ok, false);
    assert.equal(insufficient.reason, 'INSUFFICIENT_SWARM_REVENUE');
    assert.equal(insufficient.availableCents, 1800);

    const stored = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    const costs = stored.transactions.filter((transaction) => transaction.details?.kind === 'fulfillment_prepayment');
    const revenues = stored.transactions.filter((transaction) => transaction.details?.kind === 'order_revenue');
    assert.equal(costs.length, 1);
    assert.equal(revenues.length, 2);
    assert.equal(costs[0].details.prepaid_by, 'swarm');
    assert.equal(costs[0].details.funding_source, 'swarm_revenue');
  } finally {
    delete process.env.SETTLEMENT_LEDGER_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
