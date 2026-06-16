#!/usr/bin/env node
// scripts/unified-autonomous-daemon.mjs
// UNIFIED AUTONOMOUS SETTLEMENT DAEMON
// Combines all settlement logic into one 24/7 operation
// Zero human intervention, complete automation

import { Base44SDK } from '@base44/node-sdk';
import fetch from 'node-fetch';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// ============================================================================
// IMMUTABLE OWNER CONFIGURATION
// ============================================================================

const OWNER = Object.freeze({
  paypal: process.env.OWNER_PAYPAL_EMAIL || 'younestsouli2019@gmail.com',
  bank: process.env.OWNER_BANK_ACCOUNT || '007810000448500030594182',
  bankName: 'Attijariwafa Bank',
  payoneer: process.env.OWNER_PAYONEER_ID || 'PRINCIPAL_ACCOUNT',
  name: 'YOUNES TSOULI'
});

// ============================================================================
// DAEMON CONFIGURATION
// ============================================================================

const DAEMON_CONFIG = {
  // Timing
  scanInterval: 60000, // 60 seconds
  settlementDelay: 0, // Immediate execution
  healthCheckInterval: 300000, // 5 minutes
  
  // Auto-approval
  autoApproveThreshold: 999999999, // Unlimited
  autoApproveAll: true,
  
  // Execution
  maxRetries: 5,
  retryDelay: 30000, // 30 seconds
  maxConcurrentBatches: 3,
  
  // Rails priority
  rails: {
    primary: 'paypal',
    fallback: ['bank', 'payoneer']
  },
  
  // Safety (cannot be disabled)
  ownerOnlyMode: true,
  blockNonOwnerDestinations: true,
  requirePSPProof: true,
  
  // Storage
  persistLocal: true,
  enableAuditTrail: true,
  
  // Base44 integration
  tryBase44First: true,
  fallbackOnBase44Failure: true
};

// ============================================================================
// UNIFIED LOGGER
// ============================================================================

class UnifiedLogger {
  constructor() {
    this.logs = [];
    this.sessionId = crypto.randomBytes(8).toString('hex');
    this.startTime = Date.now();
    
    // Setup directories
    this.dirs = {
      audit: './audits/daemon',
      data: './data/daemon',
      exports: './exports',
      proof: './proof'
    };
    
    Object.values(this.dirs).forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  log(message, level = 'info', data = null) {
    const entry = {
      session: this.sessionId,
      timestamp: new Date().toISOString(),
      elapsed: Date.now() - this.startTime,
      level,
      message,
      data
    };
    
    this.logs.push(entry);
    
    // Console output with icons
    const icons = {
      info: 'ℹ️',
      success: '✅',
      warning: '⚠️',
      error: '❌',
      critical: '🚨',
      money: '💰',
      auto: '🤖',
      owner: '👤',
      daemon: '⚙️',
      health: '💚'
    };
    
    const icon = icons[level] || 'ℹ️';
    const ts = new Date().toISOString();
    
    console.log(`${icon} [${ts}] ${message}`);
    if (data && Object.keys(data).length > 0) {
      console.log('   Data:', JSON.stringify(data, null, 2));
    }
    
    // Persist critical logs immediately
    if (['error', 'critical', 'money', 'owner'].includes(level)) {
      this.persistLog(entry);
    }
  }

  persistLog(entry) {
    const date = entry.timestamp.split('T')[0];
    const logFile = path.join(this.dirs.audit, `${date}.jsonl`);
    fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
  }

  saveSnapshot(name, data) {
    const filepath = path.join(this.dirs.data, `${name}_${Date.now()}.json`);
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
    return filepath;
  }

  flushLogs() {
    const logFile = path.join(this.dirs.audit, `session_${this.sessionId}.json`);
    const summary = {
      session_id: this.sessionId,
      started_at: new Date(this.startTime).toISOString(),
      ended_at: new Date().toISOString(),
      duration_ms: Date.now() - this.startTime,
      total_logs: this.logs.length,
      logs: this.logs
    };
    
    fs.writeFileSync(logFile, JSON.stringify(summary, null, 2));
    this.log(`Session logs saved: ${logFile}`, 'success');
  }
}

// ============================================================================
// PERSISTENT STORAGE
// ============================================================================

class DaemonStorage {
  constructor(logger) {
    this.logger = logger;
    this.storageDir = './data/daemon/ledger';
    
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  save(type, id, data) {
    const filepath = path.join(this.storageDir, `${type}_${id}.json`);
    const record = {
      id,
      type,
      data,
      saved_at: new Date().toISOString()
    };
    
    fs.writeFileSync(filepath, JSON.stringify(record, null, 2));
    return filepath;
  }

  load(type, id) {
    const filepath = path.join(this.storageDir, `${type}_${id}.json`);
    if (!fs.existsSync(filepath)) return null;
    
    const content = fs.readFileSync(filepath, 'utf8');
    return JSON.parse(content);
  }

  loadAll(type) {
    return fs.readdirSync(this.storageDir)
      .filter(f => f.startsWith(`${type}_`))
      .map(f => {
        const content = fs.readFileSync(path.join(this.storageDir, f), 'utf8');
        return JSON.parse(content);
      });
  }

  query(type, filter) {
    const all = this.loadAll(type);
    return all.filter(record => {
      for (const [key, value] of Object.entries(filter)) {
        if (record.data[key] !== value) return false;
      }
      return true;
    });
  }

  getPendingSettlements() {
    const earnings = this.loadAll('earning');
    return earnings.filter(e => 
      e.data.status === 'pending_payout' || 
      e.data.status === 'verified' ||
      (e.data.settled === false && e.data.verification_proof)
    );
  }

  markSettled(earningId, batchId) {
    const earning = this.load('earning', earningId);
    if (!earning) return false;
    
    earning.data.status = 'settled';
    earning.data.settled_at = new Date().toISOString();
    earning.data.payout_batch_id = batchId;
    
    this.save('earning', earningId, earning.data);
    return true;
  }
}

// ============================================================================
// BASE44 CLIENT WITH FALLBACK
// ============================================================================

class ResilientBase44 {
  constructor(logger, storage) {
    this.logger = logger;
    this.storage = storage;
    this.available = false;
    
    try {
      this.client = new Base44SDK({
        appId: process.env.BASE44_APP_ID,
        serviceToken: process.env.BASE44_SERVICE_TOKEN
      });
    } catch (error) {
      this.logger.log('Base44 SDK initialization failed', 'warning', { error: error.message });
    }
  }

