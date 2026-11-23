# Changelog

## 2026-11-23
- `/health` now reports `money_readiness`: whether this deployment can quote,
  create, capture and deliver a paid order, field by field
  (`quote_key`, `order_create`, `capture`, `fulfillment`, `resend`) plus the
  `missing` variable names and a single `can_take_paid_order` verdict. The
  deployed probe reads it from the same response as the checkout gate, and the
  silent-failure audit raises a `MONEY_READINESS_UNCONFIGURED` critical finding
  when a deployment reports it cannot complete a paid order, so a store that
  accepts a checkout it can never finish is an incident instead of a clean
  audit. A deployment that does not report the block is treated as unreported,
  not as unready, so an older build is not accused of something it never
  claimed. The tick's `--deployed-checkout-gate` check fails the same way. It
  is a presence check: only a live order proves PayPal accepts the credentials,
  and no probe places one.

## 2026-11-23
- The paid-order path is now proven end to end on every pull request without
  secrets or live money. `test/checkout-end-to-end.test.mjs` drives the real
  serverless handler through quote, PayPal order create, capture, access email
  and the `/access` link against two loopback stubs (`scripts/lib/http-stub.mjs`)
  with fake credentials, and fails if anything fetches a host that is not the
  stub, so a regression that reaches the real PayPal or sends real mail fails
  the build instead of charging a card. Delivery is exercised by redirecting
  Resend with `RESEND_API_BASE_URL` (defaults to the public endpoint), the same
  way `PAYPAL_API_BASE_URL` already redirects PayPal.

## 2026-11-23
- Settlement daemon: the emergency stop now latches. It used to set a flag that
  nothing read, so the interval kept cycling and `--once`/manual runs still paid;
  a stopped process now refuses every later cycle, manual trigger and payout,
  and only a restart clears it. Reversal rows (`amount <= 0`) are refused before
  a batch is built instead of being paid as revenue. A CSV rail is an
  instruction to a human, not money: events exported to the bank-wire/Payoneer
  files are now `export_ready` with `settled: false` (previously `settled: true`
  for rows that may never be uploaded), they no longer count toward the
  settled total, and a provider settlement without a provider batch id leaves
  the events unsettled. The batch id is now a hash of the sorted event ids
  rather than `Date.now()`, so PayPal's 30-day `sender_batch_id` reuse rule
  refuses a retry instead of the daemon paying the same revenue twice. Marking
  an event also used a client method that does not exist
  (`asServiceRole.update`), so every mark failed silently; it now uses
  `entity.update`, the same call the rest of the codebase uses.

## 2026-11-23
- The paid-order path is now gated in CI. `doctor:money` knew that this
  deployment cannot quote, create an order, capture or deliver a paid order
  (no `PRICE_QUOTE_SECRET`, no PayPal order-create or capture credentials, no
  `FULFILLMENT_ACCESS_SECRET`/`RESEND_API_KEY`), but nothing called it before
  shipping, so the four failures were only ever visible to whoever ran it by
  hand. The new `money-readiness` job runs `npm run money:readiness`, which
  calls the doctor offline and separates a money path that is broken in the
  configuration it was given (catalog unreadable, checkout gate blocking, an
  attempt store that cannot be written, a dead access route — always a
  failure) from steps that only lack deployment credentials. Missing
  credentials fail the build, because a deploy in that state takes money it
  cannot deliver; on pull requests from forks, which never receive Actions
  secrets, they are reported as `NOT VERIFIED` warnings so an outside
  contributor is not blocked by a configuration only the owner can change. The
  gate is tested with the same stripped-environment harness as the preflight.

## 2026-11-20
- Fulfilment no longer depends on the app server being deployed. The paid-order
  email used to carry only `/access/<token>`, a route the live domain answers
  with 404, so a real buyer got a dead link; the email now carries the signed
  token, order, amount and entitlement in a self-contained `access-<order>.html`
  pass attached through Resend. The pass has no scripts, images or external
  references, so it opens offline and stays verifiable: support can check the
  HMAC against `FULFILLMENT_ACCESS_SECRET` with no server. The online copy is
  included only when `FULFILLMENT_ACCESS_LINK_ENABLED=true`, and the queue
  records the attachment's `filename`/`sha256` under `access_pass` so a
  delivery can be proven. `doctor:money` reports the access-link step as `ok`
  while delivery is the pass, and still fails on a 404 once the email carries
  the URL.
- A psp id now confirms money only if it names a webhook PayPal actually
  verified. `assertPSPWebhookExists` accepted any id longer than five
  characters, so a forged capture id passed as `psp_confirmation_missing`-free
  proof; it now checks a registry in which the webhook server and
  `handlePayPalWebhook` write a receipt after PayPal returns
  `verification_status: SUCCESS`, keyed by capture/transaction id, webhook event
  id and transmission id. Receipts are idempotent, a receipt without a provider
  transaction id is refused, and a corrupted registry reads as no confirmation.
  The registry is a file (`PSP_WEBHOOK_REGISTRY_FILE`, default
  `data/psp/verified-webhooks.ndjson`) or an append-only HTTP sink
  (`PSP_WEBHOOK_REGISTRY_URL`/`PSP_WEBHOOK_REGISTRY_TOKEN`) because a serverless
  instance cannot keep a file; `/health` reports it as `psp_webhook_registry`
  with `durable` and the reason, so a store that dies with the instance is not
  mistaken for an empty audit trail. `handlePayPalWebhook` also treated any
  answer from the verify call as success; only `SUCCESS` counts now, so a
  `FAILURE` response can neither record a receipt nor reach the proof.
