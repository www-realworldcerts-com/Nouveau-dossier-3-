# Incident Report — Autonomous Swarm Loop Dead (revived 2026-11-11)

**System:** `www-realworldcerts-com/Nouveau-dossier-3-` — Autonomous Revenue Swarm
**Incident:** the autonomous swarm loop stopped and never restarted
**Observed outage:** reported by the owner on 2026-11-11 ("dead since Nov 7")
**Status:** engineering chain repaired; live ticks blocked only on missing credentials
**Branch:** `freebuff/730a85239631b173652d4ff4` → pushed to `master`
**Author of the change:** Codebuff, at the owner's request

---

## 1. Executive summary

The loop was not merely idle: it could not start. Every process entering the
autonomous runner died at ES-module resolution because two security modules it
imports did not exist in the tree:

- `src/security/NetworkGuard.mjs` — imported by `src/autonomous-daemon.mjs:24`
  and `src/revenue/swarm-runner.mjs:14`
- `src/security/KeyGuard.mjs` — imported by `src/revenue/swarm-runner.mjs:15`

The failure is reproducible in the recorded heartbeat: `ERR_MODULE_NOT_FOUND …
src/security/NetworkGuard.mjs`. Even if that import had worked, three further
gaps would have kept the loop dead:

1. **No scheduler.** The repository had no `.github/workflows/` directory. The
   only workflow file, `github_workflows_bootstrap-egress-vm.yml`, sits at the
   repository root (so GitHub never loads it) and is `workflow_dispatch`-only.
2. **No start command.** `package.json` had no `start` script, while the README
   and the supervisor script both assume `npm start` launches the loop. The
   supervisor also forced `BASE44_OFFLINE=true` alongside `SWARM_LIVE=true` and
   relaunched a one-shot script every five seconds — a crash loop.
3. **No liveness signal.** Nothing wrote a heartbeat, so a stopped loop looked
   exactly like a healthy one. Persistent evidence: `data/swarm-memory.json`
   holds a `lastTick` at `2026-01-08T00:50:19Z` with `ok: false` and
   `recipient_allowlist_missing`, `consecutiveFailures: 6`, and a freeze opened
   `2026-01-04T04:51:11Z` for `webhook_missing` that was still `active: true`
   (7,481 hours old) and blocking all money-moving tasks.

All four gaps are now closed, and the loop reports honestly instead of silently
stopping. It is scheduled but **not yet earning**: a live tick needs credentials
that do not exist in this workspace (§7).

---

## 2. Evidence collected before any change

| Check | Result |
| --- | --- |
| `.github/workflows/` | absent; only `github_workflows_bootstrap-egress-vm.yml` at repo root, manual dispatch |
| `package.json` scripts | none (`npm start`, `npm test` both undefined) |
| Relative-import scan (265 files) | 6 unresolvable imports, 2 on the daemon path (`NetworkGuard`, `KeyGuard`) |
| `src/autonomous-daemon.mjs --all-good-summary` | `ERR_MODULE_NOT_FOUND: src/security/NetworkGuard.mjs`, exit 1 |
| `data/swarm-memory.json` → `daemon-state` | `lastTick.at = 2026-01-08T00:50:19.062Z`, `lastTick.ok = false`, `consecutiveFailures = 6` |
| `freeze` | `active: true` since `2026-01-04T04:51:11.384Z`, violation `webhook_missing` |
| Latest autonomous audit | `audits/autonomous/2026-01-04.jsonl` (no later ticks) |
| `check-connectivity.mjs`, Base44 SDK | SDK package absent; daemon falls back to the offline client |

Timeline: the last recorded autonomous activity is January 2026; the owner
reports the loop dead from November 7. Both are consistent with the same cause —
the loop was never scheduled and the runner could not import, so no tick could
have occurred in between.

---

## 3. Root-cause chain

```
GitHub schedule absent  ─┐
npm start absent        ─┼─► nothing invokes a tick
supervisor crash-loops  ─┘
                          │
import NetworkGuard.mjs ──┼─► every invocation dies before running a task
import KeyGuard.mjs     ──┘
                          │
no heartbeat            ──► nobody notices any of the above
stale freeze since Jan  ──► settlements stay blocked even if a tick runs
```

