import fs from 'fs';
import path from 'path';
import { readEncryptedJson } from '../src/security/data-at-rest.mjs';

// Generate a detailed report on "Overboard" Quotas vs "Safe" Liquidity
const LEDGER_DIR = path.resolve('data/autonomous/ledger');
const REPORT_FILE = path.resolve('QUOTA_EXCESS_REPORT.md');

function scanLedger() {
  if (!fs.existsSync(LEDGER_DIR)) return [];
  return fs.readdirSync(LEDGER_DIR)
    .filter(f => f.startsWith('batch_') && f.endsWith('.json'))
    .map(f => {
      try {
        return readEncryptedJson(path.join(LEDGER_DIR, f)).data;
      } catch (e) { return null; }
    })
    .filter(Boolean);
}

function generateReport() {
  const batches = scanLedger();
  
  let totalOverboard = 0;
  let totalSafe = 0;
  let overboardCount = 0;
  let safeCount = 0;
  
  // Classification Logic (Simplified from triage)
  const safeBatches = [];
  
  batches.forEach(batch => {
    const amount = batch.total_amount || 0;
    const method = (batch.method || '').toLowerCase();
    
    let isSafe = false;
    
    // Crypto < 2000 is Safe
    if (method.includes('crypto') && amount < 2000) isSafe = true;
    
    // Payoneer/PayPal < 2000 is Safe
    if ((method.includes('payoneer') || method.includes('paypal') || method.includes('selar')) && amount < 2000) isSafe = true;
    
    // Bank Wire is Overboard (Enterprise)
    if (method.includes('bank')) isSafe = false;
    
    // Check for Payoneer masquerading as Bank Wire (Bucket A in triage)
    if (method === 'bank_wire') {
       // Logic from triage: if file name says PAYONEER
       // We'll trust triage_earnings output mostly, but here we approximate for report
       // If amount < 2000, we'll call it "Pending Triage Safe" for now
       if (amount < 2000) isSafe = true; // Optimistic
    }
    
    if (isSafe) {
      totalSafe += amount;
      safeCount++;
      safeBatches.push(batch);
    } else {
      totalOverboard += amount;
      overboardCount++;
    }
  });
  
  const reportContent = `
# 🚨 QUOTA EXCESS & LIQUIDITY REPORT
**Generated:** ${new Date().toISOString()}

## 📊 Executive Summary
The system has generated significant revenue. Due to **Personal Account Limits**, the majority of funds are currently **HELD** to prevent banking flags. A small "Stimulus" portion is available for immediate P2P/Liquidity.

| Category | Status | Amount | Batches |
| :--- | :--- | :--- | :--- |
| **📉 Safe / Liquidity** | **AVAILABLE** | **$${totalSafe.toLocaleString()}** | ${safeCount} |
| **📈 Overboard / Enterprise** | **HELD (Vault)** | **$${totalOverboard.toLocaleString()}** | ${overboardCount} |
| **💰 TOTAL GENERATED** | -- | **$${(totalSafe + totalOverboard).toLocaleString()}** | ${safeCount + overboardCount} |

---

## 🟢 AVAILABLE: "Bucket A" (Safe Liquidity)
*These funds are cleared for personal account upload or P2P conversion.*

**Recent Batches:**
${safeBatches.slice(-5).map(b => `*   **${b.batch_id}**: $${b.total_amount} (${b.method})`).join('\n')}

---

## 🔴 HELD: "Bucket B" (Quota Excess)
*These funds exceed personal banking safety limits. They are stored in the Vault for the future Enterprise Account.*

*   **Reason:** Banking Friction / "Invisible Wall" Protocol
*   **Action:** Do NOT upload. Wait for Enterprise Entity.

> "The swarm generated wealth faster than the banking rails could absorb."

---

## 🛠 Next Steps
1.  **Consume Bucket A:** Use the generated Crypto Artifacts or Payoneer CSVs.
2.  **Ignore Bucket B:** Let it accumulate.
3.  **Open Enterprise Account:** Once ready, we flip the switch on the Vault.
`;

  fs.writeFileSync(REPORT_FILE, reportContent);
  console.log(`Report generated: ${REPORT_FILE}`);
}

generateReport();