- Revenue and earnings are now refused at creation, not demoted at the ledger
  write, when no payment-provider transaction id backs them
  (`REVENUE_NOT_PROVIDER_VERIFIED`). The guard sits in `buildRevenueData`,
  `buildEarningData`, `RevenueManager.ingestRawRevenue` and the autonomous
  engine's `ingestRevenue`, so a fake record never exists for a payout batch to
  pick up. `revenue/swarm-runner.mjs` no longer books a fixed $150 per trade:
  without a provider transaction it returns `REFUSED`/`NO_PROVIDER_TRANSACTION_ID`.
  `quick-crypto-stimulus`, `execute-live-settlement` and
  `simulate-external-payout` refuse to write a batch or receipt without
  `PROVIDER_TRANSACTION_ID`. `paypal_capture_id` counts as evidence, so real
  captures are unaffected. A shadowed `ingestRevenue` that wrote earnings with
  no proof at all was removed.
- Added `npm run doctor:money`, a preflight that walks the checkout in buyer
  order (catalog, signed quote, order creation, capture, attempt store,
  fulfilment, the emailed access link, the funnel log, the PayPal webhook) and
  names the exact env var behind each step that cannot work. The access-link
  step fetches `${APP_ORIGIN}/access/<invalid token>` and fails on 404, so a
  deploy that can take orders but cannot deliver is caught before traffic
  rather than discovered by a buyer holding a dead link. `--json` for machines,
  `--offline` to skip the network probe, exit 1 on any failure.
- Revenue ledger refuses self-verification. Money is recorded as `VERIFIED` only
  when a payment-provider transaction id (PayPal, Stripe, Payoneer/bank, on-chain
  hash) backs it; a local `LIVE_*` id, a settlement batch or a proof the system
  issued about itself (`autonomous_execution`, `PROOF_*`) now records the event
  as `UNVERIFIED` with the reason and the evidence it lacked, and leaves the
  event's `metadata.verification` for the audit trail. `ProofValidator` refuses
  the same self-issued proofs, `monitor-revenue-health` reports verified and
  unverified money separately, and `npm run audit:revenue-proofs` classifies the
  local ledger on disk so its totals cannot be inflated by the system's output.
- Instrumented the checkout funnel. `/buy` now records a `checkout_intent`
  when it renders a named course (`?product_id=`), and a settled capture records
  one `paid_order`, both through the existing intent tracker so
  `funnelSummary()` reports real counts instead of zeros caused by missing data.
  The two events share a checkout session cookie (`rwc_sid`), a reload or a
  replayed capture is not counted twice, and the reported `price_mad`/`price_eur`
  come from the catalog FX table rather than a guess; the charged amount is
  carried in `amount_cents`/`currency`. Recording is best effort: a write
  failure is logged and never fails a checkout. The log path is
  `CHECKOUT_INTENTS_FILE`, falling back to `$SALES_DATA_DIR/course-intents.ndjson`,
  or an append-only HTTP sink when `CHECKOUT_INTENTS_URL` is set — a serverless
  instance has no shared filesystem, so a file log would reset the funnel on
  every cold start. `/health` reports `checkout_intents` with `durable`, `target`
  and the reason it is not durable, and the sales-agent reports read the same
  store. Events keep the intent tracker schema, so `funnelSummary()` is unchanged.
- Reported post-capture reconciliation. The signed checkout attempt record now
  stores the facts of the quote it was created from (amount in cents, currency,
  catalog version and catalog digest) under the record's HMAC, and
  `POST /acp/v1/transactions/:id/capture` returns a `reconciliation` object that
  compares the captured amount and currency with them and with the current
  catalog revision. A capture that does not match the quote is reported as
  `mismatch` with machine reasons and a cent delta; a missing or unverifiable
  record, ambiguous quote metadata, a capture that has not settled or a missing
  capture amount is `unchecked`, never `ok`. Only `COMPLETED` captures count as
  captured, so pending or authorized money is not compared as if it settled. Older records that predate the extra signed field still verify, so
  an in-flight checkout stays replayable across the upgrade. The check is
  read-only: it changes no price, capture, order or catalog entry.

