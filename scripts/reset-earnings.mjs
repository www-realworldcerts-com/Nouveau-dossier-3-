
import fs from 'fs';
import path from 'path';
import { readEncryptedJson, writeJsonAtomic } from '../src/security/data-at-rest.mjs';

const LEDGER_DIR = './data/autonomous/ledger';

function resetEarnings() {
  const files = fs.readdirSync(LEDGER_DIR).filter(f => f.startsWith('earning_'));
  
  let count = 0;
  
  files.forEach(file => {
    const filepath = path.join(LEDGER_DIR, file);
    const content = readEncryptedJson(filepath);
    
    // Check if it's wrapped or unwrapped
    const data = content.data || content;
    
    // Reset if it looks like the $175 (75 + 100)
    if (data.amount === 75.00 || data.amount === 100.00) {
       console.log(`Resetting ${file} (${data.amount} ${data.currency})`);
       data.status = 'pending_payout';
       delete data.payout_batch_id;
       delete data.payout_method;
       delete data.payout_date;
       
       // Save back (preserving wrapper if existed)
       writeJsonAtomic(filepath, content);
       count++;
    }
  });
  
  console.log(`Reset ${count} earnings.`);
}

resetEarnings();
