# Serving the PayPal webhook server on Vercel

This repository now contains the pieces needed to run
`src/paypal-webhook-server.mjs` as a Vercel Node function:

- `api/index.mjs` — the serverless entry point.
- `vercel.json` — routes only the server-owned paths to that function.
- `src/paypal-webhook-server.mjs` — exports its handler and binds a port only
  when executed directly (and not on Vercel).

## Why the rewrites are not a catch-all

The server owns these paths:

`/health`, `/all-good`, `/revenue/*`, `/buy`, `/buy/success`, `/buy/cancel`,
`/data/store-prices.json`, `/acp/*`, `/x402/*`, `/rails/*`, `/ilp/*`,
`/paypal/webhook`, plus the `/api/webhooks/paypal` alias.

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
- `NO_PLATFORM_WALLET=true` (required by the live authority check)
- `OWNER_PAYPAL_EMAIL` (or another owner declaration such as `OWNER_BANK_ACCOUNT`)
- `PAYPAL_ENABLE_ORDER_CREATE=true` after the checkout is verified

The deployment is pinned to Node 22 by `package.json` (`engines.node`).
`.vercelignore` ships only `api`, `src`, `config`, the public price payload and
the package/config files. `vercel.json` excludes `data/**` and
`doomsday-vault/**` from the function bundle; without that exclusion the
function exceeds Vercel's size limit and returns `FUNCTION_INVOCATION_FAILED`.
- `PRICE_QUOTE_SECRET` (or `FULFILLMENT_ACCESS_SECRET` as a fallback), `RESEND_API_KEY`, `FULFILLMENT_FROM_EMAIL`
- `SETTLEMENT_LEDGER_PATH`, `FULFILLMENT_QUEUE_FILE` (durable writable paths)

The webhook must be registered in the PayPal dashboard for
`https://<domain>/api/webhooks/paypal` (or `/paypal/webhook`), using the same
webhook id that is in `PAYPAL_WEBHOOK_ID`.

## Working checkout

`/buy` is a self-contained checkout page served by the same function. It reads
the canonical catalog in `config/course-catalog.json`, creates a PayPal order
through `/acp/v1/transactions`, and sends the buyer to PayPal. `/buy/success`
captures the approved order through `POST /acp/v1/transactions/:id/capture`; a
payment is not considered complete until that capture succeeds and the order
status is `COMPLETED`.

The catalog is the only product source for checkout and Shopify:

```json
{
  "currency": "USD",
  "fulfillment_cost_cents": 200,
  "fx": { "USD": 1, "MAD": 10, "EUR": 0.92 },
  "courses": [
    { "slug": "rwc-cbe-2025", "title": "Certified Blockchain Expert (CBE) 2025", "price_cents": 1900 }
  ]
}
```

The ACP create endpoint requires a known `product_id` and uses the canonical
catalog price for the charge. Before posting the order, `/buy` requests a
short-lived signed quote from `/acp/v1/price-quote?product_id=...`. The quote
binds the product, amount, currency, catalog version and content-addressed
catalog digest; the create endpoint rejects a missing, expired, tampered or
mismatched quote with `409 PRICE_CHANGED` before creating a PayPal order. The
quote ID/version are stored in PayPal `custom_id`, and the catalog digest is
stored in `invoice_id` for reconciliation. If the page also posts the amount and
currency it displayed, they must match the catalog. Posted values never select
the charge.

Set `PRICE_QUOTE_SECRET` to a random value. `FULFILLMENT_ACCESS_SECRET` is used
as a fallback so existing deployments keep working, but a separate secret is
preferred. Without either secret the quote endpoint fails closed with
`503 PRICE_QUOTE_UNAVAILABLE` and checkout cannot create an order.

## Prepaid fulfillment and access delivery

After a successful capture, the handler calls `fulfillPaidOrder`:

1. The captured amount is credited to `data/financial/settlement_ledger.json` as
   `REVENUE_PAYPAL`.
