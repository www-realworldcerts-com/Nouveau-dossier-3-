/**
 * ProviderEvent: Immutable log of all provider responses
 * 
 * P1 Entity: Every single communication with a payment provider
 * is recorded immutably. Never modified, only appended.
 */

const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

class ProviderEvent {
  constructor(payoutId, event) {
    this.id = uuidv4();
    this.payoutId = payoutId;
    
    // Immutable event data
    this.provider = event.provider;           // 'paypal', 'bitget', etc.
    this.eventType = event.eventType;         // 'SUBMISSION', 'STATUS_CHECK', 'WEBHOOK', etc.
    this.status = event.status;               // 'SUCCESS', 'PENDING', 'FAILED'
    this.providerReference = event.providerReference;  // ID from provider
    this.message = event.message || null;
    
    // Raw provider data (immutable)
    this.rawRequest = event.rawRequest || null;
    this.rawResponse = event.rawResponse || null;
    this.statusCode = event.statusCode || null;
    
    // Cryptographic proof
    this.eventHash = this.computeHash();
    
    this.recordedAt = new Date();
  }

  /**
   * Compute SHA-256 hash of immutable event data
   * This proves the event hasn't been tampered with
   */
  computeHash() {
    const data = JSON.stringify({
      payoutId: this.payoutId,
      provider: this.provider,
      eventType: this.eventType,
      status: this.status,
      providerReference: this.providerReference,
      message: this.message,
      rawResponse: this.rawResponse,
      statusCode: this.statusCode
    });

    return crypto
      .createHash('sha256')
      .update(data)
      .digest('hex');
  }

  /**
   * Verify this event hasn't been modified
   */
  verifyIntegrity() {
    const recomputedHash = this.computeHash();
    return recomputedHash === this.eventHash;
  }

  toJSON() {
    return {
      id: this.id,
      payoutId: this.payoutId,
      provider: this.provider,
      eventType: this.eventType,
      status: this.status,
      providerReference: this.providerReference,
      message: this.message,
      statusCode: this.statusCode,
      eventHash: this.eventHash,
      recordedAt: this.recordedAt
    };
  }
}

module.exports = ProviderEvent;
