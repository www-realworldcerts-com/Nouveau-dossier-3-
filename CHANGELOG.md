# Changelog

## 2026-11-13
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
