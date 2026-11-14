import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decryptBuffer,
  decryptSensitiveFields,
  encryptBuffer,
  encryptSensitiveFields,
  encryptionConfigured,
  scanSensitiveFields
} from '../src/security/data-at-rest.mjs';
import { loadPayoutLedger, savePayoutLedger } from '../src/financial/payout-ledger.mjs';

const KEY_1 = Buffer.alloc(32, 11).toString('base64');
const KEY_2 = Buffer.alloc(32, 22).toString('base64');

test('sensitive fields are encrypted and round-trip without plaintext on disk', () => {
  const previous = process.env.DATA_ENCRYPTION_KEY;
  try {
    process.env.DATA_ENCRYPTION_KEY = KEY_1;
    const source = {
      payout_key: 'EARN_1',
      amount: 10,
      status: 'submitted',
      recipient: 'owner@example.com',
      bank: { account: '007810000448500030594182', swift: 'BCMAMAMC', name: 'Owner' },
      destination: 'LU774080000041265646'
    };
    assert.deepEqual(scanSensitiveFields(source).sort(), [
      'bank.account',
      'bank.name',
      'bank.swift',
      'destination',
      'recipient'
    ]);
    const encrypted = encryptSensitiveFields(source);
    const raw = JSON.stringify(encrypted);
    assert.equal(raw.includes('owner@example.com'), false);
    assert.equal(raw.includes('007810000448500030594182'), false);
    assert.equal(raw.includes('LU774080000041265646'), false);
    assert.equal(encrypted.amount, 10);
    assert.equal(encrypted.status, 'submitted');
    assert.deepEqual(decryptSensitiveFields(encrypted), source);
    assert.deepEqual(scanSensitiveFields(encrypted), []);
  } finally {
    if (previous == null) delete process.env.DATA_ENCRYPTION_KEY;
    else process.env.DATA_ENCRYPTION_KEY = previous;
  }
});

test('previous key decrypts during rotation but a wrong key fails closed', () => {
  const previous = process.env.DATA_ENCRYPTION_KEY;
  const previousRotation = process.env.DATA_ENCRYPTION_KEY_PREVIOUS;
  try {
    process.env.DATA_ENCRYPTION_KEY = KEY_1;
    const encrypted = encryptSensitiveFields({ email: 'owner@example.com' });
    process.env.DATA_ENCRYPTION_KEY = KEY_2;
    process.env.DATA_ENCRYPTION_KEY_PREVIOUS = KEY_1;
    assert.deepEqual(decryptSensitiveFields(encrypted), { email: 'owner@example.com' });
    delete process.env.DATA_ENCRYPTION_KEY_PREVIOUS;
    assert.throws(() => decryptSensitiveFields(encrypted), /could not be decrypted/i);
  } finally {
    if (previous == null) delete process.env.DATA_ENCRYPTION_KEY;
    else process.env.DATA_ENCRYPTION_KEY = previous;
    if (previousRotation == null) delete process.env.DATA_ENCRYPTION_KEY_PREVIOUS;
    else process.env.DATA_ENCRYPTION_KEY_PREVIOUS = previousRotation;
  }
});

test('binary encrypted files detect tampering', () => {
  const previous = process.env.DATA_ENCRYPTION_KEY;
  try {
    process.env.DATA_ENCRYPTION_KEY = KEY_1;
    const encrypted = encryptBuffer(Buffer.from('bank account data'));
    assert.deepEqual(decryptBuffer(encrypted), Buffer.from('bank account data'));
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] ^= 1;
    assert.throws(() => decryptBuffer(tampered), /could not be decrypted/i);
  } finally {
    if (previous == null) delete process.env.DATA_ENCRYPTION_KEY;
    else process.env.DATA_ENCRYPTION_KEY = previous;
  }
});

test('payout ledger stores encrypted fields and still loads for reconciliation', () => {
  const previous = process.env.DATA_ENCRYPTION_KEY;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'encrypted-ledger-'));
  const file = path.join(dir, 'payout_ledger.json');
  try {
    process.env.DATA_ENCRYPTION_KEY = KEY_1;
    assert.equal(encryptionConfigured(), true);
    const ledger = {
      version: 1,
      updated_at: null,
      items: {
        EARN_1: {
          payout_key: 'EARN_1',
          earning_id: 'EARN_1',
          amount: 25,
          currency: 'USD',
          status: 'submitted',
          recipient: 'owner@example.com',
          bank: { account: '007810000448500030594182', swift: 'BCMAMAMC' }
        }
      },
      statement_imports: {}
    };
    savePayoutLedger(file, ledger);
    const raw = fs.readFileSync(file, 'utf8');
    assert.equal(raw.includes('owner@example.com'), false);
    assert.equal(raw.includes('007810000448500030594182'), false);
    const loaded = loadPayoutLedger(file);
    assert.equal(loaded.items.EARN_1.amount, 25);
    assert.equal(loaded.items.EARN_1.recipient, 'owner@example.com');
    assert.equal(loaded.items.EARN_1.bank.account, '007810000448500030594182');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (previous == null) delete process.env.DATA_ENCRYPTION_KEY;
    else process.env.DATA_ENCRYPTION_KEY = previous;
  }
});
