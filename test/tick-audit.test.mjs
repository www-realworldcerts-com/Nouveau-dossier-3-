import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildTickAuditArgs, runTickAudit } from '../src/swarm/tick-audit.mjs';

function tempRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tick-audit-'));
}

function fixtureScript(root, body) {
    const file = path.join(root, 'fake-audit.mjs');
    fs.writeFileSync(file, body);
    return file;
}

test('the tick audit always reconciles PayPal in dry-run mode', () => {
    const args = buildTickAuditArgs();
    assert.ok(args.includes('--reconcile-paypal'));
    assert.ok(args.includes('--write'));
    assert.ok(!args.includes('--apply'), 'the audit must never apply reconciliation');
    assert.deepEqual(args.slice(0, 1), ['audit']);
});

test('the tick audit forwards the webhook URL when configured', () => {
    const args = buildTickAuditArgs({ webhookUrl: 'https://host/api/webhooks/paypal' });
    const index = args.indexOf('--webhook-url');
    assert.notEqual(index, -1);
    assert.equal(args[index + 1], 'https://host/api/webhooks/paypal');
});

test('runTickAudit reports the audit exit code and output', async () => {
    const root = tempRoot();
    const script = fixtureScript(root, 'console.log("audit ran"); process.exit(0);\n');
    const result = await runTickAudit({ root, script, stdio: 'pipe', env: process.env });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /audit ran/);
    assert.ok(result.duration_ms >= 0);
});

test('a finding exit code (2) is returned, not thrown', async () => {
    const root = tempRoot();
    const script = fixtureScript(root, 'process.exit(2);\n');
    const result = await runTickAudit({ root, script, stdio: 'pipe', env: process.env });
    assert.equal(result.code, 2);
});

test('runTickAudit terminates a hung audit', async () => {
    const root = tempRoot();
    const script = fixtureScript(root, 'setTimeout(() => {}, 60000);\n');
    const result = await runTickAudit({ root, script, stdio: 'pipe', env: process.env, timeoutMs: 1000 });
    assert.equal(result.timedOut, true);
    assert.notEqual(result.code, 0);
});
