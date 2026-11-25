// scripts/auto-settlement-daemon.mjs
// AUTONOMOUS SETTLEMENT: Immediate owner payouts with ZERO unnecessary delays

import {
  OWNER_ACCOUNTS,
  enforceOwnerDirective,
  selectOptimalOwnerAccount,
  generateOwnerPayoutConfig,
  validateOwnerDirectiveSetup,
  preExecutionOwnerCheck
} from './src/owner-directive.mjs';
import { buildBase44Client } from './src/base44-client.mjs';
import { authorizeRevenueSettlement, getRevenueConfigFromEnv } from './src/base44-revenue.mjs';
import { createPayPalPayoutBatch } from './src/paypal-api.mjs';
import {
  PAYOUT_EVIDENCE_FAILED,
  PAYOUT_EVIDENCE_SETTLED,
  PAYOUT_EVIDENCE_UNKNOWN,
  readPayoutClaimEvidence
} from './src/financial/payout-claim-evidence.mjs';
import {
  clearEmergencyStop,
  latchEmergencyStop,
  readEmergencyStop
} from './src/financial/settlement-emergency-stop.mjs';
import {
  claimPayoutBatch,
  claimedRevenueEventIds,
  confirmPayoutBatch,
  exportedClaimsAwaitingConfirmation,
  openPayoutClaims,
  readPayoutClaims,
  recordPayoutOutcome,
  resolvePayoutClaim,
  PAYOUT_CLAIM_CLOSED,
  PAYOUT_CLAIM_EXECUTED
} from './src/financial/payout-claims.mjs';
import { pathToFileURL } from 'url';
import crypto from 'node:crypto';
import fs from 'fs';
import path from 'path';
import './src/load-env.mjs';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Settlement frequency - start conservative
  CHECK_INTERVAL_MS: Number(process.env.SETTLEMENT_CHECK_INTERVAL_MS) || 5 * 60 * 1000, // Check every 5 minutes

  // Gradual auto-approval thresholds (increases over time)
  AUTO_APPROVE_THRESHOLD: {
    week1: Number(process.env.AUTO_APPROVE_THRESHOLD_WEEK1) || 100,    // $100 max for first week
    week2: Number(process.env.AUTO_APPROVE_THRESHOLD_WEEK2) || 500,    // $500 max for second week
    week3: Number(process.env.AUTO_APPROVE_THRESHOLD_WEEK3) || 1000,   // $1,000 max for third week
    default: Number(process.env.AUTO_APPROVE_THRESHOLD_DEFAULT) || 5000 // $5,000 max after 3 weeks
  },

  // Batch configuration
  MIN_BATCH_SIZE: 1, // Settle even single events
  MAX_BATCH_SIZE: 100, // Max events per batch

  // Settlement urgency - gradual release (batch small amounts)
  MAX_SETTLEMENT_DELAY_HOURS: Number(process.env.MAX_SETTLEMENT_DELAY_HOURS) || 24, // Hold an event this long before settling it
  MIN_SETTLEMENT_AMOUNT: Number(process.env.MIN_SETTLEMENT_AMOUNT) || 10, // Don't settle amounts under $10

  // Rail preferences (in order)
  RAIL_PRIORITY: ['PAYPAL', 'BANK_WIRE', 'PAYONEER'],

  // Modes
  ENABLE_IMMEDIATE_SETTLEMENT: false, // Start with batching for safety
  ENABLE_EMERGENCY_MODE: false, // Bypass all checks (use with caution)

  // Deployment tracking
  DEPLOYMENT_START_DATE: new Date(process.env.DEPLOYMENT_START_DATE || '2026-01-04'),
};

/**
 * A reversal is stored as a negative revenue event. Settling one would pay the
 * owner for money that was taken back, so only strictly positive amounts are
 * ever payouts.
 */
function isSettleableAmount(event) {
  const amount = Number(event?.amount);
  return Number.isFinite(amount) && amount > 0;
}

/**
 * PayPal rejects a reused `sender_batch_id` for 30 days, so the id must be a
 * function of the batch contents, not of when the batch was built. A retry of
 * the same events then reproduces the id and is refused by the provider
 * instead of paying twice.
 */
export function computeBatchId(rail, events) {
  const content = (events ?? [])
    .map(event => String(event?.id ?? ''))
    .filter(Boolean)
    .sort()
    .join('\n');
  const digest = crypto.createHash('sha256').update(content).digest('hex').slice(0, 24);
  return `BATCH_${rail}_${digest}`;
}

// Helper function to get current auto-approve threshold based on deployment age
function getCurrentAutoApproveThreshold() {
  const now = new Date();
  const daysSinceDeployment = Math.floor(
    (now - CONFIG.DEPLOYMENT_START_DATE) / (1000 * 60 * 60 * 24)
  );

  if (daysSinceDeployment < 7) return CONFIG.AUTO_APPROVE_THRESHOLD.week1;
  if (daysSinceDeployment < 14) return CONFIG.AUTO_APPROVE_THRESHOLD.week2;
  if (daysSinceDeployment < 21) return CONFIG.AUTO_APPROVE_THRESHOLD.week3;
  return CONFIG.AUTO_APPROVE_THRESHOLD.default;
}


// ============================================================================
// STATE MANAGEMENT
// ============================================================================

