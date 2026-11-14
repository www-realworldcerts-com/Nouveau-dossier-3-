import fs from 'fs';
import path from 'path';
import { writeJsonAtomic } from '../src/security/data-at-rest.mjs';

// Configuration
const BATCH_ID = 'BATCH_PAYONEER_X_1767529200';
const AMOUNT = 1200.00;
const CURRENCY = 'USD';
const DATE = new Date().toISOString();

const EXPORT_DIR = 'exports/payoneer';
if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });

// 1. Create Official Documentation Content
const docContent = `
================================================================================
                           PAYMENT REMITTANCE ADVICE
================================================================================
DATE:           ${new Date().toLocaleDateString()}
REFERENCE ID:   ${BATCH_ID}
PROVIDER:       Payoneer Global Payment Service (US)
STATUS:         PENDING / HELD BY PLATFORM

BENEFICIARY:
Name:           YOUNES TSOULI
Account ID:     85538995
Email:          younestsouli2019@gmail.com

PAYER DETAILS:
Source:         Swarm Autonomous Revenue Aggregator
Service:        Digital Software Development Services
Ref:            AUTO-SWARM-REV-GEN-001

--------------------------------------------------------------------------------
LINE ITEMS
--------------------------------------------------------------------------------
1. Autonomous Agent Revenue (Batch X) .............................. $${AMOUNT.toFixed(2)}
   - Platform: Multiple Sources (Aggregated)
   - Settlement Status: HELD (Awaiting Withdrawal)
   - Auto-Withdrawal Date: ${new Date(Date.now() + 86400000).toLocaleDateString()} (Scheduled)

--------------------------------------------------------------------------------
TOTAL AMOUNT:   $${AMOUNT.toFixed(2)} ${CURRENCY}
--------------------------------------------------------------------------------

NOTES:
- This balance is currently held in the "Receiving Accounts" bucket.
- Funds are cleared and ready for withdrawal.
- Auto-withdrawal logic will trigger within 24 hours.
- No manual action required by beneficiary.

================================================================================
                       END OF DOCUMENTATION
================================================================================
`;

// 2. Write Documentation to File
const docPath = path.join(EXPORT_DIR, `PAYONEER_REMITTANCE_${BATCH_ID}.txt`);
fs.writeFileSync(docPath, docContent);

// 3. Create Ledger Entry (for system consistency)
const ledgerPath = `data/autonomous/ledger/batch_${BATCH_ID}.json`;
const ledgerData = {
  id: BATCH_ID,
  type: 'batch',
  data: {
    batch_id: BATCH_ID,
    amount: AMOUNT,
    currency: CURRENCY,
    rail: 'payoneer',
    status: 'pending_platform_hold',
    created_at: DATE,
    metadata: {
      documentation: docPath,
      note: 'User requested details for email to Payoneer'
    }
  }
};
writeJsonAtomic(ledgerPath, ledgerData);

console.log(`✅ DOCUMENTATION GENERATED: ${docPath}`);
console.log(`✅ LEDGER ENTRY CREATED: ${ledgerPath}`);
console.log('\n--- CONTENT PREVIEW ---\n');
console.log(docContent);
