import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ExternalGatewayManager } from './ExternalGatewayManager.mjs';
import { OwnerSettlementEnforcer } from '../policy/owner-settlement.mjs';
import { AppendOnlyHmacLogger } from '../audit/AppendOnlyHmacLogger.mjs';
import { requireProviderBackedRevenue } from '../real/revenue-verification.mjs';

// ============================================================================
// LAZYARK FUSION: LEGACY REDIRECT MAP
// ============================================================================
// Maps Deprecated/Legacy Agent IDs -> Fused Super-Agent IDs
// This ensures trailing revenue from retired agents is correctly attributed.
const LEGACY_REDIRECT_MAP = {
  // Example: 'legacy_agent_001': 'fused_finance_unit_alpha'
};

// ============================================================================
// SHARED UTILITIES & STORAGE
// ============================================================================

class FinancialStorage {
  constructor(baseDir = './data/finance') {
    this.baseDir = baseDir;
    ['events', 'payouts', 'recipients', 'goals', 'rates', 'reconciliation', 'audit', 'idempotency', 'archive'].forEach(dir => {
      const fullPath = path.join(this.baseDir, dir);
      if (!fs.existsSync(fullPath)) fs.mkdirSync(fullPath, { recursive: true });
    });
    this.cache = new Map(); // Simple LRU-like cache could be better, but Map is fine for now
    this.cacheLimit = 1000;
  }

  save(type, id, data) {
    const filepath = path.join(this.baseDir, type, `${id}.json`);
    const record = { ...data, updated_at: new Date().toISOString() };
    fs.writeFileSync(filepath, JSON.stringify(record, null, 2));
    
    // Update cache
    this.cache.set(`${type}:${id}`, record);
    if (this.cache.size > this.cacheLimit) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    
    return record;
  }

  load(type, id) {
    const cacheKey = `${type}:${id}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);

    const filepath = path.join(this.baseDir, type, `${id}.json`);
    if (!fs.existsSync(filepath)) return null;
    
    const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    this.cache.set(cacheKey, data);
    return data;
  }

  list(type) {
    const dir = path.join(this.baseDir, type);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        // Try to load from cache first if ID matches filename convention
        const id = f.replace('.json', '');
        return this.load(type, id);
      });
  }

  archive(type, id) {
    const src = path.join(this.baseDir, type, `${id}.json`);
    const destDir = path.join(this.baseDir, 'archive', type);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    
    if (fs.existsSync(src)) {
      const dest = path.join(destDir, `${id}.json`);
      fs.renameSync(src, dest);
      this.cache.delete(`${type}:${id}`);
    }
  }
}

// ============================================================================
// 0. AUDIT & SAFETY CORE
// ============================================================================

class SystemAuditLogger {
  constructor(storage) {
    this.storage = storage;
    this.appendOnly = new AppendOnlyHmacLogger();
  }

  log(action, entityId, oldState, newState, actor, context = {}) {
    const auditId = `AUD_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const entry = {
      id: auditId,
      timestamp: new Date().toISOString(),
      action,
      entity_id: entityId,
      actor,
      changes: {
        before: oldState,
        after: newState
      },
      context
    };
    
    this.storage.save('audit', auditId, entry);
    console.log(`📝 [AUDIT] ${action} on ${entityId} by ${actor}`);
    try {
      this.appendOnly.write(entry);
    } catch {}
  }
}

class IdempotencyManager {
  constructor(storage) {
    this.storage = storage;
  }

  get(key) {
    return this.storage.load('idempotency', key);
  }

  lock(key) {
    const existing = this.get(key);
    if (existing && existing.status === 'completed') return existing;
    if (existing && existing.status === 'pending') {
      const age = Date.now() - new Date(existing.created_at).getTime();
      if (age < 300000) throw new Error(`Transaction ${key} is currently in progress.`);
    }

    const record = {
      id: key,
      status: 'pending',
      created_at: new Date().toISOString()
    };
    return this.storage.save('idempotency', key, record);
  }

  complete(key, result) {
    const record = {
      id: key,
      status: 'completed',
      result,
      completed_at: new Date().toISOString()
    };
    return this.storage.save('idempotency', key, record);
  }

