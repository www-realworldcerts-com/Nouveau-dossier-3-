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

## Post-capture reconciliation

`POST /acp/v1/transactions/:id/capture` reports a `reconciliation` object that
compares what PayPal actually captured with the signed checkout attempt record
for the order's quote. The quote token is client-held and gone by capture time,
so its facts — amount in cents, currency, catalog version and catalog digest —
are stored in the attempt record and covered by the record's HMAC. The check
reads that record; it never trusts a client-supplied amount.

```json
{
  "status": "mismatch",
  "reasons": ["amount_mismatch"],
  "captured": { "value_cents": 1, "currency": "USD" },
  "quoted": { "value_cents": 1900, "currency": "USD", "catalog_version": "1", "catalog_digest": "sha256:..." },
  "delta_cents": -1899,
  "catalog_revision": "ok",
  "quote_id": "q_..."
}
```

- `status` is `mismatch` when the captured amount or currency differs from the
  signed quote, `ok` when they match, and `unchecked` when no comparison is
  possible. `unchecked` reasons include `quote_reference_missing` (no quote id
  in `custom_id`/`invoice_id`), `quote_record_unavailable` (record expired,
  pruned, on another instance or not verifying), `quote_record_incomplete`,
  `quote_id_conflict`, `mixed_capture_currency`, `capture_not_settled`,
  `missing_captured_amount` and `missing_currency`.
- Only `COMPLETED` captures count as captured, matching what the rest of the
  code treats as paid: pending, declined or merely authorized money is
  `capture_not_settled`, never compared as if it had settled. `captured.value_cents`
  sums completed captures, so a multi-capture order is compared with its full
  settled total, not just the first capture.
- `catalog_revision` compares the quote's stored catalog version and digest with
  the catalog loaded now: `ok`, `mismatch` (`catalog_revision_changed`) or
  `unchecked`. A catalog change after the order was created does not make an
  accurately captured payment wrong; it is reported separately from the amount.
- `reconciliation` on an order with no quote metadata is `unchecked`, never
  `ok`. The endpoint still answers 200 and still fulfils a completed order: this
  is a report, not a gate, and it never changes a price, a captured amount, a
  catalog entry or a Shopify price.

## Idempotency

1. The queue is read before any write; an order id already present is skipped.
2. Enqueueing goes through `FulfillmentManager`, which appends a
   `PENDING_DELIVERY` entry; the id remains the idempotency key on the next run.
3. A failure during enqueue is reported in `failed` and is **not** counted as
   enqueued, so the next run retries it.

Tests (`npm run test:reconcile`) cover the dry run, apply, a second run
enqueueing nothing, pre-existing queue entries, explicit ids without search,
unpaid/unknown orders, missing email, search failure, and enqueue failure.

## Draining the queue

Reconciliation finds orders that never reached the queue. It does not retry an
order that reached the queue and then failed delivery, because any line in the
append-only queue used to count as fulfilled. Such an order sat `PENDING_EMAIL`,
`PENDING_ACCESS_SECRET` or `MISSING_PAYER_EMAIL` until someone fixed it by hand.

`scripts/drain-fulfillment.mjs` closes that hole. It reads the latest line per
order id, and for every order that is not `DELIVERED` it re-reads the order from
PayPal and re-runs `fulfillPaidOrder` — the same path the webhook uses. Sending
is deduplicated by the settlement ledger: a second attempt for an order whose
prepayment recorded `email_status: sent` returns that delivery instead of
emailing again, and the drain then marks the queue `DELIVERED` itself so a
ledger-deduplicated order is not retried on every tick. Unpaid orders are
skipped and `--limit` caps one run.

Retries are bounded, so a permanently undeliverable order (rejected address,
missing payer email, missing access secret) is not looked up and re-emailed on
every tick forever. Each failed attempt appends a queue line with
`drain.attempts`, `drain.last_reason` and `drain.next_attempt_at`; the retry
delay doubles from `--backoff-minutes` (default 15) up to six hours, and an
order that is still not due is not even looked up. After `--max-attempts`
(default 5) failures the order becomes `DELIVERY_EXHAUSTED` with an
action-required note: it is never retried automatically again, it is no longer
counted as owed, and the drain and the supervisor report it (`ESCALATED`) so a
human delivers or refunds it.

The queue belongs to the host that runs the webhook, so the drain runs on that
host: the local supervisor (`npm start`) applies the drain after every tick's
audit. The GitHub workflow deliberately does **not** run it — a fresh runner
checkout has no `logs/fulfillment_queue.log`, so the step could only ever report
an empty queue and look like a successful drain. Missing PayPal or email
configuration leaves orders queued instead of losing them, and the doctor
already reports that configuration as a money gap.

When there is no queue file at all, the drain says so (`skipped_run:
queue_missing`) instead of reporting zero pending orders, so a host that cannot
see the queue is never mistaken for a host that delivered everything.

```bash
node scripts/drain-fulfillment.mjs            # dry run: who is still waiting
node scripts/drain-fulfillment.mjs --apply    # deliver them
```

## Limits

Reconciliation only queues delivery; the drain sends the product. Both need live
PayPal credentials with reporting access, and neither moves money. Run them
after the webhook endpoint is reachable so that every path agrees.