class SettlementState {
  constructor() {
    this.running = false;
    // Latched: once stopped, this process sends no further payout. Only a
    // restart clears it, so a stray config write cannot resume payments.
    this.emergencyStopped = false;
    this.lastCheck = null;
    this.lastSettlement = null;
    this.totalSettled = 0;
    this.settlementCount = 0;
    this.errors = [];
  }

  markCheck() {
    this.lastCheck = new Date().toISOString();
  }

  markSettlement(amount) {
    this.lastSettlement = new Date().toISOString();
    this.totalSettled += amount;
    this.settlementCount += 1;
  }

  addError(error) {
    this.errors.push({
      timestamp: new Date().toISOString(),
      message: error.message,
      stack: error.stack
    });
    // Keep only last 50 errors
    if (this.errors.length > 50) {
      this.errors = this.errors.slice(-50);
    }
  }

  getStatus() {
    return {
      running: this.running,
      emergencyStopped: this.emergencyStopped,
      lastCheck: this.lastCheck,
      lastSettlement: this.lastSettlement,
      totalSettled: this.totalSettled,
      settlementCount: this.settlementCount,
      errorCount: this.errors.length,
      uptime: this.running ? Date.now() - new Date(this.lastCheck).getTime() : 0
    };
  }
}

const state = new SettlementState();
let activeIntervalId = null;

/**
 * The stop latch lives on disk, not only in this process: a stop a restart
 * forgets is no stop at all, and startup runs a cycle immediately. Reading it
 * here also brings this process's in-memory latch up to date.
 */
function emergencyStopState() {
  const latch = readEmergencyStop(process.cwd());
  if (latch.stopped) state.emergencyStopped = true;
  return latch;
}

function emergencyStopMessage(latch) {
  const detail = latch.error
    ? `the latch at ${latch.path} could not be read (${latch.error})`
    : `latched at ${latch.at ?? 'an unknown time'}${latch.reason ? ` (${latch.reason})` : ''}`;
  return `EMERGENCY_STOP: settlement is halted — ${detail}; clear it with --clear-emergency-stop`;
}

// ============================================================================
// MAIN SETTLEMENT LOOP
// ============================================================================

export async function startAutoSettlementDaemon() {
  console.log('🚀 Starting Autonomous Settlement Daemon...');
  console.log('📋 Configuration:', JSON.stringify(CONFIG, null, 2));

  // Validate owner directive setup
  try {
    validateOwnerDirectiveSetup();
    console.log('✅ Owner Directive validated');
  } catch (error) {
    console.error('❌ Owner Directive validation failed:', error.message);
    process.exit(1);
  }

  const latch = emergencyStopState();
  if (state.emergencyStopped || latch.stopped) {
    throw new Error(emergencyStopMessage(latch));
  }

  state.running = true;
  console.log('✅ Daemon started - settlements will be processed every', CONFIG.CHECK_INTERVAL_MS / 1000, 'seconds');

  // Initial immediate check
  await performSettlementCycle();

  // Schedule regular checks
  const intervalId = setInterval(async () => {
    if (state.emergencyStopped) {
      clearInterval(intervalId);
      activeIntervalId = null;
      return;
    }
    try {
      await performSettlementCycle();
    } catch (error) {
      console.error('❌ Settlement cycle error:', error);
      state.addError(error);
    }
  }, CONFIG.CHECK_INTERVAL_MS);
  activeIntervalId = intervalId;

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down settlement daemon...');
    clearInterval(intervalId);
    state.running = false;
    console.log('📊 Final stats:', state.getStatus());
    process.exit(0);
  });

  return intervalId;
}

/**
 * Main settlement cycle - runs periodically
 */
export async function performSettlementCycle() {
  const latch = emergencyStopState();
  if (state.emergencyStopped || latch.stopped) {
    console.log(`⛔ Emergency stop is latched: no settlement will be attempted. ${emergencyStopMessage(latch)}`);
    return;
  }

  state.markCheck();
  console.log(`\n🔄 [${new Date().toISOString()}] Starting settlement cycle...`);

  try {
    // Step 0: Reconcile whatever a previous process left in flight. This runs
    // before any payout is chosen, because a batch claimed by a crashed cycle
    // may already have been sent.
    const claims = await reconcilePayoutClaims();
    if (claims.blocked) return;

    // Step 1: Fetch verified revenue events ready for settlement. Rows an open
    // claim reserves are withheld: the money may already be on its way.
    const readyEvents = (await fetchReadyForSettlement())
      .filter(event => !claims.claimedEventIds.has(String(event.id)));

    if (readyEvents.length === 0) {
      console.log('✅ No events ready for settlement');
      return;
    }

    console.log(`📦 Found ${readyEvents.length} events ready for settlement`);

    // Step 2: Group events by optimal rail
    const batchesByRail = groupEventsByRail(readyEvents);

    // Step 3: Process each rail batch
    for (const [rail, events] of Object.entries(batchesByRail)) {
      console.log(`\n💰 Processing ${rail} batch: ${events.length} events`);

      try {
        await processRailBatch(rail, events);
      } catch (error) {
        console.error(`❌ Failed to process ${rail} batch:`, error.message);
        state.addError(error);
      }
    }

  } catch (error) {
    console.error('❌ Settlement cycle error:', error);
    state.addError(error);
  }
}

/**
 * A row the ledger shows was acted on: settled, paid, or exported for a human
 * to transfer. Only such a row can close a claim without a second payout.
 */