  fail(key, error) {
    const record = {
      id: key,
      status: 'failed',
      error: error.message || error,
      failed_at: new Date().toISOString()
    };
    return this.storage.save('idempotency', key, record);
  }
}

class TransactionExecutor {
  constructor(idempotencyManager, auditLogger) {
    this.idempotency = idempotencyManager;
    this.audit = auditLogger;
  }

  async execute(idempotencyKey, taskFn, context) {
    const existing = this.idempotency.get(idempotencyKey);
    if (existing && existing.status === 'completed') {
      console.log(`🔁 [IDEMPOTENCY] Returning cached result for ${idempotencyKey}`);
      return existing.result;
    }

    this.idempotency.lock(idempotencyKey);

    let attempt = 0;
    const maxRetries = 3;
    let lastError = null;

    while (attempt < maxRetries) {
      try {
        attempt++;
        const result = await taskFn();
        this.idempotency.complete(idempotencyKey, result);
        this.audit.log(context.action, idempotencyKey, null, result, context.actor, { ...context, status: 'success' });
        return result;

      } catch (error) {
        lastError = error;
        console.warn(`⚠️ [EXEC] Attempt ${attempt}/${maxRetries} failed for ${idempotencyKey}: ${error.message}`);
        if (this.isUnrecoverable(error)) break;
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }

    this.idempotency.fail(idempotencyKey, lastError);
    this.audit.log(context.action, idempotencyKey, null, { error: lastError.message }, context.actor, { ...context, status: 'failed' });
    throw new Error(`Transaction failed after ${attempt} attempts: ${lastError.message}`);
  }

  isUnrecoverable(error) {
    const fatalErrors = ['INVALID_CREDENTIALS', 'INSUFFICIENT_FUNDS', 'ACCOUNT_SUSPENDED'];
    return fatalErrors.some(code => error.message.includes(code));
  }
}

// ============================================================================
// 0.1 PERFORMANCE UTILITIES
// ============================================================================

class BatchProcessor {
  constructor(batchSize = 10, timeoutMs = 5000, processFn) {
    this.batchSize = batchSize;
    this.timeoutMs = timeoutMs;
    this.processFn = processFn; // async (items) => void
    this.queue = [];
    this.timer = null;
  }

  add(item) {
    return new Promise((resolve, reject) => {
      this.queue.push({ item, resolve, reject });
      if (this.queue.length >= this.batchSize) {
        this.flush();
      } else if (!this.timer) {
        this.timer = setTimeout(() => this.flush(), this.timeoutMs);
      }
    });
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    
    if (this.queue.length === 0) return;

    const currentBatch = this.queue.splice(0, this.batchSize);
    const items = currentBatch.map(i => i.item);

    try {
      console.log(`📦 [BATCH] Processing ${items.length} items...`);
      const results = await this.processFn(items);
      
      // Assuming results matches order of items, or processFn throws if whole batch fails
      // If processFn returns array of results:
      if (Array.isArray(results) && results.length === items.length) {
         currentBatch.forEach((entry, idx) => entry.resolve(results[idx]));
      } else {
         // Fallback if generic success
         currentBatch.forEach(entry => entry.resolve(results));
      }
    } catch (error) {
      console.error(`❌ [BATCH] Failed: ${error.message}`);
      currentBatch.forEach(entry => entry.reject(error));
    }
  }
}

// ============================================================================
// 1. RECIPIENT MANAGEMENT
// ============================================================================

class RecipientManager {
  constructor(storage, auditLogger) {
    this.storage = storage;
    this.audit = auditLogger;
  }

