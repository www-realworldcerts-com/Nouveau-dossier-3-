import fs from 'node:fs';
import path from 'node:path';

/**
 * Write guard for mission exports.
 *
 * Mission text often embeds `key:value` credentials inside longer strings, so
 * sanitising parsed JSON keys alone is not enough. Everything written through
 * this module is redacted as text and then checked again before it reaches disk.
 */

const SENSITIVE_KEY = /^(?:paypal_client_id|paypal_client_secret|client_secret|client_id|api_secret|api_key|access_token|refresh_token|private_key|password|passphrase|secret)$/i;
const EMBEDDED_SECRET = /((?:paypal_client_id|paypal_client_secret|client_secret|client_id|api_secret|api_key|access_token|refresh_token|private_key|password|passphrase|secret)\s*["']?\s*[:=]\s*["']?)([A-Za-z0-9._-]{8,})/gi;
const TOKEN_PATTERN = /\b(?:sk_live|pk_live|shpat|shpca|shppa)_[A-Za-z0-9]{8,}\b/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const REDACTED = '[REDACTED]';
const PLACEHOLDER = /(?:\[REDACTED\]|change[ _-]?me|replace[ _-]?me|your[ _-]|example|placeholder|dummy|sample|redacted|^test[-_]|^env[-_]|^local[-_]|^dev[-_]|_here$)/i;

export function isPlaceholderSecret(value) {
    return PLACEHOLDER.test(String(value ?? '').trim());
}

/**
 * Return locations of credential-like values without returning the values,
 * so a finding can never be pasted into a log.
 */
export function findSecretMatches(text) {
    const source = String(text ?? '');
    const findings = [];
    for (const match of source.matchAll(EMBEDDED_SECRET)) {
        if (match[2] === REDACTED || isPlaceholderSecret(match[2])) continue;
        findings.push({ kind: 'key_value', key: match[1].replace(/[\s"':=]+$/, '').trim(), index: match.index });
    }
    for (const match of source.matchAll(TOKEN_PATTERN)) {
        if (isPlaceholderSecret(match[0])) continue;
        findings.push({ kind: 'token', key: 'token', index: match.index });
    }
    for (const match of source.matchAll(JWT_PATTERN)) {
        findings.push({ kind: 'jwt', key: 'jwt', index: match.index });
    }
    return findings;
}

export function redactText(text) {
    return String(text ?? '')
        .replace(EMBEDDED_SECRET, `$1${REDACTED}`)
        .replace(TOKEN_PATTERN, REDACTED)
        .replace(JWT_PATTERN, REDACTED);
}

export function containsSecrets(text) {
    return findSecretMatches(text).length > 0;
}

export function redactSecrets(value) {
    if (Array.isArray(value)) return value.map(redactSecrets);
    if (!value || typeof value !== 'object') {
        return typeof value === 'string' ? redactText(value) : value;
    }
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
        if (entry !== REDACTED && SENSITIVE_KEY.test(key) && entry != null && String(entry).trim() !== '') {
            output[key] = REDACTED;
        } else {
            output[key] = redactSecrets(entry);
        }
    }
    return output;
}

export function assertNoSecrets(value) {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (containsSecrets(serialized)) {
        throw new Error('refusing to write export containing credential-like values');
    }
}

export function writeSanitizedJson(file, value) {
    const redacted = redactSecrets(value);
    assertNoSecrets(redacted);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(redacted, null, 2));
    return redacted;
}

export function writeSanitizedText(file, text) {
    const redacted = redactText(text);
    assertNoSecrets(redacted);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, redacted);
    return redacted;
}