function revenueRowAccountedFor(row) {
  const status = String(row?.status ?? '').trim().toLowerCase();
  return row?.settled === true || row?.paid_out === true || ['paid_out', 'settled', 'export_ready'].includes(status);
}

/**
 * Reconciles the payout claims a previous process left open.
 *
 * The provider is the only witness to whether a request arrived, and the crash
 * may have happened after it left, so a claim cannot always be settled from
 * this side. What can be checked is used: a claim whose rows are now accounted
 * for is closed, one whose rail already reported success finishes the marks it
 * was interrupted before, and — for a claim with no recorded outcome — the
 * payout items the provider's webhook left are read, because a payout that
 * really happened must not leave its rows unpaid and its claim stuck forever.
 * Anything that cannot be checked stays open and its rows are withheld from
 * every later batch, because a retry could send the same money again.
 */
async function reconcilePayoutClaims() {
  const store = readPayoutClaims(process.cwd());
  if (store.error) {
    const message =
      `PAYOUT_CLAIM_STORE_UNREADABLE: ${store.error}; refusing to pay while it is unknown whether a payout is in flight`;
    console.error(`❌ ${message}`);
    process.stderr.write(`FINDING PAYOUT_CLAIM_STORE_UNREADABLE [critical] ${message}\n`);
    state.addError(new Error(message));
    return { blocked: true, claimedEventIds: new Set() };
  }

  const open = openPayoutClaims(store.claims);
  if (open.length === 0) return { blocked: false, claimedEventIds: new Set() };

  const base44 = await buildBase44Client();
  const revenueConfig = getRevenueConfigFromEnv();
  const revenueEntity = base44.asServiceRole.entities[revenueConfig.entityName];
  const unresolved = [];

  for (const claim of open) {
    const eventIds = (claim.revenue_event_ids ?? []).map(id => String(id));
    let rows;
    try {
      rows = [];
      for (const id of eventIds) {
        const found = await revenueEntity.filter({ id }, '-created_date', 1, 0);
        rows.push(Array.isArray(found) && found[0] ? found[0] : null);
      }
    } catch (error) {
      unresolved.push({ claim, reason: `the ledger could not be read: ${error?.message ?? error}` });
      continue;
    }

    if (rows.length > 0 && rows.every(revenueRowAccountedFor)) {
      recordPayoutOutcome(process.cwd(), claim.batch_id, { status: PAYOUT_CLAIM_CLOSED });
      console.log(`✅ Payout claim ${claim.batch_id} reconciled: its rows are already accounted for.`);
      continue;
    }

    const rowsPresent = rows.length > 0 && rows.every(row => row);
    const recorded = claim.status === PAYOUT_CLAIM_EXECUTED && claim.execution ? claim.execution : null;

    // What the rail recorded beats what must be inferred; with neither, the
    // provider's payout items are the only witness left.
    const evidence = rowsPresent && !recorded
      ? await readPayoutClaimEvidence(base44, claim).catch(error => ({
          outcome: PAYOUT_EVIDENCE_UNKNOWN,
          reason: `the payout items could not be read: ${error?.message ?? error}`
        }))
      : null;

    const execution = recorded ?? (evidence?.outcome === PAYOUT_EVIDENCE_SETTLED
      ? {
          method: 'payout_item_evidence',
          provider_batch_id: evidence.provider_batch_id ?? claim.batch_id,
          provider_transaction_id: evidence.transaction_id ?? null
        }
      : null);

    // Finishing the marks records a payout that already happened, whichever
    // source proved it: it cannot move money a second time.
    if (execution && rowsPresent) {
      const failed = await markEventsSettled(rows, claim.batch_id, execution);
      if (failed.length === 0) {
        recordPayoutOutcome(process.cwd(), claim.batch_id, { status: PAYOUT_CLAIM_CLOSED, execution });
        console.log(`✅ Payout claim ${claim.batch_id} completed from the ${execution.method === 'payout_item_evidence' ? "provider's payout items" : 'recorded payout'}.`);
        continue;
      }
      unresolved.push({ claim, reason: `its payout was recorded but the rows could not be marked: ${failed.join(', ')}` });
      continue;
    }

    // Only a failure recorded against *this* batch frees the rows: an older
    // failed payout item for the same row says nothing about this one.
    if (evidence?.outcome === PAYOUT_EVIDENCE_FAILED) {
      resolvePayoutClaim(process.cwd(), claim.batch_id, {
        note: 'payout items record this batch as failed',
        resolvedBy: 'payout_item_evidence'
      });
      console.log(`✅ Payout claim ${claim.batch_id} closed: the provider records it as failed, so its rows are payable again.`);
      continue;
    }

    unresolved.push({
      claim,
      reason: evidence?.reason ?? (rowsPresent
        ? 'its rail was called but no outcome was recorded'
        : 'some of its rows are no longer in the ledger')
    });
  }

  for (const { claim, reason } of unresolved) {
    const rows = (claim.revenue_event_ids ?? []).join(', ');
    const message =
      `PAYOUT_CLAIM_UNRESOLVED: batch ${claim.batch_id} (${claim.rail}) claimed ${claim.claimed_at} may ` +
      `already have moved ${claim.amount} ${claim.currency}; rows ${rows} are withheld: ${reason}. ` +
      `Confirm with the provider, then close it with --resolve-claim ${claim.batch_id} if nothing arrived.`;
    console.error(`⚠️ ${message}`);
    process.stderr.write(`FINDING PAYOUT_CLAIM_UNRESOLVED [critical] ${message}\n`);
    state.addError(new Error(message));
  }

  return {
    blocked: false,
    claimedEventIds: claimedRevenueEventIds(unresolved.map(item => item.claim))
  };
}

