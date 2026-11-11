#!/usr/bin/env node
import { DEFAULT_PORT, redirectUriFor, runLocalOAuth, scopesFromEnv, writeTokenToEnv } from '../src/sales/shopify-oauth.mjs';
import { normalizeShopDomain } from '../src/sales/shopify-setup.mjs';

/**
 * Shopify self-setup, step 1: obtain the Admin API token with OAuth and store it
 * in .env (mode 0600, gitignored). The token is never printed.
 *
 * Prerequisites: a custom app in the Shopify admin with this callback URL
 * whitelisted — http://127.0.0.1:<port>/callback
 */

function parseArgs(argv) {
    const flags = {};
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token.startsWith('--')) continue;
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
            flags[key] = true;
        } else {
            flags[key] = next;
            i += 1;
        }
    }
    return flags;
}

function help() {
    console.log(`Shopify OAuth bootstrap — self-configuring admin token.

Usage:
  node scripts/shopify-oauth.mjs --shop <store>.myshopify.com [options]

Options:
  --shop <domain>    Store admin domain (or SHOPIFY_STORE_DOMAIN)
  --port <n>         Local callback port (default ${DEFAULT_PORT})
  --env <file>       Env file to update (default .env)
  --scopes <list>    Comma-separated scopes (default ${scopesFromEnv().join(',')})
  --url-only         Print the authorize URL without starting the listener
  --json             Machine-readable output

Environment:
  SHOPIFY_API_KEY, SHOPIFY_API_SECRET   Custom app credentials
  SHOPIFY_STORE_DOMAIN                  Store domain fallback
  SHOPIFY_OAUTH_SCOPES                  Scope list fallback

The access token is written to the env file with mode 0600 and never printed.
Whitelist the redirect URI in the Shopify app configuration first.`);
}

async function main() {
    const flags = parseArgs(process.argv.slice(2));
    if (flags.help) return help();

    const shop = normalizeShopDomain(flags.shop || process.env.SHOPIFY_STORE_DOMAIN);
    const apiKey = process.env.SHOPIFY_API_KEY;
    const apiSecret = process.env.SHOPIFY_API_SECRET;
    const port = Number(flags.port || DEFAULT_PORT);
    const scopes = flags.scopes ? String(flags.scopes).split(',').map(scope => scope.trim()) : scopesFromEnv();
    const envFile = flags.env || '.env';

    if (!shop) {
        console.error('Missing shop domain. Pass --shop <store>.myshopify.com or set SHOPIFY_STORE_DOMAIN.');
        process.exit(1);
    }
    if (!apiKey) {
        console.error('Missing SHOPIFY_API_KEY (Shopify admin -> Settings -> Apps -> Develop apps -> your app -> API credentials).');
        process.exit(1);
    }

    if (flags['url-only']) {
        const { buildAuthorizeUrl, createState } = await import('../src/sales/shopify-oauth.mjs');
        const url = buildAuthorizeUrl({ shop, apiKey, scopes, redirectUri: redirectUriFor(port), state: createState() });
        console.log(url);
        return;
    }
    if (!apiSecret) {
        console.error('Missing SHOPIFY_API_SECRET.');
        process.exit(1);
    }

    console.log(`Waiting for Shopify authorization on ${redirectUriFor(port)} …`);
    const result = await runLocalOAuth({
        shop,
        apiKey,
        apiSecret,
        port,
        scopes,
        log: ({ authorizeUrl }) => {
            console.log('\nOpen this URL and approve the app:\n');
            console.log(authorizeUrl);
            console.log('');
        }
    });
    const written = writeTokenToEnv({ file: envFile, domain: result.domain, token: result.access_token });
    const payload = {
        connected: true,
        domain: result.domain,
        scope: result.scope,
        env_file: written.file,
        keys_written: written.keys
    };
    if (flags.json) console.log(JSON.stringify(payload, null, 2));
    else {
        console.log(`Shopify connected: ${result.domain}`);
        console.log(`Token stored in ${written.file} (${written.keys.join(', ')}) — value not shown.`);
        console.log('Next: npm run shopify:setup');
    }
}

main().catch(error => {
    console.error(`shopify-oauth: ${error.message}`);
    process.exit(1);
});
