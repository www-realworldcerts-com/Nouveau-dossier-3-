import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tempEnv(contents) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-loading-'));
    fs.writeFileSync(path.join(dir, '.env'), contents);
    return dir;
}

function cleanEnv(keys) {
    const env = { ...process.env };
    for (const key of keys) delete env[key];
    return env;
}

function parseJsonOutput(stdout) {
    const text = String(stdout || '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    assert.ok(start >= 0 && end > start, `no JSON object in output: ${text}`);
    return JSON.parse(text.slice(start, end + 1));
}

function run(script, args, cwd, keys) {
    return spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
        cwd,
        encoding: 'utf8',
        env: cleanEnv(keys),
        timeout: 30000
    });
}

test('shopify setup reads SHOPIFY_STORE_DOMAIN from .env', () => {
    const cwd = tempEnv('SHOPIFY_STORE_DOMAIN=env-loaded.myshopify.com\n');
    const result = run('sales-agent.mjs', ['setup-shop', '--json'], cwd, ['SHOPIFY_STORE_DOMAIN', 'SHOPIFY_ADMIN_TOKEN']);
    assert.equal(result.status, 2, result.stderr);
    const report = parseJsonOutput(result.stdout);
    assert.equal(report.requested_domain, 'env-loaded.myshopify.com');
    assert.deepEqual(report.blockers, ['missing_admin_token']);
});

test('shopify OAuth reads the app credentials from .env', () => {
    const cwd = tempEnv([
        'SHOPIFY_STORE_DOMAIN=env-loaded.myshopify.com',
        'SHOPIFY_API_KEY=env-client-key',
        'SHOPIFY_API_SECRET=env-client-secret',
        ''
    ].join('\n'));
    const result = run('shopify-oauth.mjs', ['--url-only'], cwd, [
        'SHOPIFY_STORE_DOMAIN',
        'SHOPIFY_API_KEY',
        'SHOPIFY_API_SECRET'
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /env-loaded\.myshopify\.com\/admin\/oauth\/authorize/);
    assert.match(result.stdout, /client_id=env-client-key/);
});

test('the swarm doctor sees live credentials from .env', () => {
    const cwd = tempEnv([
        'SWARM_LIVE=true',
        'BASE44_APP_ID=env-base44-id',
        'BASE44_SERVICE_TOKEN=env-base44-token',
        'PAYPAL_CLIENT_ID=env-paypal-id',
        'PAYPAL_CLIENT_SECRET=env-paypal-secret',
        ''
    ].join('\n'));
    const result = run('swarm-doctor.mjs', ['--json'], cwd, [
        'SWARM_LIVE',
        'BASE44_APP_ID',
        'BASE44_SERVICE_TOKEN',
        'PAYPAL_CLIENT_ID',
        'PAYPAL_CLIENT_SECRET'
    ]);
    const report = parseJsonOutput(result.stdout);
    const live = report.checks.find(check => check.name === 'live_env');
    assert.equal(live.ok, true, live.detail);
});

test('the tick entry point loads .env before spawning the daemon', () => {
    const source = fs.readFileSync(path.join(ROOT, 'scripts', 'swarm-tick.mjs'), 'utf8');
    assert.match(source, /^#!.*\nimport '\.\.\/src\/load-env\.mjs';/m);
});
