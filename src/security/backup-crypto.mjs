import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  DataAtRestError,
  decryptBuffer,
  encryptBuffer,
  requireEncryptionKey
} from './data-at-rest.mjs';

/**
 * Encrypted backup directory format:
 *   <backup>/<relative-path>.enc
 *   <backup>/manifest.enc
 *
 * Every file, including text exports and the manifest, is AES-256-GCM
 * encrypted before it touches disk. Restore derives paths from the relative
 * names and refuses traversal outside the output directory.
 */

const MANIFEST = 'manifest.enc';

function walkFiles(root, base = root, result = []) {
  const stats = fs.lstatSync(root);
  if (stats.isSymbolicLink()) return result;
  if (stats.isDirectory()) {
    for (const name of fs.readdirSync(root)) {
      walkFiles(path.join(root, name), base, result);
    }
    return result;
  }
  if (stats.isFile()) result.push({ abs: root, rel: path.relative(base, root) });
  return result;
}

function safeRelative(rel) {
  const normalized = path.normalize(rel);
  if (path.isAbsolute(normalized) || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new DataAtRestError('Backup path escapes the destination.', 'DATA_AT_REST_UNSAFE_PATH');
  }
  return normalized;
}

function writeEncryptedFile(destination, buffer, env) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, encryptBuffer(buffer, { env }), { mode: 0o600 });
}

export function encryptBackupFile(source, destination, { env = process.env } = {}) {
  writeEncryptedFile(destination, fs.readFileSync(source), env);
}

export function decryptBackupFile(source, destination, { env = process.env, force = false } = {}) {
  if (!force && fs.existsSync(destination)) {
    throw new DataAtRestError(`Refusing to overwrite ${destination}; pass --force.`, 'DATA_AT_REST_EXISTS');
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, decryptBuffer(fs.readFileSync(source), { env }), { mode: 0o600 });
}

/**
 * Encrypt the selected files/directories into one backup directory.
 * The source paths are resolved from `projectRoot` (default cwd).
 */
export function createEncryptedBackup({
  sources = ['data', 'config', 'exports'],
  outDir,
  projectRoot = process.cwd(),
  env = process.env
}) {
  requireEncryptionKey(env);
  const root = path.resolve(projectRoot);
  const destination = path.resolve(outDir || path.join('backups', new Date().toISOString().replace(/[:.]/g, '-')));
  const files = [];

  for (const source of sources) {
    const abs = path.resolve(root, source);
    if (!fs.existsSync(abs)) continue;
    for (const entry of walkFiles(abs)) {
      const rel = safeRelative(path.relative(root, entry.abs));
      const target = path.join(destination, `${rel}.enc`);
      encryptBackupFile(entry.abs, target, { env });
      files.push(rel);
    }
  }

  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    files: files.sort(),
    fileCount: files.length
  };
  writeEncryptedFile(path.join(destination, MANIFEST), Buffer.from(JSON.stringify(manifest), 'utf8'), env);
  return { outDir: destination, fileCount: files.length, manifest };
}

export function restoreEncryptedBackup({
  backupDir,
  outDir,
  env = process.env,
  force = false
}) {
  requireEncryptionKey(env);
  const sourceRoot = path.resolve(backupDir);
  const destinationRoot = path.resolve(outDir);
  if (!fs.existsSync(sourceRoot)) throw new DataAtRestError('Backup directory does not exist.', 'DATA_AT_REST_NOT_FOUND');

  let restored = 0;
  for (const entry of walkFiles(sourceRoot)) {
    if (entry.rel === MANIFEST) continue;
    if (!entry.rel.endsWith('.enc')) continue;
    const rel = safeRelative(entry.rel.slice(0, -4));
    const destination = path.join(destinationRoot, rel);
    if (!destination.startsWith(destinationRoot + path.sep)) {
      throw new DataAtRestError('Backup path escapes the restore directory.', 'DATA_AT_REST_UNSAFE_PATH');
    }
    decryptBackupFile(entry.abs, destination, { env, force });
    restored += 1;
  }

  const manifestPath = path.join(sourceRoot, MANIFEST);
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(decryptBuffer(fs.readFileSync(manifestPath), { env }).toString('utf8'))
    : null;
  return { outDir: destinationRoot, restored, manifest };
}

export function backupIntegrity(backupDir) {
  // Paths and ciphertext only; never prints plaintext or key material.
  const root = path.resolve(backupDir);
  if (!fs.existsSync(root)) return { exists: false, files: 0 };
  const files = walkFiles(root);
  const digest = crypto.createHash('sha256');
  for (const entry of files.sort((a, b) => a.rel.localeCompare(b.rel))) {
    digest.update(entry.rel);
    digest.update(fs.readFileSync(entry.abs));
  }
  return { exists: true, files: files.length, sha256: digest.digest('hex') };
}
