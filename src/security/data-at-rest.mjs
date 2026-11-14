import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Field-level encryption for financial data at rest.
 *
 * Format: enc:v1:<iv>:<auth-tag>:<ciphertext> (URL-safe base64 parts).
 * AES-256-GCM protects confidentiality and detects tampering. The key is never
 * stored in the repository: DATA_ENCRYPTION_KEY (base64/hex) or
 * DATA_ENCRYPTION_KEY_FILE (for Docker/Kubernetes secrets). A previous key can
 * be supplied during rotation.
 */

export const ENCRYPTED_PREFIX = 'enc:v1:';
const AAD = Buffer.from('revenue-swarm:data-at-rest:v1', 'utf8');
const FILE_MAGIC = Buffer.from('DATAENC1', 'utf8');

export class DataAtRestError extends Error {
  constructor(message, code = 'DATA_AT_REST_ERROR') {
    super(message);
    this.name = 'DataAtRestError';
    this.code = code;
  }
}

function decodeKey(raw, label) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    key = Buffer.from(value, 'hex');
  } else {
    key = Buffer.from(value, 'base64');
  }
  if (key.length !== 32) {
    throw new DataAtRestError(`${label} must decode to 32 bytes (AES-256).`, 'DATA_AT_REST_BAD_KEY');
  }
  return key;
}

function readKeyFile(file) {
  try {
    return decodeKey(fs.readFileSync(file, 'utf8'), 'DATA_ENCRYPTION_KEY_FILE');
  } catch (error) {
    if (error instanceof DataAtRestError) throw error;
    throw new DataAtRestError('DATA_ENCRYPTION_KEY_FILE could not be read.', 'DATA_AT_REST_BAD_KEY');
  }
}

function previousKeys(env) {
  const raw = env.DATA_ENCRYPTION_KEY_PREVIOUS;
  if (!raw) return [];
  let values;
  const trimmed = String(raw).trim();
  if (trimmed.startsWith('[')) {
    try {
      values = JSON.parse(trimmed);
    } catch {
      throw new DataAtRestError('DATA_ENCRYPTION_KEY_PREVIOUS must be a JSON array or comma-separated keys.', 'DATA_AT_REST_BAD_KEY');
    }
  } else {
    values = trimmed.split(',');
  }
  return values
    .map((value, index) => decodeKey(value, `DATA_ENCRYPTION_KEY_PREVIOUS[${index}]`))
    .filter(Boolean);
}

/** Current and rotation keys. Throws only when a key is malformed. */
export function getEncryptionKeys(env = process.env) {
  let current = decodeKey(env.DATA_ENCRYPTION_KEY, 'DATA_ENCRYPTION_KEY');
  if (!current && env.DATA_ENCRYPTION_KEY_FILE) {
    current = readKeyFile(env.DATA_ENCRYPTION_KEY_FILE);
  }
  return { current, previous: previousKeys(env) };
}

export function encryptionConfigured(env = process.env) {
  return getEncryptionKeys(env).current !== null;
}

export function requireEncryptionKey(env = process.env) {
  const keys = getEncryptionKeys(env);
  if (!keys.current) {
    throw new DataAtRestError(
      'DATA_ENCRYPTION_KEY or DATA_ENCRYPTION_KEY_FILE is required for encrypted data.',
      'DATA_AT_REST_KEY_MISSING'
    );
  }
  return keys;
}

export function isEncryptedValue(value) {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX);
}

function seal(buffer, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

function open(buffer, keys) {
  if (buffer.length < 28) throw new DataAtRestError('Encrypted payload is truncated.', 'DATA_AT_REST_CORRUPT');
  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const ciphertext = buffer.subarray(28);
  for (const key of [keys.current, ...keys.previous].filter(Boolean)) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(AAD);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      // Try the next rotation key. Never include ciphertext or key material.
    }
  }
  throw new DataAtRestError(
    'Encrypted data could not be decrypted. Check DATA_ENCRYPTION_KEY or supply the previous key.',
    'DATA_AT_REST_DECRYPT_FAILED'
  );
}

export function encryptString(plaintext, { env = process.env } = {}) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) return plaintext;
  if (isEncryptedValue(plaintext)) return plaintext;
  const { current } = requireEncryptionKey(env);
  const sealed = seal(Buffer.from(plaintext, 'utf8'), current);
  const iv = sealed.subarray(0, 12).toString('base64url');
  const tag = sealed.subarray(12, 28).toString('base64url');
  const ciphertext = sealed.subarray(28).toString('base64url');
  return `${ENCRYPTED_PREFIX}${iv}:${tag}:${ciphertext}`;
}

export function decryptString(value, { env = process.env } = {}) {
  if (!isEncryptedValue(value)) return value;
  const parts = value.slice(ENCRYPTED_PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new DataAtRestError('Encrypted value has an invalid format.', 'DATA_AT_REST_CORRUPT');
  }
  const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, 'base64url'));
  return open(Buffer.concat([iv, tag, ciphertext]), getEncryptionKeys(env)).toString('utf8');
}

