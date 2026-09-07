/**
 * PayoutReservation: Atomic reservation against double-draining
 * 
 * P1 Infrastructure: Before executing a payout, acquire a reservation
 * that atomically reserves the funds. If multiple workers try to pay
 * the same balance simultaneously, only ONE will hold the reservation.
 * The others will wait or back off.
 */

const { v4: uuidv4 } = require('uuid');

class PayoutReservation {
  constructor(ownerAccountId, amount, provider) {
    this.id = uuidv4();
    this.ownerAccountId = ownerAccountId;
    this.amount = amount;
    this.provider = provider;
    
    // Reservation state
    this.state = 'PENDING';  // PENDING → ACQUIRED → RELEASED or ABANDONED
    this.acquiredAt = null;
    this.releasedAt = null;
    this.abandonedAt = null;
    
    // Lock holder (which worker/process owns this reservation)
    this.lockHolderId = null;  // Process ID or worker ID
    this.ttl = 60000;  // Time-to-live: 60 seconds
    
    this.createdAt = new Date();
  }

  /**
   * Acquire the reservation
   * Throws error if already acquired
   */
  acquire(lockHolderId) {
    if (this.state !== 'PENDING') {
      throw new Error(
        `Cannot acquire reservation in ${this.state} state. ` +
        `Currently held by ${this.lockHolderId}`
      );
    }

    this.state = 'ACQUIRED';
    this.lockHolderId = lockHolderId;
    this.acquiredAt = new Date();

    return this;
  }

  /**
   * Release the reservation (payout succeeded or failed)
   */
  release() {
    if (this.state !== 'ACQUIRED') {
      throw new Error(
        `Cannot release reservation in ${this.state} state`
      );
    }

    this.state = 'RELEASED';
    this.releasedAt = new Date();

    return this;
  }

  /**
   * Abandon the reservation (timed out, worker crashed, etc.)
   */
  abandon() {
    if (this.state === 'RELEASED') {
      throw new Error('Cannot abandon an already released reservation');
    }

    this.state = 'ABANDONED';
    this.abandonedAt = new Date();

    return this;
  }

  /**
   * Check if reservation has expired
   */
  isExpired() {
    if (this.state !== 'ACQUIRED') {
      return false;
    }
    const elapsed = Date.now() - this.acquiredAt.getTime();
    return elapsed > this.ttl;
  }

  toJSON() {
    return {
      id: this.id,
      ownerAccountId: this.ownerAccountId,
      amount: this.amount,
      provider: this.provider,
      state: this.state,
      lockHolderId: this.lockHolderId,
      acquiredAt: this.acquiredAt,
      releasedAt: this.releasedAt,
      createdAt: this.createdAt
    };
  }
}

module.exports = PayoutReservation;
