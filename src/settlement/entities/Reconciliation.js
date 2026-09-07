/**
 * Reconciliation: Final reconciliation proof that payment was settled
 * 
 * P1 Entity: Created only AFTER we have independently verified the payment
 * with the provider. This is the final step that allows settled=true.
 */

const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

class Reconciliation {
  constructor(payoutId, provider) {
    this.id = uuidv4();
    this.payoutId = payoutId;
    this.provider = provider;
    
    // Reconciliation state
    this.state = 'IN_PROGRESS';  // IN_PROGRESS → CONFIRMED or FAILED
    
    // Provider confirmation
    this.providerConfirmation = null;  // Response from provider when we checked status
    this.providerBalance = null;       // Balance after payout (from provider)
    this.amountReceived = null;        // What the recipient actually got
    
    // Verification
    this.verificationMethod = null;    // 'PROVIDER_API', 'WEBHOOK', 'MANUAL_AUDIT'
    this.verificationTimestamp = null;
    
    // Proof of reconciliation
    this.proofHash = null;  // Hash of all reconciliation data
    
    this.createdAt = new Date();
    this.completedAt = null;
  }

  /**
   * Record provider confirmation of payment
   */
  recordProviderConfirmation(confirmation) {
    this.providerConfirmation = confirmation;
    this.providerBalance = confirmation.balance || null;
    this.amountReceived = confirmation.amountReceived || null;
    this.verificationMethod = confirmation.verificationMethod || 'PROVIDER_API';
    this.verificationTimestamp = new Date();
    
    return this;
  }

  /**
   * Confirm the reconciliation - only if provider confirms payment succeeded
   */
  confirm() {
    if (!this.providerConfirmation) {
      throw new Error('Cannot confirm reconciliation without provider confirmation');
    }

    if (this.providerConfirmation.status !== 'SUCCESS') {
      throw new Error(
        `Cannot confirm reconciliation when provider status is ${this.providerConfirmation.status}`
      );
    }

    this.state = 'CONFIRMED';
    this.completedAt = new Date();
    this.proofHash = this.computeProofHash();

    return this;
  }

  /**
   * Mark reconciliation as failed
   */
  fail(reason) {
    this.state = 'FAILED';
    this.completedAt = new Date();
    this.failureReason = reason;

    return this;
  }

  /**
   * Compute SHA-256 hash of all reconciliation proof data
   */
  computeProofHash() {
    const data = JSON.stringify({
      payoutId: this.payoutId,
      provider: this.provider,
      providerConfirmation: this.providerConfirmation,
      providerBalance: this.providerBalance,
      amountReceived: this.amountReceived,
      verificationMethod: this.verificationMethod,
      verificationTimestamp: this.verificationTimestamp,
      completedAt: this.completedAt
    });

    return crypto
      .createHash('sha256')
      .update(data)
      .digest('hex');
  }

  toJSON() {
    return {
      id: this.id,
      payoutId: this.payoutId,
      provider: this.provider,
      state: this.state,
      verificationMethod: this.verificationMethod,
      verificationTimestamp: this.verificationTimestamp,
      amountReceived: this.amountReceived,
      proofHash: this.proofHash,
      createdAt: this.createdAt,
      completedAt: this.completedAt
    };
  }
}

module.exports = Reconciliation;
