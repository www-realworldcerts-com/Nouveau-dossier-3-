#!/usr/bin/env node
// Money-path preflight. Walks the checkout in the order a buyer meets it and
// names the env var behind each step that cannot work, so a deploy that takes
// orders but cannot deliver fails here instead of queueing fulfilment and
// emailing nothing.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { enforceAuthorityProtocol } from '../src/authority.mjs';
import { loadCourseCatalog } from '../src/sales/course-catalog.mjs';
import {
    assessCheckoutAttemptStoreStorage,
    planCheckoutReplayProtection,
    probeCheckoutAttemptStore
} from '../src/sales/checkout-attempts.mjs';
import { probeCheckoutGate, resolveCheckoutGateUrl } from '../src/resilience/checkout-gate-probe.mjs';
import { intentStoreStatus } from '../src/sales/intent-store.mjs';
import { resolvePriceQuoteKeys } from '../src/sales/price-quote.mjs';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const offline = args.includes('--offline');
const env = process.env;

// The tick workflow runs this instead of the full preflight: its runner has no
// production credentials, so only the deployed verdict can be trusted there.
// An unset CHECKOUT_HEALTH_URL only warns, so a missing repository variable
// cannot fail the tick; a configured gate that reports itself blocked does.
if (args.includes('--deployed-checkout-gate')) {
    const url = resolveCheckoutGateUrl({ env });
    if (!url) {
        console.log('::warning::no CHECKOUT_HEALTH_URL: cannot verify the deployed checkout gate');
        process.exit(0);
    }
    const gate = await probeCheckoutGate(url);
    if (gate.error) {
        console.log(`::warning::could not read ${url}: ${gate.error}`);
        process.exit(0);
    }
    if (!gate.reported) {
        console.log(`::warning::${url} did not report a checkout gate (HTTP ${gate.status}): cannot verify it`);
        process.exit(0);
    }
    if (gate.blocks) {
        console.error(`checkout gate BLOCKED at ${url}: ${gate.block_reason || 'blocks_checkout=true'} — every checkout order creation answers 503`);
        process.exit(1);
    }
    if (gate.money?.reported && !gate.money.can_take_paid_order) {
        const missing = gate.money.missing.length ? gate.money.missing.join(', ') : 'configuration';
        console.error(`deployment cannot take a paid order at ${url}: missing ${missing} — a checkout can start and never be captured or delivered`);
        process.exit(1);
    }
    console.log(`checkout gate open at ${url} (replay protection: ${gate.replay_protection || 'unknown'})`);
    process.exit(0);
}

const results = [];

function record(id, title, status, detail, extra = {}) {
    results.push({ id, title, status, detail, env: extra.env ?? [], fix: extra.fix ?? null });
}

function envBool(name) {
    return String(env[name] ?? 'false').trim().toLowerCase() === 'true';
}

function has(name) {
    return Boolean(String(env[name] ?? '').trim());
}