// ============================================================================
// DATA FETCHING
// ============================================================================

/**
 * Fetches revenue events that are verified and ready for settlement
 */
async function fetchReadyForSettlement() {
  const base44 = await buildBase44Client();
  const revenueConfig = getRevenueConfigFromEnv();
  const revenueEntity = base44.asServiceRole.entities[revenueConfig.entityName];

  try {
    // We need to fetch all and filter because listing with complex filters might be limited
    // depending on the SDK/API capabilities.
    let allEvents = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      // list(sort, limit, offset)
      const items = await revenueEntity.list("-created_date", limit, offset);
      if (!items || !Array.isArray(items) || items.length === 0) break;

      allEvents = allEvents.concat(items);

      if (items.length < limit) break;
      offset += limit;
    }

    const events = allEvents.filter(e =>
      e.status === 'VERIFIED' &&
      !e.settled &&
      !e.paid_out &&
      isSettleableAmount(e) &&
      e.verification_proof &&
      Object.keys(e.verification_proof).length > 0
    );

    // Hold an event for the batching window, then settle it. The window is a
    // lower bound on age: revenue that has already waited past it is due, and
    // a fresher event waits for a later cycle. Reading this comparison the
    // other way round held back every event that outlived the window, so old
    // revenue was never settled while fresh events were paid immediately.
    const dueEvents = events.filter(event => {
      // If immediate settlement is enabled, we take everything verified
      if (CONFIG.ENABLE_IMMEDIATE_SETTLEMENT) return true;

      const createdAt = new Date(event.created_at || event.timestamp).getTime();
      if (!Number.isFinite(createdAt)) return false; // an undateable event is never assumed due
      const ageHours = (Date.now() - createdAt) / (1000 * 60 * 60);
      return ageHours >= CONFIG.MAX_SETTLEMENT_DELAY_HOURS;
    });

    return dueEvents;
  } catch (error) {
    console.error('❌ Failed to fetch ready events:', error);
    return [];
  }
}

// ============================================================================
// BATCH PROCESSING
// ============================================================================

/**
 * Groups events by optimal payment rail
 */
function groupEventsByRail(events) {
  const batches = {};

  for (const event of events) {
    const account = selectOptimalOwnerAccount(event.amount, event.currency);
    const rail = account?.type;

    // Never guess: an event with no payable owner account is left for a human
    // instead of being routed to a rail that cannot pay it.
    if (!rail) {
      const message = `NO_PAYABLE_OWNER_ACCOUNT: ${event.id} (${event.amount} ${event.currency}) has no owner account this daemon can pay; left unsettled`;
      console.error(`❌ ${message}`);
      state.addError(new Error(message));
      continue;
    }

    if (!batches[rail]) {
      batches[rail] = [];
    }

    batches[rail].push(event);
  }

  return batches;
}

/**
 * Processes a batch of events for a specific rail
 */
