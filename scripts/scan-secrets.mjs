#!/usr/bin/env node
/**
 * Repository-wide secret scan.
 *
 * The mission-export guard only protects exports. This scanner covers every
 * tracked text file so a credential cannot quietly reappear in an audit dump,
 * a debug script, a generated page, or documentation.
 *
 * It reports file, line, kind and key name — never the value.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isPlaceholderSecret } from '../src/security/export-sanitizer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BYTES = 64 * 1024 * 1024;
const KEY_VALUE = /((?:paypal_client_secret|paypal_client_id|client_secret|api_secret|api_key|access_token|refresh_token|private_key|passphrase|client_id|password|secret)\s*["']?\s*[:=]\s*["']?)([A-Za-z0-9._~+/=-]{8,})/gi;
const TOKEN = /\b(?:sk_live|pk_live|shpat|shpca|shppa)_[A-Za-z0-9]{8,}\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const FIXTURE_PATH = /(^|\/)(?:test|tests)\/|\.(?:test|spec)\.|(^|\/)docs?\/|\.md$/i;

function looksLikeCredential(value) {
    const text = String(value ?? '').trim();
    if (!text || text === '[REDACTED]' || text.includes('...') || isPlaceholderSecret(text)) return false;
    if (text.length < 16) return false;
    if (/^(?:process\.env|os\.environ|env:|getenv|request\.|req\.|config\.|settings\.|this\.|payload\.|body\.|params\.|import\.meta)/i.test(text)) return false;
    if (/^(?:password|secret|token|key|hash|string|str|none|null|true|false|boolean|integer)$/i.test(text)) return false;
    if (/(?:process|environ|password|placeholder|example|sample|dummy|fake|mock|change|your|redacted|secret|token)/i.test(text)) return false;
    if (text.length < 20) return false;
    const hasDigit = /\d/.test(text);
    const hasUpper = /[A-Z]/.test(text);
    const hex = /^[a-f0-9]{32,}$/i.test(text);
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(text);
    return (hasDigit && (hasUpper || hex)) || hex || uuid;
}

function lineAndColumn(text, index) {
    const before = text.slice(0, index);
    const line = before.split('\n').length;
    const column = index - before.lastIndexOf('\n');
    return { line, column };
}

export function scanText(text, { file = '<text>' } = {}) {
    const source = String(text ?? '');
    const fixture = FIXTURE_PATH.test(file);
    const findings = [];
    const add = (index, kind, key) => {
        const { line, column } = lineAndColumn(source, index);
        findings.push({ file, line, column, kind, key });
    };

    for (const match of source.matchAll(KEY_VALUE)) {
        const key = match[1].replace(/[\s"':=]+$/, '').trim();
        if (!looksLikeCredential(match[2])) continue;
        add(match.index, 'key_value', key);
    }
    for (const match of source.matchAll(TOKEN)) {
        if (isPlaceholderSecret(match[0]) || /secret|token/i.test(match[0]) || (fixture && /test|dummy|fake|sample/i.test(match[0]))) continue;
        add(match.index, 'token', 'token');
    }
    for (const match of source.matchAll(JWT)) {
        if (fixture) continue;
        add(match.index, 'jwt', 'jwt');
    }
    return findings;
}

export function listTrackedFiles({ root = ROOT, staged = false } = {}) {
    const args = staged
        ? ['diff', '--cached', '--name-only', '--diff-filter=ACM', '-z']
        : ['ls-files', '-z'];
    const output = execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    return output.split('\0').filter(Boolean);
}

export function scanRepository({ root = ROOT, staged = false, files = null } = {}) {
    const tracked = files || listTrackedFiles({ root, staged });
    const findings = [];
    const skipped = [];
    for (const file of tracked) {
        const absolute = path.resolve(root, file);
        let stat;
        try {
            stat = fs.statSync(absolute);
        } catch {
            continue;
        }
        if (!stat.isFile()) continue;
        if (stat.size > MAX_BYTES) {
            skipped.push({ file, reason: 'too_large' });
            continue;
        }
        const buffer = fs.readFileSync(absolute);
        if (buffer.includes(0)) {
            skipped.push({ file, reason: 'binary' });
            continue;
        }
        findings.push(...scanText(buffer.toString('utf8'), { file }));
    }
    return { ok: findings.length === 0, scanned: tracked.length, findings, skipped };
}

function main() {
    const args = process.argv.slice(2);
    const staged = args.includes('--staged');
    const json = args.includes('--json');
    const result = scanRepository({ staged });

    if (json) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        for (const finding of result.findings) {
            console.log(`::error file=${finding.file},line=${finding.line},col=${finding.column}::${finding.kind} ${finding.key}`);
        }
        console.log(`secret scan: ${result.scanned} files, ${result.findings.length} finding(s)`);
        if (result.skipped.length) {
            const tooLarge = result.skipped.filter(row => row.reason === 'too_large').length;
            console.log(`skipped: ${result.skipped.length} binary/oversized file(s)${tooLarge ? `, including ${tooLarge} oversized` : ''}`);
        }
    }

    if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
