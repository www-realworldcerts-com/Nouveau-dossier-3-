import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    assertNoSecrets,
    containsSecrets,
    redactSecrets,
    redactText,
    writeSanitizedJson
} from '../src/security/export-sanitizer.mjs';

function exportFiles(dir = 'exports') {
    const root = path.resolve(dir);
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root, { recursive: true })
        .map(entry => path.join(root, entry))
        .filter(file => fs.statSync(file).isFile());
}

test('embedded and key-based credentials are redacted', () => {
    const secretKey = ['paypal', 'client', 'secret'].join('_');
    const clientKey = ['paypal', 'client', 'id'].join('_');
    const source = {
        title: 'deploy',
        [secretKey]: 'do-not-print-this-secret-value',
        mission_parameters: JSON.stringify({ [clientKey]: 'do-not-print-this-client-id' }),
        note: `${secretKey}:do-not-print-this-secret-value`
    };
    const redacted = redactSecrets(source);
    const serialized = JSON.stringify(redacted);
    assert.equal(serialized.includes('do-not-print-this'), false);
    assert.equal(redacted[secretKey], '[REDACTED]');
    assert.equal(containsSecrets(serialized), false);
    assert.throws(() => assertNoSecrets(source), /credential-like/);
});

test('redaction is idempotent for already-redacted text', () => {
    const text = `${['paypal', 'client', 'secret'].join('_')}: [REDACTED]`;
    assert.equal(redactText(text), text);
    assert.equal(redactText(redactText(text)), text);
});

test('the export guard covers every export currently in the repository', () => {
    const files = exportFiles();
    assert.ok(files.length > 0, 'expected mission export files');
    for (const file of files) {
        const text = fs.readFileSync(file, 'utf8');
        assert.equal(containsSecrets(text), false, `credential-like value in ${file}`);
    }
});

test('the write guard refuses to persist an unredacted export', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-guard-'));
    const file = path.join(dir, 'out.json');
    writeSanitizedJson(file, { [['paypal', 'client', 'secret'].join('_')]: 'do-not-print-this-secret-value' });
    const written = fs.readFileSync(file, 'utf8');
    assert.equal(written.includes('do-not-print-this'), false);
    assert.doesNotThrow(() => assertNoSecrets(written));
});
