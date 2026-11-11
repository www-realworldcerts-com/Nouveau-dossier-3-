# Swarm Loop Runbook — reviving and keeping the loop alive

## Why the loop died

The loop stopped and stayed stopped because the repository had **no scheduler
and no heartbeat**:

1. **No scheduler.** There was no `.github/workflows/` directory. The only
   workflow in the repo (`github_workflows_bootstrap-egress-vm.yml`) sits
   outside `.github/workflows` and is `workflow_dispatch`-only, so nothing ever
   triggered a tick.
2. **No start command.** `package.json` had no `start` script even though the
   README and `scripts/auto-restart-loop.js` assume `npm start` launches the
   supervisor.
3. **The runner could not even import.** `src/autonomous-daemon.mjs` and
   `src/revenue/swarm-runner.mjs` import `src/security/NetworkGuard.mjs` and
   `src/security/KeyGuard.mjs`; neither file existed, so every tick died with
   `ERR_MODULE_NOT_FOUND` before executing a single task. Both modules are now
   restored (`NetworkGuard` is an egress reachability watchdog, `KeyGuard`
   verifies the constitution hash and owner signature without claiming
   verification when no public key is configured), and two import paths
   (`base-marketplace`, `mission-hooks`) were corrected.
4. **No liveness signal.** `data/swarm-memory.json` still shows the last daemon
   tick at `2026-01-08T00:50:19Z`, the last autonomous audit at `2026-01-04`,
   `consecutiveFailures: 6` and a freeze opened `2026-01-04` for
   `webhook_missing` — the outage was invisible because nothing recorded it.

The old `auto-restart-loop.js` also forced `BASE44_OFFLINE=true` next to
`SWARM_LIVE=true`, which contradicts the daemon's own live-mode validation, and
restarted a one-shot script every five seconds (a crash loop, not a loop).

## What runs now

| Piece | Purpose |
| --- | --- |
| `scripts/swarm-tick.mjs` | One bounded tick. Runs `autonomous-daemon --all-good-summary` (safe tasks, no money movement) with a timeout, writes `data/swarm-heartbeat.json`, appends `data/swarm-tick-log.ndjson`, exits `0` ok / `1` failed / `2` blocked |
| `.github/workflows/swarm-tick.yml` | Cron `*/15 * * * *` + manual dispatch. Runs doctor, tick, then `--check-only` which **fails the run when no heartbeat was written for 90 minutes** |
| `scripts/swarm-doctor.mjs` | Preflight: node version, dependencies, live env, heartbeat freshness, stale freezes. `--clear-stale-freeze --ack-owner --reason "..."` clears and audits a stale freeze |
| `scripts/auto-restart-loop.js` | `npm start` supervisor for a VM: runs the same tick at `SWARM_LOOP_INTERVAL_MS` (default 15 min) with exponential backoff and a pid lock |
| `src/swarm/loop-health.mjs` | Heartbeat, env preflight, stale-freeze and state helpers used by all of the above |

## Restart checklist

```bash
npm ci                                    # dependencies are required for a real tick
npm run swarm:doctor                      # shows exactly what is blocking the loop
npm run swarm:tick                        # one tick; writes the heartbeat
node scripts/swarm-tick.mjs --check-only  # 0 = loop alive, 1 = loop dead
node --test test/network-guard.test.mjs test/swarm-loop-health.test.mjs
```

Expected doctor output once configured:

```
Swarm loop doctor
  [PASS] node          v22+
  [PASS] dependencies  installed
  [PASS] live_env      configured
  [PASS] heartbeat     last tick 1m ago (ok)
```

## Credentials

The tick needs the live configuration from `env.real-revenue.template`:
`SWARM_LIVE=true`, `BASE44_APP_ID`, `BASE44_SERVICE_TOKEN`,
`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` (plus
`AUTONOMOUS_ALLOWED_PAYPAL_RECIPIENTS` before any money-moving task is enabled).
Locally they go in `.env`; in CI add the same names as repository secrets
(Settings → Secrets and variables → Actions). The workflow also reads the
repository variable `SWARM_TICK_REVENUE` — set it to `true` only after a green
doctor run to also execute `scripts/run-swarm-orchestrated.mjs` each tick.

## Recovering the stale freeze

A freeze opened in January for a missing PayPal webhook is still marked active
and blocks money-moving tasks. It is cleared only with an explicit owner
acknowledgement, and the action is written to `audits/autonomous/<date>.jsonl`:

```bash
node scripts/swarm-doctor.mjs --clear-stale-freeze --ack-owner \
  --reason "stale freeze from 2026-01-04; loop recovered 2026-11-11"
```

## Monitoring: the loop must not go quiet again

* Every tick writes `data/swarm-heartbeat.json` with `status` (`ok`, `blocked`,
  `failed`), `tick_at`, `last_success_at`, `missing_env` and `last_error`.
* The workflow's `--check-only` step fails when the heartbeat is older than 90
  minutes, so GitHub marks the scheduled run failed and notifies you.
* A tick that runs but is blocked by missing configuration keeps a fresh
  heartbeat and prints an Actions warning (`::warning::`) instead of failing
  every 15 minutes — check the doctor step in the run summary.
* `npm test -- test/swarm-loop-health.test.mjs` (or
  `node --test test/swarm-loop-health.test.mjs`) covers heartbeat staleness,
  env preflight, stale-freeze detection and both daemon state formats.

## Local long-lived deployment

```bash
SWARM_LOOP_INTERVAL_MS=900000 npm start
```

The supervisor refuses to start if another pid holds `data/swarm-loop.lock`,
retries a blocked tick at the normal cadence (so fixing `.env` needs no
restart) and backs off exponentially on crashes.
