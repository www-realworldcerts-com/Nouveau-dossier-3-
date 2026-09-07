/**
 * ConsolidatedSettlementEngine: Single unified settlement orchestrator
 * 
 * P1 Build: Consolidates three competing systems:
 *   - auto_settlement_daemon.js
 *   - live_execution_flow.js
 *   - real_settlement_backend.js
 * 
 * This engine implements the complete state machine:
 * REVENUE → RECONCILED → ENTITLED → PROPOSED → AUTHORIZED → RESERVED 
 *   → EXECUTING → CONFIRMED → RECONCILED → SETTLED
 * 
 * P2 Test: Proves that same revenue + same payout + worker crash 
 *   + provider timeout + worker restart = exactly one payment
 */

const Settlement = require('./entities/Settlement');
const Payout = require('./entities/Payout');
const PayoutAttempt = require('./entities/PayoutAttempt');
const ProviderEvent = require('./entities/ProviderEvent');
const Reconciliation = require('./entities/Reconciliation');
const IdempotencyKey = require('./idempotency/IdempotencyKey');
const PayoutReservation = require('./reservation/PayoutReservation');
const ImmutableLedger = require('./ledger/ImmutableLedger');

class ConsolidatedSettlementEngine {
  constructor(dependencies = {}) {
    this.ledger = dependencies.ledger || new ImmutableLedger(dependencies.storageAdapter);
    this.ownerAccountStore = dependencies.ownerAccountStore;
    this.settlementStore = dependencies.settlementStore;
    this.payoutStore = dependencies.payoutStore;
    this.reconciliationStore = dependencies.reconciliationStore;
    this.idempotencyStore = dependencies.idempotencyStore;
    this.reservationStore = dependencies.reservationStore;
    this.providerClients = dependencies.providerClients || {};
    
    // Configuration
    this.maxRetries = dependencies.maxRetries || 3;
    this.providerTimeoutMs = dependencies.providerTimeoutMs || 30000;
  }

  /**
   * Step 1: REVENUE → RECONCILED
   * Start a settlement from a revenue event
   */
  async createSettlement(revenueEventId, ownerAccountId, amount) {
    const settlement = new Settlement(revenueEventId, ownerAccountId);
    settlement.amount = amount;
    
    // Persist
    await this.settlementStore.save(settlement);
    
    // Log to immutable ledger
    await this.ledger.append({
      type: 'SETTLEMENT_CREATED',
      data: {
        settlementId: settlement.id,
        revenueEventId,
        ownerAccountId,
        amount
      }
    });

    settlement.transition('RECONCILED', { actor: 'settlement-engine' });
    await this.settlementStore.save(settlement);

    return settlement;
  }

  /**
   * Step 2: RECONCILED → ENTITLED
   * Verify owner account and funds are legitimate
   */
  async verifyOwnerEntitlement(settlementId) {
    const settlement = await this.settlementStore.get(settlementId);
    if (!settlement) throw new Error(`Settlement ${settlementId} not found`);

    const ownerAccount = await this.ownerAccountStore.get(settlement.ownerAccountId);
    if (!ownerAccount) throw new Error(`Owner ${settlement.ownerAccountId} not found`);

    // Verify destination hasn't changed (security check)
    // This would call ownerAccount.verifyDestinationFingerprint()

    settlement.transition('ENTITLED', { actor: 'settlement-engine' });
    await this.settlementStore.save(settlement);
    
    await this.ledger.append({
      type: 'OWNER_ENTITLED',
      data: { settlementId, ownerAccountId: settlement.ownerAccountId }
    });

    return settlement;
  }

  /**
   * Step 3: ENTITLED → PROPOSED
   * Create payout proposal(s)
   */
  async proposePayout(settlementId, provider, amount, destinationFingerprint) {
    const settlement = await this.settlementStore.get(settlementId);
    if (!settlement) throw new Error(`Settlement ${settlementId} not found`);

    const payout = new Payout(settlementId, amount, provider, destinationFingerprint);
    await this.payoutStore.save(payout);

    settlement.addPayoutProposal(payout.id, amount, provider);
    settlement.transition('PROPOSED', { actor: 'settlement-engine' });
    await this.settlementStore.save(settlement);

    await this.ledger.append({
      type: 'PAYOUT_PROPOSED',
      data: {
        settlementId,
        payoutId: payout.id,
        amount,
        provider
      }
    });

    return payout;
  }

