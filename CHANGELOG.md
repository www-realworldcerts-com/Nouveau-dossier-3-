# Changelog

## 2026-11-17
- Required the cache-busted edge read to prove it was a cache miss. The audit
  accepts explicit `MISS`/`BYPASS`/`DYNAMIC` cache status with no non-zero
  `Age`; a `HIT`/`STALE`/`REVALIDATED` status, a positive `Age`, or missing
  cache-miss evidence marks edge freshness unchecked instead of clean.
- Added a synthetic, read-only quote audit to `shopify:price-audit`. It requests
  a quote for every catalog product and checks the quoted amount, currency,
  catalog digest, expiry, product and bound return/cancel URLs. A wrong quoted
  amount is reported as price drift; an unavailable or contract-breaking quote
  path makes the audit unchecked, so quote regressions cannot leave it green.
- Added key IDs to signed price quotes. `PRICE_QUOTE_KEY_ID` names the current
  signing key, and `PRICE_QUOTE_PREVIOUS_KEY_ID`/`PRICE_QUOTE_PREVIOUS_SECRET`
  let quotes signed before a rotation continue to verify for their short TTL.
  Legacy quotes without a key ID are tried against both keys. The fulfillment
  access secret is no longer a quote-secret fallback outside
  `NODE_ENV=development`.
- Pinned the DNS-verified origin address through the HTTPS origin request, so a
  DNS change between verification and fetch cannot redirect the audit to another
  host. Origins or buyer-facing CDN hosts resolving to private IPv4/IPv6
  addresses (including loopback and IPv4-mapped forms) are reported as unchecked
  and are never fetched.
- Bound PayPal return and cancel URLs into signed price quotes. `/acp/v1/price-quote` accepts optional `return_url`/`cancel_url`, requires HTTPS and the exact `/buy/success` and `/buy/cancel` paths, and only allows configured checkout origins (`STOREFRONT_URL`, `CHECKOUT_PRICE_ORIGIN_URL`, or the PayPal URL origins). `/acp/v1/transactions` uses the signed URLs and rejects a replayed quote whose body redirects differ with `409 QUOTE_REDIRECT_MISMATCH` before PayPal is called. Quotes without redirect binding are rejected; `/buy` now includes its success and cancel URLs in the quote request.
- Made each price quote idempotent per checkout attempt. Replaying a quote now
  returns the PayPal order created by the first request instead of creating a
  second one, concurrent replays share one in-flight creation, and a deterministic
  `PayPal-Request-Id` deduplicates retries handled by another serverless instance.
  Failed creations release the attempt for retry, while `/buy` reuses its quote
  after a lost response and refreshes only after expiry or catalog rejection.
- Strengthened the price audit's origin proof with DNS. The configured origin
  must not resolve through the buyer-facing CDN host, share its CNAME target, or
  share its A/AAAA address. DNS failures, unresolvable hosts and shared
  infrastructure are reported as unchecked, and the unverified origin is never
  fetched.
- Hardened the price audit's direct-origin check. `CHECKOUT_PRICE_ORIGIN_URL`
  must now be a public HTTPS URL for `/data/store-prices.json` on a host distinct
  from the buyer-facing CDN; non-HTTPS or malformed URLs, credentials, queries,
  fragments, private hosts, CDN/`www` aliases and unexpected paths are rejected
  before fetching. The origin request is made without following redirects and
  rejects protection/SSO responses (401/403/407/511, auth headers/cookies, login
  pages), HTML, redirects and CDN cache hits. Any unverifiable origin keeps the
  audit `unavailable` (`SHOPIFY_PRICE_DRIFT_UNCHECKED`) instead of allowing a
  clean result from the edge alone.