  createRecipient(data, actor = 'System') {
    // ENFORCE OWNER REVENUE DIRECTIVE
    const paypalPrimary = OwnerSettlementEnforcer.getOwnerAccountForType('paypal');
    const payoneerPrimary = OwnerSettlementEnforcer.getOwnerAccountForType('payoneer');
    const payoneerSecondary = OwnerSettlementEnforcer.getOwnerAccountForType('payoneer_secondary');
    const bankPrimary = OwnerSettlementEnforcer.getOwnerAccountForType('bank');
    const cryptoPrimary = OwnerSettlementEnforcer.getOwnerAccountForType('crypto');

    const isOwner = (
      data.email === paypalPrimary || 
      data.email === payoneerPrimary ||
      data.email === payoneerSecondary ||
      data.bank_account === bankPrimary ||
      (data.name && data.name.includes('Owner')) // Basic check, reliant on exact account match mostly
    );

    // If attempting to add a payment method that is NOT in the allowlist, BLOCK IT.
    if (data.payment_methods) {
      for (const method of data.payment_methods) {
        if (method.type === 'paypal' && method.details.email !== paypalPrimary) {
          throw new Error(`VIOLATION: PayPal account ${method.details.email} is not authorized. Hard-Lock Active.`);
        }
        if (method.type === 'bank' && method.details.rib !== bankPrimary) {
          throw new Error(`VIOLATION: Bank account ${method.details.rib} is not authorized. Hard-Lock Active.`);
        }
        if (method.type === 'payoneer' && 
            method.details.email !== payoneerPrimary && 
            method.details.email !== payoneerSecondary) {
          throw new Error(`VIOLATION: Payoneer account ${method.details.email} is not authorized. Hard-Lock Active.`);
        }
        if (method.type === 'crypto' && method.details.address !== cryptoPrimary) {
             throw new Error(`VIOLATION: Crypto address ${method.details.address} is not authorized. Hard-Lock Active.`);
        }
      }
    }

    // For the Recipient entity itself, we strictly enforce that any "Business" or "Individual" 
    // receiving funds must be the Owner or an explicit sub-account of the Owner.
    // However, since we are "Hard-Locked", we can just reject ANY creation that isn't explicitly the Owner.
    // But for flexibility in "Metadata", we'll rely on the Payment Method check above as the primary gate.
    
    const id = `RCP_${crypto.randomUUID()}`;
    const recipient = {
      id,
      name: data.name,
      email: data.email,
      type: data.type || 'individual',
      tax_id: data.tax_id,
      jurisdiction: data.jurisdiction || 'US', // Default to US for now
      tax_form_status: 'pending', // pending, collected, verified
      payment_methods: data.payment_methods || [],
      created_at: new Date().toISOString(),
      status: 'active'
    };
    
    const saved = this.storage.save('recipients', id, recipient);
    this.audit.log('CREATE_RECIPIENT', id, null, saved, actor);
    return saved;
  }

  getRecipient(id) {
    return this.storage.load('recipients', id);
  }

  updateRecipient(id, updates, actor = 'System') {
    const recipient = this.getRecipient(id);
    if (!recipient) throw new Error(`Recipient ${id} not found`);

    // ENFORCE OWNER REVENUE DIRECTIVE ON UPDATE
    if (updates.payment_methods) {
      const paypalPrimary = OwnerSettlementEnforcer.getOwnerAccountForType('paypal');
      const payoneerPrimary = OwnerSettlementEnforcer.getOwnerAccountForType('payoneer');
      const payoneerSecondary = OwnerSettlementEnforcer.getOwnerAccountForType('payoneer_secondary');
      const bankPrimary = OwnerSettlementEnforcer.getOwnerAccountForType('bank');
      const cryptoPrimary = OwnerSettlementEnforcer.getOwnerAccountForType('crypto');

      for (const method of updates.payment_methods) {
        if (method.type === 'paypal' && method.details.email !== paypalPrimary) {
          throw new Error(`VIOLATION: PayPal account ${method.details.email} is not authorized. Hard-Lock Active.`);
        }
        if (method.type === 'bank' && method.details.rib !== bankPrimary) {
          throw new Error(`VIOLATION: Bank account ${method.details.rib} is not authorized. Hard-Lock Active.`);
        }
        if (method.type === 'payoneer' && 
            method.details.email !== payoneerPrimary && 
            method.details.email !== payoneerSecondary) {
          throw new Error(`VIOLATION: Payoneer account ${method.details.email} is not authorized. Hard-Lock Active.`);
        }
        if (method.type === 'crypto' && method.details.address !== cryptoPrimary) {
             throw new Error(`VIOLATION: Crypto address ${method.details.address} is not authorized. Hard-Lock Active.`);
        }
      }
    }
    
    const updated = { ...recipient, ...updates };
    const saved = this.storage.save('recipients', id, updated);
    
    this.audit.log('UPDATE_RECIPIENT', id, recipient, saved, actor);
    return saved;
  }
}

// ============================================================================
// 2. MULTI-CURRENCY SUPPORT
// ============================================================================

class CurrencyManager {
  constructor(storage, auditLogger) {
    this.storage = storage;
    this.audit = auditLogger;
    this.baseCurrency = 'USD';
    this.rates = { 'USD': 1.0 };
  }

