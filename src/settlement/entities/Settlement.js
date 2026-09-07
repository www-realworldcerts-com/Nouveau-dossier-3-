/**
 * Settlement: Top-level container for a complete settlement lifecycle
 * 
 * P1 Entity: Orchestrates the entire settlement flow from revenue recognition
 * through final reconciliation. Only this entity gets to mark settled=true.
 */

const { v4: uuidv4 } = require('uuid');

class Settlement {
  constructor(revenueEventId, ownerAccountId) {
    this.id = uuidv4();
    this.revenueEventId = revenueEventId;
    this.ownerAccountId = ownerAccountId;
    
    // Lifecycle
    this.state = 'REVENUE_RECOGNIZED';  // REVENUE_RECOGNIZED → RECONCILED → ENTITLED → PROPOSED → AUTHORIZED → RESERVED → EXECUTING → CONFIRMED → RECONCILED → SETTLED
    this.stateHistory = [{
      state: 'REVENUE_RECOGNIZED',
      timestamp: new Date(),
      actor: 'system'
    }];
    
    // Financial data
    this.amount = null;
    this.currency = 'USD';
    this.payoutProposals = [];  // May be multiple proposals before settling on one
    this.selectedPayout = null; // The payout that will actually execute
    
    // Audit
    this.createdAt = new Date();
    this.updatedAt = new Date();
    this.reconciliationProof = null;  // Set only after final reconciliation
  }

  /**
   * Move through the settlement state machine
   */
  transition(newState, metadata = {}) {
    const allowedTransitions = {
      'REVENUE_RECOGNIZED': ['RECONCILED'],
      'RECONCILED': ['ENTITLED'],
      'ENTITLED': ['PROPOSED'],
      'PROPOSED': ['AUTHORIZED'],
      'AUTHORIZED': ['RESERVED'],
      'RESERVED': ['EXECUTING'],
      'EXECUTING': ['CONFIRMED', 'UNKNOWN'],  // UNKNOWN if provider doesn't respond
      'CONFIRMED': ['RECONCILED'],
      'UNKNOWN': ['EXECUTING', 'RECONCILED'],  // Retry or give up after reconciliation check
      'RECONCILED': ['SETTLED']
    };

    if (!allowedTransitions[this.state] || !allowedTransitions[this.state].includes(newState)) {
      throw new Error(
        `Invalid settlement state transition: ${this.state} → ${newState}`
      );
    }

    this.state = newState;
    this.stateHistory.push({
      state: newState,
      timestamp: new Date(),
      metadata,
      actor: metadata.actor || 'system'
    });
    this.updatedAt = new Date();

    return this;
  }

  /**
   * Propose a payout for this settlement
   */
  addPayoutProposal(payoutId, amount, provider) {
    if (this.state !== 'ENTITLED') {
      throw new Error(
        `Cannot add payout proposal when settlement is in ${this.state} state. ` +
        `Must be in ENTITLED state.`
      );
    }

    this.payoutProposals.push({
      payoutId,
      amount,
      provider,
      proposedAt: new Date()
    });

    return this;
  }

  /**
   * Select which payout to execute (after policy/limit checks)
   */
  selectPayout(payoutId) {
    if (this.state !== 'AUTHORIZED') {
      throw new Error(
        `Cannot select payout when settlement is in ${this.state} state. ` +
        `Must be in AUTHORIZED state.`
      );
    }

    const proposal = this.payoutProposals.find(p => p.payoutId === payoutId);
    if (!proposal) {
      throw new Error(`Payout ${payoutId} not found in proposals`);
    }

    this.selectedPayout = proposal;
    this.amount = proposal.amount;
    return this;
  }

  /**
   * Record the final reconciliation proof
   * ONLY this method can set settled=true
   */
  recordReconciliationProof(reconciliationData) {
    if (this.state !== 'RECONCILED') {
      throw new Error(
        `Cannot record reconciliation proof when settlement is in ${this.state} state. ` +
        `Must be in RECONCILED state.`
      );
    }

    this.reconciliationProof = {
      ...reconciliationData,
      proofAt: new Date(),
      proofHash: require('crypto')
        .createHash('sha256')
        .update(JSON.stringify(reconciliationData))
        .digest('hex')
    };

    return this;
  }

  /**
   * Complete the settlement - only after reconciliation proof
   */
  markSettled() {
    if (this.state !== 'RECONCILED') {
      throw new Error(
        `Cannot mark settled when state is ${this.state}. ` +
        `Must be RECONCILED with proof.`
      );
    }

    if (!this.reconciliationProof) {
      throw new Error(
        `Cannot mark settled without reconciliation proof`
      );
    }

    this.transition('SETTLED', { actor: 'reconciliation-engine' });
    return this;
  }

  toJSON() {
    return {
      id: this.id,
      revenueEventId: this.revenueEventId,
      ownerAccountId: this.ownerAccountId,
      state: this.state,
      amount: this.amount,
      currency: this.currency,
      selectedPayout: this.selectedPayout,
      reconciliationProof: this.reconciliationProof ? {
        hash: this.reconciliationProof.proofHash,
        proofAt: this.reconciliationProof.proofAt
      } : null,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      stateHistory: this.stateHistory
    };
  }
}

module.exports = Settlement;
