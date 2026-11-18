import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const BASE_ENV = {
    PAYPAL_WEBHOOK_ID: 'WH-TEST-123',
    PAYPAL_CLIENT_ID: 'test-client',
    PAYPAL_CLIENT_SECRET: 'test-secret',
    VERCEL: '1'
};

function run(args, { storeDir } = {}) {
    const env = { ...process.env, ...BASE_ENV };
    delete env.CHECKOUT_ATTEMPT_STORE_DIR;
    if (storeDir) env.CHECKOUT_ATTEMPT_STORE_DIR = storeDir;
    return spawnSync(process.execPath, args, {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 30000,
        env
    });
}

function configCheck(options) {
    const runResult = run(['src/paypal-webhook-server.mjs', '--check'], options);
    assert.equal(runResult.status, 0, runResult.stderr);
    return { run: runResult, config: JSON.parse(runResult.stdout.trim().split('\n').at(-1)).config };
}

test('an unset checkout attempt store warns at startup and in the config check', () => {
    const { run: cli, config } = configCheck();

    assert.match(cli.stderr, /"warning":"checkout_attempt_store_not_durable"/, 'startup logs carry the warning');
    assert.equal(cli.stderr.trim().split('\n').length, 1);
    assert.match(cli.stderr, /CHECKOUT_ATTEMPT_STORE_DIR is not set/);
    assert.equal(config.checkout_attempts.durable, false);
    assert.equal(config.warnings.length, 1);
    assert.match(config.warnings[0], /CHECKOUT_ATTEMPT_STORE_DIR is not set/);
    assert.equal(config.ok, true, 'a per-process store is a durability warning, not a fatal misconfiguration');
});

test('a configured checkout attempt store clears the warning', () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-attempt-store-'));
    try {
        const { run: cli, config } = configCheck({ storeDir: store });

        assert.equal(cli.stderr, '');
        assert.equal(config.checkout_attempts.durable, true);
        assert.deepEqual(config.warnings, []);
    } finally {
        fs.rmSync(store, { recursive: true, force: true });
    }
});

test('the health endpoint exposes the durability warning to operators', () => {
    const probe = String.raw`
import handler from './api/index.mjs';

function call(url) {
  return new Promise(resolve => {
    const req = {
      method: 'GET',
      url,
      headers: { host: 'localhost', 'user-agent': 'test', accept: '*/*' },
      socket: { remoteAddress: '127.0.0.1' }
    };
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(key, value) { this.headers[key] = value; },
      getHeader(key) { return this.headers[key]; },
      writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers || {}); return this; },
      end(body) { resolve({ status: this.statusCode, body: String(body) }); }
    };
    handler(req, res).catch(error => resolve({ status: 0, error: error.message }));
  });
}

const health = await call('/health');
process.stdout.write('RESULT ' + JSON.stringify(health) + '\n');
`;
    const runResult = run(['--input-type=module', '-e', probe]);
    assert.equal(runResult.status, 0, runResult.stderr);
    const line = runResult.stdout.split('\n').find(row => row.startsWith('RESULT '));
    assert.ok(line, runResult.stdout);
    const health = JSON.parse(line.slice('RESULT '.length));

    assert.equal(health.status, 200);
    const body = JSON.parse(health.body);
    assert.equal(body.config.checkout_attempts.durable, false);
    assert.match(body.config.warnings[0], /CHECKOUT_ATTEMPT_STORE_DIR is not set/);
});
