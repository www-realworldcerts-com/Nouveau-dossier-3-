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

## One explicit price source

`config/course-prices.json` is canonical:

```json
{
  "currency": "USD",
  "fulfillment_cost_cents": 200,
  "prices": {
    "certified-blockchain-expert-cbe-preptest-2025": {
      "name": "Certified Blockchain Expert (CBE) preptest 2025",
      "price": 19
    }
  }
}
```

`data/store-prices.json` is the generated public payload:

```json
{ "currency": "USD", "prices": { "certified-blockchain-expert-cbe-preptest-2025": 19 } }
```

- `src/sales/store-prices.mjs` validates the file and serves products/prices.
- `/data/store-prices.json` is the server route for static pages.
- `scripts/generate-course-prices.mjs` regenerates both files.
- `scripts/audit-storefront-pricing.mjs` repeats the live audit.

Current assumption: **USD 19.00 per course**, with a **USD 2.00** fulfillment cost. This is explicit and editable. The old formula ranged `$19.0000–$19.9999`, so `$19.00` is a reduction of up to `$0.9999` per sale.

Regenerate after a catalog or price change:

```bash
node scripts/generate-course-prices.mjs
```

Optional flags: `--catalog`, `--price`, `--currency`, `--fulfillment-cost-cents`.

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

The page lookup only fixes what the customer sees. The payment-intent endpoint must resolve the slug through the price map and ignore any posted amount. In this repository:

- `src/paypal-webhook-server.mjs` reads `config/course-prices.json`.
- `/buy` renders server-owned products.
- `/acp/v1/transactions` requires a known `product_id` and charges `product.price`; posted `amount` and `currency` are ignored.
- `/acp/v1/transactions/:id/capture` captures the server-created order.

The deployed static checkout must call an equivalent server-owned endpoint.

### 5. Deploy and verify

Deploy the static site and `/data/store-prices.json` together, then purge `/catalog/*` and `/checkout/*`.

1. `/data/store-prices.json` returns 298 slugs and `USD`.
2. A course page shows `$19.00`; its source has no `fpn` or `19 +`.
3. All four checkout pages show the same amount for the same slug.
4. `?amount=0.01` is ignored and the server creates a `$19.00` order.
5. An unknown slug shows “Price unavailable” and cannot submit.
6. A capture creates a `$19.00` capture, credits revenue, prepays fulfillment, and sends the access email.

## Known limitations

- No live PayPal/Resend credentials or deployment access were available, so no live payment or email was tested.
- The four duplicate catalog rows need catalog cleanup; the price map contains each unique slug once.
- `SETTLEMENT_LEDGER_PATH` and `FULFILLMENT_QUEUE_FILE` need durable writable storage; a Vercel function's local filesystem is ephemeral.
