// src/financial/SettlementLedger.mjs
import fs from 'fs';
import path from 'path';
import { MutexLock } from '../utils/MutexLock.mjs';
import { readEncryptedJson, writeJsonAtomic } from '../security/data-at-rest.mjs';

const LEDGER_PATH = path.resolve(
  process.env.SETTLEMENT_LEDGER_PATH || path.join(process.cwd(), 'data', 'financial', 'settlement_ledger.json')
);

function toCents(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100);
}

function transactionCurrency(transaction, fallback) {
  return String(transaction?.details?.currency || fallback || 'USD').toUpperCase();
}

function availableRevenueCents(data, currency) {
  const target = String(currency || 'USD').toUpperCase();
  return (data.transactions || []).reduce((balance, transaction) => {
    if (String(transaction.status || '').toUpperCase() !== 'COMPLETED') return balance;
    if (transactionCurrency(transaction, target) !== target) return balance;
    if (transaction.channel === 'REVENUE_PAYPAL') return balance + toCents(transaction.amount);
    if (transaction.channel === 'FULFILLMENT') return balance - toCents(transaction.amount);
    return balance;
  }, 0);
}

function addDailyUsage(data, channel, amount, at) {
  const day = new Date(at).toISOString().split('T')[0];
  if (!data.daily_usage[day]) data.daily_usage[day] = {};
  data.daily_usage[day][channel] = (data.daily_usage[day][channel] || 0) + Number(amount);
}

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

  /**
   * Credit a captured sale and reserve its fulfillment cost from unallocated
   * swarm revenue in one atomic ledger write. A fulfillment is never released
   * when the available revenue does not cover the configured cost.
   */
  async prepayFulfillment({
    orderId,
    revenueAmount,
    currency = 'USD',
    costCents = 0,
    productId = null,
    now = new Date()
  }) {
    return await this.lock.runExclusive(() => {
      const data = this.getLedger();
      if (!Array.isArray(data.transactions)) data.transactions = [];
      if (!data.daily_usage || typeof data.daily_usage !== 'object') data.daily_usage = {};
      const orderKey = String(orderId || '').trim();
      if (!orderKey) throw new Error('prepayFulfillment requires an orderId');

      const existingCost = (data.transactions || []).find(
        (transaction) => transaction.details?.kind === 'fulfillment_prepayment'
          && String(transaction.details?.order_id) === orderKey
      );
      const targetCurrency = String(currency || 'USD').toUpperCase();
      if (existingCost) {
        return {
          ok: true,
          duplicate: true,
          availableCents: availableRevenueCents(data, targetCurrency),
          costCents: toCents(existingCost.amount),
          revenueCents: toCents(existingCost.details?.revenue_amount),
          emailStatus: existingCost.details?.email_status || null,
          emailId: existingCost.details?.email_id || null,
          transaction: existingCost
        };
      }

      const revenueCents = toCents(revenueAmount);
      if (revenueCents <= 0) {
        return { ok: false, reason: 'INVALID_CAPTURED_REVENUE', availableCents: availableRevenueCents(data, targetCurrency), costCents };
      }
      const requestedCost = Math.max(0, Math.round(Number(costCents) || 0));
      const stamp = new Date(now).toISOString();
      const revenueId = `rev_${orderKey}`;
      let revenueTransaction = (data.transactions || []).find(
        (transaction) => transaction.details?.kind === 'order_revenue'
          && String(transaction.details?.order_id) === orderKey
      );
      const revenueAdded = !revenueTransaction;
      if (!revenueTransaction) {
        revenueTransaction = {
          id: revenueId,
          timestamp: stamp,
          channel: 'REVENUE_PAYPAL',
          amount: revenueCents / 100,
          status: 'COMPLETED',
          details: {
            kind: 'order_revenue',
            order_id: orderKey,
            currency: targetCurrency,
            product_id: productId || null
          }
        };
        data.transactions.push(revenueTransaction);
        addDailyUsage(data, 'REVENUE_PAYPAL', revenueCents / 100, stamp);
      }

      const availableCents = availableRevenueCents(data, targetCurrency);
      if (requestedCost > availableCents) {
        if (revenueAdded) this.saveLedger(data);
        return {
          ok: false,
          reason: 'INSUFFICIENT_SWARM_REVENUE',
          availableCents,
          costCents: requestedCost,
          currency: targetCurrency
        };
      }

      const costTransaction = {
        id: `ful_${orderKey}`,
        timestamp: stamp,
        channel: 'FULFILLMENT',
        amount: requestedCost / 100,
        status: 'COMPLETED',
        details: {
          kind: 'fulfillment_prepayment',
          order_id: orderKey,
          currency: targetCurrency,
          product_id: productId || null,
          prepaid_by: 'swarm',
          funding_source: 'swarm_revenue',
          revenue_transaction_id: revenueTransaction.id,
          revenue_amount: revenueCents / 100
        }
      };
      data.transactions.push(costTransaction);
      addDailyUsage(data, 'FULFILLMENT', requestedCost / 100, stamp);
      this.saveLedger(data);
      return {
        ok: true,
        duplicate: false,
        availableCents: availableCents - requestedCost,
        costCents: requestedCost,
        revenueCents,
        currency: targetCurrency,
        transaction: costTransaction
      };
    });
  }

  /** Persist the access-email outcome on the prepayment for retry idempotency. */
  async markFulfillmentEmail(orderId, { status, emailId = null, reason = null, at = new Date() } = {}) {
    return await this.lock.runExclusive(() => {
      const data = this.getLedger();
      const orderKey = String(orderId || '').trim();
      const transaction = (data.transactions || []).find(
        (item) => item.details?.kind === 'fulfillment_prepayment'
          && String(item.details?.order_id) === orderKey
      );
      if (!transaction) throw new Error(`No fulfillment prepayment for order ${orderKey}`);
      transaction.details = {
        ...transaction.details,
        email_status: String(status || '').toLowerCase() || 'unknown',
        email_id: emailId || null,
        email_error: reason || null,
        email_updated_at: new Date(at).toISOString()
      };
      data.updated_at = new Date(at).toISOString();
      this.saveLedger(data);
      return { ok: true, transaction };
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
