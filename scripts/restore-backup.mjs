import { restoreEncryptedBackup } from '../src/security/backup-crypto.mjs';
import { encryptionConfigured } from '../src/security/data-at-rest.mjs';

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

const backupDir = value('--backup');
const outDir = value('--out');
const force = args.includes('--force');

if (!backupDir || !outDir) {
  console.error('Usage: node scripts/restore-backup.mjs --backup <encrypted-backup-dir> --out <restore-dir> [--force]');
  process.exit(2);
}
if (!encryptionConfigured()) {
  console.error('❌ Restore refused: set DATA_ENCRYPTION_KEY or DATA_ENCRYPTION_KEY_FILE.');
  process.exit(2);
}

try {
  const result = restoreEncryptedBackup({ backupDir, outDir, force });
  console.log(JSON.stringify({
    ok: true,
    restored: result.restored,
    outDir: result.outDir,
    manifestFiles: result.manifest?.fileCount ?? null
  }, null, 2));
} catch (error) {
  console.error(`❌ RESTORE FAILED: ${error.message}`);
  process.exit(1);
}
