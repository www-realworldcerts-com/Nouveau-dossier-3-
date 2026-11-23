import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Every variable the preflight or the gate can name. They are stripped from the
// inherited environment so a developer's shell cannot decide the verdict.
const STRIPPED = [
    'PRICE_QUOTE_SECRET', 'PRICE_QUOTE_PREVIOUS_SECRET', 'PRICE_QUOTE_KEY_ID',
    'PAYPAL_ENABLE_ORDER_CREATE', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET',
    'PAYPAL_MODE', 'PAYPAL_API_BASE_URL', 'PAYPAL_WEBHOOK_ID',
    'SWARM_LIVE', 'NO_PLATFORM_WALLET', 'BASE44_OFFLINE', 'BASE44_OFFLINE_MODE',
    'OWNER_PAYPAL_EMAIL', 'PAYPAL_EMAIL', 'OWNER_PAYONEER_ID', 'PAYONEER_EMAIL',
    'OWNER_BANK_ACCOUNT', 'OWNER_BANK_RIB', 'BANK_ACCOUNT', 'BANK_RIB', 'BANK_IBAN',
    'FULFILLMENT_ENABLED', 'FULFILLMENT_ACCESS_SECRET', 'FULFILLMENT_FROM_EMAIL',
    'RESEND_API_KEY', 'SETTLEMENT_LEDGER_PATH', 'APP_ORIGIN',
    'FULFILLMENT_ACCESS_LINK_ENABLED', 'FULFILLMENT_SUPPORT_EMAIL',
    'CHECKOUT_ATTEMPT_STORE_DIR', 'CHECKOUT_ATTEMPT_SIGNING_SECRET',
    'CHECKOUT_INTENTS_FILE', 'CHECKOUT_INTENTS_URL', 'CHECKOUT_INTENTS_TOKEN',
    'SALES_DATA_DIR', 'VERCEL', 'AWS_LAMBDA_FUNCTION_NAME', 'NETLIFY',
    'CHECKOUT_HEALTH_URL', 'PAYMENT_WEBHOOK_URL', 'CHECKOUT_REPLAY_PROTECTION',
    'COURSE_CATALOG_FILE'
];

function runGate({ overrides = {}, args = ['--json'] } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'money-readiness-'));
    const env = { ...process.env };
    for (const name of STRIPPED) delete env[name];
    Object.assign(env, {
        CHECKOUT_ATTEMPT_STORE_DIR: path.join(dir, 'attempts'),
        SETTLEMENT_LEDGER_PATH: path.join(dir, 'ledger.json')
    }, overrides);

    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['scripts/money-readiness.mjs', ...args], {
            cwd: process.cwd(),
            env
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('close', (status) => {
            fs.rmSync(dir, { recursive: true, force: true });
            resolve({ status, stdout, stderr });
        });
    });
}

function report(run) {
    return JSON.parse(run.stdout.trim());
}

const COMPLETE = {
    PRICE_QUOTE_SECRET: 'quote-secret',
    PAYPAL_ENABLE_ORDER_CREATE: 'true',
    PAYPAL_CLIENT_ID: 'client-id',
    PAYPAL_CLIENT_SECRET: 'client-secret',
    PAYPAL_MODE: 'live',
    SWARM_LIVE: 'true',
    NO_PLATFORM_WALLET: 'true',
    OWNER_PAYPAL_EMAIL: 'owner@example.com',
    FULFILLMENT_ACCESS_SECRET: 'access-secret',
    RESEND_API_KEY: 'resend-key',
    APP_ORIGIN: 'https://checkout.example',
    PAYPAL_WEBHOOK_ID: 'WH-1'
};

test('an unconfigured deployment fails the build and names the variables to set', async () => {
    const run = await runGate();
    assert.equal(run.status, 1, run.stdout + run.stderr);

    const parsed = report(run);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.verified, false);
    assert.deepEqual(parsed.structural_failures, [], 'missing credentials are not structural failures');
    assert.deepEqual(
        parsed.credential_gated.map(step => step.id).sort(),
        ['capture', 'fulfillment', 'orders', 'quote']
    );
    assert.ok(parsed.needs.includes('PRICE_QUOTE_SECRET'));
    assert.ok(parsed.needs.includes('PAYPAL_CLIENT_ID'));
    assert.ok(parsed.needs.includes('PAYPAL_CLIENT_SECRET'));
    assert.ok(parsed.needs.includes('FULFILLMENT_ACCESS_SECRET'));
    assert.ok(parsed.needs.includes('RESEND_API_KEY'));
});

test('a fork runner without secrets warns instead of failing, and still reports what is missing', async () => {
    const run = await runGate({ args: ['--json', '--allow-unverified'] });
    assert.equal(run.status, 0, run.stdout + run.stderr);

    const parsed = report(run);
    assert.equal(parsed.ok, false, 'unverified is not the same as verified');
    assert.equal(parsed.passed, true);
    assert.equal(parsed.allow_unverified, true);
    assert.equal(parsed.credential_gated.length, 4);
});

test('a structural failure still fails the build when unverified credentials are allowed', async () => {
    const run = await runGate({
        args: ['--json', '--allow-unverified'],
        overrides: { COURSE_CATALOG_FILE: path.join(os.tmpdir(), 'no-such-catalog.json') }
    });
    assert.equal(run.status, 1, run.stdout + run.stderr);

    const parsed = report(run);
    assert.deepEqual(parsed.structural_failures.map(step => step.id), ['catalog']);
    assert.equal(parsed.passed, false);
});

test('one present credential does not buy the others a pass', async () => {
    const run = await runGate({ overrides: { PRICE_QUOTE_SECRET: 'quote-secret' } });
    assert.equal(run.status, 1, run.stdout + run.stderr);

    const parsed = report(run);
    assert.ok(parsed.credential_gated.every(step => step.id !== 'quote'), 'the configured step is not gated');
    assert.deepEqual(parsed.credential_gated.map(step => step.id).sort(), ['capture', 'fulfillment', 'orders']);
});

test('a completely configured deployment passes the gate', async () => {
    const run = await runGate({ overrides: COMPLETE });
    assert.equal(run.status, 0, run.stdout + run.stderr);

    const parsed = report(run);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.verified, true);
    assert.deepEqual(parsed.structural_failures, []);
    assert.deepEqual(parsed.credential_gated, []);
    assert.deepEqual(parsed.needs, []);
});

test('a credential that is set but rejected is a structural failure, not unverified', async () => {
    // PAYPAL_MODE=sandbox is present, so the step cannot be excused as a
    // missing-secret runner: the deployment is configured for the wrong API.
    const run = await runGate({
        args: ['--json', '--allow-unverified'],
        overrides: { ...COMPLETE, PAYPAL_MODE: 'sandbox' }
    });
    assert.equal(run.status, 1, run.stdout + run.stderr);

    const parsed = report(run);
    assert.deepEqual(parsed.structural_failures.map(step => step.id), ['orders', 'capture']);
});

test('github actions annotations are emitted for the failure', async () => {
    const run = await runGate({ args: ['--github-actions'] });
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stderr, /::error::money readiness: PayPal order creation/);
    assert.match(run.stderr, /%3A/, 'annotation text is escaped for the workflow command');
    assert.match(run.stdout, /Set PRICE_QUOTE_SECRET/);
});

test('github actions annotations downgrade to warnings only when unverified is allowed', async () => {
    const run = await runGate({ args: ['--github-actions', '--allow-unverified'] });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /::warning::money readiness: PayPal order creation not verified/);
    assert.doesNotMatch(run.stderr, /::error::/);
});
