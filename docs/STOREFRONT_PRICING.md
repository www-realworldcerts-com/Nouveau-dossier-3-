# Storefront pricing: audit and deployment patch

## Live audit (2026-11-14)

`https://www.realworldcerts.com` has **302 catalog rows / 298 unique slugs**. Four rows are exact duplicate titles. All 298 course pages returned HTTP 200, **none showed a price**, and every page linked to all four checkout methods without an `amount`.

All four checkout pages compute the amount from the slug:

```js
var fpn = 0;
for (var i = 0; i < slug.length; i++) fpn = (fpn * 31 + slug.charCodeAt(i)) % 10000;
var amtNum = amount ? Number(amount) : (19 + fpn / 10000);
```

The result is a hash artifact, not a price: `certified-blockchain-expert-cbe-preptest-2025` shows `$19.2536`, `financial-risk-manager-test-bank` shows `$19.9965`, and the browser can replace it with `?amount=`. The crypto page separately displayed `(19 + fp / 10000).toFixed(4) + " USDT"`.

## One canonical catalog and price source

`config/course-catalog.json` is the only product source for checkout and
Shopify. It contains every course once, with explicit **USD cents** and one FX
table. There is no separate price book and no MAD tier price on the publishing
path.

```json
{
  "currency": "USD",
  "fulfillment_cost_cents": 200,
  "fx": { "USD": 1, "MAD": 10, "EUR": 0.92 },
  "courses": [
    {
      "slug": "certified-blockchain-expert-cbe-preptest-2025",
      "title": "Certified Blockchain Expert (CBE) preptest 2025",
      "price_cents": 1900,
      "description": "…",
      "image": "/assets/courses/certified-blockchain-expert-cbe-preptest-2025.svg"
    }
  ]
}
```

`data/store-prices.json` is a generated public projection:

```json
{ "currency": "USD", "prices": { "certified-blockchain-expert-cbe-preptest-2025": 19 } }
```

- `src/sales/course-catalog.mjs` validates the catalog and derives checkout
  products, storefront prices, Shopify store-currency amounts and the
  content-addressed catalog digest.
- `src/sales/course-catalog.mjs` is imported directly by checkout and Shopify.
- `/data/store-prices.json` is the server route for static pages.
- `scripts/generate-course-catalog.mjs` imports `data/catalog.json` into the
  canonical file and regenerates the public payload.
- `scripts/audit-storefront-pricing.mjs` repeats the live audit.

Current assumption: **USD 19.00 per course**, with a **USD 2.00** fulfillment
cost. A MAD store receives **190.00 MAD**; a EUR store receives **17.48 EUR**.
Those amounts come from the catalog FX table, not from the retired MAD tier
engine and not from a browser-supplied amount.

Regenerate after a catalog or price change:

```bash
node scripts/generate-course-catalog.mjs
```

Optional flags: `--catalog`, `--out`, `--public`, `--price`, `--currency`,
`--fulfillment-cost-cents`. Existing `price_cents` values are preserved when a
canonical file already exists, so a deliberate price change is not overwritten
by a metadata refresh.

## Deployed source changes

The live static site is not built from this repository. Apply these changes in the repository that deploys `www.realworldcerts.com`.

### 1. Publish the price payload

Serve `data/store-prices.json` at `/data/store-prices.json` on the same origin as the course and checkout pages. It is public product data; the charge is enforced server-side.

### 2. Show the price on course pages

Add one element to the course template and populate it by slug. Set `data-course-slug` on `<html>` when generating each page.

```html
<p data-course-price>Loading price…</p>
<script>
  (function () {
    var slug = document.documentElement.dataset.courseSlug;
    var el = document.querySelector('[data-course-price]');
    fetch('/data/store-prices.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('price table unavailable'); return r.json(); })
      .then(function (table) {
        var price = Number(table.prices && table.prices[slug]);
        if (!Number.isFinite(price) || price <= 0) throw new Error('price missing');
        el.textContent = '$' + price.toFixed(2) + ' ' + table.currency;
      })
      .catch(function () {
        el.textContent = 'Price unavailable — checkout disabled';
        document.querySelectorAll('a[href*="/checkout/"]').forEach(function (a) {
          a.setAttribute('aria-disabled', 'true');
          a.addEventListener('click', function (event) { event.preventDefault(); });
        });
      });
  }());
</script>
```

