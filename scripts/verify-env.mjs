#!/usr/bin/env node
import '../src/load-env.mjs';

const required = [
  'BASE44_APP_ID',
  'BASE44_SERVICE_TOKEN',
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET'
];

const optional = [
  'OWNER_PAYONEER_ID',
  'MOROCCAN_BANK_RIB',
  'OWNER_BANK_ACCOUNT_NUM'
];

console.log('🔍 Verifying environment configuration for live deployment...\n');

let hasErrors = false;
let hasWarnings = false;

// Check required variables
console.log('📋 Required Variables:');
for (const key of required) {
  const value = process.env[key];
  if (!value || value.includes('YOUR_') || value.includes('PENDING') || value.includes('<your_')) {
    console.error(`   ❌ Missing or invalid: ${key}`);
    hasErrors = true;
  } else {
    const masked = value.length > 10 ? value.substring(0, 10) + '...' : '***';
    console.log(`   ✅ ${key}: ${masked}`);
  }
}

// Check optional variables
console.log('\n📋 Optional Variables:');
for (const key of optional) {
  const value = process.env[key];
  if (!value || value.includes('PENDING') || value.includes('<your_')) {
    console.warn(`   ⚠️  Not configured: ${key}`);
    hasWarnings = true;
  } else {
    const masked = value.length > 10 ? value.substring(0, 10) + '...' : '***';
    console.log(`   ✅ ${key}: ${masked}`);
  }
}

// Verify PayPal mode
console.log('\n🔒 Security Checks:');
const paypalMode = process.env.PAYPAL_MODE || 'live';
if (paypalMode !== 'live') {
  console.error(`   ❌ PAYPAL_MODE is "${paypalMode}" (must be "live" for production)`);
  hasErrors = true;
} else {
  console.log(`   ✅ PAYPAL_MODE: live`);
}

// Verify SWARM_LIVE
const swarmLive = String(process.env.SWARM_LIVE || 'false').toLowerCase();
if (swarmLive !== 'true') {
  console.error(`   ❌ SWARM_LIVE is "${swarmLive}" (must be "true" for production)`);
  hasErrors = true;
} else {
  console.log(`   ✅ SWARM_LIVE: true`);
}

// Verify NO_PLATFORM_WALLET
const noPlatformWallet = String(process.env.NO_PLATFORM_WALLET || 'false').toLowerCase();
if (noPlatformWallet !== 'true') {
  console.error(`   ❌ NO_PLATFORM_WALLET is "${noPlatformWallet}" (must be "true" for production)`);
  hasErrors = true;
} else {
  console.log(`   ✅ NO_PLATFORM_WALLET: true`);
}

// Verify owner accounts
console.log('\n👤 Owner Accounts:');
const paypalRecipients = process.env.AUTONOMOUS_ALLOWED_PAYPAL_RECIPIENTS || 'younestsouli2019@gmail.com';
console.log(`   PayPal: ${paypalRecipients}`);

const bankRib = process.env.MOROCCAN_BANK_RIB || '007810000448500030594182';
console.log(`   Bank RIB: ${bankRib}`);

const payoneerId = process.env.OWNER_PAYONEER_ID || 'PENDING_ID';
if (payoneerId === 'PENDING_ID') {
  console.warn(`   ⚠️  Payoneer: Not configured`);
  hasWarnings = true;
} else {
  console.log(`   Payoneer: ${payoneerId}`);
}

// Check Base44 write permissions
console.log('\n📝 Ledger Configuration:');
const base44Write = String(process.env.BASE44_ENABLE_PAYOUT_LEDGER_WRITE || 'false').toLowerCase();
if (base44Write !== 'true') {
  console.warn(`   ⚠️  BASE44_ENABLE_PAYOUT_LEDGER_WRITE is "${base44Write}" (should be "true")`);
  hasWarnings = true;
} else {
  console.log(`   ✅ BASE44_ENABLE_PAYOUT_LEDGER_WRITE: true`);
}

// Summary
console.log('\n' + '='.repeat(60));
if (hasErrors) {
  console.error('❌ Environment verification FAILED');
  console.error('   Fix the errors above before deploying to production');
  process.exit(1);
} else if (hasWarnings) {
  console.warn('⚠️  Environment verification passed with WARNINGS');
  console.warn('   Review warnings above - some features may not work');
  process.exit(0);
} else {
  console.log('✅ Environment verification PASSED');
  console.log('🚀 System ready for production deployment');
  process.exit(0);
}