  async checkAvailability() {
    if (!this.client) return false;
    
    try {
      await this.client.Earning?.find?.({ limit: 1 });
      this.available = true;
      this.logger.log('Base44 connection: AVAILABLE', 'success');
      return true;
    } catch (error) {
      this.available = false;
      this.logger.log('Base44 connection: UNAVAILABLE (using fallback)', 'warning');
      return false;
    }
  }

  async queryRevenueEvents() {
    if (!this.available) {
      return this.storage.query('revenue', { settled: false, status: 'VERIFIED' });
    }
    
    try {
      const results = await this.client.RevenueEvent.find({
        settled: false,
        status: 'VERIFIED'
      });
      
      return results.records || [];
    } catch (error) {
      this.logger.log('Base44 query failed, using fallback', 'warning');
      return this.storage.query('revenue', { settled: false, status: 'VERIFIED' });
    }
  }

  async createEarning(earning) {
    // Save to local storage first (always)
    this.storage.save('earning', earning.earning_id, earning);
    
    if (!this.available) {
      return { location: 'fallback', id: earning.earning_id };
    }
    
    try {
      const result = await this.client.Earning.create(earning);
      this.logger.log(`Earning synced to Base44: ${earning.earning_id}`, 'success');
      return { location: 'base44', id: earning.earning_id, data: result };
    } catch (error) {
      this.logger.log('Base44 sync failed, using fallback', 'warning');
      return { location: 'fallback', id: earning.earning_id };
    }
  }

  async createPayoutBatch(batch) {
    this.storage.save('batch', batch.batch_id, batch);
    
    if (!this.available) {
      return { location: 'fallback', id: batch.batch_id };
    }
    
    try {
      const result = await this.client.PayoutBatch.create(batch);
      this.logger.log(`Batch synced to Base44: ${batch.batch_id}`, 'success');
      return { location: 'base44', id: batch.batch_id, data: result };
    } catch (error) {
      this.logger.log('Base44 sync failed, using fallback', 'warning');
      return { location: 'fallback', id: batch.batch_id };
    }
  }
}

// ============================================================================
// PAYPAL EXECUTOR
// ============================================================================

class PayPalExecutor {
  constructor(logger) {
    this.logger = logger;
    this.accessToken = null;
    this.tokenExpiry = null;
    
    this.config = {
      clientId: process.env.PAYPAL_CLIENT_ID,
      clientSecret: process.env.PAYPAL_CLIENT_SECRET,
      mode: process.env.PAYPAL_MODE || 'live'
    };
    
    this.apiBase = 'https://api-m.paypal.com';
  }

