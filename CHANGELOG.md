# Changelog

## 2026-11-25
- An exported batch that was never uploaded can now be released from its
  waiting claim. A CSV export closes its own claim as soon as the file is
  written, so the state an operator resolves is normally `closed` with no
  resolution — and `--resolve-claim` refused it as
  `PAYOUT_BATCH_NOT_RELEASABLE`, leaving a batch everyone knew was never sent
  with no way out: no payment to confirm and no rows back in the queue. That
  state is now releasable under the same evidence a confirmation uses: the
  claim must record a `manual_csv` export whose `export_filename` still exists
  in `exports/`, otherwise the batch is refused as
  `PAYOUT_BATCH_EXPORT_MISSING` with the path. The not-sent resolution is
  stamped on the closed claim, so the batch leaves daemon health's
  awaiting-confirmation queue and the audit's `PAYOUT_EXPORT_UNCONFIRMED`
  finding, cannot later be confirmed as paid (`PAYOUT_BATCH_NEVER_SENT`), and
  its rows go back to `VERIFIED` exactly as the open-claim release does. Tests
  cover the CLI release from the waiting state (claim resolved, rows released,
  queue empty, confirmation refused) and the missing export file (nothing
  written, claim still waiting).
- Closing a claim as never sent now returns its rows to the settlement queue.
  `--resolve-claim` recorded the resolution and left the rows at `export_ready`,
  which the settlement selector never takes, so the revenue it said was payable
  again could never be paid. `resolveExportedBatch` now releases the batch's
  rows: `VERIFIED`, with `settled`, `paid_out`, `payout_batch_id` and
  `exported_at` cleared and the releasing batch stamped on the row. The claim is
  closed first and the rows written second, so reconciliation — which reads only
  open claims and counts `export_ready`/settled rows as accounted for via
  `revenueRowAccountedFor` — can never mistake the batch for paid or re-close
  it; a released row is `VERIFIED` and therefore unaccounted for by design.
  Every row is validated before any is written: a paid row or a row another
  batch owns refuses the whole release (`PAYOUT_ROWS_NOT_RELEASED`) and leaves
  the claim open, and running the command again on an already-closed batch
  finishes an interrupted release instead of failing. Tests cover the CLI path
  (claim closed, rows released, second run idempotent), the next cycle exporting
  the released row again under a new claim, and the refusal leaving the claim
  and every row untouched.
- An exported CSV batch a crash left open can now be recorded as paid.
  `confirmExportedBatch` refused every open claim before reading its rail, so a
  batch whose export ran and was recorded but whose claim never closed — the
  rows sit at `export_ready`, the file is on disk, the operator uploaded it —
  could never become `paid_out`, and the remedy that names `--confirm-payout`
  for it always exited 1. That one state is now accepted: the claim must be
  `executed` with `execution.method: manual_csv` **and** its `export_filename`
  must exist in `exports/`, otherwise the batch is refused as before
  (`PAYOUT_BATCH_UNRESOLVED`) or, when only the file is missing, as
  `PAYOUT_BATCH_EXPORT_MISSING` with the path. The rows are still validated
  whole before any write, then marked paid_out, then the claim is closed with
  the execution it recorded and stamped paid. Two tests cover the accepted state
  (rows, confirmation note, claim closed as paid) and the missing file (nothing
  written, claim left open).
- An exported payout batch nobody confirms now becomes an audit finding, not just
  a field in daemon health. `PAYOUT_EXPORT_UNCONFIRMED` (high) reports every
  closed manual-CSV claim still waiting past the confirmation window (3 days,
  `--export-confirm-days`), with its batch, rail, amount, export file and age,
  and `evidence.payout_claims.awaiting_confirmation` counts the queue. A batch
  confirmed paid, closed as never sent, or inside the window is not a finding,
  and an export whose age cannot be read is reported rather than assumed young.
  Daemon health and the audit share one predicate
  (`exportedClaimsAwaitingConfirmation`), so they cannot disagree about which
  batches are waiting.
