# Autonomous Sales Agent

Closes the engineering half of the revenue chain described in the
`Autonomous_Pricing_Blueprint`: **price the catalog → publish to Shopify →
observe checkout intent → reprice from evidence**. It is a Node module
(`src/sales/`) with an append-only ndjson job store, so no database or extra
service is required. Stack deviation from the blueprint: the LLM valuation
worker is called directly over the OpenAI-compatible HTTP API instead of a
separate Python LangGraph process, which removes the second runtime without
changing the node contracts.

## Control loop

| Node | What it does | Output |
| --- | --- | --- |
| `recon` | Reads the catalog, classifies tiers, counts unpriced courses and exception candidates | `CatalogManifest.ndjson` |
| `gen_matrix` | Tier-map prices for the bulk; LLM valuation for exceptions; applies self-improve hints | `PriceMatrix.ndjson` |
| `triage` | Tier bounds, MAD rounding, duplicates, reasoning-trace presence | `TriageReport.ndjson` |
| `assemble` | Merges passing prices into the publishable matrix | `FinalPriceMatrix.ndjson` |
| `approval_gate` | Writes `REQUEST.json`; rules-priced courses auto-approve, LLM/self-improve prices wait for `decision.json` | `REQUEST.json` / `decision.json` |
| `publish` | Appends prices to `prices.ndjson`, upserts Shopify products idempotently, checks the password gate | `PublishReport.ndjson` |
| `self_improve` | Joins intents + views + orders, flags repricing candidates for the next run | `RepricingCandidates.ndjson` |

State lives in `data/sales/jobs/<job_id>/`. Re-running with `--job <id>`
resumes from the files on disk; nothing is held in memory between runs.

## Quick start

```bash
# 1. Price the catalog and see the proposed matrix (no writes to Shopify)
node scripts/sales-agent.mjs price --catalog catalog.ndjson --mock

# 2. Run the loop: rules prices publish, exceptions wait for review
node scripts/sales-agent.mjs run --catalog catalog.ndjson

# 3. Review and approve the exceptions
node scripts/sales-agent.mjs approve <job_id> --all
node scripts/sales-agent.mjs resume <job_id> --catalog catalog.ndjson

# 4. Instrument and read the funnel
node scripts/sales-agent.mjs intent --course crs_204 --price 1500 --referrer "https://google.com/"
node scripts/sales-agent.mjs funnel --days 30
node scripts/sales-agent.mjs status --catalog catalog.ndjson

# 5. Weekly repricing pass
node scripts/sales-agent.mjs self-improve --catalog catalog.ndjson --days 30
```

`--mock` disables all network calls (Shopify skipped, deterministic valuation
fallback) while still exercising the full loop — use it for the end-to-end smoke
test.

## Catalog format

One course per ndjson line (or a JSON array / `{ "courses": [...] }`):

```json
{"course_id":"crs_204","title":"ACCA Financial Reporting — Advanced","exam_board":"ACCA","level":"advanced","duration_hours":90,"price_mad":null,"price_status":"quote_required","description":"..."}
```

`tier` is optional; when absent it is inferred from title keywords. Pricing
tiers, bounds, exception patterns, rounding and self-improve thresholds live in
[`config/pricing.json`](../config/pricing.json).

## Pricing decision engine

* Rules: tier baseline, clamped to the tier's min/max, rounded per blueprint
  Appendix C (nearest 50 MAD below 2000, nearest 100 MAD at or above).
* Exceptions (premium exam board, premium title, out-of-band default tier,
  awkward rounding) go to the LLM worker with the Appendix A prompt. Answers
  outside tier bounds or with an insufficient reasoning trace are rejected and
  retried up to 3 times, then fall back to a deterministic price flagged
  `needs_review`.
* Only `rules`-sourced prices auto-approve (`AUTO_APPROVE_RULES=false`
  disables). LLM, fallback and self-improve prices always require a founder
  `decision.json`; the gate normalizes `approve`/`approved`/`yes` so a stalled
  request cannot loop forever.

## Observability

`src/sales/intent-tracker.mjs` is dependency-free; import it from the site's
checkout route:

```js
import { buildCheckoutIntent, appendIntent } from './src/sales/intent-tracker.mjs';

const intent = buildCheckoutIntent({
  courseId: course.id,
  priceMad: course.price_mad,
  priceEur: course.price_eur,
  sessionId: cookies.get('sid'),
  referrer: request.headers.get('referer'),
  source: 'crypto_checkout'
});
appendIntent(intent, 'data/sales/course-intents.ndjson');
```

Schema: `event`, `timestamp`, `session_id`, `course_id`, `price_mad`,
`price_eur`, `source`, `referrer` (normalized to direct/google/meta/tiktok/
linkedin/youtube/whatsapp/referral). `funnelSummary()` returns counts for
`page_view`, `course_view`, `checkout_intent`, `paid_order`, intent→paid rate,
and per-course / per-referrer breakdowns. Views used by `self_improve` come
from `data/sales/course-views.ndjson` (`{course_id, views}`); paid orders from
`data/sales/orders.ndjson`.

## Environment

| Variable | Purpose |
| --- | --- |
| `CATALOG_PATH` | Catalog ndjson/json when `--catalog` is not passed |
| `SALES_PRICING_CONFIG` | Alternative pricing config path |
| `SALES_DATA_DIR` | State directory (default `data/sales`) |
| `SALES_AGENT_MOCK=true` | Force mock mode |
| `AUTO_APPROVE_RULES=false` | Hold even rules-priced courses for review |
| `OPENAI_API_KEY` | LLM valuation key (never logged; falls back deterministically when absent) |
| `SALES_LLM_BASE_URL`, `SALES_LLM_MODEL` | OpenAI-compatible endpoint and model |
| `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ADMIN_TOKEN` | Shopify Admin API publishing. Token is redacted from every error and report |

Until `SHOPIFY_ADMIN_TOKEN` is present, `publish` writes prices to
`data/sales/prices.ndjson` and records `shopify.status = skipped` with a warning,
so the catalog is priced before the storefront exists. If the Shopify password
gate is detected, `PublishReport` carries a loud warning: a buyer would hit a
password page, not the catalog.

## Tests

```bash
node --test test/sales.test.mjs
```

Covers MAD rounding, tier resolution, exception patterns, prompt/JSON
validation with retries, catalog merging, intent schema and funnel math,
idempotent Shopify create/update, decision-vocabulary normalization, and the
full mock loop including triage blocking and the self-improve hint path.
