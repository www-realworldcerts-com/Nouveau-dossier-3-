import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * Post-tick silent-failure audit, shared by the local supervisor (`npm start`).
 *
 * The GitHub workflow runs the same audit as a separate step after the tick.
 * Local deployments previously ran only the tick, so `--reconcile-paypal` and
 * the missing-fulfilment finding never fired there. This helper runs the same
 * dry-run audit after every supervisor tick.
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
            resolve({ code: code ?? 1, timedOut, stdout, stderr, args, duration_ms: Date.now() - startedAt });
        });
        proc.on('error', error => {
            clearTimeout(timer);
            resolve({ code: 1, timedOut, stdout, stderr: `${stderr}${error.message}`, args, duration_ms: Date.now() - startedAt });
        });
    });
}

export default runTickAudit;