- The payout findings now have a schedule where their evidence lives.
  `PAYOUT_CLAIM_UNRESOLVED`, `PAYOUT_EXPORT_UNCONFIRMED` and
  `REVENUE_SETTLEMENT_BLOCKED` read the payout claim store and the
  blocked-settlement log, which exist only on the settlement host; the
  `Swarm Tick` audit runs on a clean GitHub runner, where a missing store reads
  as an empty one, so those three could never fire there.
  `.github/workflows/payout-sentinel.yml` runs
  `scripts/silent-failure.mjs audit --fail-on high` hourly against a
  configurable root and fails the job on high or critical findings. Its
  preflight refuses to run the audit at all unless the claim store is readable,
  because a green run that read no store is a false clearance; the
  blocked-settlement log is only reported as present or absent, since absence
  is the normal state of a host that never refused a settlement. It is pointed
  at the settlement host with the `PAYOUT_SENTINEL_RUNNER` repository variable,
  and fails on purpose until that variable exists.
- The `PAYOUT_CLAIM_UNRESOLVED` remedy now says what it can actually do. The
  finding has two states — a claim store that could not be read, and open
  batches — and the old text only addressed the second: it now asks for the
  store to be restored first when no batch is listed, and no longer claims
  `--resolve-claim` makes an exported batch's rows payable again, which it does
  not (they stay `export_ready` and the settlement selector takes only
  `VERIFIED`). The daemon's own success line made the same promise and no longer
  does, and the `resolvePayoutClaim` docstring says what closing a claim does to
  its rows. The test that only grepped the flag names is replaced by one that
  runs the remedy's command against the offline claim store and asserts the
  resulting claim (`closed`, `not_sent`, note, no longer open in health) and row
  (`paid_out: false`, `settled: false`, batch retained).

## 2026-11-24
- An exported payout batch can now be confirmed paid. A CSV rail stops at
  `export_ready` — correct, because the file is an instruction to a human — but
  nothing moved a row past that state, so uploaded batches never became
  `paid_out` and the ledger held revenue paid forever as "exported". The
  operator who uploads the file now records it: `confirmExportedBatch(batchId)`
  in the daemon and `node auto_settlement_daemon.js --confirm-payout <batch_id>`
  mark the batch's rows `paid_out`/`settled` with the confirmer, time and note,
  and stamp the batch as paid in the claim store so a second confirmation is a
  no-op. It refuses an unknown batch, a claim still open (its money may be on
  its way), a batch closed as never sent (there is no payment to confirm), a
  batch another rail paid (only an export waits for a human), and any row it
  cannot prove belongs to this batch — and it checks every row before writing
  any, so a refused batch is left whole, not half marked. `getDaemonHealth()`
  now lists `payout_claims.awaiting_confirmation`, the exported batches still
  waiting.
- Two payout-rail bugs that could send an instruction nowhere are fixed. The
  Payoneer rail wrote `exports/…` without creating the directory, so on a fresh
  checkout it threw `ENOENT` after its payout claim was written, withholding the
  rows until an operator intervened; both rails now write through one helper
  that creates the directory. And `selectOptimalOwnerAccount` chose an account
  while each CSV wrote a hardcoded registry constant as the payee, so the rail
  and the destination could disagree, and an account without the identifier its
  rail needs could be selected and then never paid. Selection now proves the
  destination (`ownerAccountDestination`: enabled, a type a rail pays, and the
  identifier that rail needs), the generated payout item carries it, the CSVs
  pay the item's destination, and the primary Payoneer account id they write is
  in `ALLOWED_BENEFICIARIES`. An event with no payable owner account is left
  unsettled and reported instead of being routed.
