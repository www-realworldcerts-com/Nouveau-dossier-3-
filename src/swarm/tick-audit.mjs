import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * Post-tick money maintenance, shared by the local supervisor (`npm start`).
 *
 * The GitHub workflow runs the same audit and the same fulfilment drain as
 * separate steps after the tick. Local deployments previously ran only the
 * tick, so `--reconcile-paypal` and the missing-fulfilment finding never fired
 * there. This helper runs the same dry-run audit after every supervisor tick.
 *
 * When Shopify Admin credentials are present, the same run also performs the
 * read-only price-drift audit. Missing credentials leave it disabled instead
 * of raising an unavailable-source finding on every tick.
 *
 * A finding (exit code 2) is not a supervisor failure: the audit records the
 * incident and the loop keeps its normal cadence.
 */

export function hasShopifyAdminCredentials(env = process.env) {
    return Boolean(
        String(env.SHOPIFY_STORE_DOMAIN || '').trim()
        && String(env.SHOPIFY_ADMIN_TOKEN || env.SHOPIFY_shpat_TOKEN || '').trim()
    );
}

export function buildTickAuditArgs({ webhookUrl = null, checkoutHealthUrl = null, storefrontUrl = null, stallDays = 7, failOn = 'high', shopifyPriceDrift = false } = {}) {
    const args = [
        'audit',
        '--write',
        '--stall-days', String(stallDays),
        '--fail-on', String(failOn),
        '--reconcile-paypal'
    ];
    if (webhookUrl) args.push('--webhook-url', String(webhookUrl));
    if (checkoutHealthUrl) args.push('--checkout-health-url', String(checkoutHealthUrl));
    if (storefrontUrl) args.push('--storefront-url', String(storefrontUrl));
    if (shopifyPriceDrift) args.push('--shopify-price-drift');
    return args;
}

export function buildDrainArgs({ queueFile = null, limit = null } = {}) {
    const args = ['--apply', '--json'];
    if (queueFile) args.push('--queue', String(queueFile));
    if (limit) args.push('--limit', String(limit));
    return args;
}

function lastJsonLine(text) {
    const lines = String(text || '').split('\n').map(line => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (!lines[i].startsWith('{')) continue;
        try {
            return JSON.parse(lines[i]);
        } catch {
            /* keep looking */
        }
    }
    return null;
}

function runNode({ scriptPath, args, root, env, stdio, timeoutMs }) {
    return new Promise(resolve => {
        const startedAt = Date.now();
        const proc = spawn(process.execPath, [scriptPath, ...args], {
            cwd: root,
            env,
            stdio: stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        if (proc.stdout) proc.stdout.on('data', chunk => { stdout += chunk.toString(); });
        if (proc.stderr) proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
        const timer = setTimeout(() => {
            timedOut = true;
            try { proc.kill('SIGTERM'); } catch { /* already gone */ }
        }, Math.max(1000, Number(timeoutMs)));
        proc.on('close', code => {
            clearTimeout(timer);
            resolve({ code: code ?? 1, timedOut, stdout, stderr, duration_ms: Date.now() - startedAt });
        });
        proc.on('error', error => {
            clearTimeout(timer);
            resolve({ code: 1, timedOut, stdout, stderr: `${stderr}${error.message}`, duration_ms: Date.now() - startedAt });
        });
    });
}

export function runTickAudit({
    root = process.cwd(),
    script = path.join('scripts', 'silent-failure.mjs'),
    env = process.env,
    webhookUrl = env.PAYMENT_WEBHOOK_URL || null,
    checkoutHealthUrl = env.CHECKOUT_HEALTH_URL || null,
    storefrontUrl = env.STOREFRONT_URL || null,
    stallDays = 7,
    failOn = 'high',
    shopifyPriceDrift = null,
    timeoutMs = 180000,
    stdio = 'inherit'
} = {}) {
    const includePriceDrift = shopifyPriceDrift === null
        ? hasShopifyAdminCredentials(env)
        : Boolean(shopifyPriceDrift);
    const args = buildTickAuditArgs({ webhookUrl, checkoutHealthUrl, storefrontUrl, stallDays, failOn, shopifyPriceDrift: includePriceDrift });
    const scriptPath = path.isAbsolute(script) ? script : path.join(root, script);
    return runNode({ scriptPath, args, root, env, stdio, timeoutMs }).then(result => ({ ...result, args }));
}

/**
 * Deliver paid orders that are sitting in the fulfilment queue.
 *
 * The live webhook delivers on `PAYMENT.CAPTURE.COMPLETED`, but an order whose
 * access email failed stays `PENDING_EMAIL` in the append-only queue, and
 * reconciliation counts its id as fulfilled because a line exists. Without a
 * scheduled drain such an order is only delivered if someone retries by hand.
 * This runs the idempotent drain (keyed by PayPal order id in the ledger), so
 * re-running never emails the same buyer twice.
 */
export function runFulfillmentDrain({
    root = process.cwd(),
    script = path.join('scripts', 'drain-fulfillment.mjs'),
    env = process.env,
    queueFile = env.FULFILLMENT_QUEUE_FILE || null,
    limit = 25,
    timeoutMs = 120000,
    stdio = 'inherit'
} = {}) {
    const args = buildDrainArgs({ queueFile, limit });
    const scriptPath = path.isAbsolute(script) ? script : path.join(root, script);
    return runNode({ scriptPath, args, root, env, stdio, timeoutMs })
        .then(result => ({ ...result, args, report: lastJsonLine(result.stdout) }));
}

export default runTickAudit;