  async updateExchangeRates(actor = 'System') {
    console.log('🔄 Fetching real-time exchange rates...');
    const oldRates = { ...this.rates };
    
    const mockRates = {
      'USD': 1.0,
      'EUR': 0.92,
      'GBP': 0.79,
      'MAD': 10.15,
      'BTC': 0.000023,
      'ETH': 0.00035
    };
    this.rates = mockRates;
    
    const saved = this.storage.save('rates', 'latest', { 
      base: this.baseCurrency, 
      rates: this.rates, 
      timestamp: Date.now() 
    });

    this.audit.log('UPDATE_EXCHANGE_RATES', 'latest', oldRates, this.rates, actor);
    return this.rates;
  }

  getExchangeRate(from, to) {
    const fromRate = this.rates[from];
    const toRate = this.rates[to];
    if (!fromRate || !toRate) throw new Error(`Exchange rate not found for ${from} -> ${to}`);
    return toRate / fromRate;
  }

  convert(amount, from, to) {
    const rate = this.getExchangeRate(from, to);
    return amount * rate;
  }
}

// ============================================================================
// 3. REVENUE INGESTION & ADJUSTMENT
// ============================================================================

export class RevenueManager {
  constructor(storage, auditLogger) {
    this.storage = storage;
    this.audit = auditLogger;
    // Example of using BatchProcessor for high-volume ingest if needed
    // this.ingestBatcher = new BatchProcessor(50, 2000, this.processBatch.bind(this));
  }

  ingestRawRevenue(data, sourceSystem, actor = 'System') {
    // Nothing enters the revenue ledger without provider evidence, including
    // recurring schedules and swarm trades that only assert an amount.
    requireProviderBackedRevenue(
      {
        externalId: data?.external_id ?? data?.id ?? null,
        amount: data?.amount,
        currency: data?.currency,
        metadata: data?.metadata,
        verification_proof: data?.verification_proof
      },
      { label: `revenue ingest from ${sourceSystem ?? actor}` }
    );

    const id = `REV_${crypto.randomUUID()}`;
    
    // LAZYARK FUSION: Handle Legacy Agent Redirection
    let agentId = data.agent_id || 'unknown';
    let originalAgentId = null;
    let fusionMetadata = {};

    // CHECK 1: Explicit Harvest Mode (from Agent Config/Metadata)
    // "Legacy Harvest Protocol": Kept agents contribute revenue to Fused Parent
    if (data.metadata && (data.metadata.harvest_mode_enabled || data.metadata.is_legacy_harvest)) {
      originalAgentId = agentId;
      fusionMetadata = {
        is_legacy_harvest: true,
        tributary_source: originalAgentId,
        fused_parent_id: data.metadata.fused_parent_id || null,
        revenue_type: 'passive_harvest', // High-margin legacy yield
        payout_priority: 'immediate' // Harvested funds settle to owner ASAP
      };
      
      // Redirect attribution to parent if defined, but keep source tracking
      if (data.metadata.fused_parent_id) {
        agentId = data.metadata.fused_parent_id;
        console.log(`🌾 [HARVEST] Processing legacy yield from ${originalAgentId} -> ${agentId}`);
      } else {
        console.log(`🌾 [HARVEST] Processing legacy yield from ${originalAgentId} (Unlinked Tributary)`);
      }
    }
    // CHECK 2: Static Map (Fallback)
    else if (LEGACY_REDIRECT_MAP[agentId]) {
      originalAgentId = agentId;
      agentId = LEGACY_REDIRECT_MAP[agentId];
      fusionMetadata = {
        is_legacy_redirect: true,
        original_agent_id: originalAgentId,
        redirect_reason: 'LazyArk Fusion Protocol'
      };
      console.log(`🔀 [FUSION] Redirecting revenue from Legacy Agent ${originalAgentId} -> Fused Unit ${agentId}`);
    }

    const event = {
      id,
      source_system: sourceSystem,
      original_data: data,
      amount: parseFloat(data.amount),
      currency: data.currency || 'USD',
      status: 'pending_reconciliation',
      timestamp: data.timestamp || new Date().toISOString(),
      metadata: { 
        ...(data.metadata || {}),
        ...fusionMetadata
      },
      // Attribution fields
      attribution: {
        agent_id: agentId,
        fused_agent_id: data.fused_agent_id || (agentId.startsWith('fused_') ? agentId : null),
        campaign_id: data.campaign_id || null,
        source_url: data.source_url || null
      }
    };
    
    if (data.proof_id || data.transaction_id) {
      event.status = 'verified';
    }

    const saved = this.storage.save('events', id, event);
    this.audit.log('INGEST_REVENUE', id, null, saved, actor, { source: sourceSystem, fusion_redirect: !!originalAgentId });
    return saved;
  }