const SENSITIVE_KEYS = new Set([
  'account',
  'accountid',
  'accountno',
  'accountnumber',
  'accountholder',
  'bank',
  'bankaccount',
  'bankaccountnumber',
  'bankname',
  'beneficiary',
  'beneficiaryname',
  'bic',
  'cardnumber',
  'destination',
  'email',
  'iban',
  'ownerbankaccount',
  'payee',
  'payeeemail',
  'payeename',
  'payoneer',
  'payoneerid',
  'paypal',
  'paypalemail',
  'phone',
  'recipient',
  'recipientemail',
  'recipientname',
  'rib',
  'routingnumber',
  'sortcode',
  'swift',
  'swiftcode',
  'walletaddress'
]);

function compactKey(key) {
  return String(key ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isSensitive(key, parentKeys, value) {
  const k = compactKey(key);
  if (SENSITIVE_KEYS.has(k)) return true;
  if (k.includes('iban') || k.includes('rib') || k.includes('swift') || k.includes('bankaccount')) return true;
  const parent = parentKeys.map(compactKey);
  const inIdentityContext = parent.some((p) =>
    ['bank', 'beneficiary', 'recipient', 'payee', 'account', 'owner', 'payoneer', 'paypal'].includes(p)
  );
  if (inIdentityContext && ['name', 'address', 'identifier', 'account', 'email', 'phone'].includes(k)) return true;
  if (inIdentityContext && typeof value === 'string' && k === 'id') return true;
  return false;
}

function walk(value, transform, { parentKeys = [] } = {}) {
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, transform, { parentKeys }));
  }
  if (!value || typeof value !== 'object') return value;

  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string' && isSensitive(key, parentKeys, child)) {
      result[key] = transform(child);
    } else if (child && typeof child === 'object') {
      result[key] = walk(child, transform, { parentKeys: [...parentKeys, key] });
    } else {
      result[key] = child;
    }
  }
  return result;
}

/** Encrypt sensitive fields without mutating the input object. */
function scan(value, { parentKeys = [], pathParts = [] } = {}, result = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scan(item, { parentKeys, pathParts: [...pathParts, `[${index}]`] }, result));
    return result;
  }
  if (!value || typeof value !== 'object') return result;
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...pathParts, key];
    if (typeof child === 'string' && isSensitive(key, parentKeys, child) && !isEncryptedValue(child)) {
      result.push(childPath.join('.'));
    } else if (child && typeof child === 'object') {
      scan(child, { parentKeys: [...parentKeys, key], pathParts: childPath }, result);
    }
  }
  return result;
}

/** Paths of sensitive plaintext fields; never returns the values. */
export function scanSensitiveFields(value) {
  return scan(value);
}

export function encryptSensitiveFields(value, { env = process.env, required = false } = {}) {
  if (!encryptionConfigured(env)) {
    if (required) requireEncryptionKey(env);
    return value;
  }
  return walk(value, (text) => encryptString(text, { env }));
}

/** Decrypt every encrypted string in a structure, regardless of its field name. */
export function decryptSensitiveFields(value, { env = process.env } = {}) {
  const transform = (node) => {
    if (typeof node === 'string') return decryptString(node, { env });
    if (Array.isArray(node)) return node.map(transform);
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, transform(child)]));
    }
    return node;
  };
  return transform(value);
}

export function encryptBuffer(buffer, { env = process.env } = {}) {
  const { current } = requireEncryptionKey(env);
  return Buffer.concat([FILE_MAGIC, seal(Buffer.from(buffer), current)]);
}

export function decryptBuffer(buffer, { env = process.env } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < FILE_MAGIC.length + 28 || !buffer.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)) {
    throw new DataAtRestError('Not an encrypted JARVIS file.', 'DATA_AT_REST_CORRUPT');
  }
  return open(buffer.subarray(FILE_MAGIC.length), getEncryptionKeys(env));
}

let warnedAboutPlaintext = false;

export function writeJsonAtomic(file, value, { env = process.env, required = false } = {}) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  if (!encryptionConfigured(env) && scanSensitiveFields(value).length > 0) {
    if (!warnedAboutPlaintext) {
      console.warn('[data-at-rest] Sensitive fields are being written in plaintext because DATA_ENCRYPTION_KEY is not set.');
      warnedAboutPlaintext = true;
    }
  }
  const encrypted = encryptSensitiveFields(value, { env, required });
  const tmp = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(encrypted, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, resolved);
  return encrypted;
}

export function readEncryptedJson(file, { env = process.env } = {}) {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  return decryptSensitiveFields(parsed, { env });
}

export function writeJsonPlainAtomic(file, value) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const tmp = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, resolved);
  return value;
}
