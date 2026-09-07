/**
 * OwnerAccount: Durable owner identity with secret-managed destinations
 * 
 * P1 Entity: Replaces hard-coded owner fallbacks in source code.
 * Stores encrypted destination credentials that are rotated/managed via secrets.
 * Never stores raw wallet/account info in code.
 */

const crypto = require('crypto');
const {
  OWNER_ACCOUNT_SECRET_KEY,
  OWNER_ACCOUNT_VERIFICATION_SALT
} = process.env;

class OwnerAccount {
  constructor(ownerAccountId, metadata = {}) {
    this.id = ownerAccountId;
    this.createdAt = new Date();
    this.metadata = metadata;
    
    // Will be populated from secrets manager, never from code
    this.destinationFingerprint = null;   // Hash of the destination to detect changes
    this.destinationEncrypted = null;     // Encrypted destination reference
    this.providerRegistry = {}; // Maps provider -> verified destination ID
    
    // Audit trail
    this.destinationHistory = [];
  }

  /**
   * Set the owner destination with cryptographic verification
   * This should ONLY be called during owner account initialization
   * and from authenticated, secret-managed configuration sources.
   */
  setOwnerDestination(provider, destinationData, secretKey) {
    if (!destinationData || !secretKey) {
      throw new Error('OwnerAccount.setOwnerDestination requires destinationData and secretKey');
    }

    // Create cryptographic fingerprint
    const fingerprint = crypto
      .createHmac('sha256', OWNER_ACCOUNT_VERIFICATION_SALT)
      .update(JSON.stringify(destinationData))
      .digest('hex');

    // Encrypt the destination reference
    const cipher = crypto.createCipher('aes-256-cbc', secretKey);
    let encrypted = cipher.update(JSON.stringify(destinationData), 'utf8', 'hex');
    encrypted += cipher.final('hex');

    // Record the destination
    const record = {
      provider,
      fingerprint,
      encrypted,
      setAt: new Date()
    };

    this.destinationHistory.push(record);
    this.providerRegistry[provider] = fingerprint;
    this.destinationEncrypted = encrypted;
    this.destinationFingerprint = fingerprint;

    return record;
  }

  /**
   * Verify that the destination hasn't changed
   * Call this before executing ANY payout to this owner
   */
  verifyDestinationFingerprint(provider, expectedFingerprint) {
    if (this.providerRegistry[provider] !== expectedFingerprint) {
      throw new Error(
        `OwnerAccount destination mismatch for provider ${provider}. ` +
        `Expected: ${expectedFingerprint}, Current: ${this.providerRegistry[provider]}`
      );
    }
    return true;
  }

  /**
   * Get the owner destination (encrypted, requires key)
   * Only called by the Settlement Engine when executing a payout
   */
  getOwnerDestination(secretKey) {
    if (!this.destinationEncrypted) {
      throw new Error('OwnerAccount has no destination configured');
    }

    const decipher = crypto.createDecipher('aes-256-cbc', secretKey);
    let decrypted = decipher.update(this.destinationEncrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return JSON.parse(decrypted);
  }

  toJSON() {
    return {
      id: this.id,
      createdAt: this.createdAt,
      metadata: this.metadata,
      destinationFingerprint: this.destinationFingerprint,
      providerRegistry: this.providerRegistry,
      destinationHistoryCount: this.destinationHistory.length,
      // Never expose encrypted or raw destination in JSON
    };
  }
}

module.exports = OwnerAccount;