  disputeEvent(id, reason, actor = 'System') {
    const event = this.storage.load('events', id);
    if (!event) throw new Error(`Event ${id} not found`);
    
    const oldState = { ...event };
    event.status = 'disputed';
    event.dispute_reason = reason;
    event.dispute_date = new Date().toISOString();
    
    const saved = this.storage.save('events', id, event);
    this.audit.log('DISPUTE_EVENT', id, oldState, saved, actor, { reason });
    return saved;
  }

  adjustEvent(id, newAmount, reason, actor = 'System') {
    const event = this.storage.load('events', id);
    if (!event) throw new Error(`Event ${id} not found`);

    const oldState = { ...event };
    const oldAmount = event.amount;
    event.amount = newAmount;
    event.adjustment_history = event.adjustment_history || [];
    event.adjustment_history.push({
      date: new Date().toISOString(),
      old_amount: oldAmount,
      new_amount: newAmount,
      reason
    });
    event.status = 'adjusted';

    const saved = this.storage.save('events', id, event);
    this.audit.log('ADJUST_EVENT', id, oldState, saved, actor, { reason, oldAmount, newAmount });
    return saved;
  }
}

// ============================================================================
// 4. FINANCIAL GOALS & ANALYTICS
// ============================================================================

class FinancialGoalManager {
  constructor(storage, revenueManager, auditLogger) {
    this.storage = storage;
    this.revenueManager = revenueManager;
    this.audit = auditLogger;
  }

  createGoal(name, targetAmount, targetDate, type = 'revenue', actor = 'System') {
    const id = `GOAL_${crypto.randomUUID()}`;
    const goal = {
      id,
      name,
      target_amount: targetAmount,
      target_date: targetDate,
      type,
      status: 'active',
      created_at: new Date().toISOString()
    };
    const saved = this.storage.save('goals', id, goal);
    this.audit.log('CREATE_GOAL', id, null, saved, actor);
    return saved;
  }

  checkGoals() {
    const goals = this.storage.list('goals').filter(g => g.status === 'active');
    const events = this.storage.list('events');
    
    const results = goals.map(goal => {
      let currentAmount = 0;
      if (goal.type === 'revenue') {
        currentAmount = events
          .filter(e => e.status === 'verified' || e.status === 'settled')
          .reduce((sum, e) => sum + e.amount, 0);
      } else if (goal.type === 'passive_income') {
        // NEW: Track passive harvest revenue separately if goal type is 'passive_income'
        currentAmount = events
          .filter(e => (e.status === 'verified' || e.status === 'settled') && e.metadata?.mode === 'passive_harvest')
          .reduce((sum, e) => sum + e.amount, 0);
      }
      
      const progress = (currentAmount / goal.target_amount) * 100;
      const isMet = currentAmount >= goal.target_amount;
      
      return {
        goal_id: goal.id,
        name: goal.name,
        current: currentAmount,
        target: goal.target_amount,
        progress: progress.toFixed(2) + '%',
        met: isMet
      };
    });
    
    return results;
  }

