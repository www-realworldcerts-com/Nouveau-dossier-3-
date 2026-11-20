import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Every variable the preflight names. They are stripped from the inherited
// environment so a developer's shell cannot make these tests pass by accident.
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
    'SALES_DATA_DIR', 'VERCEL', 'AWS_LAMBDA_FUNCTION_NAME', 'NETLIFY'
];

// Asynchronous on purpose: the delivery-route checks need this process's event
// loop free to answer the probe, which spawnSync would block.
function runDoctor({ overrides = {}, args = ['--offline', '--json'] } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-money-'));
    const env = { ...process.env };
    for (const name of STRIPPED) delete env[name];
    Object.assign(env, {
        CHECKOUT_ATTEMPT_STORE_DIR: path.join(dir, 'attempts'),
        SETTLEMENT_LEDGER_PATH: path.join(dir, 'ledger.json')
    }, overrides);

    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['scripts/doctor-money.mjs', ...args], {
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

function steps(run) {
    return report(run).steps;
}

test('an unconfigured deploy fails the steps that need credentials and names them', async () => {
    const run = await runDoctor();
    assert.equal(run.status, 1, run.stderr);

    const byId = Object.fromEntries(steps(run).map(step => [step.id, step]));
    assert.equal(byId.catalog.status, 'ok', JSON.stringify(byId.catalog));
    assert.equal(byId.quote.status, 'fail');
    assert.deepEqual(byId.quote.env, ['PRICE_QUOTE_SECRET']);

    assert.equal(byId.orders.status, 'fail');
    assert.ok(byId.orders.env.includes('PAYPAL_ENABLE_ORDER_CREATE=true'));
    assert.ok(byId.orders.env.includes('PAYPAL_CLIENT_ID'));
    assert.ok(byId.orders.env.includes('PAYPAL_CLIENT_SECRET'));

    assert.equal(byId.capture.status, 'fail', 'capture cannot work if orders cannot');

    assert.equal(byId.fulfillment.status, 'fail');
    assert.ok(byId.fulfillment.env.includes('FULFILLMENT_ACCESS_SECRET'));
    assert.ok(byId.fulfillment.env.includes('RESEND_API_KEY'));
    assert.match(byId.fulfillment.detail, /never delivered/);

    assert.equal(byId.webhook.status, 'warn');
    assert.deepEqual(byId.webhook.env, ['PAYPAL_WEBHOOK_ID']);
});

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

test('a fully configured deploy passes the preflight', async () => {
    const run = await runDoctor({ overrides: COMPLETE });
    assert.equal(run.status, 0, run.stdout + run.stderr);

    const parsed = report(run);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.summary.fail, 0);
    const byId = Object.fromEntries(parsed.steps.map(step => [step.id, step]));
    assert.equal(byId.orders.status, 'ok');
    assert.equal(byId.fulfillment.status, 'ok');
    assert.equal(byId.attempt_store.status, 'ok');
});

test('a serverless deploy without a durable funnel log is warned, not passed silently', async () => {
    const run = await runDoctor({ overrides: { ...COMPLETE, VERCEL: '1' } });
    assert.equal(run.status, 0);

    const funnel = steps(run).find(step => step.id === 'funnel');
    assert.equal(funnel.status, 'warn');
    assert.deepEqual(funnel.env, ['CHECKOUT_INTENTS_URL']);
    assert.match(funnel.detail, /cold start/);

    const durable = await runDoctor({ overrides: { ...COMPLETE, VERCEL: '1', CHECKOUT_INTENTS_URL: 'https://logs.example/intents' } });
    assert.equal(steps(durable).find(step => step.id === 'funnel').status, 'ok');
});

test('a delivery link that 404s is a failure only when the email carries it', async (t) => {
    const server = http.createServer((req, res) => {
        if (req.url.startsWith('/access/')) {
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end('not found');
            return;
        }
        res.writeHead(500);
        res.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const origin = `http://127.0.0.1:${server.address().port}`;

    // The pass is the delivery by default, so a dead route costs the buyer
    // nothing and is not a failure.
    const unattached = await runDoctor({ overrides: { ...COMPLETE, APP_ORIGIN: origin }, args: ['--json'] });
    assert.equal(unattached.status, 0, unattached.stdout + unattached.stderr);
    const idle = steps(unattached).find(step => step.id === 'delivery_link');
    assert.equal(idle.status, 'ok');
    assert.match(idle.detail, /self-contained/);

    // Once the email starts carrying the URL, the dead route is the buyer's problem.
    const run = await runDoctor({
        overrides: { ...COMPLETE, APP_ORIGIN: origin, FULFILLMENT_ACCESS_LINK_ENABLED: 'true' },
        args: ['--json']
    });
    assert.equal(run.status, 1, run.stdout + run.stderr);

    const link = steps(run).find(step => step.id === 'delivery_link');
    assert.equal(link.status, 'fail');
    assert.match(link.detail, /answers 404/);
    assert.deepEqual(link.env, ['APP_ORIGIN', 'FULFILLMENT_ACCESS_LINK_ENABLED']);
});

test('a delivery route that answers for an invalid token is accepted', async (t) => {
    const server = http.createServer((req, res) => {
        res.writeHead(401, { 'content-type': 'text/html' });
        res.end('invalid token');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const origin = `http://127.0.0.1:${server.address().port}`;

    const run = await runDoctor({
        overrides: { ...COMPLETE, APP_ORIGIN: origin, FULFILLMENT_ACCESS_LINK_ENABLED: 'true' },
        args: ['--json']
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const link = steps(run).find(step => step.id === 'delivery_link');
    assert.equal(link.status, 'ok');
    assert.match(link.detail, /401/);
});