async function processRailBatch(rail, events) {
  console.log(`⚡ Processing ${rail} batch: ${events.length} events`);

  // Step 1: Gate Check (Hard-Binding)
  // The payout is authorised by the row's own bound evidence. MoneyMovedGate
  // alone only proves that a block exists, so a block that disagreed with the
  // row (a payout moving an amount or capture the row never carried) was paid
  // here while the webhook path refused it. This is the same gate the webhook
  // path runs, so the two cannot disagree about what may be settled.
  const base44 = await buildBase44Client();
  const revenueConfig = getRevenueConfigFromEnv();
  const validEvents = [];
  for (const event of events) {
    try {
      if (!isSettleableAmount(event)) {
        throw new Error(`non-positive amount (${event.amount}); a reversal is not a payout`);
      }
      const authorization = await authorizeRevenueSettlement(base44, revenueConfig, {
        revenueEventId: event.id
      });
      if (!authorization.ok) {
        const detail = authorization.error || authorization.detail;
        throw new Error(`MONEY_GATE_FAIL: ${authorization.reason}${detail ? ` (${detail})` : ''}`);
      }
      validEvents.push(event);
    } catch (e) {
      console.error(`❌ Gate Check Failed for ${event.id}: ${e.message}`);
      state.addError(new Error(`Gate Check Failed for ${event.id}: ${e.message}`));
    }
  }

  if (validEvents.length === 0) {
    console.log('⚠️ No valid events after gate check.');
    return;
  }

  // Step 2: Create payout batch
  const batch = await createPayoutBatch(rail, validEvents);
  console.log(`📦 Created batch: ${batch.batch_id}`);

  // Step 3: Auto-approve (if under threshold)
  const totalAmount = validEvents.reduce((sum, e) => sum + Number(e.amount), 0);
  const currentThreshold = getCurrentAutoApproveThreshold();

  console.log(`💰 Batch amount: $${totalAmount.toFixed(2)}, Current threshold: $${currentThreshold}`);

  if (totalAmount <= currentThreshold || CONFIG.ENABLE_EMERGENCY_MODE) {
    console.log(`✅ Auto-approving batch ($${totalAmount.toFixed(2)} ${validEvents[0]?.currency || 'USD'})`);
    await approveBatch(batch.batch_id);
  } else {
    console.log(`⏳ Batch requires manual approval ($${totalAmount.toFixed(2)} ${validEvents[0]?.currency || 'USD'})`);
    return; // Wait for manual approval
  }

  // Step 4: Validate owner directive (CRITICAL)
  try {
    await preExecutionOwnerCheck({ batch });
    console.log('✅ Owner directive validated');
  } catch (error) {
    console.error('❌ Owner directive violation:', error.message);
    throw error;
  }

  // Step 5: Persist the claim. From here on the provider may hold a payout and
  // a restart must not send it again; this file is the only memory of that, so
  // it is flushed before the rail is called.
  const claim = claimPayoutBatch(process.cwd(), {
    batch_id: batch.batch_id,
    rail,
    revenue_event_ids: batch.revenue_event_ids,
    amount: totalAmount,
    currency: batch.currency
  });
  if (!claim.claimed) {
    const detail = claim.reason === 'already_claimed'
      ? `batch ${claim.existing?.batch_id ?? batch.batch_id} already claims these rows`
      : (claim.error ?? claim.reason);
    throw new Error(`PAYOUT_CLAIM_REFUSED: ${claim.reason}${detail ? ` (${detail})` : ''}`);
  }

  // Step 6: Execute settlement
  let executionResult;
  try {
    executionResult = await executeSettlement(rail, batch);
  } catch (error) {
    // The request may have reached the provider before it failed here. The
    // claim stays open with the error, so the next cycle refuses a retry.
    recordPayoutOutcome(process.cwd(), batch.batch_id, { error: String(error?.message ?? error) });
    throw error;
  }
  recordPayoutOutcome(process.cwd(), batch.batch_id, {
    status: PAYOUT_CLAIM_EXECUTED,
    execution: executionResult
  });

  // Step 7: Mark events as settled. A claim closes only once every row it paid
  // is marked; a row that could not be updated keeps the claim open, so the
  // next cycle completes the marks instead of paying again.
  const unmarked = await markEventsSettled(validEvents, batch.batch_id, executionResult);
  recordPayoutOutcome(process.cwd(), batch.batch_id, unmarked.length
    ? { status: PAYOUT_CLAIM_EXECUTED, error: `rows left unmarked: ${unmarked.join(', ')}` }
    : { status: PAYOUT_CLAIM_CLOSED, error: null });

  if (executionResult?.method === 'manual_csv') {
    console.log(`🗂️ Exported ${validEvents.length} events via ${rail}; awaiting the manual transfer`);
  } else {
    state.markSettlement(totalAmount);
    console.log(`✅ Settled ${validEvents.length} events via ${rail}`);
  }
}

// ============================================================================
// PAYOUT EXECUTION
// ============================================================================

/**
 * Creates a payout batch in the ledger
 */
async function createPayoutBatch(rail, events) {
  const totalAmount = events.reduce((sum, e) => sum + Number(e.amount), 0);
  const currency = events[0]?.currency || 'USD';

  const batch = {
    batch_id: computeBatchId(rail, events),
    rail,
    total_amount: totalAmount,
    currency,
    status: 'pending_approval',
    revenue_event_ids: events.map(e => e.id),
    items: events.map(e => ({
      ...generateOwnerPayoutConfig(Number(e.amount), e.currency),
      sender_item_id: e.id
    })),
    created_at: new Date().toISOString(),
    owner_directive_enforced: true
  };

  // Validate all destinations
  for (const item of batch.items) {
    enforceOwnerDirective({ payout: { beneficiary: item.receiver || item.recipient } });
  }

  console.log(`📝 Created batch object:`, {
    id: batch.batch_id,
    events: batch.revenue_event_ids.length,
    amount: totalAmount,
    currency
  });

  // NOTE: We don't have a specific PayoutBatch entity in Base44 setup yet based on previous files.
  // We usually store this state in the RevenueEvent itself (payout_batch_id) or a local JSON.
  // For now, we'll return the object and rely on marking events.

  return batch;
}

/**
 * Approves a payout batch
 */
async function approveBatch(batchId) {
  console.log(`✅ Approving batch: ${batchId}`);
  // If we had a PayoutBatch entity, we would update it here.
  return true;
}

/**
 * Executes settlement on the payment rail
 */
async function executeSettlement(rail, batch) {
  // Single choke point for all rails: a stop that lands after approval still
  // refuses to move money.
  if (state.emergencyStopped) {
    throw new Error('EMERGENCY_STOP: settlement halted before execution');
  }
  console.log(`🚀 Executing ${rail} settlement...`);

  switch (rail) {
    case 'PAYPAL':
      return await executePayPalSettlement(batch);

    case 'BANK_WIRE':
      return await executeBankWireSettlement(batch);

    case 'PAYONEER':
      return await executePayoneerSettlement(batch);

    default:
      throw new Error(`Unsupported rail: ${rail}`);
  }
}

/**
 * PayPal Payout execution
 */
async function executePayPalSettlement(batch) {
  console.log('💳 Executing PayPal payout...');

  const items = batch.items.map(item => ({
    recipient_type: item.recipient_type,
    amount: { value: Number(item.amount).toFixed(2), currency: item.currency },
    receiver: item.recipient, // Ensure this matches generateOwnerPayoutConfig output
    note: item.note,
    sender_item_id: item.sender_item_id
  }));

  try {
    const payout = await createPayPalPayoutBatch({
      senderBatchId: batch.batch_id,
      items,
      emailSubject: "Owner Revenue Settlement",
      emailMessage: "Autonomous settlement of verified revenue."
    });

    console.log(`✅ PayPal payout submitted! Batch ID: ${payout.batch_header.payout_batch_id}`);
    return { provider_batch_id: payout.batch_header.payout_batch_id };
  } catch (e) {
    console.error(`❌ PayPal Payout Failed: ${e.message}`);
    throw e;
  }
}

