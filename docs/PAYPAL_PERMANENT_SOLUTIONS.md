# PayPal: permanent solutions, not one-off repairs

Status: design + implemented transport controls. Owner-gated items are marked.

## What the two links actually establish

- `paypal-hack-chicago.devpost.com` is a **closed 2019 event** (Oct 11–12, 2019,
  Merchandise Mart, Chicago; eligibility was full-time Chicago-area college
  students). It ended and has no current submission window, so it is not a
  route to revenue or support.
- `developer.paypal.com/platforms/troubleshoot` is client-rendered; its content
  is not fetchable as text. The durable rules below come from PayPal's API and
  webhook documentation instead.

## PayPal's hard constraints (from official docs)

1. A webhook listener must answer **2xx**; any other status (or no connection)
   makes PayPal retry **up to 25 times over 3 days**, then mark the delivery
   `Failed`. Failed deliveries can be resent manually from the Webhook Events
   dashboard.
   <https://developer.paypal.com/api/rest/webhooks/>
2. Verification is mandatory in practice: either CRC32 signature verification
   or the `verify-webhook-signature` endpoint. Without it, a sender cannot be
   proven to be PayPal.
3. A returned non-2xx (404/500) means the **listener or its web server** is
   wrong, not PayPal. No response at all points at DNS, port 443 blocking or
   domain reputation.
4. API failures carry `debug_id`; support needs it. 4xx are deterministic and
   must not be retried; 429/5xx are retryable with backoff.
   <https://developer.paypal.com/api/rest/responses>
5. Repeated 401s mean the token lifecycle is wrong: refresh before expiry.
   <https://developer.paypal.com/api/handle-api-responses>

## Failure classes observed here, and the permanent control

| Failure | Root cause | Permanent control | Status |
| --- | --- | --- | --- |
| `POST /api/webhooks/paypal` → 404 on the live domain | Vercel deploys a static directory with no API routes | Deployment-topology probe (`STOREFRONT_NOT_TRANSACTIONAL`) + webhook probe run every tick; deploy an app build at the domain | Detection implemented; deployment owner-gated |
| Preview hosts answer 401 | Vercel Authentication protects the deployment | Protection bypass for the webhook path or a dedicated public host | Owner-gated |
| Paid orders never fulfilled | Missed/failed webhook beyond 3-day retries | Dry-run reconciliation every tick raises `PAYPAL_UNFULFILLED_ORDERS`; `--apply` replays idempotently through the existing queue | Implemented |
| Duplicate deliveries from retries | PayPal retries until 2xx | Idempotency by order id in the fulfilment queue; webhook dedupe store | Implemented |
| 401 spikes / rate pressure | A new access token per request | Token cache with early refresh + one forced refresh on 401 | Implemented in `src/paypal-api.mjs` |
| Support cannot trace a failure | Error body discarded | `debug_id` and error `name` surfaced in thrown messages | Implemented in `src/paypal-api.mjs` |
| Slow handler exhausts retries | Processing (DB writes) happens before the 2xx | Acknowledge after signature verification and enqueue; process asynchronously | Recommended, not implemented |
| Account limited/restricted | Compliance, not code | Resolve with PayPal; no code path can bypass it | Owner-gated |

## Architectural rules that make fixes permanent

1. **Verify, then enqueue, then acknowledge.** The listener's only synchronous
   work should be signature verification and a durable write. Everything else
   runs behind the queue. This keeps the 2xx inside PayPal's timeout and makes
   the 25 retries harmless.
2. **One source of truth.** The fulfilment queue is the record; reconciliation
   compares PayPal's captured orders against it. Never introduce a second
   ledger.
3. **Idempotency at the edge.** The order id is the key; replays and duplicate
   webhooks converge to one fulfilment.
4. **Reconciliation is the backstop, not the primary path.** Webhooks are
   best-effort even when correct; a periodic dry run is what turns a missed
   delivery into an alarm instead of silent revenue loss.
5. **Probe the deployment, not the intention.** A CI job that only runs unit
   tests cannot see that the domain serves static HTML. Reachability, route and
   capability probes belong in every tick.
6. **Separate transport from state.** A DNS blip is not a broken build; retries
   and `warning` severity keep the critical signal meaningful.

## Operating the debugging path

When a PayPal call fails:

1. Read the thrown message: it now includes HTTP status, error `name` and
   `debug_id`.
2. Use `debug_id` with PayPal support or the developer dashboard; do not retry
   4xx.
3. For webhooks, check the Webhook Events dashboard for the delivery status and
   resend failed events after the listener is fixed.
4. Run `npm run reconcile:paypal` (dry run) to see what is still missing, then
   `--apply` to replay.

## Verification

```bash
node --test test/paypal-api.test.mjs        # token cache, 401 refresh, debug_id
npm run test:reconcile                      # idempotent replay logic
npm run test:resilience                     # probes and findings
node scripts/silent-failure.mjs audit --fail-on high
```

The live audit is expected to keep reporting the deployment findings until the
domain actually serves the application; those are real, not noise.

## What is still owner-gated

- Point the Vercel project that owns `www.realworldcerts.com` at a build that
  contains the webhook route (see the deployment notes), or host the webhook on
  a public Node host and route to it.
- Provide PayPal credentials (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`,
  `PAYPAL_WEBHOOK_ID`) to the running deployment.
- Resolve any account limitation directly with PayPal.

No code in this repository can cross those account boundaries.