## 2026-11-19
- Signed stored checkout attempt records. When `CHECKOUT_ATTEMPT_SIGNING_SECRET`
  (or the configured price quote key) is set, every record in
  `CHECKOUT_ATTEMPT_STORE_DIR` carries an HMAC over its quote id, key, order and
  expiry. A record that does not verify — swapped order id, stripped signature
  or a signature from another key — is treated as absent, so a replay creates a
  fresh PayPal order instead of trusting it. The signing key is derived and never
  written to the store. The config check and `/health` now report whether that
  protection is real as `config.checkout_attempts.signed`, and a configured
  `CHECKOUT_ATTEMPT_STORE_DIR` with neither signing secret raises a
  `checkout_attempt_store_unsigned` warning instead of leaving an operator to
  assume the records are signed.
- Limited checkout order creation per client. `POST /acp/v1/transactions` now
  accepts 60 attempts per 10 minutes from one client address and answers
  `429 CHECKOUT_RATE_LIMITED` with `retryable: true`, `retry_after_ms` and a
  `Retry-After` header beyond that, before any quote check or PayPal call. The
  default is deliberately generous because the key is a network address and
  buyers behind one NAT share it; `CHECKOUT_RATE_LIMIT_MAX` and
  `CHECKOUT_RATE_LIMIT_WINDOW_MS` tune it and `0` disables it. Forwarding
  headers are read only when the request already arrived through a local proxy,
  so a direct caller cannot mint a fresh bucket per request. The counter is per
  process, so it bounds what one source can make one instance do.
- Swept stale `CHECKOUT_ATTEMPT_STORE_DIR` artifacts at startup: expired order
  records, abandoned claim locks, truncated temp files and unreadable records
  older than the stale window are removed, so a crashed creator cannot leave
  files behind forever. Live claims and fresh temp files are left alone.
- Kept checkout attempts keyed by the quote id rather than by the cart. A quote
  carries no buyer identity — product, amount, currency and redirect URLs are
  the same for every customer buying that course — so a cart key would replay
  one buyer's PayPal order and approval link to the next buyer. A second quote
  for the same cart is a separate attempt; a reload that keeps its quote still
  replays it, and `PayPal-Request-Id` still deduplicates retries of one attempt.

## 2026-11-18
- Checked that `CHECKOUT_ATTEMPT_STORE_DIR` is on shared storage. The config
  check, the startup log and `/health` now report
  `config.checkout_attempts.storage` (`shared`, `instance_local` or `unknown`)
  and `filesystem`, and a serverless runtime or a memory-backed filesystem makes
  `durable: false` with a `checkout_attempt_store_instance_local` warning, so a
  Vercel deployment can no longer report per-instance replay protection as
  durable. A network mount is the only positive proof of sharing.
- Probed `CHECKOUT_ATTEMPT_STORE_DIR` instead of trusting it. The directory is
  now created, written to and cleaned up by the config check, the startup log
  and `/health`; when that probe fails the server raises a
  `checkout_attempt_store_unwritable` warning, reports
  `config.checkout_attempts.durable: false` with the failing path and error, and
  still exits `0`, so a read-only or misconfigured volume can no longer look
  restart-safe until the first checkout fails.
- Warned operators when checkout replay protection silently degrades to per
  process memory. If `CHECKOUT_ATTEMPT_STORE_DIR` is unset the server now writes
  a `checkout_attempt_store_not_durable` warning to stderr at startup, lists it
  in `--check` output and `/health` (`config.warnings`,
  `config.checkout_attempts.durable`), so a restart can no longer quietly lose
  duplicate-order protection. The warning does not fail the config check.
- Made `/buy` retry the retryable `409 CHECKOUT_IN_PROGRESS` itself: it waits
  `retry_after_ms` and resends the identical request with the same signed quote
  instead of showing the buyer a generic failure.
- Returned a retryable `409 CHECKOUT_IN_PROGRESS` when another instance is still
  creating the order for a quote instead of letting the attempt registry's
  conflict surface as an unhandled `500`. The response carries `retryable`,
  `retry_after_ms`, `quote_id`, `request_id` and a `Retry-After` header, and the
  failed request still creates no order. `CHECKOUT_ATTEMPT_CLAIM_TIMEOUT_MS`
  tunes how long a request waits for the competing creator first.
- Made quote-to-order attempt idempotency durable and shared. With
  `CHECKOUT_ATTEMPT_STORE_DIR` set, a checkout attempt is claimed through an
  exclusive lock file and its order is published with an atomic rename, so a
  replay after a restart or on another instance returns the stored order instead
  of creating a second PayPal order. A crashed claim goes stale after 60 seconds
  and a failed creation releases the claim for retry. Without the directory the
  registry stays in process memory.
- Checked both quote currencies, top-level `currency` and `amount.currency`,
  against the catalog instead of letting a correct one hide a wrong one; each
  mismatch is reported with the field that is wrong.
- Pinned both buyer-facing price-audit reads (edge and cache-busted edge) to the
  DNS-verified CDN address through the HTTPS request, and reject every 3xx
  instead of following it. A rebinding DNS answer or a redirect to a private
  address now leaves the read unchecked and is never fetched. The CDN host is
  resolved once per audit and that snapshot also feeds the origin-distinctness
  check, so the two proofs cannot disagree.

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