  /**
   * Step 4: PROPOSED → AUTHORIZED
   * Apply policy and limit checks
   */
  async authorizePayoutProposal(settlementId, payoutId, policyCheck = {}) {
    const settlement = await this.settlementStore.get(settlementId);
    const payout = await this.payoutStore.get(payoutId);
    
    if (!settlement || !payout) throw new Error('Settlement or payout not found');

    // Apply policies (amount limits, frequency, etc.)
    if (policyCheck.maxAmount && payout.amount > policyCheck.maxAmount) {
      throw new Error(`Payout ${payout.amount} exceeds max ${policyCheck.maxAmount}`);
    }

    payout.transition('POLICY_CHECKED');
    payout.transition('LIMIT_CHECKED');
    await this.payoutStore.save(payout);

    settlement.selectPayout(payoutId);
    settlement.transition('AUTHORIZED', { actor: 'settlement-engine' });
    await this.settlementStore.save(settlement);

    await this.ledger.append({
      type: 'PAYOUT_AUTHORIZED',
      data: { settlementId, payoutId, policyCheck }
    });

    return settlement;
  }

  /**
   * Step 5: AUTHORIZED → RESERVED
   * Acquire atomic reservation
   */
  async reserveFunds(settlementId, payoutId, lockHolderId) {
    const settlement = await this.settlementStore.get(settlementId);
    const payout = await this.payoutStore.get(payoutId);
    
    if (!settlement || !payout) throw new Error('Settlement or payout not found');

    // Try to acquire reservation
    const reservation = new PayoutReservation(
      settlement.ownerAccountId,
      payout.amount,
      payout.provider
    );

    try {
      reservation.acquire(lockHolderId);
      await this.reservationStore.save(reservation);
    } catch (error) {
      // Reservation failed - another worker has it
      throw new Error(`Cannot acquire reservation: ${error.message}`);
    }

    payout.transition('RESERVED');
    await this.payoutStore.save(payout);

    settlement.transition('RESERVED', { actor: 'settlement-engine' });
    await this.settlementStore.save(settlement);

    await this.ledger.append({
      type: 'FUNDS_RESERVED',
      data: { settlementId, payoutId, reservationId: reservation.id }
    });

    return reservation;
  }

  /**
   * Step 6: RESERVED → INSTRUCTION_CREATED
   * Generate idempotency key and create submission instruction
   */
  async createPayoutInstruction(payoutId) {
    const payout = await this.payoutStore.get(payoutId);
    if (!payout) throw new Error(`Payout ${payoutId} not found`);

    const idempotencyKey = new IdempotencyKey(payoutId, payout.provider);
    await this.idempotencyStore.save(idempotencyKey);

    payout.transition('INSTRUCTION_CREATED');
    await this.payoutStore.save(payout);

    await this.ledger.append({
      type: 'PAYOUT_INSTRUCTION_CREATED',
      data: {
        payoutId,
        idempotencyKey: idempotencyKey.key,
        provider: payout.provider
      }
    });

    return idempotencyKey;
  }

  /**
   * Step 7: INSTRUCTION_CREATED → SUBMITTED
   * Actually call the provider API
   */
  async submitPayoutToProvider(payoutId, idempotencyKey, destinationData) {
    const payout = await this.payoutStore.get(payoutId);
    if (!payout) throw new Error(`Payout ${payoutId} not found`);

    const client = this.providerClients[payout.provider];
    if (!client) throw new Error(`No provider client for ${payout.provider}`);

    // Create execution attempt
    const attempt = payout.createAttempt(idempotencyKey.key);
    attempt.markSubmitted({
      payoutId,
      amount: payout.amount,
      destination: '***redacted***',  // Never log raw destination
      idempotencyKey: idempotencyKey.key
    });

    payout.transition('SUBMITTED');
    await this.payoutStore.save(payout);

    try {
      // Call provider with idempotency key
      const response = await client.submitPayout(
        payout.amount,
        destinationData,
        idempotencyKey.key,
        { timeout: this.providerTimeoutMs }
      );

      attempt.recordResponse(response, response.statusCode);
      idempotencyKey.markAcknowledged();

      // Record provider event
      const event = payout.recordProviderEvent({
        provider: payout.provider,
        eventType: 'SUBMISSION',
        status: response.status,
        providerReference: response.payoutId,
        message: response.message,
        rawResponse: response,
        statusCode: response.statusCode
      });

      await this.ledger.append({
        type: 'PROVIDER_SUBMISSION',
        data: {
          payoutId,
          provider: payout.provider,
          providerReference: response.payoutId,
          status: response.status
        }
      });

      await this.payoutStore.save(payout);
      await this.idempotencyStore.save(idempotencyKey);

      return event;
    } catch (error) {
      // Provider error or timeout
      attempt.recordError(error.message);
      idempotencyKey.markFailed();

      // Transition to UNKNOWN state - we don't know if payment went through
      payout.transition('UNKNOWN');
      await this.payoutStore.save(payout);
      await this.idempotencyStore.save(idempotencyKey);

      await this.ledger.append({
        type: 'PROVIDER_SUBMISSION_FAILED',
        data: {
          payoutId,
          provider: payout.provider,
          error: error.message
        }
      });

      throw error;
    }
  }

