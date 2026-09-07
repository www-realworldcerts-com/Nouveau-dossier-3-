/**
 * Payout: Represents a single payout instruction
 * 
 * P1 Entity: Durable first-class financial transaction.
 * Contains everything needed to execute and track a payment.
 */

const { v4: uuidv4 } = require('uuid');

class Payout {
  constructor(settlementId, amount, provider, destinationFingerprint) {
    this.id = uuidv4();
    this.settlementId = settlementId;
    this.amount = amount;
    this.provider = provider;  // 'paypal', 'bitget', 'bybit', 'stripe', etc.
    this.destinationFingerprint = destinationFingerprint;  // Immutable proof of destination
    
    // Payout state machine
    this.state = 'PROPOSED';  // PROPOSED → POLICY_CHECKED → LIMIT_CHECKED → RESERVED → INSTRUCTION_CREATED → SUBMITTED → CONFIRMED → RECONCILED
    this.stateHistory = [{
      state: 'PROPOSED',
      timestamp: new Date()
    }];
    
    // Execution tracking
    this.attempts = [];  // Array of PayoutAttempt objects
    this.currentAttemptIndex = -1;
    
    // Provider response
    this.providerReference = null;  // ID from payment provider (e.g., PayPal payout ID)
    this.providerEvents = [];        // Immutable log of all provider communication
    
    // Final reconciliation
    this.reconciliationStatus = null;  // 'CONFIRMED', 'FAILED', 'UNKNOWN'
    this.reconciliationTimestamp = null;
    
    // Audit
    this.createdAt = new Date();
    this.updatedAt = new Date();
  }

  /**
   * Move through payout state machine
   */
  transition(newState) {
    const allowedTransitions = {
      'PROPOSED': ['POLICY_CHECKED'],
      'POLICY_CHECKED': ['LIMIT_CHECKED'],
      'LIMIT_CHECKED': ['RESERVED'],
      'RESERVED': ['INSTRUCTION_CREATED'],
      'INSTRUCTION_CREATED': ['SUBMITTED'],
      'SUBMITTED': ['CONFIRMED', 'UNKNOWN'],
      'UNKNOWN': ['SUBMITTED', 'FAILED', 'RECONCILED'],  // Retry or fail
      'CONFIRMED': ['RECONCILED'],
      'FAILED': [],  // Terminal state
      'RECONCILED': []  // Terminal state
    };

    if (!allowedTransitions[this.state] || !allowedTransitions[this.state].includes(newState)) {
      throw new Error(
        `Invalid payout state transition: ${this.state} → ${newState}`
      );
    }

    this.state = newState;
    this.stateHistory.push({
      state: newState,
      timestamp: new Date()
    });
    this.updatedAt = new Date();

    return this;
  }

  /**
   * Create a new execution attempt
   * Returns the PayoutAttempt object
   */
  createAttempt(idempotencyKey) {
    const PayoutAttempt = require('./PayoutAttempt');
    const attempt = new PayoutAttempt(this.id, idempotencyKey);
    this.attempts.push(attempt);
    this.currentAttemptIndex = this.attempts.length - 1;
    return attempt;
  }

  /**
   * Get current attempt
   */
  getCurrentAttempt() {
    if (this.currentAttemptIndex === -1) {
      return null;
    }
    return this.attempts[this.currentAttemptIndex];
  }

  /**
   * Record provider response and update payout state
   */
  recordProviderEvent(event) {
    const ProviderEvent = require('./ProviderEvent');
    const providerEvent = new ProviderEvent(this.id, event);
    this.providerEvents.push(providerEvent);

    // Update provider reference if we got one
    if (event.providerReference) {
      this.providerReference = event.providerReference;
    }

    // Update state based on event
    if (event.status === 'SUCCESS') {
      this.transition('CONFIRMED');
    } else if (event.status === 'PENDING') {
      this.transition('UNKNOWN');
    } else if (event.status === 'FAILED') {
      this.transition('FAILED');
    }

    return providerEvent;
  }

  /**
   * Record final reconciliation
   */
  reconcile(status, proof) {
    if (!['CONFIRMED', 'FAILED', 'UNKNOWN'].includes(status)) {
      throw new Error(`Invalid reconciliation status: ${status}`);
    }

    this.reconciliationStatus = status;
    this.reconciliationTimestamp = new Date();
    
    if (status === 'CONFIRMED') {
      this.transition('RECONCILED');
    } else {
      this.transition('FAILED');
    }

    return this;
  }

  toJSON() {
    return {
      id: this.id,
      settlementId: this.settlementId,
      amount: this.amount,
      provider: this.provider,
      state: this.state,
      providerReference: this.providerReference,
      reconciliationStatus: this.reconciliationStatus,
      attemptCount: this.attempts.length,
      providerEventCount: this.providerEvents.length,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }
}

module.exports = Payout;