- The settlement daemon's emergency stop survives a restart. The latch was
  in-memory only while startup runs a settlement cycle immediately, so a restart
  — including the one an operator performs because money is misbehaving —
  cleared the stop and the next cycle paid. `emergencyStop()` now writes
  `data/financial/settlement-emergency-stop.json` (override with
  `SETTLEMENT_EMERGENCY_STOP_FILE`), and startup, `--once` and manual triggers
  refuse while it exists, reading the file rather than trusting process memory.
  A latch that cannot be read counts as stopped, and a stop that cannot be
  persisted is reported as a critical finding instead of quietly protecting only
  this process. Clearing is explicit: `--clear-emergency-stop`.
- The settlement daemon claims a payout before it sends it. A crash between
  paying a batch and marking its rows left no record that money may have moved:
  the rows were still VERIFIED, so the next cycle selected them again and sent a
  second payout. `processRailBatch` now writes a claim
  (`data/financial/payout-claims.json`, override with `PAYOUT_CLAIM_STORE`)
  before the rail is called and closes it only once every row it paid is marked.
  Every cycle reconciles the open claims first: a claim whose rows are already
  accounted for is closed, a recorded payout finishes the marks it was
  interrupted before (recording money that moved cannot move it twice), and a
  claim with no recorded outcome is checked against the payout items PayPal's
  webhook left for its rows — success marks the rows settled, while a failure
  recorded against the claim's own batch frees them. Anything that cannot be
  checked is reported (`FINDING PAYOUT_CLAIM_UNRESOLVED`, critical), exposed in
  daemon health and in a `PAYOUT_CLAIM_UNRESOLVED` audit finding with the batch,
  rows, amount and age, and its rows are withheld from every later batch. An
  unreadable claim store refuses to pay at all. `--resolve-claim <batch_id>`
  closes a claim an owner has confirmed never arrived — the only state besides
  provider evidence in which its rows may be paid again.
- The amount PayPal verified is kept and compared on the money path.
  `recordVerifiedWebhook` stored only the psp/event/transmission ids, so a
  settlement block was built from the revenue row's own numbers and a row could
  claim any amount for a real capture id. A receipt now records the
  `resource.amount` and currency the provider stated; `findVerifiedWebhook`
  returns that receipt and `agreesWithVerifiedAmount` compares a proof against
  it, and the ingest-time bind, `authorizeRevenueSettlement` and the one-off
  backfill all refuse a row whose numbers disagree with it
  (`provider_amount_mismatch`). Receipts written before this carry no amount and
  are treated as unable to contradict a row, so legacy captures still bind.
- A capture whose amount the verified webhook contradicts is now an incident.
  The ingest-time bind and the one-off backfill refused such a row
  (`provider_amount_mismatch`) with no `FINDING` line and no settlement-block
  entry, so the row sat unsettleable and no audit saw it. Both now write
  `FINDING SETTLEMENT_EVIDENCE_AMOUNT_MISMATCH [critical]` and append an
  `evidence_amount_mismatch` line to the settlement block log, and the
  silent-failure audit raises `SETTLEMENT_EVIDENCE_AMOUNT_MISMATCH` (critical)
  for every row still open, with the difference between the recorded and the
  verified amount. It is reported apart from `SETTLEMENT_EVIDENCE_UNBOUND`
  because no block is missing: the row's own number is wrong, so the remedy is
  to reconcile the row, not to repair the chain volume. A later settlement of
  the row closes the finding.
- Evidence chain appends are serialised. `EvidenceIntegrityChain.addBlock` is
  read-modify-write: two captures recorded at the same moment both read the same
  last block, each appended its own and the second write removed the first, so
  the chain forked and a later settlement checked a branch that no longer held
  its block. An append now holds a lock file beside the chain
  (`<chain>.lock`, so it also excludes another process on the same volume),
  waits up to 10 s for it, and steals it only after 30 s, which is how a writer
  that died mid-append stops wedging the chain. The chain is written to a
  staging file and renamed, so a reader never sees a half written chain.