function probeWritable(directory) {
    const resolved = path.resolve(directory);
    const probe = path.join(resolved, `.doctor-money-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    try {
        fs.mkdirSync(resolved, { recursive: true });
        fs.writeFileSync(probe, 'probe');
        fs.unlinkSync(probe);
        return { ok: true, directory: resolved, error: null };
    } catch (error) {
        return { ok: false, directory: resolved, error: error?.message ?? String(error) };
    }
}

// 1 ─ Catalog: there is something to sell, at a price the server owns.
let catalog = null;
try {
    catalog = loadCourseCatalog();
    const unpriced = catalog.courses.filter(course => !Number.isInteger(course.price_cents) || course.price_cents <= 0);
    if (unpriced.length) {
        record('catalog', 'Course catalog', 'fail',
            `${unpriced.length} of ${catalog.courses.length} courses have no valid price_cents`,
            { env: ['COURSE_CATALOG_FILE'], fix: 'Fix or remove the unpriced rows in config/course-catalog.json' });
    } else {
        record('catalog', 'Course catalog', 'ok',
            `${catalog.courses.length} courses at ${catalog.currency} ${(catalog.courses[0].price_cents / 100).toFixed(2)}`);
    }
} catch (error) {
    record('catalog', 'Course catalog', 'fail', error?.message ?? String(error),
        { env: ['COURSE_CATALOG_FILE'], fix: 'Point COURSE_CATALOG_FILE at a readable catalog' });
}

// 2 ─ Signed price quote: without a quote there is no checkout at all.
try {
    const keys = resolvePriceQuoteKeys(env);
    if (keys.current) {
        record('quote', 'Signed price quote', 'ok', `key "${keys.current.keyId}"${keys.previous ? ' (+1 previous)' : ''}`);
    } else {
        record('quote', 'Signed price quote', 'fail',
            'no quote signing key: /acp/v1/price-quote answers 503 PRICE_QUOTE_UNAVAILABLE and /buy cannot start a checkout',
            { env: ['PRICE_QUOTE_SECRET'], fix: 'Set PRICE_QUOTE_SECRET to a long random string' });
    }
} catch (error) {
    record('quote', 'Signed price quote', 'fail', error?.message ?? String(error),
        { env: ['PRICE_QUOTE_SECRET', 'PRICE_QUOTE_KEY_ID'] });
}

// 3 ─ PayPal order creation: env gates, then the live-authority protocol.
const orderEnv = [];
if (!envBool('PAYPAL_ENABLE_ORDER_CREATE')) orderEnv.push('PAYPAL_ENABLE_ORDER_CREATE=true');
if (!has('PAYPAL_CLIENT_ID')) orderEnv.push('PAYPAL_CLIENT_ID');
if (!has('PAYPAL_CLIENT_SECRET')) orderEnv.push('PAYPAL_CLIENT_SECRET');

const paypalMode = String(env.PAYPAL_MODE ?? 'live').toLowerCase();
const paypalBase = String(env.PAYPAL_API_BASE_URL ?? '').toLowerCase();
if (paypalMode === 'sandbox' || paypalBase.includes('sandbox.paypal.com')) {
    orderEnv.push('PAYPAL_MODE=live');
}

if (orderEnv.length) {
    record('orders', 'PayPal order creation', 'fail',
        `cannot create an order: ${orderEnv.join(', ')}`,
        { env: orderEnv, fix: '/acp/v1/transactions answers 403 before PayPal is called' });
} else {
    try {
        enforceAuthorityProtocol({ action: 'doctor:money order creation', requireLive: true });
        record('orders', 'PayPal order creation', 'ok', `mode ${paypalMode}, live authority satisfied`);
    } catch (error) {
        const message = error?.message ?? String(error);
        const missing = [];
        if (/SWARM_LIVE/.test(message)) missing.push('SWARM_LIVE=true');
        if (/NO_PLATFORM_WALLET/.test(message)) missing.push('NO_PLATFORM_WALLET=true');
        if (/OWNER_|owner declaration/i.test(message)) missing.push('OWNER_PAYPAL_EMAIL (or OWNER_PAYONEER_ID / OWNER_BANK_ACCOUNT)');
        if (/offline/i.test(message)) missing.push('BASE44_OFFLINE (must be unset/false)');
        record('orders', 'PayPal order creation', 'fail', message,
            { env: missing.length ? missing : ['SWARM_LIVE'], fix: 'Live mode refuses to run without these' });
    }
}

// 4 ─ Capture: the same gates, so a buyer cannot approve and then be stranded.
const orderStep = results.find(result => result.id === 'orders');
if (orderStep?.status === 'ok') {
    record('capture', 'Payment capture', 'ok', 'same gates as order creation');
} else {
    record('capture', 'Payment capture', 'fail',
        'capture is refused for the same reason order creation is; an approved payment could not be captured',
        { env: orderStep?.env ?? [] });
}

// 5 ─ Checkout attempt store: replay protection across instances.
// The server's gate and this preflight share one plan, so they cannot disagree
// about which durable layer is in use or when checkout is blocked.
const appOrigin = String(env.APP_ORIGIN ?? '').trim();
const attemptDir = String(env.CHECKOUT_ATTEMPT_STORE_DIR ?? '').trim();
const attemptStore = attemptDir
    ? probeCheckoutAttemptStore(attemptDir)
    : { configured: false, ok: false, directory: null, code: null, error: null };
const attemptPlan = planCheckoutReplayProtection({
    store: attemptStore,
    storage: attemptDir ? assessCheckoutAttemptStoreStorage(attemptDir, env) : {},
    env
});

if (attemptPlan.mode === 'provider') {
    record('attempt_store', 'Checkout attempt store', 'ok',
        'durable dedupe is the quote-bound PayPal-Request-Id, so a retry inside the quote lifetime returns the same order'
        + (attemptPlan.explicit ? ' (CHECKOUT_REPLAY_PROTECTION=provider)' : '')
        + (attemptDir ? '; the configured directory is not the durable layer' : ''));
} else if (!attemptDir) {
    record('attempt_store', 'Checkout attempt store', attemptPlan.production ? 'fail' : 'warn',
        attemptPlan.production
            ? 'no CHECKOUT_ATTEMPT_STORE_DIR in production with CHECKOUT_REPLAY_PROTECTION=store: checkout order creation is refused (503 CHECKOUT_ATTEMPT_STORE_NOT_DURABLE) because replay protection would be per process, so a restart or another instance could create a second order for a reused quote'
            : 'no CHECKOUT_ATTEMPT_STORE_DIR: quote replay protection is per process, and a restart can create a second order for a reused quote',
        { env: ['CHECKOUT_ATTEMPT_STORE_DIR'], fix: 'Point CHECKOUT_ATTEMPT_STORE_DIR at a volume shared by every instance, or set CHECKOUT_REPLAY_PROTECTION=provider' });
} else if (!attemptStore.ok) {
    record('attempt_store', 'Checkout attempt store', 'fail',
        `cannot write to ${attemptStore.directory}: ${attemptStore.error}`,
        { env: ['CHECKOUT_ATTEMPT_STORE_DIR'] });
} else if (attemptPlan.production && attemptPlan.block_reason) {
    // A shared volume was claimed, but this one is per process: production
    // refuses to create an order rather than pretend it is protected.
    record('attempt_store', 'Checkout attempt store', 'fail',
        `${attemptStore.directory} is on instance-local storage: checkout order creation is refused (503 ${attemptPlan.block_reason}) because it cannot be the durable layer. Mount a shared volume, or set CHECKOUT_REPLAY_PROTECTION=provider.`,
        { env: ['CHECKOUT_ATTEMPT_STORE_DIR', 'CHECKOUT_REPLAY_PROTECTION'] });
} else {
    const signed = has('CHECKOUT_ATTEMPT_SIGNING_SECRET') || has('PRICE_QUOTE_SECRET');
    record('attempt_store', 'Checkout attempt store', 'ok',
        `${attemptStore.directory} is writable, records ${signed ? 'signed' : 'unsigned (set CHECKOUT_ATTEMPT_SIGNING_SECRET)'}`
        + (attemptPlan.block_reason ? ' (instance-local: not durable, refused in production)' : ''));
}

// 5b ─ Checkout gate: a blocked gate takes no orders at all, so it is its own
// failing step rather than a line in another step's detail. The local plan
// decides before deploy; a reachable /health decides for the live deployment.
const healthUrl = resolveCheckoutGateUrl({ env });
let deployedGate = null;
let deployedGateError = null;
if (healthUrl && !offline) {
    deployedGate = await probeCheckoutGate(healthUrl);
    if (deployedGate.error) {
        deployedGateError = deployedGate.error;
        deployedGate = null;
    }
}
const gateFix = { env: ['CHECKOUT_ATTEMPT_STORE_DIR', 'CHECKOUT_REPLAY_PROTECTION'], fix: 'A deploy in this state answers 503 on every checkout and takes no money' };
if (attemptPlan.production && attemptPlan.block_reason) {
    record('checkout_gate', 'Checkout gate', 'fail',
        `this configuration blocks checkout with 503 ${attemptPlan.block_reason}: no durable replay layer, so no order can be created`,
        gateFix);
} else if (deployedGate && !deployedGate.reported) {
    record('checkout_gate', 'Checkout gate', 'warn',
        `${healthUrl} did not report a checkout gate (HTTP ${deployedGate.status}): cannot verify the deployed gate`,
        { env: ['CHECKOUT_HEALTH_URL'] });
} else if (deployedGate?.blocks) {
    record('checkout_gate', 'Checkout gate', 'fail',
        `the deployed /health at ${healthUrl} reports blocks_checkout=true (${deployedGate.block_reason || 'unknown reason'}): checkout order creation answers 503`,
        { ...gateFix, env: ['CHECKOUT_HEALTH_URL', ...gateFix.env] });
} else if (deployedGateError) {
    record('checkout_gate', 'Checkout gate', 'warn',
        `could not verify the deployed gate at ${healthUrl}: ${deployedGateError}`,
        { env: ['CHECKOUT_HEALTH_URL'] });
} else if (deployedGate) {
    record('checkout_gate', 'Checkout gate', 'ok',
        `deployed gate at ${healthUrl} is open (replay protection: ${deployedGate.replay_protection || 'unknown'})`);
} else {
    record('checkout_gate', 'Checkout gate', 'ok',
        'open in this configuration'
        + (healthUrl ? ' (not checked: --offline)' : '; set CHECKOUT_HEALTH_URL to verify the deployed gate'));
}

// 6 ─ Fulfilment: the step that silently queues today.
if (String(env.FULFILLMENT_ENABLED ?? 'true').toLowerCase() === 'false') {
    record('fulfillment', 'Access delivery', 'warn',
        'FULFILLMENT_ENABLED=false: captures are recorded and nothing is delivered',
        { env: ['FULFILLMENT_ENABLED'] });
} else {
    const missing = [];
    if (!has('FULFILLMENT_ACCESS_SECRET')) missing.push('FULFILLMENT_ACCESS_SECRET');
    if (!has('RESEND_API_KEY')) missing.push('RESEND_API_KEY');
    const ledgerFile = String(env.SETTLEMENT_LEDGER_PATH ?? path.join(process.cwd(), 'data', 'financial', 'settlement_ledger.json'));
    const ledgerProbe = probeWritable(path.dirname(ledgerFile));
    if (!ledgerProbe.ok) missing.push('SETTLEMENT_LEDGER_PATH');

    if (missing.length) {
        record('fulfillment', 'Access delivery', 'fail',
            `a paid order would be queued as PENDING_ACCESS_SECRET / PENDING_EMAIL and never delivered: ${missing.join(', ')}`,
            { env: missing, fix: 'The buyer pays, the ledger records revenue, and the email never sends' });
    } else {
        record('fulfillment', 'Access delivery', 'ok',
            'access email can be sent (Resend + signed token) and the fulfilment cost can be prepaid');
    }
}

// 7 ─ The online copy of the link. It is only emailed when explicitly enabled:
// delivery is the attached pass, so a 404 route is not a failed delivery.
const accessLinkEnabled = /^(1|true|yes|on)$/i.test(String(env.FULFILLMENT_ACCESS_LINK_ENABLED ?? '').trim());
if (!accessLinkEnabled) {
    record('delivery_link', 'Access link route', 'ok',
        'not used: the emailed access pass is self-contained, so delivery does not need the app server');
} else if (!appOrigin) {
    record('delivery_link', 'Access link route', 'warn',
        'APP_ORIGIN is unset: the emailed link falls back to https://www.realworldcerts.com/access/<token>, where the app server is not deployed',
        { env: ['APP_ORIGIN'] });
} else if (offline) {
    record('delivery_link', 'Access link route', 'warn', `not checked (--offline): ${appOrigin}/access/<token>`);
} else {
    const url = `${appOrigin.replace(/\/+$/, '')}/access/doctor-${crypto.randomBytes(6).toString('hex')}`;
    try {
        const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
        if (response.status === 404) {
            record('delivery_link', 'Access link route', 'fail',
                `${appOrigin}/access/<token> answers 404: the buyer would receive a dead link`,
                { env: ['APP_ORIGIN', 'FULFILLMENT_ACCESS_LINK_ENABLED'], fix: 'Unset FULFILLMENT_ACCESS_LINK_ENABLED, or deploy the app server at APP_ORIGIN' });
        } else if ([400, 401, 403, 410].includes(response.status)) {
            record('delivery_link', 'Access link route', 'ok', `route answers ${response.status} for an invalid token`);
        } else {
            record('delivery_link', 'Access link route', 'warn', `unexpected status ${response.status} for an invalid token`);
        }
    } catch (error) {
        record('delivery_link', 'Access link route', 'warn',
            `could not verify ${appOrigin}: ${error?.message ?? error}`, { env: ['APP_ORIGIN'] });
    }
}

// 8 ─ Funnel log: a serverless file log resets on every cold start.
const intents = intentStoreStatus();
if (intents.durable) {
    record('funnel', 'Funnel log', 'ok', `${intents.kind} at ${intents.target}`);
} else {
    record('funnel', 'Funnel log', 'warn',
        `${intents.kind} log at ${intents.target} is instance-local (${intents.reason}): checkout_intent/paid_order counts reset on every cold start`,
        { env: ['CHECKOUT_INTENTS_URL'] });
}

// 9 ─ PayPal webhook: asynchronous captures and disputes are only seen here.
if (has('PAYPAL_WEBHOOK_ID')) {
    record('webhook', 'PayPal webhook', 'ok', 'PAYPAL_WEBHOOK_ID set');
} else {
    record('webhook', 'PayPal webhook', 'warn',
        'no PAYPAL_WEBHOOK_ID: /paypal/webhook cannot verify signatures, so out-of-band captures and disputes are invisible',
        { env: ['PAYPAL_WEBHOOK_ID'] });
}

const failed = results.filter(result => result.status === 'fail');
const warned = results.filter(result => result.status === 'warn');

if (asJson) {
    console.log(JSON.stringify({
        ok: failed.length === 0,
        checked_at: new Date().toISOString(),
        steps: results,
        summary: { ok: results.length - failed.length - warned.length, warn: warned.length, fail: failed.length }
    }, null, 2));
} else {
    console.log('Money path preflight');
    console.log('='.repeat(64));
    for (const result of results) {
        const mark = result.status === 'ok' ? 'ok  ' : result.status === 'warn' ? 'warn' : 'FAIL';
        console.log(`[${mark}] ${result.title}: ${result.detail}`);
        if (result.env?.length) console.log(`       env: ${result.env.join(', ')}`);
        if (result.fix) console.log(`       why: ${result.fix}`);
    }
    console.log('-'.repeat(64));
    console.log(`${results.length - failed.length - warned.length} ok, ${warned.length} warning(s), ${failed.length} failure(s)`);
    if (failed.length) {
        console.log('\nThis deployment cannot complete a paid order. Fix the failures above before sending traffic.');
    } else if (warned.length) {
        console.log('\nCheckout can complete; review the warnings, which fail silently under load.');
    }
}

process.exit(failed.length ? 1 : 0);