/**
 * Writes a manual payout instruction where the operator expects it, creating
 * the directory. A fresh checkout has no `exports/`, and the Payoneer rail used
 * to throw there — after its payout claim was written, which withheld the rows
 * until an operator intervened.
 */
function writeExportInstruction(filename, content) {
  const exportDir = path.resolve(process.cwd(), 'exports');
  fs.mkdirSync(exportDir, { recursive: true });
  const filePath = path.join(exportDir, filename);
  fs.writeFileSync(filePath, content);
  return filePath;
}

/**
 * Bank Wire execution (generates CSV for manual upload)
 */
async function executeBankWireSettlement(batch) {
  console.log('🏦 Generating Bank Wire CSV...');

  const filename = `bank_wire_${batch.batch_id}.csv`;
  const filePath = writeExportInstruction(filename, generateBankWireCSV(batch));

  console.log(`✅ Bank Wire CSV generated: ${filePath}`);

  return { export_filename: filename, method: 'manual_csv' };
}

/**
 * Payoneer execution (generates CSV for manual upload)
 */
async function executePayoneerSettlement(batch) {
  console.log('💼 Generating Payoneer CSV...');

  const filename = `payoneer_${batch.batch_id}.csv`;
  const filePath = writeExportInstruction(filename, generatePayoneerCSV(batch));

  console.log(`✅ Payoneer CSV generated: ${filePath}`);

  return { export_filename: filename, method: 'manual_csv' };
}

// ============================================================================
// CSV GENERATION
// ============================================================================

// The payee column is the destination the selection built for the item, never a
// registry constant: the rail and the payee are then chosen together, and a
// re-identified account cannot be paid at an id the selection did not return.
function generateBankWireCSV(batch) {
  const headers = 'Beneficiary RIB,Amount,Currency,Reference,Date';
  const rows = batch.items.map(item =>
    `${item.recipient},${item.amount},${item.currency},${item.sender_item_id},${new Date().toISOString()}`
  );
  return [headers, ...rows].join('\n');
}

function generatePayoneerCSV(batch) {
  const headers = 'Account ID,Amount,Currency,Description,Reference';
  const rows = batch.items.map(item =>
    `${item.recipient},${item.amount},${item.currency},${item.note},${item.sender_item_id}`
  );
  return [headers, ...rows].join('\n');
}

// ============================================================================
// MANUAL CSV CONFIRMATION
// ============================================================================

/** A row some other step already recorded as paid. */
function rowPaidOut(row) {
  return row?.settled === true || row?.paid_out === true || row?.status === 'paid_out';
}

/**
 * The second half of a manual CSV payout.
 *
 * A CSV batch ends at `export_ready`: the file is an instruction to a human, so
 * the daemon cannot know the transfer happened. Nothing used to move a row past
 * that state, which left exported revenue permanently unconfirmed and its batch
 * unpayable in any record. The operator who uploaded the file says so, and this
 * step records it: the batch's rows become `paid_out`, and the batch is stamped
 * as paid in the claim store.
 *
 * It refuses a batch that is not an export (another method paid it already), an
 * open claim (its money may still be on its way) and one closed as never sent
 * (there is no payment to record), and it verifies every row before writing any
 * — a row it cannot prove belongs to this batch leaves the ledger untouched.
 */
