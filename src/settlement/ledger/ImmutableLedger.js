/**
 * ImmutableLedger: Append-only financial transaction log
 * 
 * P1 Infrastructure: Every financial decision is recorded immutably.
 * This becomes the source of truth for all settlement activity.
 * Entries are cryptographically linked (hash chain).
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

class ImmutableLedger {
  constructor(storageAdapter) {
    this.adapter = storageAdapter;  // Database, file system, etc.
    this.entries = [];  // In-memory cache
    this.lastHash = null;
  }

  /**
   * Append an entry to the ledger
   * Each entry is linked to the previous via hash chain
   */
  async append(entry) {
    const ledgerEntry = {
      id: uuidv4(),
      sequence: this.entries.length + 1,
      timestamp: new Date(),
      entryType: entry.type,  // 'SETTLEMENT_START', 'PAYOUT_SUBMISSION', 'PROVIDER_EVENT', etc.
      data: entry.data,
      previousHash: this.lastHash,
      hash: null  // Will be computed below
    };

    // Compute hash including previous hash (creates immutable chain)
    const hashInput = JSON.stringify({
      sequence: ledgerEntry.sequence,
      entryType: ledgerEntry.entryType,
      data: ledgerEntry.data,
      previousHash: ledgerEntry.previousHash,
      timestamp: ledgerEntry.timestamp.toISOString()
    });

    ledgerEntry.hash = crypto
      .createHash('sha256')
      .update(hashInput)
      .digest('hex');

    // Persist to storage
    await this.adapter.write(ledgerEntry);

    // Update in-memory state
    this.entries.push(ledgerEntry);
    this.lastHash = ledgerEntry.hash;

    return ledgerEntry;
  }

  /**
   * Get all entries for a settlement
   */
  async getEntriesForSettlement(settlementId) {
    return this.entries.filter(e => e.data.settlementId === settlementId);
  }

  /**
   * Verify ledger integrity
   * Ensures no entries have been modified or removed
   */
  async verifyIntegrity() {
    let previousHash = null;

    for (const entry of this.entries) {
      if (entry.previousHash !== previousHash) {
        throw new Error(
          `Ledger integrity violation at entry ${entry.sequence}. ` +
          `Expected previousHash ${previousHash}, got ${entry.previousHash}`
        );
      }

      // Recompute hash to verify entry hasn't been modified
      const hashInput = JSON.stringify({
        sequence: entry.sequence,
        entryType: entry.entryType,
        data: entry.data,
        previousHash: entry.previousHash,
        timestamp: entry.timestamp.toISOString()
      });

      const recomputedHash = crypto
        .createHash('sha256')
        .update(hashInput)
        .digest('hex');

      if (recomputedHash !== entry.hash) {
        throw new Error(
          `Ledger integrity violation at entry ${entry.sequence}. ` +
          `Hash mismatch: expected ${entry.hash}, computed ${recomputedHash}`
        );
      }

      previousHash = entry.hash;
    }

    return true;
  }

  toJSON() {
    return {
      entryCount: this.entries.length,
      lastHash: this.lastHash,
      lastTimestamp: this.entries.length > 0 ? this.entries[this.entries.length - 1].timestamp : null
    };
  }
}

module.exports = ImmutableLedger;