- Added signed, short-lived checkout price quotes. `/acp/v1/price-quote` binds
  the product, amount, currency, catalog version and content-addressed catalog
  digest into a signed, expiring token; `/acp/v1/transactions` now requires that
  token and rejects a missing, expired, tampered or catalog-mismatched quote
  with `409 PRICE_CHANGED` before calling PayPal. `/buy` fetches a fresh quote
  immediately before ordering. The quote ID and catalog version are stored in
  the PayPal order's `custom_id`, and the catalog digest is stored in
  `invoice_id`; reconciliation reports catalog revision matches, mismatches and
  unchecked legacy orders. Reconciliation also reports missing, malformed and
  stale quote metadata without changing prices; genuine pre-quote orders can be
  allowlisted by id or by `PAYPAL_QUOTE_REQUIRED_AFTER`, and the silent-failure
  audit raises `PAYPAL_QUOTE_METADATA_DRIFT` for the rest. The endpoint fails closed when
  `PRICE_QUOTE_SECRET` is not configured; `FULFILLMENT_ACCESS_SECRET` is only a
  fallback in development.
- Added a read-only Shopify price-drift audit (`shopify:price-audit`) that
  compares the canonical catalog, the public checkout payload and live Shopify
  variant/presentment prices. It raises `SHOPIFY_PRICE_DRIFT` through the
  silent-failure protocol when they diverge and
  `SHOPIFY_PRICE_DRIFT_UNCHECKED` when a source cannot be read; it never writes
  to Shopify or changes a price. High-severity drift now requires a comparable
  amount to differ and is grouped by affected course instead of per variant or
  presentment row; missing FX, missing listings, currency gaps and unreadable
  sources are unchecked. The audit now reads the exact buyer-facing edge route
  without a cache buster, the same edge route with a cache-busting nonce, and a
  direct origin route configured by `CHECKOUT_PRICE_ORIGIN_URL`; the report
  includes the canonical `catalog_digest`, and it marks
  `edge.stale_vs_fresh`, `edge.differs_from_origin` and
  `origin.differs_from_fresh`, and fails closed when the origin is missing or
  unreadable. The post-tick silent-failure run enables it
  automatically when a Shopify store domain and Admin token are configured,
  including the scheduled GitHub Actions audit. Silent-failure state now keeps a
  stable fingerprint per drift with independent first-seen/escalation state,
  reports newly added drifts separately, and records resolved drifts only after
  a complete audit; an unavailable audit leaves prior drifts open.
- Added a purchase-time price invariant: the checkout posts the amount and
  currency it displayed, and `/acp/v1/transactions` rejects a stale value with
  `409 PRICE_CHANGED` before creating a PayPal order. It still charges only the
  canonical catalog price.
- PayPal reconciliation now compares every captured order amount with the
  canonical catalog and raises `PAYPAL_ORDER_PRICE_DRIFT` for a mismatch. It is
  read-only and never changes catalog, Shopify or PayPal prices.
- Added `checkout:browser-audit`: a Playwright probe that loads the exact `/buy`
  page on the buyer edge, a cache-busted edge and the direct origin, reads the
  displayed price, intercepts the checkout POST before PayPal, and verifies the
  POSTed amount and currency. A stale page or missing POSTed amount is drift;
  the probe never creates an order or moves money.

## 2026-11-16
- `shopify:publish` now fails closed before any write when a selected active
  product's price differs from the canonical catalog. `--dry-run` evaluates the
  same guard, lists each current → target price and exits non-zero when a real
  publish would be blocked; without Admin credentials it marks the check
  skipped instead of implying the guard passed.
- Added `shopify:reprice` for active prices: it takes the shared catalog
  mutation lock, snapshots every prior variant price, updates only active
  single-variant products, verifies the result and restores the whole snapshot
  on failure. `--rollback <run-id|latest>` restores a completed run, and
  refuses to overwrite a price changed outside that run. After rollback it
  re-reads every snapshotted variant and reports `rollback_price_mismatch` if
  any price did not return to its original value.
- The Shopify launch gate now resolves the primary market for country,
  currency and tax mode, requires a complete canary delivery address, and
  validates canary availability, shipping, tax and totals against that market.
  Added the `read_markets` scope and the canary address variables.
