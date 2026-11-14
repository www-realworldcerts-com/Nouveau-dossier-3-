import fs from 'fs';
import path from 'path';
import { OwnerSettlementEnforcer } from '../src/policy/owner-settlement.mjs';
import { readEncryptedJson } from '../src/security/data-at-rest.mjs';

function readLedger() {
  const p = path.join(process.cwd(), 'data', 'financial', 'settlement_ledger.json');
  if (!fs.existsSync(p)) return null;
  return readEncryptedJson(p);
}

function run() {
  const ledger = readLedger() || { transactions: [], queued: [] };
  const accounts = OwnerSettlementEnforcer.getOwnerAccounts().map(a => String(a.identifier).toLowerCase());
  let violations = 0;
  let total = 0;
  for (const t of ledger.transactions || []) {
    total++;
    const d = String((t.details && t.details.destination) || '').toLowerCase();
    if (!accounts.includes(d)) violations++;
  }
  const ok = violations === 0;
  const out = { ok, total, violations };
  const outFile = path.join(process.cwd(), 'exports', 'owner-directive-validation.json');
  if (!fs.existsSync(path.dirname(outFile))) fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(outFile);
}

run();