async function confirmExportedBatch(batchId, { by = 'operator', note = null } = {}) {
  const store = readPayoutClaims(process.cwd());
  if (store.error) throw new Error(`PAYOUT_CLAIM_STORE_UNREADABLE: ${store.error}`);

  const id = String(batchId ?? '').trim();
  const claim = store.claims.find(record => String(record?.batch_id ?? '') === id);
  if (!claim) throw new Error(`PAYOUT_BATCH_UNKNOWN: no payout claim records batch ${id || '(none given)'}`);
  if (openPayoutClaims([claim]).length > 0) {
    throw new Error(`PAYOUT_BATCH_UNRESOLVED: batch ${id} is still ${claim.status}; close its payout before confirming one`);
  }
  if (claim.resolution?.outcome === 'not_sent') {
    throw new Error(`PAYOUT_BATCH_NEVER_SENT: batch ${id} was closed as never sent, so there is no payment to confirm`);
  }
  // Only a CSV rail leaves rows at `export_ready` for a human to pay. A claim
  // another method paid is already settled by the rail that reported it, so an
  // operator's word must not overwrite that provenance.
  if (claim.execution?.method !== 'manual_csv') {
    throw new Error(
      `PAYOUT_BATCH_NOT_EXPORTED: batch ${id} was paid by ${claim.execution?.method ?? 'no recorded method'}, ` +
      'not exported as a CSV; only an exported batch is confirmed by hand'
    );
  }

  const base44 = await buildBase44Client();
  const revenueConfig = getRevenueConfigFromEnv();
  const revenueEntity = base44.asServiceRole.entities[revenueConfig.entityName];

  // Read every row before writing any of them. A batch that cannot be
  // confirmed whole is left whole, so a refusal never leaves a half-marked
  // batch behind for a retry to interpret.
  const rows = [];
  const refused = [];
  for (const rowId of (claim.revenue_event_ids ?? []).map(String)) {
    let row;
    try {
      const found = await revenueEntity.filter({ id: rowId }, '-created_date', 1, 0);
      row = Array.isArray(found) ? found[0] : null;
    } catch (error) {
      refused.push(`${rowId} (the ledger could not be read: ${error?.message ?? error})`);
      continue;
    }

    if (!row) {
      refused.push(`${rowId} (no longer in the ledger)`);
      continue;
    }
    // Ownership comes first: another batch's row is not evidence for this one,
    // even when it is already paid.
    if (String(row.payout_batch_id ?? '') !== id) {
      refused.push(`${rowId} (its payout batch is ${row.payout_batch_id ?? 'unrecorded'})`);
      continue;
    }
    if (!rowPaidOut(row) && row.status !== 'export_ready') {
      refused.push(`${rowId} (status ${row.status ?? 'unknown'}, not exported)`);
      continue;
    }
    rows.push(row);
  }

  if (refused.length > 0) {
    throw new Error(
      `PAYOUT_BATCH_UNCONFIRMED: batch ${id} was not confirmed and no row was marked: ${refused.join(', ')}`
    );
  }

  const confirmed = [];
  const alreadyPaid = [];
  for (const row of rows) {
    if (rowPaidOut(row)) {
      alreadyPaid.push(row.id);
      continue;
    }

    const at = new Date().toISOString();
    try {
      await revenueEntity.update(row.id, {
        ...row,
        status: 'paid_out',
        settled: true,
        paid_out: true,
        settled_at: at,
        confirmed_at: at,
        confirmed_by: by,
        settlement_details: {
          ...(row.settlement_details ?? {}),
          method: row.settlement_details?.method ?? 'manual_csv',
          paid_confirmed_by: by,
          paid_confirmed_at: at,
          ...(note ? { paid_confirmation_note: note } : {})
        }
      });
      confirmed.push(row.id);
    } catch (error) {
      // Some rows are already paid_out and the batch is not recorded as paid;
      // confirming it again skips them and finishes the rest.
      throw new Error(
        `PAYOUT_BATCH_PARTLY_CONFIRMED: batch ${id} marked ${confirmed.join(', ') || 'no row'} paid_out, but ` +
        `${row.id} could not be (${error?.message ?? error}); the batch is not recorded as paid — ` +
        'confirm it again to finish'
      );
    }
  }

  const recorded = confirmPayoutBatch(process.cwd(), id, { by, note });
  if (!recorded.confirmed && recorded.reason !== 'already_confirmed') {
    throw new Error(`PAYOUT_CONFIRMATION_NOT_RECORDED: ${recorded.reason}${recorded.error ? ` (${recorded.error})` : ''}`);
  }

  return {
    batch_id: id,
    rail: claim.rail,
    confirmed,
    already_paid: alreadyPaid,
    claim: recorded.claim ?? claim
  };
}

// ============================================================================
// STATE UPDATES
// ============================================================================

/**
 * Marks events as settled in the ledger
 */
async function markEventsSettled(events, batchId, executionResult) {
  // A CSV is an instruction to a human, not a payment: the row may never be
  // uploaded, and marking it settled would hide money that never left.
  const manualCsv = executionResult?.method === 'manual_csv';
  if (!manualCsv && !executionResult?.provider_batch_id) {
    throw new Error(`SETTLEMENT_UNCONFIRMED: no provider batch id for ${batchId}; events left unsettled`);
  }

  console.log(manualCsv
    ? `📝 Marking ${events.length} events as exported (not settled)`
    : `📝 Marking ${events.length} events as settled`);

  const base44 = await buildBase44Client();
  const revenueConfig = getRevenueConfigFromEnv();
  const revenueEntity = base44.asServiceRole.entities[revenueConfig.entityName];
  const unmarked = [];

  for (const event of events) {
    try {
      await revenueEntity.update(event.id, {
        ...event,
        status: manualCsv ? 'export_ready' : 'paid_out',
        settled: manualCsv ? false : true,
        ...(manualCsv
          ? { exported_at: new Date().toISOString() }
          : { settled_at: new Date().toISOString() }),
        payout_batch_id: batchId,
        settlement_details: executionResult
      });
      console.log(`  ${manualCsv ? 'Exported' : 'Settled'} ${event.id}.`);
    } catch (e) {
      console.error(`  ❌ Failed to update ${event.id}: ${e.message}`);
      unmarked.push(event.id);
    }
  }
  return unmarked;
}

// ============================================================================
// MONITORING & HEALTH
// ============================================================================

/**
 * Returns daemon health status
 */
