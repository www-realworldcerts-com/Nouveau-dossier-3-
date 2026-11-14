import fs from 'fs';
import path from 'path';
import { threatMonitor } from '../src/security/threat-monitor.mjs';
import { readEncryptedJson } from '../src/security/data-at-rest.mjs';

function print(k, v) {
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  const ss = String(t.getSeconds()).padStart(2, '0');
  console.log(`[${hh}:${mm}:${ss}] ${k}: ${v}`);
}

function has(v) {
  return v && String(v).trim().length > 0;
}

function getLedger() {
  const p = path.join(process.cwd(), 'data', 'financial', 'settlement_ledger.json');
  if (!fs.existsSync(p)) return { transactions: [], queued: [] };
  try {
    return readEncryptedJson(p);
  } catch {
    return { transactions: [], queued: [] };
  }
}

function run() {
  print('🔎 Diagnosing Non-Movement', 'START');
  const bunker = threatMonitor.isBunkerMode();
  print('Bunker Mode', bunker ? 'ACTIVE' : 'INACTIVE');
  const payoneerMode = process.env.PAYONEER_MODE || 'RECEIVE';
  const paypalMode = process.env.PAYPAL_MODE || 'BILLING';
  print('Payoneer Mode', payoneerMode);
  print('PayPal Mode', paypalMode);
  const hasPayoneerCreds = has(process.env.PAYONEER_CLIENT_ID) && has(process.env.PAYONEER_CLIENT_SECRET);
  const hasPaypalCreds = has(process.env.PAYPAL_CLIENT_ID) && has(process.env.PAYPAL_SECRET);
  const hasWalletKey = has(process.env.WALLET_PRIVATE_KEY);
  print('Payoneer API Credentials', hasPayoneerCreds ? 'PRESENT' : 'MISSING');
  print('PayPal API Credentials', hasPaypalCreds ? 'PRESENT' : 'MISSING');
  print('Crypto Private Key', hasWalletKey ? 'PRESENT' : 'MISSING');
  const ledger = getLedger();
  print('Queued Items', String((ledger.queued || []).length));
  print('Transactions', String((ledger.transactions || []).length));
  const blockers = [];
  if (bunker) blockers.push('BUNKER_MODE');
  if (payoneerMode !== 'PAYOUT') blockers.push('PAYONEER_RECEIVE_MODE');
  if (!hasPayoneerCreds) blockers.push('PAYONEER_CREDENTIALS_MISSING');
  if (paypalMode !== 'PAYOUT') blockers.push('PAYPAL_BILLING_MODE');
  if (!hasPaypalCreds) blockers.push('PAYPAL_CREDENTIALS_MISSING');
  if (!hasWalletKey) blockers.push('CRYPTO_PRIVATE_KEY_MISSING');
  if (blockers.length === 0) {
    print('Conclusion', 'No config blockers detected; verify incoming funds or provider-side status.');
  } else {
    print('Conclusion', `BLOCKERS: ${blockers.join(', ')}`);
  }
}

run();