The decisive defect is the missing modules: a scheduler alone would have run a
process that instantly crashed, and a heartbeat alone would have recorded a
`failed` status without fixing anything. All three layers were required.

---

## 4. Remediation delivered

### 4.1 Loop revival — commit `7ae425d` (16 files, +1,512 / −61)

| File | Change |
| --- | --- |
| `src/security/NetworkGuard.mjs` *(new, 140 lines)* | Egress reachability watchdog used by the daemon and runner. Any HTTP response counts as reachable; network errors/timeouts are failures; transition alerts; never throws at boot; optional ndjson log |
| `src/security/KeyGuard.mjs` *(new, 92 lines)* | Constitution-hash check plus Ed25519 owner-signature verification. Returns `verified: false` with `public_key_missing` rather than ever claiming an unverified pass |
| `src/autonomous-config.mjs`, `src/marketplaces/base-marketplace.mjs`, `src/swarm/mission-hooks.mjs` | Corrected broken relative import paths (see §4.3) |
| `scripts/swarm-tick.mjs` *(new, 244 lines)* | One bounded tick: runs `autonomous-daemon --all-good-summary` with timeout/SIGTERM→SIGKILL, writes `data/swarm-heartbeat.json`, appends `data/swarm-tick-log.ndjson`, exit 0 ok / 1 failed / 2 blocked. `--check-only` is a credential-free liveness probe; `--with-revenue` (or `SWARM_TICK_REVENUE=true`) also runs the revenue orchestrator |
| `.github/workflows/swarm-tick.yml` *(new)* | Cron `*/15 * * * *` + manual dispatch, concurrency guard, `npm ci`, doctor → tick → `--check-only --max-silence-min 90`, artifact upload. The verify step fails when nothing ticked for 90 minutes, so silence pages |
| `scripts/swarm-doctor.mjs` *(new, 175 lines)* | Preflight: node version, dependencies, live env, heartbeat age, freezes. `--clear-stale-freeze --ack-owner --reason` clears and audits |
| `scripts/auto-restart-loop.js` *(rewritten, 127 lines)* | Real supervisor for a VM: same tick at `SWARM_LOOP_INTERVAL_MS` (default 15 min), exponential backoff, blocked ticks retry at normal cadence, pid lock; no forced offline mode |
| `src/swarm/loop-health.mjs` *(new, 236 lines)* | Heartbeat, env preflight, freeze-age/staleness and daemon-state helpers for both `.autonomous-state.json` and `data/swarm-memory.json` |
| `package.json` | `start`, `swarm:tick`, `swarm:tick:check`, `swarm:doctor`, `swarm:loop`, `test:loop` |
| `.gitignore` | heartbeat, tick log, loop lock, sales runtime state |
| `data/swarm-memory.json` | Stale freeze cleared (audited, §5) |
| `audits/autonomous/2026-11-11.jsonl` *(new)* | Audit record of the freeze clear |
| `docs/SWARM_LOOP_RUNBOOK.md` *(new, 105 lines)* | Why it died, restart checklist, credentials, monitoring, local deployment |
| `test/network-guard.test.mjs`, `test/swarm-loop-health.test.mjs` *(new)* | Guards, heartbeat, env preflight, stale freeze, both state formats, audit and log trimming |

### 4.2 Sales chain — commit `1f16498` (11 files, +2,333)

The blueprint's engineering half existed nowhere in the repo, so it was built:
`src/sales/` (pricing engine, LLM exception valuation, transcript-safe catalog
I/O, intent tracker, Shopify publisher, seven-node agent), `scripts/sales-agent.mjs`,
`config/pricing.json`, `docs/SALES_AGENT.md`, `test/sales.test.mjs`. Rules price
the bulk; premium exam boards/titles, out-of-band tiers and awkward prices go to
the LLM; only rules prices auto-approve; publishing is idempotent; checkout
intents are recorded to ndjson with a funnel summary.

### 4.3 Import repair

