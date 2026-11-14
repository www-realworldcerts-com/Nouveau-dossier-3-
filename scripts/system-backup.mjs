import path from 'node:path';
import { createEncryptedBackup } from '../src/security/backup-crypto.mjs';
import { encryptionConfigured } from '../src/security/data-at-rest.mjs';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir = outIndex >= 0 ? args[outIndex + 1] : null;
const includeIndex = args.indexOf('--include');
const include = includeIndex >= 0 ? args[includeIndex + 1] : null;
const sources = include
  ? include.split(',').map((item) => item.trim()).filter(Boolean)
  : ['data', 'config', 'exports', '.env.example'];

if (!encryptionConfigured()) {
  console.error('❌ Backup refused: set DATA_ENCRYPTION_KEY or DATA_ENCRYPTION_KEY_FILE.');
  console.error('   Backups contain bank details, IBANs and payout records and are encrypted at rest.');
  process.exit(2);
}

try {
  const result = createEncryptedBackup({ sources, outDir });
  console.log(`✅ Encrypted backup completed: ${result.outDir}`);
  console.log(`   Encrypted files: ${result.fileCount}`);
  console.log('   Restore with: npm run restore:backup -- --backup <dir> --out <dir>');
} catch (error) {
  console.error(`❌ BACKUP FAILED: ${error.message}`);
  process.exit(1);
}