- Updated production dependencies within their existing ranges to clear six
  audit advisories, including critical `proxy-addr` IP spoofing and high
  `body-parser`, `path-to-regexp` and `ws` issues.

## 2026-11-14
- Added AES-256-GCM encryption at rest for financial JSON fields (IBANs, RIBs,
  bank/account numbers, recipient identities, emails, phones) and encrypted
  backup directories/manifests. Keys come only from
  `DATA_ENCRYPTION_KEY`/`DATA_ENCRYPTION_KEY_FILE`; rotation is supported with
  a previous-key ring.
- Payout and settlement ledgers now encrypt on write and decrypt on read. A
  missing/wrong key on encrypted history fails closed instead of making payout
  history look empty.
- Added dry-run-first migration, rollback and rotation commands in
  `scripts/encrypt-sensitive-data.mjs`, plus encrypted backup/restore tooling.
  Existing committed plaintext still requires an operator-run migration and
  rotation of exposed account details; see `docs/DATA_AT_REST.md`.

## 2026-11-13
- JARVIS chat is now local-first: set `JARVIS_LOCAL_BASE_URL` to use a Strata or
  other OpenAI-compatible endpoint. Cloud use is an explicit opt-in fallback, not
  a silent one, and search/image tools still use ZAI when available.
- Added per-request privacy masking for secrets, tokens, private keys, emails,
  IBANs, Luhn-valid cards, long bank account numbers and Moroccan phone numbers.
  Values get stable placeholders before leaving the server and are restored only
  in the reply; the map is never logged or persisted.
- JARVIS now follows evidence guardrails inspired by Bonsai: prompts distinguish
  observed/search/user-supplied/unknown data, generated documents are marked
  `DRAFT` with no authorization or payment-confirmation codes, and the chat no
  longer claims actions that no tool performed.
- `/api/jarvis/status` derives real runtime state from heartbeat, findings,
  contentieux, procurement and payout files instead of reporting hardcoded
  "online"; missing or stale evidence is `unknown`/`blocked`. The status bar
  consumes it.
- Fixed the standalone build root so `bun run build` and `bun run start` produce
  and serve `.next/standalone/server.js` (Docker also expects this path).
- Added a dry-run-first procurement bootstrap importer for existing orders and
  AMANA scan files (`npm run procurement:import`). It backdates creation and
  placement, matches evidence by PO/tracking, and leaves invalid or missing
  PODs on hold instead of fabricating delivery proof.
- Wired procurement contentieux into the tick audit: every written audit raises
  `PROCUREMENT_CONTENTIEUX` with case IDs, amount at stake, oldest aging and hold
  codes, and persists `data/resilience/contentieux.json` for JARVIS.
- JARVIS now serves the contentieux report at `/api/jarvis/contentieux` and shows
  case IDs, amounts, aging, severity and holds above the swarm agents.
- Added a persistent payout ledger: every CSV export reserves both `earning_id`
  and `item_id`, checks the ledger plus all historical payout batches, and
  refuses a duplicate export. Payouts move through submitted/credited/failed/
  returned, with `--mark-credited` for manual settlement.
- Added Attijari/Payoneer statement import (`npm run import:payout-statement`)
  with reference-first matching, amount/date fallback only when unique,
  idempotent fingerprints, and fee, net amount, FX rate and FX difference
  recorded per settlement.
- Added procurement contentieux case files (`npm run contentieux`): late or held
  POs become `CTX-<po_ref>` cases with amount at stake, hold meanings, an
  evidence checklist and a next action. The report is read-only and never
  fabricates a POD, receipt or invoice.
- Attijari bank-wire export no longer hardcodes Windows paths or the owner's
  account: batch/account come from flags or environment, the account is masked,
  and amounts, currency and references are validated. `--dry-run` validates
  without writing. `docs/ATTIJARI_CONTENTIEUX.md` records that bulk CSV upload
  needs Attijari Entreprise, so a personal account must use unit transfers.
