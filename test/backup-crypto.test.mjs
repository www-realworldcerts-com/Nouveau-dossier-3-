import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createEncryptedBackup,
  restoreEncryptedBackup
} from '../src/security/backup-crypto.mjs';

const KEY = Buffer.alloc(32, 33).toString('base64');

test('backups encrypt every file and restore byte-for-byte', () => {
  const previous = process.env.DATA_ENCRYPTION_KEY;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-crypto-'));
  try {
    process.env.DATA_ENCRYPTION_KEY = KEY;
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'payout.json'), '{"recipient":"owner@example.com"}');
    fs.writeFileSync(path.join(root, 'data', 'statement.txt'), 'IBAN LU774080000041265646');

    const result = createEncryptedBackup({
      sources: ['data'],
      outDir: path.join(root, 'backup'),
      projectRoot: root
    });
    assert.equal(result.fileCount, 2);

    const backupFiles = [];
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) walk(full);
        else backupFiles.push(full);
      }
    };
    walk(path.join(root, 'backup'));
    const bytes = backupFiles.map((file) => fs.readFileSync(file)).join('');
    assert.equal(bytes.includes('owner@example.com'), false);
    assert.equal(bytes.includes('LU774080000041265646'), false);
    assert.ok(backupFiles.every((file) => file.endsWith('.enc')));

    const restored = restoreEncryptedBackup({
      backupDir: path.join(root, 'backup'),
      outDir: path.join(root, 'restored')
    });
    assert.equal(restored.restored, 2);
    assert.equal(fs.readFileSync(path.join(root, 'restored', 'data', 'payout.json'), 'utf8'), '{"recipient":"owner@example.com"}');
    assert.equal(fs.readFileSync(path.join(root, 'restored', 'data', 'statement.txt'), 'utf8'), 'IBAN LU774080000041265646');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    if (previous == null) delete process.env.DATA_ENCRYPTION_KEY;
    else process.env.DATA_ENCRYPTION_KEY = previous;
  }
});

test('restore refuses to overwrite without force and a wrong key fails', () => {
  const previous = process.env.DATA_ENCRYPTION_KEY;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-crypto-'));
  try {
    process.env.DATA_ENCRYPTION_KEY = KEY;
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'a.json'), '{"email":"owner@example.com"}');
    createEncryptedBackup({ sources: ['data'], outDir: path.join(root, 'backup'), projectRoot: root });
    fs.mkdirSync(path.join(root, 'out', 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'out', 'data', 'a.json'), 'existing');
    assert.throws(
      () => restoreEncryptedBackup({ backupDir: path.join(root, 'backup'), outDir: path.join(root, 'out') }),
      /Refusing to overwrite/
    );
    assert.throws(
      () => restoreEncryptedBackup({
        backupDir: path.join(root, 'backup'),
        outDir: path.join(root, 'out'),
        force: true,
        env: { DATA_ENCRYPTION_KEY: Buffer.alloc(32, 44).toString('base64') }
      }),
      /could not be decrypted/i
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    if (previous == null) delete process.env.DATA_ENCRYPTION_KEY;
    else process.env.DATA_ENCRYPTION_KEY = previous;
  }
});
