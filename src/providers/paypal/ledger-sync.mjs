import { getPayoutBatchDetails, paypalRequest, getPayPalAccessToken } from "../../paypal-api.mjs";
import { getPayoutBatchConfigFromEnv, getPayoutItemConfigFromEnv } from "../../base44-payout.mjs";
import { getRevenueConfigFromEnv } from "../../base44-revenue.mjs";
import { proveMoneyMoved } from "../../proofs/prove-money-moved.mjs";
import { EvidenceIntegrityChain } from "../../real/evidence-integrity.mjs";
import { MoneyMovedGate } from "../../real/money-moved-gate.mjs";
import { OWNER_ACCOUNTS } from "../../owner-directive.mjs";
import { recordSettlementSettled } from "../../resilience/settlement-blocks.mjs";

async function findOneBy(entity, filter) {
  const res = await entity.filter(filter, "-created_date", 1, 0);
  return Array.isArray(res) && res[0] ? res[0] : null;
}

async function listAll(entity, filter) {
  // Simple pagination for now
  return entity.filter(filter, "-created_date", 1000, 0); 
}

export async function syncPayPalBatchToLedger(base44, { batchId, paypalBatchId, dryRun = false }) {
  const batchCfg = getPayoutBatchConfigFromEnv();
  const itemCfg = getPayoutItemConfigFromEnv();
  const revCfg = getRevenueConfigFromEnv();

  const batchEntity = base44.asServiceRole.entities[batchCfg.entityName];
  const itemEntity = base44.asServiceRole.entities[itemCfg.entityName];
  const revEntity = base44.asServiceRole.entities[revCfg.entityName];

  // 1. Resolve internal batch
  let internalBatch = null;
  if (batchId) {
    internalBatch = await findOneBy(batchEntity, { [batchCfg.fieldMap.batchId]: batchId });
  } else if (paypalBatchId) {
    internalBatch = await findOneBy(batchEntity, { [batchCfg.fieldMap.providerBatchId]: paypalBatchId });
  }

  if (!internalBatch) {
    throw new Error(`Internal payout batch not found for id=${batchId} or provider_id=${paypalBatchId}`);
  }

  const internalId = internalBatch.id;
  const currentProviderId = internalBatch[batchCfg.fieldMap.providerBatchId];
  
  // 2. Resolve PayPal Batch ID
  let targetPayPalId = paypalBatchId || currentProviderId;
  
  // If we don't have the PayPal ID yet, we might try to find it via sender_batch_id (which is usually our batchId)
  // But standard PayPal API get-payout requires the Payout Batch ID (returned at creation).
  // If we don't have it, we might be stuck unless we stored it. 
  // Assumption: We stored it during creation. If not, we can't sync.
  
  if (!targetPayPalId) {
     return { 
       ok: false, 
       error: "missing_provider_id", 
       batchId: internalBatch[batchCfg.fieldMap.batchId],
       message: "Cannot sync without PayPal Payout Batch ID"
     };
  }

  // 3. Fetch from PayPal
  let ppBatch;
  try {
    const res = await getPayoutBatchDetails(targetPayPalId);
    ppBatch = await res.json();
  } catch (err) {
    return { ok: false, error: "paypal_api_error", details: err.message };
  }

  if (ppBatch.name === "RESOURCE_NOT_FOUND") {
     return { ok: false, error: "not_found_at_provider", paypalBatchId: targetPayPalId };
  }

  // 4. Map Status
  // PayPal statuses: PENDING, SUCCESS, DENIED, PROCESSING, CANCELED
  const ppStatus = ppBatch.batch_header.batch_status;
  const mappedStatus = mapPayPalStatus(ppStatus);

  const updates = {
    batch: null,
    items: [],
    revenues: []
  };

  // 5. Update Batch
  if (!dryRun) {
    if (internalBatch[batchCfg.fieldMap.status] !== mappedStatus) {
      await batchEntity.update(internalId, {
        [batchCfg.fieldMap.status]: mappedStatus
      });
      updates.batch = { from: internalBatch[batchCfg.fieldMap.status], to: mappedStatus };
    }
  } else {
    updates.batch = { from: internalBatch[batchCfg.fieldMap.status], to: mappedStatus, dryRun: true };
  }

  // 6. Update Items
  // We need to match PayPal items to our items. 
  // PayPal items have `payout_item_id` (which is PayPal's ID) and `payout_item.sender_item_id` (which should be ours).
  
  const internalItems = await listAll(itemEntity, { [itemCfg.fieldMap.batchId]: internalBatch[batchCfg.fieldMap.batchId] });
  const internalItemMap = new Map(internalItems.map(i => [i[itemCfg.fieldMap.itemId], i]));

  for (const ppItem of ppBatch.items) {
    const senderItemId = ppItem.payout_item.sender_item_id;
    const itemRec = internalItemMap.get(senderItemId);
    
    if (!itemRec) continue;

    const itemStatus = mapPayPalItemStatus(ppItem.transaction_status);
    const itemUpdates = {};
    
    // Update status
    if (itemRec[itemCfg.fieldMap.status] !== itemStatus) {
      itemUpdates[itemCfg.fieldMap.status] = itemStatus;
    }
    
    // Update transaction ID if available
    if (ppItem.transaction_id && itemRec[itemCfg.fieldMap.transactionId] !== ppItem.transaction_id) {
      itemUpdates[itemCfg.fieldMap.transactionId] = ppItem.transaction_id;
    }

    if (Object.keys(itemUpdates).length > 0) {
      updates.items.push({ id: itemRec.id, ...itemUpdates });
      if (!dryRun) {
        await itemEntity.update(itemRec.id, itemUpdates);
      }

      // 7. Update Revenue Event if Item is SUCCESS/FAILED
      const revId = itemRec[itemCfg.fieldMap.revenueEventId];
      if (revId) {
        let revStatus = null;
        let proofData = null;

        if (itemStatus === "completed") {
          revStatus = "paid_out"; // Money moved!
          
          if (!dryRun) {
             // 🔐 AGENTIC AI SECURITY: PROVE MONEY MOVED
             // We verify the movement against the provider before considering it "done" in our ledger.
             try {
                 const extId = ppItem.transaction_id || itemRec[itemCfg.fieldMap.transactionId];
                 
                 // 1. Construct Proof
                 proofData = {
                     type: 'paypal_payout_item',
                     psp_id: extId,
                     amount: Number(itemRec[itemCfg.fieldMap.amount]),
                     currency: itemRec[itemCfg.fieldMap.currency],
                     timestamp: ppItem.time_processed || new Date().toISOString(),
                     recipient: ppItem.payout_item.receiver
                 };

                 // SECURITY CHECK: Verify Recipient is OWNER
                 // We don't just trust the PSP, we verify it matches our Owner Directive
                 const actualRecipient = ppItem.payout_item.receiver;
                 const ownerEmail = OWNER_ACCOUNTS.paypal.email;
                 
                 if (actualRecipient.toLowerCase() !== ownerEmail.toLowerCase()) {
                     throw new Error(`CRITICAL: Money moved to UNAUTHORIZED RECIPIENT: ${actualRecipient}. Expected: ${ownerEmail}`);
                 }

                 // 2. Add to Evidence Integrity Chain
                 await EvidenceIntegrityChain.addBlock(revId, proofData);

                 // 3. Fetch Revenue Event for Gate Check
                 const revRecForGate = await findOneBy(revEntity, { id: revId });
                 if (!revRecForGate) throw new Error(`RevenueEvent ${revId} not found during gate check`);

                 // 4. Assert Money Moved (Hard Gate)
                 const eventForGate = {
                     ...revRecForGate,
                     verification_proof: proofData,
                     settled: false // We are asserting BEFORE settlement/payout marking
                 };
                 await MoneyMovedGate.assertMoneyMoved(eventForGate);

                 // 5. Legacy Proof (Optional, for redundancy)
                 if (extId) {
                     await proveMoneyMoved({
                         ledgerEntry: {
                             id: itemRec.id,
                             external_tx_id: extId,
                             amount: Number(itemRec[itemCfg.fieldMap.amount]), 
                             currency: itemRec[itemCfg.fieldMap.currency]
                         },
                         destination: {
                             type: "PAYPAL",
                             address: ppItem.payout_item.receiver
                         }
                     });
                 }
                 
                 console.log(`✅ [MoneyMovedGate] PASSED for RevenueEvent ${revId}`);

             } catch (proofErr) {
                 console.error(`[LedgerSync] 🚨 PROOF/GATE FAILED for item ${itemRec.id}:`, proofErr);
                 // CRITICAL: If Gate fails, we MUST NOT mark as paid_out.
                 revStatus = "payout_failed"; // Or keep as processing?
                 // We revert status to failed/processing to prevent false settlement.
             }
          }
        }
        if (itemStatus === "failed" || itemStatus === "returned") revStatus = "payout_failed";

        if (revStatus) {
          const revRec = await findOneBy(revEntity, { id: revId });
          if (revRec && revRec[revCfg.fieldMap.status] !== revStatus) {
             updates.revenues.push({ id: revId, status: revStatus });
             if (!dryRun) {
               const updatePayload = { [revCfg.fieldMap.status]: revStatus };
               
               // Attach proof metadata if available and successful
               if (revStatus === "paid_out" && proofData) {
                   const existingMeta = revRec[revCfg.fieldMap.metadata] || {};
                   updatePayload[revCfg.fieldMap.metadata] = {
                       ...existingMeta,
                       verification_proof: proofData,
                       money_moved_gate_passed: true,
                       gate_passed_at: new Date().toISOString()
                   };
               }
               
               await revEntity.update(revId, updatePayload);
               if (revStatus === "paid_out") {
                 // This is the other path that settles revenue. Without a
                 // closing line here, a block the webhook wrote for this row
                 // would stay open forever after the batch sync fixed it.
                 recordSettlementSettled(process.cwd(), { revenue_event_id: revId });
               }
             }
          }
        }
      }
    }
  }

  return {
    ok: true,
    batchId: internalBatch[batchCfg.fieldMap.batchId],
    paypalBatchId: targetPayPalId,
    status: ppStatus,
    mappedStatus,
    updates
  };
}

function mapPayPalStatus(status) {
  switch (String(status).toUpperCase()) {
    case "SUCCESS": return "completed";
    case "PENDING": return "processing";
    case "PROCESSING": return "processing";
    case "DENIED": return "failed";
    case "CANCELED": return "cancelled";
    default: return "processing";
  }
}

function mapPayPalItemStatus(status) {
  switch (String(status).toUpperCase()) {
    case "SUCCESS": return "completed";
    case "FAILED": return "failed";
    case "PENDING": return "processing";
    case "UNCLAIMED": return "unclaimed";
    case "RETURNED": return "returned";
    case "ONHOLD": return "on_hold";
    case "BLOCKED": return "blocked";
    case "REFUNDED": return "refunded";
    case "REVERSED": return "reversed";
    default: return "processing";
  }
}
