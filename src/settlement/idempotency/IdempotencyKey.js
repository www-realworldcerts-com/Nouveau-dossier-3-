/**
 * IdempotencyKey: Prevents double execution of the same payment
 * 
 * P1 Infrastructure: Before submitting ANY payout to a provider,
 * generate an idempotency key and register it. If the submission fails
 * and we retry, the provider will recognize the same key and NOT double-charge.
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

class IdempotencyKey {
  constructor(payoutId, provider) {
    this.payoutId = payoutId;
    this.provider = provider;
    this.key = this.generateKey();
    this.createdAt = new Date();
    this.usedAt = null;
    this.status = 'CREATED';  // CREATED → SUBMITTED → ACKNOWLEDGED or FAILED
  }

  /**
   * Generate a unique idempotency key
   * Deterministic based on payoutId + timestamp
   */
  generateKey() {
    const input = `${this.payoutId}:${this.provider}:${Date.now()}`;
    return crypto
      .createHash('sha256')
      .update(input)
      .digest('hex');
  }

  /**
   * Mark this key as submitted to the provider
   */
  markSubmitted() {
    this.status = 'SUBMITTED';
    this.usedAt = new Date();
    return this;
  }

  /**
   * Mark this key as acknowledged by the provider
   */
  markAcknowledged() {
    this.status = 'ACKNOWLEDGED';
    return this;
  }

  /**
   * Mark as failed (and can be retried with same key)
   */
  markFailed() {
    this.status = 'FAILED';
    return this;
  }

  toJSON() {
    return {
      payoutId: this.payoutId,
      provider: this.provider,
      key: this.key,
      status: this.status,
      createdAt: this.createdAt,
      usedAt: this.usedAt
    };
  }
}

module.exports = IdempotencyKey;
