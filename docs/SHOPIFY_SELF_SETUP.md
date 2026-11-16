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
| Verify a configured payment gateway | Yes with scope | `payment_gateways.json` |
| Verify the Shopify Payments payout account | Yes with scope | `shopifyPaymentsAccount` |
| Verify PayPal / external payouts | **No API** | Explicit owner attestation, validated against the configured gateway |
| Verify primary domain | Yes | `/shop.json` + storefront final URL |
| Verify collection membership | Yes | `custom_collections.json` + `collects.json` |
| Create a canary checkout | Yes with Storefront token | Storefront `cartCreate` |
| Create the "Courses" collection | Yes | `custom_collections.json` (REST) |
| Create/update product drafts | Yes | `npm run shopify:publish` |
| Activate products after the gate | Yes | `npm run shopify:activate` |
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
   `write_products`, `read_publications`, `write_publications`,
   `read_payment_gateways`, `read_shopify_payments_accounts`.
4. Add the redirect URL `http://127.0.0.1:3456/callback`.
5. Put the credentials in `.env` (gitignored). Start from
   [`env.shopify.template`](../env.shopify.template):

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

### External payout attestation

Shopify does not expose the destination behind a PayPal or other external
payout provider. When Shopify Payments is not the payout destination, the gate
requires an owner-controlled JSON attestation:

```json
{
  "provider": "paypal",
  "destination": "owner@example.com",
  "attested_by": "Store Owner",
  "attested_at": "2026-11-16T00:00:00Z",
  "statement": "I confirm this is the store owner payout destination."
}
```

Set `SHOPIFY_PAYOUT_ATTESTATION_FILE` to its path and make the file owner-only
(`chmod 600`), or pass `--payout-attestation <file>`. Group- or world-readable
files are rejected with `payout_attestation_permissions`. Integrations backed by
a secrets manager can instead pass the attestation object directly as
`settings.payoutAttestation` (the `secret_store` source), which avoids a local
file entirely.

The provider must match an enabled non-Shopify payment gateway, and the
attestation must include the destination, who attested and a timestamp no older
than 365 days (with a five-minute future clock-skew allowance). This is an
explicit owner assertion, not API proof; keep the file owner-controlled and out
of public reports or commits. The launch report and CLI show the provider with a
masked destination, never the full destination.

When PayPal credentials are configured (`PAYPAL_CLIENT_ID`,
`PAYPAL_CLIENT_SECRET`, with optional `PAYPAL_API_BASE_URL`) or an access token
is injected by the caller, the gate also calls PayPal user info and requires the
attested destination to match the authenticated account email or payer id. A
mismatch or failed lookup blocks with `paypal_account_mismatch` or
`paypal_account_unverified`. Without PayPal credentials the gate falls back to
the owner attestation and records the `paypal_account_check_skipped` warning.
The token is never printed. `--url-only` prints the URL without starting the
listener, and `--env <file>` targets a different env file.

The launch gate also needs a **Storefront API access token** and the primary
domain. Add these to `.env` (never commit it):

```
SHOPIFY_STOREFRONT_ACCESS_TOKEN=...
SHOPIFY_PRIMARY_DOMAIN=www.realworldcerts.com
# optional: override the first active course used for the canary
SHOPIFY_CANARY_COURSE=
# optional: country used for shipping and tax estimates (default US)
SHOPIFY_CANARY_COUNTRY_CODE=US
```

The launch gate reads with `read_products`, `read_publications`,
`read_payment_gateways` and `read_shopify_payments_accounts`. The publisher
additionally needs `write_products`; activation publishes drafts to the Online
Store channel and verifies them, so it needs `write_publications` too. Add those
scopes to `SHOPIFY_OAUTH_SCOPES` before re-running OAuth if the token was issued
with only the publishing scopes.

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

Catalog prices are in **USD cents**. The publisher writes variant prices in the
**store currency**, derived from the catalog's single FX table:

- `USD` → 19.00 USD (no conversion);
- `MAD` → 190.00 MAD at `fx.MAD: 10`;
- `EUR` → 17.48 EUR at `fx.EUR: 0.92`;
- anything else → refused with `unsupported_store_currency`, never guessed.

The FX table lives in `config/course-catalog.json`; there is no MAD tier price
on the publishing path. Set `SHOPIFY_STORE_CURRENCY` only to override what
`/shop.json` reports (for example in a dry run). The publish report records the
store currency it used.

## Step 4 — publish drafts

```bash
npm run shopify:setup -- --ensure-collection
npm run shopify:publish -- --dry-run   # inspect 298 converted prices, no writes
npm run shopify:publish                # create/update drafts only
```

`shopify:publish` never activates a product. New products are created as
`draft`, so a first run cannot expose an unready catalog.

## Step 5 — run the gate and activate

```bash
npm run shopify:activate -- --dry-run
npm run shopify:activate
npm run shopify:activate -- --json
```

`--dry-run` reports the selected products, variant price checks, planned
activation/publication/collection actions, and readiness blockers without
changing products, publications, the collection, or creating a canary cart. It
writes `data/sales/ShopifyActivationDryRun.json` instead of the activation
report. The dry-run readiness result carries the
`canary_checkout_skipped_dry_run` warning because a real cart cannot be created
without making a Shopify write.

Activation performs the canary path in order:

1. acquires an exclusive run lock and creates a resumable run report;
2. snapshots every selected product's status and Online Store publication
   state;
3. validates every selected variant against the canonical catalog price and
   store currency;
4. publishes every selected product that is not already on the Online Store
   channel;
5. ensures every selected product is in the `Courses` collection;
6. temporarily activates one canary product;
7. runs the launch gate against that canary;
8. activates the rest only if the gate passes, then verifies every active
   product is published to Online Store.

A missing/unusable variant, stale price, unsupported currency, or missing
store-currency presentment blocks activation before any product is changed.

Activation is transactional after the snapshot: any failure restores every
snapshotted status and Online Store publication state, including products
activated before the failing call. Products that were already active stay
active.

An interrupted run can be resumed with its run id, or with the latest
in-progress run:

```bash
npm run shopify:activate -- --resume <run-id>
npm run shopify:activate -- --resume latest
```

Run reports are written to `data/sales/ShopifyActivationRuns/<run-id>.json`;
`data/sales/ShopifyActivationReport.json` remains the latest result. The lock is
`data/sales/ShopifyActivation.lock` and is released on completion. A lock from a
crashed process on the same host is reclaimed automatically. Dry runs do not
create a lock or run report.

The gate verifies all of the following:

- Admin token scopes, including payment and payout read scopes;
- store currency and catalog FX conversion;
- storefront password protection is off;
- at least one enabled payment gateway;
- Shopify Payments is activated with a bank account and payout schedule, or a
  valid external-provider owner attestation matches the configured gateway;
- the storefront's primary domain matches `SHOPIFY_PRIMARY_DOMAIN`;
- every selected course is a member of the `Courses` collection;
- every selected product is published to the Online Store channel;
- the canary variant is `availableForSale`, not `currentlyNotInStock`, has a
  price in the store currency, and has usable inventory data;
- a country-aware Storefront cart returns subtotal, tax and total amounts in the
  store currency, the subtotal matches the variant price, and the total is not
  below the subtotal;
- a shipping variant has at least one delivery option in the store currency, or
  the variant explicitly does not require shipping;
- the resulting checkout URL is reachable.

The canary creates a cart and fetches the checkout URL; it does **not** complete
a payment or create an order. Missing Storefront credentials or payment/payout
configuration are blockers, not warnings. `SHOPIFY_CANARY_COUNTRY_CODE`
controls the delivery/tax context; align it with the store's primary market.

Then complete the manual steps from the report:

1. **Password protection off** — a buyer must not hit a password page.
2. **Payment provider active** — without it, even a checkout intent cannot complete.
3. **Payout account** — revenue cannot settle until payouts are configured.
4. **Custom domain** — buyers should land on `realworldcerts.com`, not a myshopify URL.

