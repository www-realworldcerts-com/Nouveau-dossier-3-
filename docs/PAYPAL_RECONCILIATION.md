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