- The settlement daemon authorises each payout through
  `authorizeRevenueSettlement` instead of `MoneyMovedGate` alone. The gate's
  `assertEventBound` only proves that *a* block exists, so a block that
  disagreed with the row — an amount or capture the row never carried — was
  paid by the daemon while the applied webhook path refused it. The daemon now
  refuses `settlement_evidence_missing` and `settlement_evidence_mismatch` for
  the same reason the webhook path does, and records the refusal as a gate
  error in its health state.
- `scripts/backfill-settlement-evidence.mjs` now reports a truncated scan. The
  walk is newest first and bounded at 5000 rows, so a full ledger used to produce
  a report that looked complete while the oldest rows — the ones most likely to
  predate ingest-time binding — were never examined. The report and the printed
  summary say `truncated` and point at `--limit`.

## 2026-11-23
- `scripts/backfill-settlement-evidence.mjs` (`npm run evidence:backfill`) binds
  settlement-evidence blocks for revenue rows recorded before capture ingest
  wrote them, which the settlement gate now refuses as
  `settlement_evidence_missing`. It is a one-off, report-only unless `--apply` is
  passed, and it only ever writes evidence: no status change, no settlement, no
  overwrite. A row whose psp id no verified webhook named is refused, a row whose
  existing block disagrees is refused rather than replaced, and rows that are
  already `paid_out` or non-positive (reversals) are skipped. The canonical
  "evidence for this row" and "does the block agree" rules moved into
  `settlementEvidenceProof` / `settlementEvidenceAgrees` so ingest, the gate and
  the backfill cannot drift apart.

## 2026-11-23
- A capture whose settlement-evidence block could not be written is now an
  incident instead of stderr. `bindSettlementEvidence` appends an
  `evidence_unbound` line to the settlement block log
  (`data/resilience/settlement-blocks.ndjson`, override with
  `SETTLEMENT_BLOCK_LOG`), and the silent-failure audit raises
  `SETTLEMENT_EVIDENCE_UNBOUND` (critical) for every row still open, naming the
  revenue row, the capture id, the write error and its age. It is reported
  separately from `REVENUE_SETTLEMENT_BLOCKED` because no payout went out: the
  row is unsettleable rather than misaccounted. A later settlement of the same
  row appends a closing line, so a replayed capture clears the finding.

## 2026-11-23
- The settlement-evidence block is now written when a capture is recorded, not
  reconstructed when the money is about to move. Every capture ingest path funnels
  through `createBase44RevenueEvent(Idempotent)`, which binds an
  `EvidenceIntegrityChain` block naming the row's own provider transaction id,
  amount and currency from the proof it verified at creation. `authorizeRevenueSettlement`
  no longer creates the block it could not find: a row with no bound evidence is
  refused as `settlement_evidence_missing`, and bound evidence that disagrees
  with the row's current psp id, amount or currency is refused as
  `settlement_evidence_mismatch`, so a row can no longer authorise its own payout
  from whatever it says today. A capture whose block cannot be written is still
  recorded (the money did move) but reported as
  `FINDING SETTLEMENT_EVIDENCE_NOT_BOUND [high]` and left unsettleable. The chain
  path is also configurable with `EVIDENCE_CHAIN_PATH` and its directory is
  created on first write, so a deployment can put it on a durable volume and a
  test keeps it out of the repository.

## 2026-11-23
- Settlement daemon: the batching window was inverted. `MAX_SETTLEMENT_DELAY_HOURS`
  is a lower bound on age, but the filter kept events *younger* than it
  (`ageHours < 24`), so revenue that had waited past the window was never
  settled while fresh events were paid immediately. Aged events are now the
  ones picked up and a fresher one waits for a later cycle; an event with no
  parseable date is still never assumed due. Covered by a test against the
  offline store that settles a 25-hour-old event and leaves a new one alone.

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
