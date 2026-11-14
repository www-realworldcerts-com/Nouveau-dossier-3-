import fs from 'node:fs';
import path from 'node:path';
import {
  decryptSensitiveFields,
  encryptSensitiveFields,
  encryptionConfigured,
  scanSensitiveFields,
  writeJsonAtomic,
  writeJsonPlainAtomic
} from '../src/security/data-at-rest.mjs';
import { encryptBackupFile } from '../src/security/backup-crypto.mjs';

/**
 * Migration tool for financial JSON at rest.
 *
 * Default is a read-only dry run. `--apply` encrypts sensitive fields and
 * writes an encrypted copy of every original file under backups/ before it
 * changes anything. `--decrypt` is the rollback path. Text exports and docs are
 * not rewritten; that requires a separate redaction review.
 */

const DEFAULT_ROOTS = [
  'data/financial',
  'data/autonomous/ledger',
  'data/fallback',
  'data/finance/payouts',
  'backups'
];

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const apply = flag('--apply');
const decrypt = flag('--decrypt');
const rotate = flag('--rotate');
const verify = flag('--verify');
const roots = value('--root')
  ? [value('--root')]
  : DEFAULT_ROOTS;
const backupRoot = value('--backup-dir', path.join('backups', `encryption-migration-${new Date().toISOString().replace(/[:.]/g, '-')}`));

if ([apply, decrypt, rotate].filter(Boolean).length > 1) {
  console.error('Choose one of --apply, --decrypt or --rotate.');
  process.exit(2);
}

if ((apply || decrypt || rotate) && !encryptionConfigured()) {
  console.error('DATA_ENCRYPTION_KEY or DATA_ENCRYPTION_KEY_FILE is required for --apply/--decrypt.');
  process.exit(2);
}

function walkJson(root) {
  if (!fs.existsSync(root)) return [];
  const stats = fs.statSync(root);
  if (stats.isFile()) return root.endsWith('.json') ? [root] : [];
  const files = [];
  for (const name of fs.readdirSync(root)) {
    files.push(...walkJson(path.join(root, name)));
  }
  return files;
}

function safeBackupPath(file) {
  const rel = path.relative(process.cwd(), path.resolve(file));
  if (rel.startsWith('..')) return path.join('external', path.basename(file));
  return rel;
}

const report = {
  mode: decrypt ? 'decrypt' : rotate ? 'rotate' : apply ? 'encrypt' : 'dry-run',
  encryptionKeyConfigured: encryptionConfigured(),
  roots,
  filesScanned: 0,
  filesChanged: 0,
  filesSkipped: 0,
  plaintextFields: 0,
  backupsWritten: 0,
  changed: []
};

for (const root of roots) {
  for (const file of walkJson(root)) {
    report.filesScanned += 1;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      report.filesSkipped += 1;
      continue;
    }

    const plaintextFields = scanSensitiveFields(parsed);
    const plaintext = decryptSensitiveFields(parsed);
    const next = decrypt
      ? plaintext
      : rotate
        ? encryptSensitiveFields(plaintext)
        : encryptSensitiveFields(parsed);
    const changed = plaintextFields.length > 0 || JSON.stringify(parsed) !== JSON.stringify(next);
    if (!changed) continue;

    report.filesChanged += 1;
    report.plaintextFields += plaintextFields.length;
    report.changed.push(safeBackupPath(file));
    if (!apply && !decrypt && !rotate) continue;

    const backupPath = path.join(backupRoot, `${safeBackupPath(file)}.enc`);
    encryptBackupFile(file, backupPath);
    report.backupsWritten += 1;

    if (decrypt) writeJsonPlainAtomic(file, next);
    else if (rotate) writeJsonAtomic(file, plaintext);
    else writeJsonAtomic(file, parsed);
  }
}

if (verify) {
  let remainingPlaintextFields = 0;
  for (const root of roots) {
    for (const file of walkJson(root)) {
      try {
        remainingPlaintextFields += scanSensitiveFields(JSON.parse(fs.readFileSync(file, 'utf8'))).length;
      } catch {
        // Unreadable files are reported by the scan counts above.
      }
    }
  }
  report.remainingPlaintextFields = remainingPlaintextFields;
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(JSON.stringify(report, null, 2));
}

if (!apply && !decrypt && !rotate) {
  console.error('Dry run only. Re-run with --apply to write, --rotate to re-encrypt, or --decrypt to roll back.');
}