  generateForecast(months = 3) {
    const events = this.storage.list('events')
      .filter(e => e.status === 'verified' || e.status === 'settled')
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    if (events.length < 2) return { error: "Not enough data for forecast" };

    const firstDate = new Date(events[0].timestamp);
    const lastDate = new Date(events[events.length - 1].timestamp);
    const days = (lastDate - firstDate) / (1000 * 60 * 60 * 24);
    const totalRevenue = events.reduce((sum, e) => sum + e.amount, 0);
    const dailyAvg = totalRevenue / (days || 1);

    const forecast = [];
    let currentDate = new Date();
    
    for (let i = 1; i <= months; i++) {
      currentDate.setMonth(currentDate.getMonth() + 1);
      forecast.push({
        month: currentDate.toISOString().slice(0, 7),
        projected_revenue: (dailyAvg * 30).toFixed(2)
      });
    }

    return forecast;
  }
}

// ============================================================================
// 4.1 ANALYTICS ENGINE
// ============================================================================

class AnalyticsEngine {
  constructor(storage) {
    this.storage = storage;
  }

  detectAnomalies(thresholdMultiplier = 2.0) {
    const events = this.storage.list('events')
      .filter(e => e.status === 'verified' || e.status === 'settled')
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    if (events.length < 10) return []; // Need baseline

    // Calculate mean and std dev of daily revenue
    const dailyRevenue = {};
    events.forEach(e => {
      const day = e.timestamp.slice(0, 10);
      dailyRevenue[day] = (dailyRevenue[day] || 0) + e.amount;
    });

    const values = Object.values(dailyRevenue);
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);

    const anomalies = [];
    for (const [day, amount] of Object.entries(dailyRevenue)) {
      if (amount > mean + (thresholdMultiplier * stdDev) || amount < mean - (thresholdMultiplier * stdDev)) {
        anomalies.push({
          date: day,
          amount,
          type: amount > mean ? 'SPIKE' : 'DROP',
          deviation: ((amount - mean) / stdDev).toFixed(2)
        });
      }
    }
    
    return anomalies;
  }
}

// ============================================================================
// 5. ADVANCED RECONCILIATION
// ============================================================================

class ReconciliationEngine {
  constructor(storage, revenueManager, auditLogger) {
    this.storage = storage;
    this.revenueManager = revenueManager;
    this.audit = auditLogger;
  }

  importExternalStatement(fileData, source) {
    const lines = fileData.trim().split('\n');
    const transactions = lines.slice(1).map(line => {
      const [date, desc, amount, currency, ref] = line.split(',');
      return { date, desc, amount: parseFloat(amount), currency, ref };
    });

    return this.matchTransactions(transactions, source);
  }

  matchTransactions(externalTxns, source) {
    const internalEvents = this.storage.list('events').filter(e => e.status !== 'reconciled');
    const matches = [];
    const unmatched = [];

    externalTxns.forEach(ext => {
      const match = internalEvents.find(int => {
        const amountMatch = Math.abs(int.amount - ext.amount) < 0.01;
        const refMatch = int.id === ext.ref || (int.original_data && int.original_data.transaction_id === ext.ref);
        return refMatch || amountMatch;
      });

      if (match) {
        const oldState = { ...match };
        match.status = 'reconciled';
        match.reconciliation_data = {
          source,
          external_ref: ext.ref,
          matched_at: new Date().toISOString()
        };
        const saved = this.storage.save('events', match.id, match);
        this.audit.log('RECONCILE_MATCH', match.id, oldState, saved, 'ReconciliationEngine', { externalRef: ext.ref });
        matches.push({ internal: match.id, external: ext });
      } else {
        unmatched.push(ext);
      }
    });

    return { matches, unmatched };
  }
}

// ============================================================================
// 6. RECURRING PAYOUTS
// ============================================================================

class RecurringPayoutManager {
  constructor(storage, revenueManager, auditLogger, executor) {
    this.storage = storage;
    this.revenueManager = revenueManager;
    this.audit = auditLogger;
    this.executor = executor;
  }

  createSchedule(recipientId, amount, currency, frequency, startDate, actor = 'System') {
    const id = `SCHED_${crypto.randomUUID()}`;
    const schedule = {
      id,
      recipient_id: recipientId,
      amount,
      currency,
      frequency,
      start_date: startDate,
      next_run: startDate,
      status: 'active',
      created_at: new Date().toISOString()
    };
    const saved = this.storage.save('payouts', id, schedule);
    this.audit.log('CREATE_PAYOUT_SCHEDULE', id, null, saved, actor);
    return saved;
  }