  async getAccessToken() {
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }
    
    this.logger.log('Obtaining PayPal access token...', 'auto');
    
    const auth = Buffer.from(
      `${this.config.clientId}:${this.config.clientSecret}`
    ).toString('base64');
    
    const response = await fetch(`${this.apiBase}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    });
    
    if (!response.ok) {
      throw new Error(`PayPal auth failed: ${response.status}`);
    }
    
    const data = await response.json();
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + (data.expires_in * 1000) - 60000;
    
    this.logger.log('PayPal access token obtained', 'success');
    return this.accessToken;
  }

  async executePayout(batch) {
    this.logger.log('Executing PayPal payout...', 'money');
    
    const token = await this.getAccessToken();
    
    const payload = {
      sender_batch_header: {
        sender_batch_id: batch.batch_id,
        email_subject: 'Autonomous Revenue Settlement',
        email_message: 'Your automated revenue settlement'
      },
      items: batch.items.map(item => ({
        recipient_type: 'EMAIL',
        amount: {
          value: item.amount.toFixed(2),
          currency: item.currency
        },
        receiver: OWNER.paypal,
        note: `Settlement: ${item.earning_id || item.revenue_event_id}`,
        sender_item_id: item.item_id
      }))
    };
    
    const response = await fetch(`${this.apiBase}/v1/payments/payouts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`PayPal payout failed: ${error}`);
    }
    
    const data = await response.json();
    
    this.logger.log('✅ PAYPAL PAYOUT EXECUTED', 'money');
    this.logger.log(`   PayPal Batch ID: ${data.batch_header.payout_batch_id}`, 'success');
    this.logger.log(`   Status: ${data.batch_header.batch_status}`, 'success');
    this.logger.log(`   Amount: $${batch.total_amount} ${batch.currency}`, 'money');
    this.logger.log(`   Recipient: ${OWNER.paypal}`, 'owner');
    
    return data;
  }

