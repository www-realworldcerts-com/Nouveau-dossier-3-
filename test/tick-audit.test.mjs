import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    buildDrainArgs,
    buildTickAuditArgs,
    hasShopifyAdminCredentials,
    runFulfillmentDrain,
    runTickAudit
} from '../src/swarm/tick-audit.mjs';

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
    assert.ok(!args.includes('--shopify-price-drift'), 'price drift requires explicit enablement or credentials');
    assert.deepEqual(args.slice(0, 1), ['audit']);
});

test('Shopify price drift is enabled only for a complete admin credential pair', () => {
    assert.equal(hasShopifyAdminCredentials({}), false);
    assert.equal(hasShopifyAdminCredentials({ SHOPIFY_STORE_DOMAIN: 'shop.myshopify.com' }), false);
    assert.equal(hasShopifyAdminCredentials({ SHOPIFY_ADMIN_TOKEN: 'shpat_test' }), false);
    assert.equal(hasShopifyAdminCredentials({
        SHOPIFY_STORE_DOMAIN: 'shop.myshopify.com',
        SHOPIFY_ADMIN_TOKEN: 'shpat_test'
    }), true);
    assert.equal(hasShopifyAdminCredentials({
        SHOPIFY_STORE_DOMAIN: 'shop.myshopify.com',
        SHOPIFY_shpat_TOKEN: 'shpat_test'
    }), true);

    const args = buildTickAuditArgs({ shopifyPriceDrift: true });
    assert.ok(args.includes('--shopify-price-drift'));
});

test('the tick audit forwards the webhook URL when configured', () => {
    const args = buildTickAuditArgs({ webhookUrl: 'https://host/api/webhooks/paypal' });
    const index = args.indexOf('--webhook-url');
    assert.notEqual(index, -1);
    assert.equal(args[index + 1], 'https://host/api/webhooks/paypal');
});

test('the tick audit forwards the deployed checkout gate URL when configured', () => {
    const args = buildTickAuditArgs({ checkoutHealthUrl: 'https://host/health' });
    const index = args.indexOf('--checkout-health-url');
    assert.notEqual(index, -1);
    assert.equal(args[index + 1], 'https://host/health');
    assert.ok(!buildTickAuditArgs().includes('--checkout-health-url'), 'an unset URL must not probe anything');
});

test('runTickAudit reports the audit exit code and output', async () => {
    const root = tempRoot();
    const script = fixtureScript(root, 'console.log("audit ran"); process.exit(0);\n');
    const result = await runTickAudit({ root, script, stdio: 'pipe', env: process.env });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /audit ran/);
    assert.ok(result.duration_ms >= 0);
});

test('runTickAudit enables price drift when Shopify credentials are present', async () => {
    const root = tempRoot();
    const script = fixtureScript(root, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
    const env = {
        ...process.env,
        SHOPIFY_STORE_DOMAIN: 'shop.myshopify.com',
        SHOPIFY_ADMIN_TOKEN: 'shpat_test'
    };
    const result = await runTickAudit({ root, script, stdio: 'pipe', env });
    assert.equal(result.code, 0);
    assert.ok(JSON.parse(result.stdout).includes('--shopify-price-drift'));
});

test('runTickAudit leaves price drift off without Shopify credentials', async () => {
    const root = tempRoot();
    const script = fixtureScript(root, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
    const env = { ...process.env };
    delete env.SHOPIFY_STORE_DOMAIN;
    delete env.SHOPIFY_ADMIN_TOKEN;
    delete env.SHOPIFY_shpat_TOKEN;
    const result = await runTickAudit({ root, script, stdio: 'pipe', env });
    assert.equal(result.code, 0);
    assert.ok(!JSON.parse(result.stdout).includes('--shopify-price-drift'));
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

test('the fulfilment drain always applies and only forwards a configured queue', () => {
    assert.deepEqual(buildDrainArgs(), ['--apply', '--json']);
    const args = buildDrainArgs({ queueFile: 'logs/q.log', limit: 5 });
    assert.ok(args.includes('--apply'));
    assert.equal(args[args.indexOf('--queue') + 1], 'logs/q.log');
    assert.equal(args[args.indexOf('--limit') + 1], '5');
});

test('runFulfillmentDrain applies the drain and returns its report', async () => {
    const root = tempRoot();
    const script = fixtureScript(root, [
        'console.log(JSON.stringify({ pending: 2, delivered: [{ order_id: "ORD-1" }], remaining: 1 }));',
        'console.log(JSON.stringify(process.argv.slice(2)));'
    ].join('\n') + '\n');
    const result = await runFulfillmentDrain({ root, script, stdio: 'pipe', env: process.env });
    assert.equal(result.code, 0);
    assert.ok(result.args.includes('--apply'));
    assert.equal(result.report.delivered[0].order_id, 'ORD-1');
    assert.equal(result.report.remaining, 1);
    assert.ok(JSON.parse(result.stdout.trim().split('\n').pop()).includes('--apply'));
});

test('runFulfillmentDrain surfaces a failing drain instead of throwing', async () => {
    const root = tempRoot();
    const script = fixtureScript(root, 'console.error("no paypal"); process.exit(1);\n');
    const result = await runFulfillmentDrain({ root, script, stdio: 'pipe', env: process.env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no paypal/);
});
