/**
 * PayoutAttempt: Track individual provider submission attempts
 * 
 * P1 Entity: Each payout may have multiple attempts if the provider
 * times out or rejects the request. Each attempt is immutable.
 */

const { v4: uuidv4 } = require('uuid');

class PayoutAttempt {
  constructor(payoutId, idempotencyKey) {
    this.id = uuidv4();
    this.payoutId = payoutId;
    this.idempotencyKey = idempotencyKey;  // Prevents duplicate submission
    
    // Attempt state
    this.state = 'PENDING';  // PENDING → SUBMITTED → RESPONSE_RECEIVED or TIMEOUT
    
    // Execution details
    this.submittedAt = null;
    this.responseReceivedAt = null;
    this.timeoutAt = null;  // Set if provider doesn't respond
    this.timeoutThreshold = 30000;  // 30 seconds
    
    // Provider communication
    this.request = null;       // The exact request we sent
    this.response = null;      // The exact response we got
    this.providerStatusCode = null;
    
    // Error tracking
    this.error = null;
    
    this.createdAt = new Date();
  }

  /**
   * Mark this attempt as submitted
   */
  markSubmitted(request) {
    this.state = 'SUBMITTED';
    this.request = request;
    this.submittedAt = new Date();
    return this;
  }

  /**
   * Record the provider response
   */
  recordResponse(response, statusCode) {
    this.state = 'RESPONSE_RECEIVED';
    this.response = response;
    this.providerStatusCode = statusCode;
    this.responseReceivedAt = new Date();
    return this;
  }

  /**
   * Mark attempt as timed out
   */
  markTimeout() {
    this.state = 'TIMEOUT';
    this.timeoutAt = new Date();
    this.error = 'Provider did not respond within timeout threshold';
    return this;
  }

  /**
   * Record an error during submission
   */
  recordError(error) {
    this.error = error;
    this.state = 'ERROR';
    return this;
  }

  /**
   * Check if this attempt has timed out
   */
  hasTimedOut() {
    if (this.state !== 'SUBMITTED') {
      return false;
    }
    const elapsed = Date.now() - this.submittedAt.getTime();
    return elapsed > this.timeoutThreshold;
  }

  toJSON() {
    return {
      id: this.id,
      payoutId: this.payoutId,
      idempotencyKey: this.idempotencyKey,
      state: this.state,
      submittedAt: this.submittedAt,
      responseReceivedAt: this.responseReceivedAt,
      providerStatusCode: this.providerStatusCode,
      error: this.error,
      createdAt: this.createdAt
    };
  }
}

module.exports = PayoutAttempt;