Do not fall back to `19` when the lookup fails.

### 3. Replace the formula on all four checkout pages

Files or their templates: `checkout/paypal.html`, `checkout/payoneer.html`, `checkout/crypto.html`, `checkout/bank.html`.

Remove `const amount = q.get("amount")`, the `fpn` block, and `19 + fpn / 10000`. Disable submit until the lookup finishes:

```js
var amtNum = null;
var priceReady = false;
var payButton = document.getElementById('pay-button'); // use the page's real submit button

if (payButton) payButton.disabled = true;
amt.textContent = 'Loading price…';

fetch('/data/store-prices.json', { cache: 'no-store' })
  .then(function (response) {
    if (!response.ok) throw new Error('price table unavailable');
    return response.json();
  })
  .then(function (table) {
    var price = Number(table.prices && table.prices[slug]);
    if (!Number.isFinite(price) || price <= 0) throw new Error('price missing for ' + slug);
    amtNum = price;
    priceReady = true;
    amt.textContent = '$' + price.toFixed(2);
    if (payButton) payButton.disabled = false;
  })
  .catch(function (error) {
    amt.textContent = 'Price unavailable — payment disabled';
    if (payButton) payButton.disabled = true;
    console.error(error);
  });
```

On the crypto page display `price.toFixed(2) + ' USDT'`. The submit handler must require `priceReady` and send the resolved `amtNum`; it must not treat a browser-supplied amount as authoritative.

### 4. Enforce the price on the server

The page lookup only fixes what the customer sees. The payment-intent endpoint must resolve the slug through the price map and never use a posted amount as the charge. In this repository:

- `src/paypal-webhook-server.mjs` reads `config/course-catalog.json`.
- `/buy` renders server-owned products and posts the amount/currency it displayed.
- `/buy` first requests a short-lived signed quote from `/acp/v1/price-quote?product_id=...`, binding the product, amount, currency, catalog version and content-addressed catalog digest.
- `/acp/v1/transactions` requires a known `product_id` and charges `product.price`; a missing, expired or mismatched quote, or a posted `amount`/`currency` that does not match the catalog, is rejected with `409 PRICE_CHANGED` before PayPal is called. The quote ID and catalog version are stored in PayPal `custom_id`; the catalog digest is stored in `invoice_id` so reconciliation can prove the exact catalog revision. A quote is idempotent per checkout attempt: replaying it returns the original PayPal order, and the order-create request uses a deterministic `PayPal-Request-Id` to suppress duplicate orders across retries. The attempt is keyed by the quote id, never by the cart it sells: the quote carries no buyer identity (every customer buying a course gets the same product, amount, currency and redirect URLs), so a cart-keyed attempt would hand the next buyer the previous buyer's order and approval link. A second quote for the same cart is therefore a separate attempt, while a page reload that keeps its quote still replays the original order. The quote also binds the allowed `/buy/success` and `/buy/cancel` URLs on a configured checkout origin; a transaction that tries to change either redirect is rejected with `409 QUOTE_REDIRECT_MISMATCH` before PayPal is called. If another instance is still creating the order for that quote, the endpoint answers `409 CHECKOUT_IN_PROGRESS` with `retryable: true` and a `retry_after_ms` hint instead of a `500`; the page should keep the quote and retry the identical request after that delay, which then replays the published order.
- At most 60 checkout attempts per client address per 10 minutes are accepted; beyond that `/acp/v1/transactions` answers `429 CHECKOUT_RATE_LIMITED` (retryable, with `retry_after_ms` and `Retry-After`) before any quote check or PayPal call. Replaying an existing quote counts as an attempt but creates no order. `CHECKOUT_RATE_LIMIT_MAX` and `CHECKOUT_RATE_LIMIT_WINDOW_MS` tune the limit (`0` disables it); the counter is per process and keyed by client address, so buyers behind one NAT share an allowance.
- `/acp/v1/transactions/:id/capture` captures the server-created order.
- `npm run reconcile:paypal` compares captured orders with the catalog in a read-only report and never changes a price.

