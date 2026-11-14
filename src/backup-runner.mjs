import './load-env.mjs';
import fs from 'fs';
import path from 'path';
import { buildBase44Client } from './base44-client.mjs';
import { encryptBuffer, requireEncryptionKey } from './security/data-at-rest.mjs';

function getEntityName(envKey, defaultName) {
  return process.env[envKey] ?? defaultName;
}

async function fetchAll(client, entityName) {
  const entity = client.asServiceRole.entities[entityName];
  if (!entity) {
    console.warn(`Entity schema ${entityName} not found in client.`);
    return [];
  }

  const all = [];
  let offset = 0;
  const limit = 100;

  try {
    while (true) {
      const page = await entity.list("-created_date", limit, offset);
      if (!Array.isArray(page) || page.length === 0) break;
      all.push(...page);
      if (page.length < limit) break;
      offset += page.length;
    }
  } catch (e) {
    console.error(`Error fetching ${entityName}: ${e.message}`);
  }
  return all;
}

export async function runFullBackup() {
  console.log('💾 STARTING FULL BACKUP...');
  requireEncryptionKey();
  
  const client = buildBase44Client();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join('backups', timestamp);
  
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const entities = [
    { key: 'BASE44_REVENUE_ENTITY', default: 'RevenueEvent' },
    { key: 'BASE44_PAYOUT_BATCH_ENTITY', default: 'PayoutBatch' },
    { key: 'BASE44_PAYOUT_ITEM_ENTITY', default: 'PayoutItem' },
    { key: 'BASE44_PAYPAL_EVENT_ENTITY', default: 'PayPalWebhookEvent' },
    { key: 'BASE44_PAYPAL_METRIC_ENTITY', default: 'PayPalMetric' },
    { key: 'BASE44_LEDGER_TRANSACTION_LOG_ENTITY', default: 'TransactionLog' }
  ];

  const summary = {
    timestamp,
    counts: {}
  };

  for (const ent of entities) {
    const name = getEntityName(ent.key, ent.default);
    console.log(`Exporting ${name}...`);
    const records = await fetchAll(client, name);
    
    fs.writeFileSync(
      path.join(backupDir, `${name}.json.enc`),
      encryptBuffer(Buffer.from(JSON.stringify(records, null, 2), 'utf8')),
      { mode: 0o600 }
    );
    
    summary.counts[name] = records.length;
    console.log(`  -> Saved ${records.length} records.`);
  }

  // Also save a summary file
  fs.writeFileSync(
    path.join(backupDir, 'backup-summary.json.enc'),
    encryptBuffer(Buffer.from(JSON.stringify(summary, null, 2), 'utf8')),
    { mode: 0o600 }
  );

  console.log(`✅ Encrypted full backup completed at ${backupDir}`);
  return { ...summary, encrypted: true };
}

if (process.argv[1].endsWith('backup-runner.mjs')) {
  runFullBackup().catch(console.error);
}