`shopify:launch-check` remains available as a standalone diagnostic once a
canary or active product exists. The activation command is the path that both
checks and activates.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `missing_admin_token` | Run `npm run shopify:oauth` or set `SHOPIFY_ADMIN_TOKEN` |
| `invalid_shop_domain` | Use `<store>.myshopify.com`; custom domains cannot call the Admin API |
| `missing_scopes:write_products` | Add the scope in the app configuration, then reinstall/re-authorize |
| `HTTP 401` | Token revoked or wrong store; rotate via OAuth again |
| `HTTP 403` on products | Missing `read_products`/`write_products` scope |
| `collection_endpoint_unsupported` | REST collection endpoint unavailable on this API version; create the collection in the admin |
| `currency_conversion` warning | Expected when the store is not USD; verify the rate in `config/course-catalog.json` |
| `password_gate_on` | Manual: Online Store → Preferences → disable password protection |
| `missing_payment_scope` / `payments_unverified` | Add `read_payment_gateways` to the app and re-authorize |
| `payouts_unverified` / `payouts_not_activated` | Add `read_shopify_payments_accounts`, activate Shopify Payments and add a bank account, or configure an external payout attestation |
| `payout_attestation_required` | Set `SHOPIFY_PAYOUT_ATTESTATION_FILE` with an owner attestation for the enabled external gateway |
| `payout_attestation_invalid` | Fill in `provider`, `destination`, `attested_by` and a valid ISO `attested_at` |
| `payout_attestation_provider_mismatch` | Match the attestation `provider` to an enabled non-Shopify payment gateway |
| `payout_attestation_unreadable` | Fix the attestation file path or JSON syntax |
| `payout_attestation_permissions` | Run `chmod 600 <file>` or inject the attestation from a secrets store |
| `payout_attestation_stale` | Re-attest the current payout destination; attestations expire after 365 days |
| `payout_attestation_future` | Correct `attested_at`; timestamps more than five minutes in the future are rejected |
| `paypal_account_mismatch` | The attested destination is not the account behind the PayPal API credentials |
| `paypal_account_unverified` | PayPal credentials are configured but the account lookup failed |
| `missing_storefront_token` | Add a Storefront API access token as `SHOPIFY_STOREFRONT_ACCESS_TOKEN` |
| `canary_variant_unavailable` | Publish the canary variant to the Online Store channel and make it available for sale |
| `canary_variant_out_of_stock` | Restock the canary variant or choose a stocked canary course |
| `canary_shipping_unavailable` | Add a shipping rate for `SHOPIFY_CANARY_COUNTRY_CODE`, or use a non-shipping canary |
| `canary_currency_mismatch` | Align the canary market/country with the store currency or fix the variant price |
| `canary_subtotal_mismatch` | Re-run `npm run shopify:publish` so the canary subtotal matches the variant price |
| `canary_total_mismatch` | Fix the cart price/tax configuration; the total must not be below the subtotal |
| `canary_tax_missing` | Enable tax calculations for the canary market and retry |
| `collection_missing_products` | Run `npm run shopify:setup -- --ensure-collection` and `npm run shopify:activate`; activation adds selected products to the collection |
| `products_not_published` | Run `npm run shopify:publish` first; activation only operates on existing drafts |
| `variant_validation_failed` | Re-run `npm run shopify:publish` to restore canonical prices, or fix the variant in Shopify; activation reports each mismatch |
| `products_not_published_to_online_store` | Confirm each listed product is visible to the Online Store channel, then rerun `npm run shopify:activate` |
| `online_store_publication_missing` | Confirm the Online Store sales channel is active and the app has `read_publications` |
| `publication_set_failed` | Add `write_publications`, confirm the app can edit products, and rerun activation |

## Security notes

- `.env` is gitignored and written `0600`; tokens never appear in CLI output,
  reports or logs (errors are passed through `redactToken`).
- Use a custom app dedicated to this pipeline, with only the scopes above.
- Rotate the token if it is ever exposed (`npm run shopify:oauth` again).
