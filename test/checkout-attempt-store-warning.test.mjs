import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { classifyCheckoutAttemptStorage } from '../src/sales/checkout-attempts.mjs';

const BASE_ENV = {
    PAYPAL_WEBHOOK_ID: 'WH-TEST-123',
    PAYPAL_CLIENT_ID: 'test-client',
    PAYPAL_CLIENT_SECRET: 'test-secret',
    VERCEL: '1'
};

const HEALTH_PROBE = String.raw`
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

function run(args, { storeDir, serverless = true } = {}) {
    const env = { ...process.env, ...BASE_ENV };
    delete env.CHECKOUT_ATTEMPT_STORE_DIR;
    if (!serverless) delete env.VERCEL;
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

function healthCheck(options) {
    const runResult = run(['--input-type=module', '-e', HEALTH_PROBE], options);
    assert.equal(runResult.status, 0, runResult.stderr);
    const line = runResult.stdout.split('\n').find(row => row.startsWith('RESULT '));
    assert.ok(line, runResult.stdout);
    return JSON.parse(line.slice('RESULT '.length));
}

test('an unset checkout attempt store warns at startup and in the config check', () => {
    const { run: cli, config } = configCheck();

    assert.match(cli.stderr, /"warning":"checkout_attempt_store_not_durable"/, 'startup logs carry the warning');
    assert.equal(cli.stderr.trim().split('\n').length, 1);
    assert.match(cli.stderr, /CHECKOUT_ATTEMPT_STORE_DIR is not set/);
    assert.equal(config.checkout_attempts.durable, false);
    assert.equal(config.checkout_attempts.directory, null);
    assert.equal(config.warnings.length, 1);
    assert.match(config.warnings[0], /CHECKOUT_ATTEMPT_STORE_DIR is not set/);
    assert.equal(config.ok, true, 'a per-process store is a durability warning, not a fatal misconfiguration');
});

test('a writable store on a single host clears the warning', () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-attempt-store-'));
    try {
        const { run: cli, config } = configCheck({ storeDir: store, serverless: false });

        assert.equal(cli.stderr, '');
        assert.equal(config.checkout_attempts.durable, true);
        assert.equal(config.checkout_attempts.storage, 'unknown', 'local storage is reported, not assumed shared');
        assert.deepEqual(config.warnings, []);
        assert.deepEqual(fs.readdirSync(store), [], 'the writability probe removes the file it creates');
    } finally {
        fs.rmSync(store, { recursive: true, force: true });
    }
});

test('a writable store on a serverless runtime is not reported as durable', () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-attempt-store-serverless-'));
    try {
        const { run: cli, config } = configCheck({ storeDir: store });

        assert.match(cli.stderr, /"warning":"checkout_attempt_store_instance_local"/);
        assert.equal(cli.stderr.trim().split('\n').length, 1);
        assert.match(cli.stderr, /is on instance-local storage/);
        assert.equal(config.checkout_attempts.durable, false, 'per-instance protection is not restart protection');
        assert.equal(config.checkout_attempts.writable, true, 'the directory itself is still writable');
        assert.equal(config.checkout_attempts.storage, 'instance_local');
        assert.equal(config.warnings.length, 1);
        assert.match(config.warnings[0], /CHECKOUT_ATTEMPT_STORE_DIR \(.*\) is on instance-local storage/);
        assert.equal(config.ok, true, 'instance-local storage is a warning, not a fatal misconfiguration');
    } finally {
        fs.rmSync(store, { recursive: true, force: true });
    }
});

test('storage classification separates network mounts from volatile and unknown storage', () => {
    const env = { VERCEL: '1' };

    assert.deepEqual(
        classifyCheckoutAttemptStorage({ directory: '/mnt/store', env, filesystemType: 0x6969 }),
        { configured: true, storage: 'shared', filesystem: 'nfs', volatile: false, runtime: 'vercel' },
        'a network mount is shared even on a serverless runtime'
    );
    assert.equal(
        classifyCheckoutAttemptStorage({ directory: '/tmp/store', env, filesystemType: 0x01021994 }).storage,
        'instance_local',
        'a memory-backed filesystem cannot survive a restart'
    );
    assert.equal(
        classifyCheckoutAttemptStorage({ directory: '/var/lib/store', env: {}, filesystemType: 0xef53 }).storage,
        'unknown',
        'a plain local volume on one host is neither proved shared nor proved per instance'
    );
});

test('a configured but unwritable checkout attempt store is not reported as durable', () => {
    // A path that exists but is a file: mkdir/write fail here even for root,
    // unlike a read-only directory, which root can still write.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-attempt-store-unwritable-'));
    const storePath = path.join(root, 'not-a-directory');
    fs.writeFileSync(storePath, 'x');
    try {
        const { run: cli, config } = configCheck({ storeDir: storePath });

        assert.match(cli.stderr, /"warning":"checkout_attempt_store_unwritable"/, 'startup logs carry the warning');
        assert.equal(cli.stderr.trim().split('\n').length, 1);
        assert.match(cli.stderr, /is set but not writable/);
        assert.equal(config.checkout_attempts.durable, false, 'an unusable store is not durable');
        assert.equal(config.checkout_attempts.directory, path.resolve(storePath));
        assert.match(config.checkout_attempts.error, /EEXIST|ENOTDIR/);
        assert.equal(config.warnings.length, 1);
        assert.match(config.warnings[0], /CHECKOUT_ATTEMPT_STORE_DIR \(.*\) is set but not writable/);
        assert.equal(config.ok, true, 'an unusable store is a warning, not a fatal misconfiguration');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('the health endpoint exposes the durability warning to operators', () => {
    const health = healthCheck();

    assert.equal(health.status, 200);
    const body = JSON.parse(health.body);
    assert.equal(body.config.checkout_attempts.durable, false);
    assert.match(body.config.warnings[0], /CHECKOUT_ATTEMPT_STORE_DIR is not set/);
});

test('the health endpoint reports instance-local storage as not durable', () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-attempt-store-serverless-health-'));
    try {
        const health = healthCheck({ storeDir: store });

        assert.equal(health.status, 200);
        const body = JSON.parse(health.body);
        assert.equal(body.config.checkout_attempts.durable, false);
        assert.equal(body.config.checkout_attempts.storage, 'instance_local');
        assert.match(body.config.warnings[0], /is on instance-local storage/);
    } finally {
        fs.rmSync(store, { recursive: true, force: true });
    }
});

test('the health endpoint reports a configured but unwritable store', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-attempt-store-unwritable-health-'));
    const storePath = path.join(root, 'not-a-directory');
    fs.writeFileSync(storePath, 'x');
    try {
        const health = healthCheck({ storeDir: storePath });

        assert.equal(health.status, 200);
        const body = JSON.parse(health.body);
        assert.equal(body.config.checkout_attempts.durable, false);
        assert.match(body.config.checkout_attempts.error, /EEXIST|ENOTDIR/);
        assert.equal(body.config.warnings.length, 1);
        assert.match(body.config.warnings[0], /is set but not writable/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
