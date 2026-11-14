// src/financial/SettlementLedger.mjs
import fs from 'fs';
import path from 'path';
import { MutexLock } from '../utils/MutexLock.mjs';
import { readEncryptedJson, writeJsonAtomic } from '../security/data-at-rest.mjs';

const LEDGER_PATH = path.join(process.cwd(), 'data', 'financial', 'settlement_ledger.json');

export class SettlementLedger {
  constructor() {
    this.lock = new MutexLock('settlement_ledger');
    this.ensureLedgerExists();
  }

  ensureLedgerExists() {
    const dir = path.dirname(LEDGER_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(LEDGER_PATH)) {
      writeJsonAtomic(LEDGER_PATH, {
        daily_usage: {}, // { "YYYY-MM-DD": { "BANK_WIRE": 0, ... } }
        transactions: [], // History of all transactions
        queued: [] // Transactions waiting for limits/resources
      });
    }
  }

  getLedger() {
    if (!fs.existsSync(LEDGER_PATH)) {
      return { daily_usage: {}, transactions: [], queued: [] };
    }
    return readEncryptedJson(LEDGER_PATH);
  }

  saveLedger(data) {
    writeJsonAtomic(LEDGER_PATH, data);
  }

  async getDailyUsage(channel) {
    // Read-only, but should be consistent
    return await this.lock.runExclusive(() => {
        const data = this.getLedger();
        const today = new Date().toISOString().split('T')[0];
        
        if (!data.daily_usage[today]) {
          return 0;
        }
        return data.daily_usage[today][channel] || 0;
    });
  }

  async recordTransaction(channel, amount, status, txId, details = {}) {
    return await this.lock.runExclusive(() => {
        const data = this.getLedger();
        const today = new Date().toISOString().split('T')[0];
    
        // Update Daily Usage if Completed
        if (status === 'COMPLETED' || status === 'IN_TRANSIT') {
          if (!data.daily_usage[today]) data.daily_usage[today] = {};
          if (!data.daily_usage[today][channel]) data.daily_usage[today][channel] = 0;
          data.daily_usage[today][channel] += amount;
        }
    
        // Record Transaction
        const transaction = {
          id: txId || `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          timestamp: new Date().toISOString(),
          channel,
          amount,
          status, // QUEUED, IN_TRANSIT, COMPLETED, FAILED
          details
        };
        
        data.transactions.push(transaction);
        this.saveLedger(data);
        return transaction;
    });
  }

  async queueTransaction(channel, amount, reason) {
    return await this.lock.runExclusive(() => {
        const data = this.getLedger();
        const queueItem = {
          id: `queue_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          timestamp: new Date().toISOString(),
          channel,
          amount,
          reason,
          status: 'QUEUED'
        };
        data.queued.push(queueItem);
        this.saveLedger(data);
        return queueItem;
    });
  }
}