2. The product's fulfillment cost is reserved from **available swarm revenue**
   and recorded as a `FULFILLMENT` debit. The ledger entry records `prepaid_by: "swarm"` and
   `funding_source: "swarm_revenue"`.
3. If available revenue does not cover the cost, access is not released. The
   order is queued as `BLOCKED_PREPAYMENT` and the success page reports that
   fulfillment needs support.
4. Otherwise a signed `/access/<token>` link is generated and emailed through
   Resend (`RESEND_API_KEY`, `FULFILLMENT_FROM_EMAIL`). A provider failure is
   queued as `PENDING_EMAIL`, never reported as delivered.

The settlement ledger is also the email idempotency key: retrying a capture for
an order already marked `email_status: sent` does not send a second email.

Required fulfillment variables:

- `FULFILLMENT_ENABLED=true` (set `false` only for a dry deployment)
- `FULFILLMENT_ACCESS_SECRET` — random secret for signed access links; this is
  distinct from the data encryption key
- `APP_ORIGIN=https://www.realworldcerts.com`
- `RESEND_API_KEY` and a verified `FULFILLMENT_FROM_EMAIL`
- `SETTLEMENT_LEDGER_PATH` and `FULFILLMENT_QUEUE_FILE` pointing at durable,
  writable storage

**Persistence warning:** Vercel’s local filesystem is ephemeral. A ledger or
queue written under the deployment directory disappears between invocations.
Mount durable storage or move these two paths to a persistent volume before
relying on production fulfillment. The code still fails closed: without a
writable ledger, delivery is queued/blocked rather than silently given away.

`/access/<token>` verifies the HMAC and expiry, then links to the configured
product URL or catalog slug. `FULFILLMENT_QUEUE_FILE` is an append-only audit
trail; `BLOCKED_PREPAYMENT`, `PENDING_EMAIL`, `PENDING_ACCESS_SECRET`, and
`DELIVERED` are the delivery states.

Required for live checkout: `PAYPAL_ENABLE_ORDER_CREATE=true`, `SWARM_LIVE=true`,
`NO_PLATFORM_WALLET=true`, `PAYPAL_MODE=live`, and real PayPal credentials. The
return URL is derived from the request origin, so `https://www.realworldcerts.com`
must be the origin buyers use. Set `CHECKOUT_PRICE_ORIGIN_URL` to the direct
deployment origin as a public HTTPS URL on a host distinct from the CDN (not a
`www`/CDN alias, localhost, or a URL with credentials/query/fragment) so
`shopify:price-audit` can compare the buyer-facing edge payload with a
cache-busted edge and origin response. The audit rejects protected/SSO, HTML,
redirected, or CDN-cached origin responses and reports them as unchecked. Use
`npm run checkout:browser-audit` for the browser-level check of the exact `/buy`
page and the amount/currency it POSTs. Register `https://www.realworldcerts.com/buy/success`
as the PayPal return URL only if using a static PayPal button; the `/buy` flow
sets its own return and cancel URLs.

`/buy` links use the catalog slug, for example
`https://www.realworldcerts.com/buy?product_id=certified-blockchain-expert-cbe-preptest-2025`.
Point course and campaign buttons at these links. The old checkout pages are
manual-instructions pages and must not be used for live sales.

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

## Raw webhook body

Signature verification needs the exact bytes PayPal sent. Vercel exposes
`request.body` as a lazy, parsed helper, so the handler must never touch it
before reading the stream. `readRawBody` therefore:

1. reads the request stream first and returns it unchanged;
2. only if the stream is already ended, falls back to `req.rawBody` or
   `req.body` when that value is a Buffer, string or byte array;
3. throws (fail closed) if the only remaining value is a parsed object, since
   re-serialising it would change whitespace and key order.

The wrapper test feeds a real `Readable` through the handler and asserts the
parsed event reaches signature verification, so an empty or reformatted body
fails the test rather than production.
