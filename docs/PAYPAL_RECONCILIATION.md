# PayPal paid-but-unfulfilled reconciliation

The webhook is the primary fulfilment path, but it is a single point of failure:
if the endpoint is unreachable (404 static host, 401 deployment protection), the
buyer pays, PayPal retries for a while, and the order is never delivered.

`scripts/reconcile-paypal.mjs` is the replay path. It compares PayPal's own
record of captured payments with the existing fulfilment queue
(`logs/fulfillment_queue.log`) and enqueues anything missing through
`FulfillmentManager` — the same path the webhook uses.

There is **no second ledger**:

- source of truth for payment: PayPal Orders/Reporting API via `src/paypal-api.mjs`
  (`searchTransactions`, `getPayPalOrderDetails`);
- source of truth for fulfilment: the existing `logs/fulfillment_queue.log`,
  written by `FulfillmentManager.fulfillOrder`;
- idempotency key: the PayPal order id already present in that queue.

## Usage

```bash
# Dry run: report drift, write nothing (default)
npm run reconcile:paypal

# Replay: enqueue every paid-but-unfulfilled order
npm run reconcile:paypal -- --apply

# Narrow to explicit order ids (useful for a single reported case)
npm run reconcile:paypal -- --order-id 5O190127TN364715T --apply

# JSON for alerting / dashboards
npm run reconcile:paypal -- --json
```

Options: `--lookback-days <n>` (default 30), `--no-search` (explicit ids only),
`--queue <file>`, `--json`.

Exit code `0` on success (including when drift is reported), `1` on a fatal
error such as a failed PayPal search with no explicit ids.

## What counts as paid

An order is paid only when PayPal returns a `COMPLETED` capture. Approved but
uncaptured orders are skipped (`not_paid`), as are orders whose lookup fails
(`lookup_failed`). A paid order with no payer email is still enqueued — visible
and fixable — and listed in `warnings` as `missing_email:<order_id>`.

## Captured price reconciliation

Each paid order is also compared with the canonical catalog in
`config/course-catalog.json`. The report adds:

- `price_checked` — captured orders whose price could be compared;
- `price_mismatch_count` / `price_mismatches` — captured amount differs from
the catalog, with order, product, capture, expected, actual, currency and delta;
- `price_unchecked` — orders that could not be compared because the product id,
capture amount or currency is missing, the product is unknown or an FX rate is
unavailable;
- `price_catalog_error` — the catalog itself could not be read.

The audit report also records the canonical `catalog_digest`, making it clear
which catalog revision the comparison used. This check is read-only. It does
not change a catalog, Shopify or PayPal price,
and `--apply` only enqueues missing fulfilment. A mismatch is a
`PAYPAL_ORDER_PRICE_DRIFT` high finding for the owner to review for a refund,
collection or acceptance decision.

The purchase path has a separate assertion: `/acp/v1/transactions` charges the
catalog price and requires a short-lived signed price quote binding the product,
amount, currency, catalog version and content-addressed catalog digest. A
missing, expired, tampered or stale quote receives `409 PRICE_CHANGED` before
PayPal is called. New orders store the quote ID and catalog version in
`custom_id` (for example `product|q=quote-id|v=1`) and the catalog digest in
`invoice_id` (for example `q=quote-id|d=sha256:...`). Product extraction accepts
both this structured custom ID and the legacy product-only value, so existing
orders remain reconcilable.

`reconcileOrderPrice` also exposes `quote_id`, `catalog_version`,
`catalog_digest`, `catalog_digest_expected` and `catalog_revision`. The
reconciliation report summarizes `catalog_revision_checked`,
`catalog_revision_mismatch_count`, `catalog_revision_mismatches` and
`catalog_revision_unchecked`. A revision mismatch means the order was created
from a different catalog revision than the one currently loaded; it is reported
separately from a captured amount mismatch, and legacy orders without a digest
are unchecked rather than treated as clean or as price drift.

## Quote metadata findings

Every paid order is also checked for complete quote metadata. A complete order
has the quote id and catalog version in `custom_id` and the quote id plus
catalog digest in `invoice_id`. The report exposes:

- `quote_metadata_checked` — orders whose metadata was evaluated;
- `quote_metadata_finding_count` / `quote_metadata_findings` — orders with
  `missing`, `malformed` or `stale` metadata;
- `quote_metadata_legacy` — orders excluded by the legacy allowlist;
- `quote_metadata_unchecked` — orders that cannot be compared because the
  current catalog revision is unavailable.

Each row includes `quote_metadata_status`, `quote_metadata_reason`,
`quote_id`, `catalog_version`, `catalog_digest` and the expected revision where
available. Malformed metadata covers partial `custom_id`/`invoice_id` values,
quote-id disagreement and invalid digest syntax. Stale metadata means the
version or digest no longer matches the loaded catalog. The check is read-only:
no PayPal metadata, catalog price, Shopify price or captured amount is changed.

Genuine pre-quote orders can be allowlisted with the comma-separated
`PAYPAL_LEGACY_QUOTE_ORDER_IDS` environment variable (or the
`legacyQuoteOrderIds` option), or by setting `PAYPAL_QUOTE_REQUIRED_AFTER` to an
ISO timestamp; orders paid before that timestamp are treated as legacy. Missing
metadata on an allowlisted order is not a finding. Malformed or stale metadata
is never suppressed by the legacy allowlist.

The silent-failure audit maps these rows to the high-severity
`PAYPAL_QUOTE_METADATA_DRIFT` finding, with the affected order ids and reasons
in its evidence.

## Idempotency

1. The queue is read before any write; an order id already present is skipped.
2. Enqueueing goes through `FulfillmentManager`, which appends a
   `PENDING_DELIVERY` entry; the id remains the idempotency key on the next run.
3. A failure during enqueue is reported in `failed` and is **not** counted as
   enqueued, so the next run retries it.

Tests (`npm run test:reconcile`) cover the dry run, apply, a second run
enqueueing nothing, pre-existing queue entries, explicit ids without search,
unpaid/unknown orders, missing email, search failure, and enqueue failure.

## Limits

This tool only queues delivery; the downstream deliverer still has to send the
product. It needs live PayPal credentials with reporting access, and it does not
move money. Run it after the webhook endpoint is reachable so that both paths
agree.
