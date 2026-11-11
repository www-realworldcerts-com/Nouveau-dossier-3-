# Shopify Self-Setup

Turns the empty Shopify store into a store the sales agent can publish into —
without pasting an admin token by hand and without guessing what Shopify will
not let an app configure.

## What "self-setup" can and cannot do

| Task | Automatable | How |
| --- | --- | --- |
| Create the Shopify store | No | Shopify signup flow; the store must already exist |
| Obtain the Admin API token | Yes | OAuth bootstrap writes it to `.env` (`npm run shopify:oauth`) |
| Verify token, plan, currency | Yes | `GET /shop.json` |
| Verify API scopes | Yes | `GET /access_scopes.json` |
| Detect the storefront password gate | Yes | Storefront fetch |
| Create the "Courses" collection | Yes | `custom_collections.json` (REST) |
| Publish products with prices | Yes | `npm run sales -- run --catalog …` |
| Turn off password protection | **No API** | Shopify admin → Online Store → Preferences |
| Choose a payment provider | **No API** | Shopify admin → Settings → Payments |
| Configure payouts / bank account | **No API** | Shopify admin → Settings → Payments → Payouts |
| Point realworldcerts.com at the store | **No API** | Shopify admin → Settings → Domains |

Shopify does not expose storefront password protection, payment-provider
selection or payout configuration through the Admin API for a custom app. The
self-setup command reports those as explicit manual steps with direct admin
links instead of pretending they were automated.

## Step 1 — create a custom app (once)

1. Shopify admin → **Settings → Apps → Develop apps → Create an app**.
2. API credentials → copy the **client id** and **client secret**.
3. Configuration → Admin API integration → enable scopes `read_products`,
   `write_products`, `read_orders`.
4. Add the redirect URL `http://127.0.0.1:3456/callback`.
5. Put the credentials in `.env` (gitignored):

```
SHOPIFY_API_KEY=...
SHOPIFY_API_SECRET=...
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
```

## Step 2 — obtain the token by OAuth

```bash
npm run shopify:oauth -- --shop your-store.myshopify.com
```

The command prints an authorize URL, waits on `127.0.0.1:3456/callback`, verifies
Shopify's HMAC and `state`, exchanges the code, and writes
`SHOPIFY_ADMIN_TOKEN` plus `SHOPIFY_STORE_DOMAIN` to `.env` with mode `0600`.
The token is never printed. `--url-only` prints the URL without starting the
listener, and `--env <file>` targets a different env file.

If OAuth is not possible, create an Admin API access token in the app and set
`SHOPIFY_ADMIN_TOKEN=shpat_...` in `.env` instead.

## Step 3 — audit the shop

```bash
npm run shopify:setup                       # human checklist, exit 0 ready / 2 blocked
npm run shopify:setup -- --json             # machine-readable, also written to data/sales/ShopifySetupReport.json
npm run shopify:setup -- --ensure-collection
```

The report covers:

- shop name, plan and **currency**;
- granted scopes vs `read_products` + `write_products`;
- product count;
- storefront password-gate status;
- currency conversion readiness (see below);
- manual steps with admin links.

## Currency correctness

Catalog prices are in **MAD**. The publisher writes variant prices in the
**store currency**. Publishing 1500 MAD into a USD store would create a
1500.00 USD course, so the publisher converts explicitly:

- store currency `MAD` → price unchanged;
- `EUR` → `fx.eur_per_mad` (0.092);
- `USD` → `fx.usd_per_mad` (0.10);
- anything else → refused with `unsupported_store_currency`, never guessed.

Rates live in `config/pricing.json` under `fx`. Set `SHOPIFY_STORE_CURRENCY` only
to override what `/shop.json` reports (for example in a mock run). The publish
report records the store currency it used.

## Step 4 — publish and finish the manual steps

```bash
npm run sales -- run --catalog catalog.ndjson --ensure-collection
```

Rules-priced courses auto-approve; LLM-priced exceptions wait for
`approve` → `resume`. Then complete the manual steps from the report:

1. **Password protection off** — a buyer must not hit a password page.
2. **Payment provider active** — without it, even a checkout intent cannot complete.
3. **Payout account** — revenue cannot settle until payouts are configured.
4. **Custom domain** — buyers should land on `realworldcerts.com`, not a myshopify URL.

Re-run `npm run shopify:setup` afterwards; `ready: YES`, `password gate: off` and
`products > 0` are the exit criteria.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `missing_admin_token` | Run `npm run shopify:oauth` or set `SHOPIFY_ADMIN_TOKEN` |
| `invalid_shop_domain` | Use `<store>.myshopify.com`; custom domains cannot call the Admin API |
| `missing_scopes:write_products` | Add the scope in the app configuration, then reinstall/re-authorize |
| `HTTP 401` | Token revoked or wrong store; rotate via OAuth again |
| `HTTP 403` on products | Missing `read_products`/`write_products` scope |
| `collection_endpoint_unsupported` | REST collection endpoint unavailable on this API version; create the collection in the admin |
| `currency_conversion` warning | Expected when the store is not MAD; verify the rate in `config/pricing.json` |
| `password_gate_on` | Manual: Online Store → Preferences → disable password protection |

## Security notes

- `.env` is gitignored and written `0600`; tokens never appear in CLI output,
  reports or logs (errors are passed through `redactToken`).
- Use a custom app dedicated to this pipeline, with only the scopes above.
- Rotate the token if it is ever exposed (`npm run shopify:oauth` again).