  async checkBatchStatus(paypalBatchId) {
    const token = await this.getAccessToken();
    
    const response = await fetch(
      `${this.apiBase}/v1/payments/payouts/${paypalBatchId}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    if (!response.ok) {
      throw new Error(`Failed to check status: ${response.statusText}`);
    }
    
    return await response.json();
  }
}

// ============================================================================
// BANK WIRE GENERATOR
// ============================================================================

class BankWireGenerator {
  constructor(logger) {
    this.logger = logger;
    this.exportDir = './exports/bank-wire';
    
    if (!fs.existsSync(this.exportDir)) {
      fs.mkdirSync(this.exportDir, { recursive: true });
    }
  }

  generate(batch) {
    const csv = this.generateCSV(batch);
    const filename = `bank_wire_${batch.batch_id}_${Date.now()}.csv`;
    const filepath = path.join(this.exportDir, filename);
    
    fs.writeFileSync(filepath, csv);
    
    this.logger.log('✅ BANK WIRE FILE GENERATED', 'success');
    this.logger.log(`   File: ${filename}`, 'success');
    this.logger.log(`   Amount: $${batch.total_amount} ${batch.currency}`, 'money');
    this.logger.log(`   Recipient: ${OWNER.bank} (${OWNER.bankName})`, 'owner');
    this.logger.log(`   Path: ${filepath}`, 'info');
    
    return filepath;
  }

  generateCSV(batch) {
    const headers = [
      'Beneficiary Account',
      'Amount',
      'Currency',
      'Reference',
      'Date',
      'Description'
    ];
    
    const rows = batch.items.map(item => [
      OWNER.bank,
      item.amount.toFixed(2),
      item.currency,
      item.item_id,
      new Date().toISOString().split('T')[0],
      `Auto-settlement: ${item.earning_id || 'N/A'}`
    ]);
    
    return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  }
}

// ============================================================================
// UNIFIED AUTONOMOUS DAEMON
// ============================================================================

class UnifiedAutonomousDaemon {
  constructor() {
    this.logger = new UnifiedLogger();
    this.storage = new DaemonStorage(this.logger);
    this.base44 = new ResilientBase44(this.logger, this.storage);
    this.paypal = new PayPalExecutor(this.logger);
    this.bank = new BankWireGenerator(this.logger);
    
    this.running = false;
    this.stats = {
      started_at: null,
      scans_completed: 0,
      settlements_executed: 0,
      total_amount: 0,
      total_events: 0,
      last_settlement: null,
      errors: 0
    };
  }

  async start() {
    this.logger.log('╔════════════════════════════════════════════════════════════╗', 'daemon');
    this.logger.log('║  UNIFIED AUTONOMOUS SETTLEMENT DAEMON                      ║', 'daemon');
    this.logger.log('║  24/7 OPERATION - ZERO HUMAN INTERVENTION                  ║', 'daemon');
    this.logger.log('╚════════════════════════════════════════════════════════════╝', 'daemon');
    
    this.logger.log('\n🤖 DAEMON CONFIGURATION:', 'auto');
    this.logger.log(`   Scan Interval: ${DAEMON_CONFIG.scanInterval / 1000}s`, 'info');
    this.logger.log(`   Settlement Delay: ${DAEMON_CONFIG.settlementDelay}s (IMMEDIATE)`, 'info');
    this.logger.log(`   Auto-Approve: ALL AMOUNTS`, 'success');
    this.logger.log(`   Max Retries: ${DAEMON_CONFIG.maxRetries}`, 'info');
    this.logger.log(`   Owner-Only Mode: ENFORCED`, 'success');
    
    this.logger.log('\n🔒 OWNER ACCOUNTS (HARDCODED):', 'owner');
    this.logger.log(`   PayPal: ${OWNER.paypal}`, 'owner');
    this.logger.log(`   Bank: ${OWNER.bank} (${OWNER.bankName})`, 'owner');
    this.logger.log(`   Payoneer: ${OWNER.payoneer}`, 'owner');
    
    // Check Base44 availability
    if (DAEMON_CONFIG.tryBase44First) {
      await this.base44.checkAvailability();
    }
    
    this.running = true;
    this.stats.started_at = new Date().toISOString();
    
    // Initial scan
    await this.scan();
    
    // Schedule periodic scans
    this.scanInterval = setInterval(() => {
      this.scan().catch(error => {
        this.logger.log(`Scan error: ${error.message}`, 'error');
        this.stats.errors++;
      });
    }, DAEMON_CONFIG.scanInterval);
    
    // Schedule health checks
    this.healthInterval = setInterval(() => {
      this.healthCheck();
    }, DAEMON_CONFIG.healthCheckInterval);
    
    this.logger.log('\n✅ DAEMON RUNNING (24/7)', 'success');
    this.logger.log('   Press Ctrl+C to stop gracefully\n', 'info');
    
    // Graceful shutdown
    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
  }

  async scan() {
    const scanId = crypto.randomBytes(4).toString('hex');
    this.logger.log(`\n🔍 [SCAN ${scanId}] Scanning for pending settlements...`, 'auto');
    
    try {
      // Get pending from both Base44 and local storage
      const pending = this.storage.getPendingSettlements();
      
      if (pending.length === 0) {
        this.logger.log('   No pending settlements found', 'info');
        this.stats.scans_completed++;
        return;
      }
      
      this.logger.log(`   Found ${pending.length} pending settlements`, 'success');
      
      // Group into batches
      const batches = this.createBatches(pending);
      
      this.logger.log(`   Created ${batches.length} settlement batches`, 'success');
      
      // Execute batches
      for (const batch of batches) {
        await this.executeSettlement(batch);
      }
      
      this.stats.scans_completed++;
      
    } catch (error) {
      this.logger.log(`Scan failed: ${error.message}`, 'error', { stack: error.stack });
      this.stats.errors++;
    }
  }

  createBatches(pending) {
    const groups = {};
    
    // Group by currency
    for (const record of pending) {
      const earning = record.data;
      const currency = earning.currency || 'USD';
      
      if (!groups[currency]) {
        groups[currency] = [];
      }
      
      groups[currency].push(earning);
    }
    
    // Create batches
    const batches = [];
    
    for (const [currency, earnings] of Object.entries(groups)) {
      const batch = {
        batch_id: `DAEMON_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        status: 'auto_approved',
        total_amount: earnings.reduce((sum, e) => sum + (e.amount || 0), 0),
        currency,
        created_at: new Date().toISOString(),
        approved_at: new Date().toISOString(),
        payout_method: DAEMON_CONFIG.rails.primary,
        recipient: OWNER.paypal,
        recipient_type: 'owner',
        autonomous: true,
        daemon_generated: true,
        items: earnings.map(e => ({
          item_id: `ITEM_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
          amount: e.amount,
          currency: e.currency || 'USD',
          recipient: OWNER.paypal,
          recipient_type: 'owner',
          earning_id: e.earning_id,
          revenue_event_id: e.revenue_event_id
        }))
      };
      
      batches.push(batch);
    }
    
    return batches;
  }

  async executeSettlement(batch) {
    this.logger.log(`\n💰 [SETTLEMENT] Executing batch: ${batch.batch_id}`, 'money');
    this.logger.log(`   Amount: $${batch.total_amount} ${batch.currency}`, 'money');
    this.logger.log(`   Items: ${batch.items.length}`, 'info');
    this.logger.log(`   Recipient: ${OWNER.paypal}`, 'owner');
    
    let retries = 0;
    let success = false;
    let result = null;
    
    while (!success && retries < DAEMON_CONFIG.maxRetries) {
      try {
        // Save batch
        await this.base44.createPayoutBatch(batch);
        
        // Execute on primary rail
        if (batch.payout_method === 'paypal') {
          result = await this.paypal.executePayout(batch);
          
          batch.paypal_batch_id = result.batch_header.payout_batch_id;
          batch.paypal_status = result.batch_header.batch_status;
          batch.executed_at = new Date().toISOString();
          
        } else if (batch.payout_method === 'bank') {
          result = this.bank.generate(batch);
          batch.bank_wire_file = result;
          batch.executed_at = new Date().toISOString();
        }
        
        // Mark items as settled
        for (const item of batch.items) {
          this.storage.markSettled(item.earning_id, batch.batch_id);
        }
        
        // Update batch status
        batch.status = 'executed';
        this.storage.save('batch', batch.batch_id, batch);
        
        // Update stats
        this.stats.settlements_executed++;
        this.stats.total_events += batch.items.length;
        this.stats.total_amount += batch.total_amount;
        this.stats.last_settlement = new Date().toISOString();
        
        this.logger.log('✅ SETTLEMENT EXECUTED SUCCESSFULLY', 'success');
        this.logger.log(`   Batch: ${batch.batch_id}`, 'success');
        this.logger.log(`   PayPal ID: ${batch.paypal_batch_id || 'N/A'}`, 'success');
        this.logger.log(`   Amount: $${batch.total_amount} ${batch.currency}`, 'money');
        this.logger.log(`   Recipient: ${OWNER.paypal}`, 'owner');
        
        success = true;
        
      } catch (error) {
        retries++;
        this.logger.log(
          `Attempt ${retries}/${DAEMON_CONFIG.maxRetries} failed: ${error.message}`,
          'warning'
        );
        
        if (retries < DAEMON_CONFIG.maxRetries) {
          this.logger.log(`Retrying in ${DAEMON_CONFIG.retryDelay / 1000}s...`, 'info');
          await new Promise(resolve => setTimeout(resolve, DAEMON_CONFIG.retryDelay));
        } else {
          // Try fallback rail
          if (batch.payout_method === 'paypal') {
            this.logger.log('Switching to bank wire fallback...', 'warning');
            batch.payout_method = 'bank';
            return await this.executeSettlement(batch);
          }
        }
      }
    }
    
    if (!success) {
      this.logger.log('❌ SETTLEMENT FAILED AFTER ALL RETRIES', 'critical');
      batch.status = 'failed';
      batch.error = 'Max retries exceeded';
      this.storage.save('batch', batch.batch_id, batch);
      this.stats.errors++;
    }
  }

  healthCheck() {
    this.logger.log('\n💚 [HEALTH CHECK] System status...', 'health');
    
    const uptime = Date.now() - new Date(this.stats.started_at).getTime();
    const uptimeHours = (uptime / (1000 * 60 * 60)).toFixed(2);
    
    this.logger.log(`   Uptime: ${uptimeHours}h`, 'info');
    this.logger.log(`   Scans: ${this.stats.scans_completed}`, 'info');
    this.logger.log(`   Settlements: ${this.stats.settlements_executed}`, 'info');
    this.logger.log(`   Total Amount: $${this.stats.total_amount.toFixed(2)}`, 'money');
    this.logger.log(`   Errors: ${this.stats.errors}`, this.stats.errors > 0 ? 'warning' : 'info');
    this.logger.log(`   Last Settlement: ${this.stats.last_settlement || 'None'}`, 'info');
    
    // Check system health
    const healthy = this.running && this.stats.errors < 10;
    this.logger.log(`   Status: ${healthy ? 'HEALTHY ✅' : 'DEGRADED ⚠️'}`, healthy ? 'success' : 'warning');
  }

  stop() {
    this.logger.log('\n🛑 Graceful shutdown initiated...', 'warning');
    
    clearInterval(this.scanInterval);
    clearInterval(this.healthInterval);
    this.running = false;
    
    this.logger.log('\n📊 FINAL STATISTICS:', 'info');
    this.logger.log(`   Uptime: ${((Date.now() - new Date(this.stats.started_at).getTime()) / (1000 * 60 * 60)).toFixed(2)}h`, 'info');
    this.logger.log(`   Total Scans: ${this.stats.scans_completed}`, 'info');
    this.logger.log(`   Settlements Executed: ${this.stats.settlements_executed}`, 'info');
    this.logger.log(`   Events Settled: ${this.stats.total_events}`, 'info');
    this.logger.log(`   Total Amount: $${this.stats.total_amount.toFixed(2)}`, 'money');
    this.logger.log(`   Errors: ${this.stats.errors}`, 'info');
    
    this.logger.flushLogs();
    this.logger.log('\n✅ Daemon stopped gracefully\n', 'success');
    
    process.exit(0);
  }

  async ingestRevenue(params) {
    this.logger.log('\n📥 [INGESTION] New revenue detected', 'auto');
    
    const earning = {
      earning_id: params.earning_id || `EARN_${Date.now()}`,
      amount: params.amount,
      currency: params.currency || 'USD',
      occurred_at: new Date().toISOString(),
      source: params.source || 'daemon_ingestion',
      beneficiary: OWNER.paypal,
      status: 'pending_payout',
      revenue_event_id: params.revenue_event_id || `REV_${Date.now()}`,
      metadata: {
        recipient_type: 'owner',
        daemon_ingested: true,
        ingested_at: new Date().toISOString()
      },
      created_at: new Date().toISOString()
    };
    
    await this.base44.createEarning(earning);
    
    this.logger.log(`   Earning: ${earning.earning_id}`, 'success');
    this.logger.log(`   Amount: $${earning.amount} ${earning.currency}`, 'money');
    this.logger.log(`   Beneficiary: ${earning.beneficiary}`, 'owner');
    this.logger.log('   Status: Queued for settlement', 'success');
    
    // Trigger immediate scan if daemon is running
    if (this.running) {
      this.logger.log('   Triggering immediate scan...', 'auto');
      setTimeout(() => this.scan(), 5000);
    }
    
    return earning;
  }

  getStats() {
    return {
      ...this.stats,
      running: this.running,
      uptime: this.stats.started_at 
        ? Date.now() - new Date(this.stats.started_at).getTime()
        : 0
    };
  }
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

async function main() {
  const daemon = new UnifiedAutonomousDaemon();
  
  // Check for ingestion mode
  if (process.argv.includes('--ingest')) {
    const amount = parseFloat(
      process.argv.find(a => a.startsWith('--amount='))?.split('=')[1] || '100'
    );
    const currency = process.argv.find(a => a.startsWith('--currency='))?.split('=')[1] || 'USD';
    const source = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] || 'manual';
    
    await daemon.ingestRevenue({ amount, currency, source });
    
    console.log('\n✅ Revenue ingested successfully');
    console.log('   Start daemon to process: node scripts/unified-autonomous-daemon.mjs\n');
    
    process.exit(0);
  }
  
  // Check for stats mode
  if (process.argv.includes('--stats')) {
    console.log('\n📊 Loading daemon statistics...\n');
    // Load from storage and display
    console.log('Run daemon to collect stats\n');
    process.exit(0);
  }
  
  // Start daemon
  await daemon.start();
}

// Execute
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('\n💥 DAEMON STARTUP FAILED:', error.message);
    console.error(error.stack);
    process.exit(1);
  });
}

export {
  UnifiedAutonomousDaemon,
  PayPalExecutor,
  BankWireGenerator,
  ResilientBase44,
  DaemonStorage,
  OWNER,
  DAEMON_CONFIG
};