- Storefront capability probe now runs against `https://www.realworldcerts.com` by default
  (`STOREFRONT_URL` / `--storefront-url` override) and raises
  `STOREFRONT_NOT_TRANSACTIONAL` only when an origin 200 proves a static build
  with no application runtime or API route.
- Probe recognises `/api/healthz`, `/health` and the webhook route, so a deployed
  plain-HTML app is no longer misreported as static; transient 5xx on health
  stays a warning.
- Transport failures (DNS, timeout, 502/503/504 after bounded retries) downgraded to
  `STOREFRONT_UNREACHABLE` warnings; unexpected origin status is
  `STOREFRONT_HTTP_ERROR`; a `warning` severity rank was added.
- Local supervisor (`scripts/auto-restart-loop.js`) runs the silent-failure audit
  after every tick, matching the CI sentinel; `SWARM_TICK_AUDIT=false` disables it.
- PayPal reconciliation dry run runs from the tick audit and raises
  `PAYPAL_UNFULFILLED_ORDERS` for captured-but-unfulfilled orders;
  `PAYPAL_RECONCILIATION_UNAVAILABLE` covers missing credentials.
- PayPal API calls cache access tokens with early refresh, force one refresh and
  replay on 401, and include the error `name` and `debug_id` in thrown errors.
- Webhook server can run as a Vercel function: handler export, no port binding
  under `VERCEL`, `api/index.mjs` entry point and path-scoped rewrites that keep
  the static storefront intact.
- Webhook raw-body reader prefers streamed bytes, falls back only to exact
  buffered bytes, and fails closed on a pre-parsed body, preserving signature
  verification input.
- Added `docs/PAYPAL_PERMANENT_SOLUTIONS.md`, `docs/VERCEL_NODE_DEPLOY.md`, and
  tests for the storefront probe, tick audit, deployment wrapper and PayPal API
  controls (`npm run test:deploy`, `npm run test:reconcile`).

## 2026-01-05
- Added on-chain verification support in ProofValidator via ChainVerifier (USDT on BSC).
- Integrated 72h Settlement SLA auto-fail pre-check in OwnerSettlementEnforcer.
- Enhanced owner settlement enforcement to queue on Bunker Mode or missing credentials and approve only after proof validation.
- Added Payoneer primary bank destinations:
  - UK: Barclays (Sort code 231486, Account 15924956)
  - Japan: MUFG (Bank code 0005, Branch 869, Account 4671926)
  - EU: Banking Circle (IBAN LU774080000041265646, BIC BCIRLULL)
- Updated owner allowlist to include Payoneer bank references.
- Tests added for SLA enforcement and owner settlement verification paths.
- Added consolidated Control Panel script to chain validation, billing, audit, reconcile, auto/run, emergency payout, and repair actions with console-format status prints.
- Enforced global owner lock guard in orchestrator; added hard-binding toggles and directive validation.
- Live configuration helpers:
  - .env.example with secure keys (no secrets committed)
  - set-live-modes script to toggle SWARM_LIVE and payout modes
  - PayPal payout+sync script to produce provider proof and mark paid_out when credentials are present
- Updated Owner Revenue Directive mapping sequence:
  - Redirected PayPal and Stripe settlements to Bank (Attijari) due to country restrictions.
  - Added comprehensive crypto (Trust Wallet, Bybit ERC20/TON) and secondary Payoneer accounts to owner policy.
  - Consolidated OWNER_ALLOWLIST with all active destinations.
- Implemented PSP webhook handler skeletons and unified proof validators:
  - PayPal signature verification and event mapping
  - Stripe endpoint signature validation
  - Payoneer HMAC verification
  - Bank Wire reference normalization
- Added append-only HMAC-signed audit logger with chain verification and integrated it into SystemAuditLogger.
- Exposed External Payment Gateway Integration for agents:
  - Programmatic API: requestAutoSettlement, requestPayPalPayout, updatePayoutStatus, getGatewayBalance
  - Internal HTTP service with secured endpoints for agent access
- Wet-run deployment validated locally; audit entries are written via append-only logger; endpoints started under AGENT_API_PORT.