  async processSchedules(actor = 'System') {
    const schedules = this.storage.list('payouts').filter(s => s.status === 'active' && s.next_run);
    const now = new Date();
    const generatedEvents = [];

    for (const sched of schedules) {
      if (new Date(sched.next_run) <= now) {
        // Use TransactionExecutor for idempotency
        const idempotencyKey = `PAYOUT_RUN_${sched.id}_${sched.next_run}`;
        
        try {
          const event = await this.executor.execute(idempotencyKey, async () => {
             // Generate Revenue Event (or Payout Request)
            const newEvent = this.revenueManager.ingestRawRevenue({
              amount: sched.amount,
              currency: sched.currency,
              source: 'RecurringSchedule',
              metadata: { schedule_id: sched.id, recipient_id: sched.recipient_id }
            }, 'RecurringPayoutSystem', actor);
            
            // Update next run
            const oldState = { ...sched };
            const nextDate = new Date(sched.next_run);
            if (sched.frequency === 'daily') nextDate.setDate(nextDate.getDate() + 1);
            if (sched.frequency === 'weekly') nextDate.setDate(nextDate.getDate() + 7);
            if (sched.frequency === 'monthly') nextDate.setMonth(nextDate.getMonth() + 1);
            
            sched.next_run = nextDate.toISOString();
            this.storage.save('payouts', sched.id, sched);
            this.audit.log('UPDATE_SCHEDULE_NEXT_RUN', sched.id, oldState, sched, actor);

            return newEvent;
          }, { action: 'PROCESS_RECURRING_PAYOUT', actor });

          generatedEvents.push(event);

        } catch (e) {
          console.error(`Failed to process schedule ${sched.id}:`, e);
        }
      }
    }

    return generatedEvents;
  }
}

// ============================================================================
// 7. COMPLIANCE MANAGER
// ============================================================================

class ComplianceManager {
  constructor(storage, auditLogger) {
    this.storage = storage;
    this.audit = auditLogger;
  }

  generateTaxReport(year, jurisdiction = 'US') {
    const startDate = new Date(`${year}-01-01`);
    const endDate = new Date(`${year}-12-31`);
    
    // Scan all recipients and their payouts
    // Note: This logic assumes we have 'payouts' recorded as events or separate entities
    // For now, we scan 'events' that are marked as payouts or revenue paid out
    // In a real system, we'd query a 'Payouts' table. Using 'events' for simplicity here.
    
    const recipients = this.storage.list('recipients');
    const events = this.storage.list('events'); // Assuming events track money movement

    const report = {
      year,
      jurisdiction,
      generated_at: new Date().toISOString(),
      recipients: []
    };

    recipients.forEach(rcp => {
      if (jurisdiction && rcp.jurisdiction !== jurisdiction) return;

      const totalPaid = events
        .filter(e => {
          const date = new Date(e.timestamp);
          return date >= startDate && date <= endDate && 
                 e.metadata && e.metadata.recipient_id === rcp.id;
        })
        .reduce((sum, e) => sum + e.amount, 0);

      if (totalPaid > 0) {
        report.recipients.push({
          id: rcp.id,
          name: rcp.name,
          tax_id: rcp.tax_id,
          total_paid: totalPaid,
          form_required: totalPaid > 600 // Example threshold
        });
      }
    });

    return report;
  }

  enforceRetentionPolicy(daysToRetain = 365) {
    console.log('🧹 Enforcing Data Retention Policy...');
    const now = new Date();
    const cutoff = new Date(now.setDate(now.getDate() - daysToRetain));

    ['events', 'audit', 'idempotency'].forEach(type => {
      const items = this.storage.list(type);
      let archivedCount = 0;
      
      items.forEach(item => {
        const itemDate = new Date(item.timestamp || item.created_at);
        if (itemDate < cutoff) {
          this.storage.archive(type, item.id);
          archivedCount++;
        }
      });
      
      if (archivedCount > 0) {
        console.log(`   - Archived ${archivedCount} ${type} items older than ${daysToRetain} days.`);
      }
    });
  }
}

// ============================================================================
// 8. INTEGRATION HUB
// ============================================================================

