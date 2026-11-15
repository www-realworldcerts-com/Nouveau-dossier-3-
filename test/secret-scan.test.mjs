import assert from 'node:assert/strict';
import test from 'node:test';

import { scanRepository, scanText } from '../scripts/scan-secrets.mjs';

const secretKey = ['paypal', 'client', 'secret'].join('_');
const secretValue = ['A1b2C3d4E5f6G7h8', 'I9j0K1l2M3n4O5p6'].join('');

test('finds credential-shaped assignments without returning the value', () => {
    const findings = scanText(`${secretKey}: ${secretValue}`);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, 'key_value');
    assert.equal(findings[0].key, secretKey);
    assert.equal(JSON.stringify(findings).includes(secretValue), false);
});

test('ignores environment references and placeholders', () => {
    const text = [
        `${secretKey}: process.env.PAYPAL_CLIENT_SECRET`,
        `${secretKey}: CHANGE_ME_BEFORE_DEPLOY`,
        `${secretKey}: your_client_secret_here`,
        `${secretKey}: test-client-secret-1234`
    ].join('\n');
    assert.deepEqual(scanText(text), []);
});

test('the tracked repository has no high-confidence credential findings', () => {
    const result = scanRepository();
    assert.equal(result.ok, true, JSON.stringify(result.findings));
    assert.ok(result.scanned > 0);
});