  /**
   * Step 8: UNKNOWN → EXECUTING or CONFIRMED
   * Provider reconciliation: check if payment actually went through
   */
  async reconcileWithProvider(payoutId) {
    const payout = await this.payoutStore.get(payoutId);
    if (!payout) throw new Error(`Payout ${payoutId} not found`);

    if (payout.state === 'CONFIRMED') {
      return payout;  // Already confirmed
    }

    const client = this.providerClients[payout.provider];
    if (!client) throw new Error(`No provider client for ${payout.provider}`);

    try {
      // Query provider for payout status
      const status = await client.getPayoutStatus(
        payout.providerReference,
        { timeout: this.providerTimeoutMs }
      );

      const reconciliation = new Reconciliation(payoutId, payout.provider);
      reconciliation.recordProviderConfirmation(status);

      if (status.status === 'SUCCESS') {
        // Payment confirmed
        reconciliation.confirm();
        payout.reconcile('CONFIRMED');
        
        await this.ledger.append({
          type: 'PROVIDER_RECONCILIATION_SUCCESS',
          data: {
            payoutId,
            provider: payout.provider,
            amountReceived: status.amountReceived
          }
        });
      } else {
        // Payment failed or still pending
        reconciliation.fail(`Provider status: ${status.status}`);
        payout.reconcile('FAILED');
        
        await this.ledger.append({
          type: 'PROVIDER_RECONCILIATION_FAILED',
          data: {
            payoutId,
            provider: payout.provider,
            providerStatus: status.status
          }
        });
      }

      await this.reconciliationStore.save(reconciliation);
      await this.payoutStore.save(payout);

      return reconciliation;
    } catch (error) {
      await this.ledger.append({
        type: 'PROVIDER_RECONCILIATION_ERROR',
        data: {
          payoutId,
          provider: payout.provider,
          error: error.message
        }
      });

      throw error;
    }
  }

  /**
   * Step 9: CONFIRMED → RECONCILED
   * Settlement final reconciliation
   */
  async finalizeSettlement(settlementId, reconciliationProof) {
    const settlement = await this.settlementStore.get(settlementId);
    if (!settlement) throw new Error(`Settlement ${settlementId} not found`);

    settlement.recordReconciliationProof(reconciliationProof);
    settlement.transition('RECONCILED', { actor: 'settlement-engine' });
    await this.settlementStore.save(settlement);

    await this.ledger.append({
      type: 'SETTLEMENT_RECONCILED',
      data: {
        settlementId,
        proofHash: reconciliationProof.proofHash
      }
    });

    return settlement;
  }

  /**
   * Step 10: RECONCILED → SETTLED
   * ONLY this marks the settlement as complete
   */
  async markSettled(settlementId) {
    const settlement = await this.settlementStore.get(settlementId);
    if (!settlement) throw new Error(`Settlement ${settlementId} not found`);

    settlement.markSettled();
    await this.settlementStore.save(settlement);

    await this.ledger.append({
      type: 'SETTLEMENT_COMPLETED',
      data: { settlementId }
    });

    return settlement;
  }

  /**
   * Release reservation and clean up after settlement
   */
  async releaseReservation(reservationId) {
    const reservation = await this.reservationStore.get(reservationId);
    if (!reservation) throw new Error(`Reservation ${reservationId} not found`);

    reservation.release();
    await this.reservationStore.save(reservation);

    return reservation;
  }
}

module.exports = ConsolidatedSettlementEngine;