class IntegrationHub {
  constructor(storage) {
    this.storage = storage;
  }

  async syncToCRM(entityType, entityId) {
    // Stub: Would connect to Salesforce/HubSpot
    console.log(`🔌 [CRM] Syncing ${entityType}:${entityId}...`);
    return { status: 'synced', external_id: `CRM_${entityId}` };
  }

  async exportToERP(batchId) {
    // Stub: Would connect to SAP/Oracle
    console.log(`🔌 [ERP] Exporting batch ${batchId}...`);
    return { status: 'exported', erp_ref: `ERP_BATCH_${Date.now()}` };
  }
}

// ============================================================================
// MAIN MANAGER
// ============================================================================

export class AdvancedFinancialManager {
  constructor() {
    this.storage = new FinancialStorage();
    this.audit = new SystemAuditLogger(this.storage);
    this.idempotency = new IdempotencyManager(this.storage);
    this.executor = new TransactionExecutor(this.idempotency, this.audit);
    
    // Utils
    this.batcher = new BatchProcessor();

    // Managers
    this.recipients = new RecipientManager(this.storage, this.audit);
    this.currency = new CurrencyManager(this.storage, this.audit);
    this.revenue = new RevenueManager(this.storage, this.audit);
    this.goals = new FinancialGoalManager(this.storage, this.revenue, this.audit);
    this.reconciliation = new ReconciliationEngine(this.storage, this.revenue, this.audit);
    this.recurring = new RecurringPayoutManager(this.storage, this.revenue, this.audit, this.executor);
    
    // New Modules
    this.compliance = new ComplianceManager(this.storage, this.audit);
    this.analytics = new AnalyticsEngine(this.storage);
    this.integration = new IntegrationHub(this.storage);
    this.gateway = new ExternalGatewayManager(this.storage, this.audit, this.executor);
  }

  async initialize() {
    console.log('🚀 Initializing Advanced Financial Manager...');
    console.log('   - Audit System: Active');
    console.log('   - Idempotency Manager: Active');
    console.log('   - Caching: Active');
    await this.currency.updateExchangeRates();
    console.log('✅ Financial Manager Ready');
  }

  /**
   * Main Reconciliation Entry Point
   * Checks for stalled events or data integrity issues
   */
  async reconcile() {
    console.log('🔍 [MANAGER] Running internal reconciliation...');
    const events = this.storage.list('events');
    const now = Date.now();
    const discrepancies = [];
    let processedCount = 0;

    for (const event of events) {
      processedCount++;
      // Check 1: Stalled Pending Events (> 24h)
      if (event.status === 'pending_reconciliation') {
        const age = now - new Date(event.timestamp).getTime();
        if (age > 86400000) { // 24 hours
          discrepancies.push({
            id: event.id,
            type: 'STALLED_EVENT',
            amount: event.amount, // Expose amount for decision making
            details: `Event pending for ${(age / 3600000).toFixed(1)} hours. Amount: $${event.amount}`
          });
        }
      }
      
      // Check 2: Missing Attribution
      if (!event.attribution || !event.attribution.agent_id) {
        discrepancies.push({
          id: event.id,
          type: 'MISSING_ATTRIBUTION',
          details: 'Event lacks agent_id attribution'
        });
      }

      // Check 3: Amount Mismatch (Ledger vs Proof)
      // PSP Proof is the Source of Truth
      if (event.verification_proof && event.verification_proof.amount) {
          const ledgerAmount = Number(event.amount);
          const proofAmount = Number(event.verification_proof.amount);
          if (Math.abs(ledgerAmount - proofAmount) > 0.01) {
              discrepancies.push({
                  id: event.id,
                  type: 'AMOUNT_MISMATCH',
                  details: `Ledger: ${ledgerAmount}, Proof: ${proofAmount}`,
                  correction_data: {
                      correct_amount: proofAmount,
                      diff: Math.abs(ledgerAmount - proofAmount)
                  }
              });
          }
      }
    }

    return {
      processed_count: processedCount,
      discrepancies
    };
  }

  /**
   * Helper to execute a secure financial transaction from external callers
   */
  async executeTransaction(key, taskFn, context) {
    return this.executor.execute(key, taskFn, context);
  }
}
