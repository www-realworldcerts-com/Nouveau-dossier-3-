# Serving the PayPal webhook server on Vercel

This repository now contains the pieces needed to run
`src/paypal-webhook-server.mjs` as a Vercel Node function:

- `api/index.mjs` — the serverless entry point.
- `vercel.json` — routes only the server-owned paths to that function.
- `src/paypal-webhook-server.mjs` — exports its handler and binds a port only
  when executed directly (and not on Vercel).

## Why the rewrites are not a catch-all

The server owns these paths:

`/health`, `/all-good`, `/revenue/*`, `/acp/*`, `/x402/*`, `/rails/*`,
`/ilp/*`, `/paypal/webhook`, plus the `/api/webhooks/paypal` alias.

It does **not** serve static files. A catch-all rewrite would send `/` to the
server, which answers 404, and the storefront would disappear. The marketing
site therefore stays on Vercel's static output and only the routes above are
rewritten to `api/index`.

## Vercel project settings

The project must build the repository that contains these files:

| Setting | Value |
| --- | --- |
| Root Directory | repository root |
| Framework Preset | Other |
| Build Command | empty |
| Output Directory | `rank/output` (the existing static site) |
| Node.js Version | 20.x or 22.x |
| Install Command | `npm ci` (the server imports project modules only) |

Environment variables (Production, at minimum):

- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`
- `PAYPAL_WEBHOOK_ID`
- `SWARM_LIVE=true` only when the account and wallet checks are satisfied
- `PAYPAL_MODE=live`

The webhook must be registered in the PayPal dashboard for
`https://<domain>/api/webhooks/paypal` (or `/paypal/webhook`), using the same
webhook id that is in `PAYPAL_WEBHOOK_ID`.

## Deployment warning

The domain is currently served from `CoNrAd2525/swarm`, root `rank/`, while this
work lives in `www-realworldcerts-com/Nouveau-dossier-3-`. Pushing here does not
deploy there. Either:

1. point the Vercel project at this repository (root = repo root, output =
   `rank/output`), or
2. copy `api/index.mjs`, `vercel.json` and the server change into the deployed
   repository.

Until one of those happens, the live domain keeps returning 404 for the health
and webhook routes.

## Verification

Local, without Vercel:

```bash
PORT=8787 node src/paypal-webhook-server.mjs
curl -i http://127.0.0.1:8787/health            # 200
curl -i http://127.0.0.1:8787/paypal/webhook    # 405 on GET
```

The embedded path used by Vercel:

```bash
VERCEL=1 node --input-type=module -e "
import handler from './api/index.mjs';
// invoke with a request/response pair and assert /health -> 200
"
```

Automated: `npm run test:deploy`.

After deploying:

```bash
curl -i https://www.realworldcerts.com/health
# expect 200 and JSON with ok:true
curl -i https://www.realworldcerts.com/api/webhooks/paypal
# expect 405 (route exists), not 404
node scripts/silent-failure.mjs audit --fail-on high
# storefront finding clears; webhook probe should reach invalid_json (400)
```

PayPal retries a non-2xx delivery up to 25 times over 3 days, so the health and
webhook checks must pass before relying on the endpoint.