The deployed static checkout must call an equivalent server-owned endpoint.

### 5. Deploy and verify

Deploy the static site and `/data/store-prices.json` together, then purge `/catalog/*` and `/checkout/*`.

1. `/data/store-prices.json` returns 298 slugs and `USD`.
2. A course page shows `$19.00`; its source has no `fpn` or `19 +`.
3. All four checkout pages show the same amount for the same slug.
4. A stale displayed amount is rejected with `409 PRICE_CHANGED` before a PayPal order exists.
5. An unknown slug shows “Price unavailable” and cannot submit.
6. A capture creates a `$19.00` capture, credits revenue, prepays fulfillment, and sends the access email.
7. `shopify:price-audit` reads the buyer edge route, a cache-busted edge route and a validated public-HTTPS `CHECKOUT_PRICE_ORIGIN_URL` on a host distinct from the CDN. DNS must also prove the origin is not a CDN alias: it must not CNAME to the CDN host, share its CNAME target, or share its A/AAAA address; DNS failures, shared infrastructure, and private/loopback addresses are unchecked; the verified origin and buyer-facing CDN addresses are pinned into manual-redirect HTTPS requests, so DNS cannot change between proof and fetch and a 3xx is rejected instead of followed. All views agree, the cache-busted edge proves a cache miss (`MISS`/`BYPASS`/`DYNAMIC` with no positive `Age`), the report includes the canonical `catalog_digest`, the origin is not redirected/protected/SSO/HTML/cache-hit, and no edge/origin stale marker is reported.

## Known limitations

- No live PayPal/Resend credentials or deployment access were available, so no live payment or email was tested.
- The source snapshot has four duplicate rows; the canonical catalog contains each of the 298 unique slugs once.
- `SETTLEMENT_LEDGER_PATH` and `FULFILLMENT_QUEUE_FILE` need durable writable storage; a Vercel function's local filesystem is ephemeral.
- Durable replay protection comes from a shared `CHECKOUT_ATTEMPT_STORE_DIR`, or, with no directory configured, from the quote-bound `PayPal-Request-Id` on a serverless runtime (a retry inside the quote's lifetime returns the same order), so a serverless deploy keeps taking orders without extra configuration. When a directory is configured the measured storage decides rather than the runtime marker: a network mount is used, and instance-local storage is refused in production with `503 CHECKOUT_ATTEMPT_STORE_INSTANCE_LOCAL`, as is an unset directory with `503 CHECKOUT_ATTEMPT_STORE_NOT_DURABLE` on a non-serverless host. `CHECKOUT_REPLAY_PROTECTION=provider|store` overrides the fallback explicitly. The webhook is not blocked, so money already taken is still recorded and delivered. `npm run doctor:money` reports the same rule.
- `CHECKOUT_ATTEMPT_STORE_DIR` must point at the same durable, writable directory for every checkout instance (the config check and `/health` probe it by writing and removing a file); otherwise quote replay protection is per process and a restart can create a second order for a reused quote. At startup the server sweeps expired records, abandoned claim locks and truncated temp files older than the stale window from that directory. Records are HMAC-signed with `CHECKOUT_ATTEMPT_SIGNING_SECRET` (falling back to the resolved price quote signing key); a record whose signature does not verify is treated as absent, so write access to the store cannot swap an order id that a replay would return. Rotating the signing key leaves old records unverifiable for the rest of their TTL, but the retry reuses the same deterministic `PayPal-Request-Id`, so PayPal returns the existing order rather than creating another. The config check and `/health` report `config.checkout_attempts.signed`, and a configured directory with neither secret raises `checkout_attempt_store_unsigned` so an unsigned store cannot be mistaken for a signed one.
