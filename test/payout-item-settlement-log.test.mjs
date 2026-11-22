import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applyPayoutItemUpdate } from '../src/paypal-webhook-server.mjs';
import { EvidenceIntegrityChain } from '../src/real/evidence-integrity.mjs';
import { openSettlementBlocks, readSettlementBlocks } from '../src/resilience/settlement-blocks.mjs';
import { RedressEngine } from '../src/resilience/redress.mjs';

// Capture ids in the shape PayPal issues (17 uppercase alphanumerics).
const CAPTURE = '5O190127TN364715T';

/** A payout item the webhook is completing, with the row it is meant to settle. */
function payoutItem() {
  return {
    id: 'pi-1',
    item_id: 'ITEM-1',
    paypal_item_id: 'PAYOUT-ITEM-1',
    batch_id: null,
    recipient: '007810000448500030594182',
    amount: 19,
    revenue_event_id: 'rev-1',
    status: 'processing'
  };
}

function revenueRow(metadata) {
  return {
    id: 'rev-1',
    created_date: '2026-11-20T10:00:00.000Z',
    amount: 19,
    currency: 'USD',
    occurred_at: '2026-11-20T09:59:00.000Z',
    event_id: 'CAPTURE-EVENT-1',
    status: 'VERIFIED',
    metadata
  };
}

function payoutUpdate() {
  return {
    paypalItemId: 'PAYOUT-ITEM-1',
    paypalTxnId: 'PAYOUT-TXN-1',
    status: 'success',
    processedAt: '2026-11-22T10:00:00.000Z',
    paypalStatus: 'SUCCESS',
    webhookEventId: 'WH-1',
    webhookEventType: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED'
  };
}

function fakeBase44(row) {
  const itemUpdates = [];
  const revenueUpdates = [];
  const item = payoutItem();
  return {
    itemUpdates,
    revenueUpdates,
    base44: {
      asServiceRole: {
        entities: {
          PayoutItem: {
            filter: async () => [item],
            update: async (id, patch) => {
              itemUpdates.push({ id, patch });
              return { ...item, id, ...patch };
            }
          },
          PayoutBatch: { filter: async () => [] },
          TransactionLog: {
            filter: async () => [],
            create: async data => ({ id: 'tx-1', ...data })
          },
          RevenueEvent: {
            filter: async () => (row ? [row] : []),
            update: async (id, patch) => {
              revenueUpdates.push({ id, patch });
              return { id, ...patch };
            }
          }
        }
      }
    }
  };
}

/** The chain and the velocity breaker are tested where they live. */
function stubGateDependencies(t) {
  const saved = {
    fetch: EvidenceIntegrityChain.fetchBlockForEvent,
    add: EvidenceIntegrityChain.addBlock,
    assert: EvidenceIntegrityChain.assertEventBound,
    allowed: RedressEngine.prototype.isSettlementAllowed
  };
  EvidenceIntegrityChain.fetchBlockForEvent = async () => null;
  EvidenceIntegrityChain.addBlock = async (eventId, proof) => ({ eventId, proof });
  EvidenceIntegrityChain.assertEventBound = async () => true;
  RedressEngine.prototype.isSettlementAllowed = () => true;
  t.after(() => {
    EvidenceIntegrityChain.fetchBlockForEvent = saved.fetch;
    EvidenceIntegrityChain.addBlock = saved.add;
    EvidenceIntegrityChain.assertEventBound = saved.assert;
    RedressEngine.prototype.isSettlementAllowed = saved.allowed;
  });
}

/** The block log lives on disk, so point it at this test's own file. */
function useBlockLog(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payout-settlement-'));
  const file = path.join(dir, 'settlement-blocks.ndjson');
  const previous = process.env.SETTLEMENT_BLOCK_LOG;
  process.env.SETTLEMENT_BLOCK_LOG = file;
  t.after(() => {
    if (previous === undefined) delete process.env.SETTLEMENT_BLOCK_LOG;
    else process.env.SETTLEMENT_BLOCK_LOG = previous;
  });
  return file;
}