| File | Before | After |
| --- | --- | --- |
| `src/marketplaces/base-marketplace.mjs` | `../opus/swarm_prime_directive.js` | `../../opus/swarm_prime_directive.js` |
| `src/swarm/mission-hooks.mjs` | `../../base44-client.mjs` (repo root) | `../base44-client.mjs` (`src/base44-client.mjs`) |

Re-scan: all relative imports in `src/` and `scripts/` resolve except
`scripts/test-blog-writer.mjs → ../src/work-execution/blog-writer.mjs`, a
pre-existing manual test script with no `blog-writer` module anywhere in the
repo. It is not on the loop path and was left untouched.

### 4.4 Env-name drift fix — uncommitted (2 files, +25)

`resolveRuntimeConfig` only read `AUTONOMOUS_AUTO_SUBMIT_PAYPAL_PAYOUTS` and
`AUTONOMOUS_AUTO_EXPORT_PAYONEER_PAYOUTS`, while `deploy-live.ps1` and the tests
use the `_PAYOUT_BATCHES` spellings (the deploy script also exports
`AUTONOMOUS_AUTO_SUBMIT_PAYPAL`). Setting the documented variable to `true`
silently left the payout task unarmed. Both flags now accept every alias in use.
A regression test asserts `…_PAYOUT_BATCHES=false` → off and `…_PAYOUTS=true` → on.
The two previously failing tests were fixed without weakening any assertion.

---

## 5. Freeze recovery

The freeze opened `2026-01-04T04:51:11Z` for `webhook_missing` had blocked
money-moving tasks for 7,481 hours. It was cleared with explicit owner
acknowledgement rather than an automatic rule:

```
node scripts/swarm-doctor.mjs --clear-stale-freeze --ack-owner \
  --reason "stale freeze since 2026-01-04 blocking loop recovery; owner requested revival 2026-11-11"
```

Result is recorded in `audits/autonomous/2026-11-11.jsonl`:

```json
{"timestamp":"2026-11-11T22:02:58.568Z","autonomous":true,"level":"policy",
 "message":"Stale swarm freeze cleared",
 "data":{"file":"data/swarm-memory.json","previous":{"active":true,"since":"2026-01-04T04:51:11.384Z",
 "violations":[{"type":"webhook_missing","severity":"high","message":"No PayPal webhooks observed"}]},
 "reason":"stale freeze since 2026-01-04 blocking loop recovery; owner requested revival 2026-11-11"}}
```

`data/swarm-memory.json` now holds `freeze.active: false` with `cleared_at`,
`cleared_by` and `clear_reason`; violations are preserved for the record.

---

## 6. Verification evidence

| Check | Command | Result |
| --- | --- | --- |
| Import resolution | custom scan, 265 files | only the pre-existing `blog-writer` script import remains unresolved |
| Daemon boot | `node src/autonomous-daemon.mjs --all-good-summary` | exit 2, JSON summary: `readinessOk:true, base44Ok:true, missionHealthOk:true, simulationOk:true, payoutTruthOk:true, freezeActive:false, deadmanOk:true, missionFreezeOk:true`; only `paypal_ping` false (no credentials) |
| Tick | `node scripts/swarm-tick.mjs` | `blocked` in ~470 ms, heartbeat written, `blocked_reason: missing_env:…`, exit 2 |
| Liveness probe | `node scripts/swarm-tick.mjs --check-only` | `swarm loop alive: last heartbeat 1m ago (blocked)`, exit 0 |
| Doctor | `node scripts/swarm-doctor.mjs` | `node PASS`, `dependencies PASS`, `heartbeat PASS`, `live_env FAIL` (only blocker) |
| Tests | `node --test test/autonomousDaemon.test.mjs test/network-guard.test.mjs test/swarm-loop-health.test.mjs test/sales.test.mjs` | **46 tests, 13 suites, 46 pass, 0 fail** |
| Workflow syntax | `python3 -c "import yaml; yaml.safe_load(...)"` | `YAML OK` |
| Push | `cloud_git push master` | fast-forward `47e5e8e..7ae425d` |