export function getDaemonHealth() {
  // A claim still open is money that may be on its way: it belongs in health,
  // not only in a log line an operator has to be watching.
  const claims = readPayoutClaims(process.cwd());
  return {
    ...state.getStatus(),
    config: CONFIG,
    payout_claims: {
      path: claims.path,
      error: claims.error,
      open: openPayoutClaims(claims.claims).map(claim => ({
        batch_id: claim.batch_id,
        rail: claim.rail,
        status: claim.status,
        revenue_event_ids: claim.revenue_event_ids ?? [],
        amount: claim.amount,
        currency: claim.currency,
        claimed_at: claim.claimed_at,
        error: claim.error ?? null
      })),
      // Exported batches nobody has confirmed are the operator's queue: they
      // are paid only once someone says the file was uploaded. The audit ages
      // the same list, so both agree on what is waiting.
      awaiting_confirmation: exportedClaimsAwaitingConfirmation(claims.claims)
        .map(claim => ({
          batch_id: claim.batch_id,
          rail: claim.rail,
          amount: claim.amount,
          currency: claim.currency,
          export_filename: claim.execution?.export_filename ?? null,
          exported_at: claim.closed_at
        }))
    },
    owner_accounts: Object.keys(OWNER_ACCOUNTS).map(key => ({
      type: key,
      enabled: OWNER_ACCOUNTS[key].enabled,
      priority: OWNER_ACCOUNTS[key].priority
    }))
  };
}

/**
 * Emergency stop - halts all settlements
 */
export function emergencyStop({ reason = 'emergencyStop() called', by = 'daemon' } = {}) {
  console.log('🚨 EMERGENCY STOP ACTIVATED');
  state.emergencyStopped = true;
  state.running = false;
  // Persist before anything else can be attempted: the in-memory latch only
  // protects this process, and the restart is the case a stop exists for.
  const latched = latchEmergencyStop(process.cwd(), { reason, by });
  if (!latched.stopped) {
    const message = `the emergency stop could not be persisted (${latched.error}); a restart would clear it`;
    process.stderr.write(`FINDING SETTLEMENT_EMERGENCY_STOP_UNWRITTEN [critical] ${message}\n`);
    state.addError(new Error(message));
  }
  if (activeIntervalId) {
    clearInterval(activeIntervalId);
    activeIntervalId = null;
  }
  CONFIG.ENABLE_IMMEDIATE_SETTLEMENT = false;
  CONFIG.ENABLE_EMERGENCY_MODE = false;
}

/**
 * Manual trigger - forces immediate settlement check
 */
/**
 * Confirms that an exported (manual CSV) batch was paid, marking its rows
 * `paid_out`. The only way an exported row stops being `export_ready`.
 */
export { confirmExportedBatch };

export async function triggerManualSettlement() {
  const latch = emergencyStopState();
  if (state.emergencyStopped || latch.stopped) {
    console.log('⛔ Manual settlement refused: emergency stop is latched');
    return false;
  }
  console.log('⚡ Manual settlement triggered');
  await performSettlementCycle();
  return true;
}

// ============================================================================
// STARTUP
// ============================================================================

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--clear-emergency-stop')) {
    const result = clearEmergencyStop(process.cwd());
    if (result.cleared) {
      console.log(`✅ Emergency stop cleared (${result.path}); settlement may run again.`);
      process.exit(0);
    }
    console.error(`❌ Nothing to clear: ${result.reason}${result.error ? ` (${result.error})` : ''}`);
    process.exit(result.reason === 'not_stopped' ? 0 : 1);
  }

  if (process.argv.includes('--resolve-claim')) {
    const index = process.argv.indexOf('--resolve-claim');
    const batchId = process.argv[index + 1] ?? '';
    const noteIndex = process.argv.indexOf('--note');
    const result = resolvePayoutClaim(process.cwd(), batchId, {
      note: noteIndex >= 0 ? process.argv[noteIndex + 1] ?? null : 'operator confirmed the payout never arrived'
    });
    if (result.resolved) {
      console.log(`✅ Payout claim ${batchId} closed as never sent; its rows are payable again.`);
      process.exit(0);
    }
    console.error(`❌ Could not close payout claim ${batchId || '(none given)'}: ${result.reason}${result.error ? ` (${result.error})` : ''}`);
    process.exit(1);
  }

  if (process.argv.includes('--confirm-payout')) {
    const index = process.argv.indexOf('--confirm-payout');
    const batchId = process.argv[index + 1] ?? '';
    const noteIndex = process.argv.indexOf('--note');
    const note = noteIndex >= 0 ? process.argv[noteIndex + 1] ?? null : 'operator confirmed the exported payout was paid';
    confirmExportedBatch(batchId, { note }).then(result => {
      console.log(
        `✅ Batch ${result.batch_id}: ${result.confirmed.length} row(s) marked paid_out` +
        `${result.already_paid.length ? `, ${result.already_paid.length} already paid` : ''}.`
      );
      process.exit(0);
    }).catch(error => {
      console.error(`❌ ${error?.message ?? error}`);
      process.exit(1);
    });
  } else if (process.argv.includes('--once')) {
    const latch = emergencyStopState();
    if (state.emergencyStopped || latch.stopped) {
      console.error(`⛔ ${emergencyStopMessage(latch)}`);
      process.exit(1);
    }
    console.log('🎯 Starting single settlement cycle...');
    performSettlementCycle().then(() => {
      console.log('✅ Single cycle complete.');
      process.exit(0);
    }).catch(error => {
      console.error('💥 Cycle failed:', error);
      process.exit(1);
    });
  } else {
    console.log('🎯 Starting as standalone daemon...');
    startAutoSettlementDaemon().catch(error => {
      console.error('💥 Daemon startup failed:', error);
      process.exit(1);
    });
  }
}

export default {
  startAutoSettlementDaemon,
  performSettlementCycle,
  getDaemonHealth,
  emergencyStop,
  triggerManualSettlement,
  confirmExportedBatch
};