/** A registry that has received a verified webhook for this capture. */
function useRegistry(t, ids) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payout-registry-'));
  const file = path.join(dir, 'verified-webhooks.ndjson');
  fs.writeFileSync(
    file,
    ids.map(id => JSON.stringify({ provider: 'paypal', psp_id: id })).join('\n') + '\n',
    'utf8'
  );
  const previous = process.env.PSP_WEBHOOK_REGISTRY_FILE;
  process.env.PSP_WEBHOOK_REGISTRY_FILE = file;
  t.after(() => {
    if (previous === undefined) delete process.env.PSP_WEBHOOK_REGISTRY_FILE;
    else process.env.PSP_WEBHOOK_REGISTRY_FILE = previous;
  });
}

test('a refused settlement writes a blocked line and does not mark revenue paid_out', async t => {
  stubGateDependencies(t);
  const logFile = useBlockLog(t);
  const { base44, itemUpdates, revenueUpdates } = fakeBase44(revenueRow({
    verification_proof: {
      type: 'autonomous_execution',
      psp_id: 'PROOF_1767462283250',
      amount: 19,
      currency: 'USD'
    }
  }));

  const result = await applyPayoutItemUpdate(base44, payoutUpdate());

  assert.equal(result.ok, true, 'the payout item itself is still recorded as PayPal reported it');
  assert.equal(result.revenueUpdated, false);
  assert.equal(result.revenueSettlement.reason, 'self_issued_proof');
  assert.equal(itemUpdates.length, 1, 'the payout item line is written');
  assert.equal(itemUpdates[0].patch.status, 'success');
  assert.deepEqual(revenueUpdates, [], 'nothing may be written to a refused revenue row');

  const log = readSettlementBlocks(process.cwd(), { env: process.env });
  assert.equal(log.path, logFile);
  assert.equal(log.records.length, 1, 'the refusal must reach the block log, not only stderr');
  assert.equal(log.records[0].outcome, 'blocked');
  assert.equal(log.records[0].revenue_event_id, 'rev-1');
  assert.equal(log.records[0].psp_transaction_id, 'PAYOUT-TXN-1');
  assert.equal(log.records[0].reason, 'self_issued_proof');
  assert.equal(log.records[0].webhook_event_id, 'WH-1');
});

test('an approved settlement marks revenue paid_out and invents no log when nothing is open', async t => {
  stubGateDependencies(t);
  const logFile = useBlockLog(t);
  useRegistry(t, [CAPTURE]);
  const { base44, revenueUpdates } = fakeBase44(revenueRow({ paypal_capture_id: CAPTURE }));

  const result = await applyPayoutItemUpdate(base44, payoutUpdate());

  assert.equal(result.ok, true);
  assert.equal(result.revenueUpdated, true);
  assert.equal(result.revenueSettlement.ok, true);
  assert.equal(revenueUpdates.length, 1);
  assert.equal(revenueUpdates[0].id, 'rev-1');
  assert.equal(revenueUpdates[0].patch.status, 'paid_out');
  assert.equal(fs.existsSync(logFile), false, 'no block has ever been written, so there is nothing to close');
});

test('a block followed by a successful settlement is closed, not left open', async t => {
  stubGateDependencies(t);
  useBlockLog(t);

  const refused = fakeBase44(revenueRow({
    verification_proof: {
      type: 'autonomous_execution',
      psp_id: 'PROOF_1767462283250',
      amount: 19,
      currency: 'USD'
    }
  }));
  const first = await applyPayoutItemUpdate(refused.base44, payoutUpdate());
  assert.equal(first.revenueUpdated, false);

  useRegistry(t, [CAPTURE]);
  const settled = fakeBase44(revenueRow({ paypal_capture_id: CAPTURE }));
  const second = await applyPayoutItemUpdate(settled.base44, payoutUpdate());
  assert.equal(second.revenueUpdated, true);

  const log = readSettlementBlocks(process.cwd(), { env: process.env });
  assert.equal(log.records.length, 2, 'both lines are kept as history');
  assert.equal(log.records[1].outcome, 'settled');
  assert.equal(log.records[1].revenue_event_id, 'rev-1');
  assert.deepEqual(openSettlementBlocks(log.records), []);
});