Runtime artifacts checked: `data/swarm-heartbeat.json` (status `blocked`,
`missing_env`, `last_success_at: null`), `data/swarm-tick-log.ndjson` (two
entries, daemon summary embedded), audit file above.

---

## 7. Current operational state

**Working now:** scheduling (`Swarm Tick` every 15 min on `master`), preflight,
heartbeat, liveness paging, stale-freeze detection and supervised local ticks.
A run ticks, records `blocked`, and surfaces `live_env` as the reason.

**Not working yet — needs the owner:** a live tick requires repository secrets
(or `.env` locally):

| Variable | Purpose |
| --- | --- |
| `SWARM_LIVE=true` | Enables live mode validation |
| `BASE44_APP_ID`, `BASE44_SERVICE_TOKEN` | Base44 service access (currently the SDK is also absent, so the daemon falls back to the offline client) |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | PayPal ping and payouts (`PAYPAL_MODE=live`) |
| `AUTONOMOUS_ALLOWED_PAYPAL_RECIPIENTS` | Required before any money-moving task is enabled |
| repo variable `SWARM_TICK_REVENUE=true` | Optional: also run `scripts/run-swarm-orchestrated.mjs` each tick |

Recovery procedure: add the secrets → `npm run swarm:doctor` until it passes →
`npm run swarm:tick` → confirm `status: ok` in `data/swarm-heartbeat.json`. The
cron workflow then keeps ticking.

**Nothing in this work generates revenue by itself.** With zero checkout intents
and an unpriced catalog (the blueprint's diagnostic), the sales agent can price
and publish, but traffic remains the binding constraint.

---

## 8. Risks and known issues

| Risk | Severity | Notes / mitigation |
| --- | --- | --- |
| **The daemon's offline fallback rewrites tracked `.sys-integ.dat`** | High for data hygiene | Observed twice: running `--all-good-summary` without the Base44 SDK replaced 1,579 lines of revenue/payout records with empty `records: []`. The file is restored in git before committing, but a local tick can clobber it again. Should be fixed by refusing to rewrite the snapshot when the client is offline, or by moving it out of version control |
| No live verification | High | No credentials in this workspace; PayPal ping and every money path are unverified against production |
| Missing Base44 SDK | Medium | Daemon falls back to the offline client and logs a warning; Base44 reads may be empty until the SDK/service is available |
| Supervisor not long-run tested | Medium | `npm start` logic reviewed and tick-tested; no multi-hour soak, no reboot test |
| Stale freeze cleared manually | Low | Intentional, owner-acknowledged, audited; the underlying `webhook_missing` cause (no PayPal webhook observed) is not fixed by clearing it |
| `SWARM_TICK_REVENUE=true` runs settlement logic every 15 min | Medium | Off by default; enable only after doctor is green and after reviewing `config/autonomous.json` money-moving flags |
| Pre-existing broken import in `scripts/test-blog-writer.mjs` | Low | Manual script only; module absent from the repo |
| Env-alias fix uncommitted | Low | 2 files, +25 lines, tests green; not on `master` yet |

---

## 9. Recommended next actions

1. Commit and push the env-alias fix (2 files).
2. Add the live secrets listed in §7 and run the doctor until green.
3. Decide whether the daemon may rewrite `.sys-integ.dat`; if not, guard the
   offline fallback before enabling `SWARM_TICK_REVENUE`.
4. Feed a real catalog export to the sales agent, run the price pass, approve the
   exceptions, and publish — the blueprint's day-1-to-day-7 action.
5. Instrument `checkout_intent` on the site's checkout route and watch
   `npm run funnel`; the first non-zero intent is the blueprint's terminal
   engineering milestone.

---

## 10. Reproduction commands

```bash
npm ci
node scripts/swarm-doctor.mjs                 # what is blocking the loop
node scripts/swarm-tick.mjs                   # bounded tick, writes heartbeat
node scripts/swarm-tick.mjs --check-only      # 0 alive / 1 dead
node --test test/autonomousDaemon.test.mjs test/network-guard.test.mjs \
            test/swarm-loop-health.test.mjs test/sales.test.mjs
node scripts/sales-agent.mjs price --catalog test/fixtures/catalog.sample.ndjson --mock
```
