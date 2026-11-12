# Silent failure ("faillite silencieuse") — remediation and mitigation protocol

> Protocol id: `faillite-silencieuse/remediation-v1`

Silent failure is the failure mode this repository has already lived through:
the autonomous loop stopped on 2026-01-04, nothing recorded it, no alarm fired,
and the absence of a signal was read as the absence of a problem. The same shape
reappears whenever the loop ticks but is blocked on credentials, when a customer
order sits in a queue, or when a delivery is recorded without proof.

**Definition.** A silent failure exists whenever a component's health signal is
missing, stale, blocked or decoupled from the obligation it is supposed to
produce — revenue, delivery, fulfillment or audit evidence.

The protocol is implemented, not just documented:

| Phase | What happens | Where |
| --- | --- | --- |
| Detect | Heartbeat, revenue, procurement, fulfillment, audit and source scans | `src/resilience/silent-failure.mjs` |
| Contain | Findings classified `low → critical`; payout/settlement freeze when revenue stalls | `src/resilience/redress.mjs`, `src/real/money-moved-gate.mjs` |
| Remediate | Every finding carries a remedy, owner action, SLA and verification step | `FINDING_CATALOG` |
| Redress | Incident record with obligations, exposure and evidence | `data/resilience/incidents/` (gitignored) + `audits/autonomous/` |
| Prevent | Silence budget, dead-man switch, error-swallow ban, delivery gate | below |
| Verify | Re-audit must return below `--fail-on`; each finding states its verification | CLI |

No part of this protocol moves money. Monetary compensation requires explicit
owner authorization and is never inferred by the swarm.

## Detection matrix

| Finding | Severity | Trigger |
| --- | --- | --- |
| `LOOP_HEARTBEAT_MISSING` | critical | No heartbeat has ever been written |
| `LOOP_HEARTBEAT_STALE` | critical | Heartbeat older than `--max-silence-min` (default 90) |
| `LOOP_BLOCKED` | high | Fresh heartbeat but `blocked`/`ok:false` or missing live env |
| `REVENUE_STALL` | high | Latest financial record older than `--stall-days` (default 7) |
| `PROCUREMENT_DELIVERY_STALL` | high | POs placed/shipped longer than the stall window |
| `DELIVERY_UNVERIFIED` | medium | Delivered/on-hold POs without completed verification |
| `FULFILLMENT_BACKLOG` | high | `PENDING_DELIVERY` orders older than the stall window |
| `SILENT_EXCEPTION_SWALLOW` | medium | Empty (or comment-only) `catch` blocks in `src/`, `scripts/` |
| `AUDIT_BLINDSPOT` | medium | No audit entry for 7 days while heartbeats keep arriving |
| `PAYMENT_WEBHOOK_UNREACHABLE` | critical | Public webhook probe returns anything but `400 invalid_json` |
| `STOREFRONT_NOT_TRANSACTIONAL` | critical | The domain serves static HTML with no application runtime/API |
| `PAYPAL_UNFULFILLED_ORDERS` | critical | A dry-run reconciliation finds captured orders missing from the queue |
| `PAYPAL_RECONCILIATION_UNAVAILABLE` | medium | The reconciliation itself failed, so drift is unknown |

Findings that stay unresolved past the **silence budget** (`--silence-budget-hours`,
default 24) are escalated to `critical` with an audit trail. Silence is never
treated as success a second time.

### Payment webhook (P8)

A paid order whose webhook never arrives is silent revenue loss: the buyer is
charged, fulfilment never runs, and PayPal stops retrying. `--webhook-url`
(or `PAYMENT_WEBHOOK_URL`) sends one `not-json` POST from this host and expects
`400 invalid_json`:

| Status | Verdict |
| --- | --- |
| 400 | reachable and configured |
| 404 | route not deployed on that host |
| 401/403/302/307 | deployment protection blocks PayPal |
| 503 | route present, webhook id or credentials missing |
| 5xx | server failure, fulfilment unproven |

```bash
npm run resilience -- audit \
  --webhook-url https://<public-host>/api/webhooks/paypal --fail-on high
```

Any status other than 400 is `PAYMENT_WEBHOOK_UNREACHABLE` (critical). A bare
`--webhook-url` with no value is a usage error (exit 1), and a non-http(s) value
is rejected before any request is made. The probe is read-only and sends no
order or buyer data.

### Storefront capability

`--storefront-url` (or `STOREFRONT_URL`) checks the live domain: it loads the
homepage, looks for an application runtime (`_next`/`__NEXT_DATA__`) and probes
`/api/healthz`. A 200 page with neither is `STOREFRONT_NOT_TRANSACTIONAL`
(critical): the deployed directory has no API routes, so checkout and webhooks
cannot work regardless of the application code elsewhere.

```bash
npm run resilience -- audit --storefront-url https://www.realworldcerts.com --fail-on high
```

### Paid-but-unfulfilled orders

`--reconcile-paypal` runs the idempotent reconciliation in dry-run mode as part
of the audit (and therefore in the tick workflow): it scans PayPal reporting
transactions, verifies a `COMPLETED` capture, and compares each order id with
`logs/fulfillment_queue.log`. Any captured order missing from the queue is
`PAYPAL_UNFULFILLED_ORDERS` (critical). If the check itself cannot run, it is
`PAYPAL_RECONCILIATION_UNAVAILABLE` (medium) — never a silent "0 missing".
Without PayPal credentials the step prints a skip message and records the skip
in evidence; the loop-blocked finding already covers that state.

```bash
npm run resilience -- audit --reconcile-paypal --fail-on high
npm run reconcile:paypal -- --apply     # replay after reviewing the finding
```

## Redress: what "full" means here

Each incident (`data/resilience/incidents/SF-YYYYMMDD-xxxxxxxx.json`) contains:

- the findings, severity, first-seen, silent hours and occurrences;
- the obligation that is not being met and the owner action that satisfies it;
- an SLA deadline (`sla_hours` per finding);
- quantified exposure: stalled PO value (MAD), unverified PO value, pending
  fulfillments, stalled revenue days, swallowed exceptions;
- postconditions and residual risk;
- the full mitigation list.

Redress is complete only when every obligation has a completed owner action, the
verification step passes, and a re-audit is clear. The incident and audit entry
are retained as evidence; the protocol never deletes its own history.

## Mitigations (implemented)

1. **Heartbeat contract** — every tick writes `data/swarm-heartbeat.json`; a
   missing signal is a failure, not a default-healthy state.
2. **Dead-man switch** — the scheduled workflow fails when no heartbeat was
   written for 90 minutes.
3. **Silence budget** — persistent findings escalate to critical after 24h.
4. **Fail-loud sentinel** — the audit exits `2` at or above `--fail-on`
   (default `high`); CI cannot stay green through a silent failure.
5. **Error-swallow ban** — static scan for empty catch blocks.
6. **Delivery verification gate** — no PO closes without POD evidence and a
   3-way match (see `PROCUREMENT.md`).
7. **Pre-paid invariant** — owner-initiated procurement is pre-paid by the
   swarm; recipients never disburse.
8. **Owner-gated freeze release** — clearing a stale money freeze requires
   `--ack-owner` and writes an audit record.
9. **Self-redress engine** — four reversible actions, persisted to
   `data/resilience/redress.json`:
   - `velocity_breaker` — no confirmed revenue for the stall window while ticks
     succeed → halt new settlements for 300s and require a capital audit;
   - `log_monotony_entropy` — >70% duplicate tick outcomes → shift 15% of
     publish routing to a backup channel for 5 minutes;
   - `cannibalistic_global_lock` — duplicate settlements on a cycle → 10-minute
     mutex on that cycle;
   - `context_hydration` — re-inject the frozen prompt genesis (objective,
     KPIs, safety boundaries), rate-limited to once per hour.
10. **Settlement freeze gate** — `MoneyMovedGate` rejects settlement assertions
    while the velocity breaker is active (`MONEY_GATE_FAIL: settlement_frozen_…`).
11. **Audit trail** — every trigger and clear is appended to
    `audits/autonomous/<date>.jsonl`.
12. **Owner-gated money** — no code path here transfers funds or promises
    compensation.

## Operating it

```bash
# Detect and print the full plan (no state written)
node scripts/silent-failure.mjs audit

# Record the incident, audit entry and redress evaluation
node scripts/silent-failure.mjs redress

# Machine-readable; exit 2 on high/critical findings
node scripts/silent-failure.mjs audit --json --fail-on high

# Mitigation controls
node scripts/silent-failure.mjs mitigations
node scripts/silent-failure.mjs status
node scripts/silent-failure.mjs trigger velocity_breaker --reason "9d without revenue"
node scripts/silent-failure.mjs trigger cannibalistic_global_lock --cycle cycle-A
node scripts/silent-failure.mjs clear all --audit-done
node scripts/silent-failure.mjs check-settlements   # exit 3 when frozen
```

The sentinel runs in `.github/workflows/swarm-tick.yml` right after the loop
liveness check, and uploads `data/resilience/incidents/*.json` as evidence. The
local supervisor (`npm start`) runs the same audit after every tick via
`src/swarm/tick-audit.mjs` (`SWARM_TICK_AUDIT=false` disables it), so a VM
deployment raises the same findings as CI.
Set the repository **variable** `PAYMENT_WEBHOOK_URL` (comma-separated for
several hosts) to enable the P8 probe on every tick; leaving it empty skips the
probe. While live credentials are missing, the step is expected to fail: a
fresh heartbeat that cannot earn is exactly the silent failure this protocol
exists to expose.

Registered hosts for the P8 probe (verified 2026-11-12):

```
https://www.realworldcerts.com/api/webhooks/paypal          -> 404
https://supply-chain-swarm.vercel.app/api/webhooks/paypal   -> 401
https://swarm-ops-project.vercel.app/api/webhooks/paypal    -> 401
```

The `401` hosts are protected, not healthy: PayPal cannot authenticate through
deployment protection. A probe that returns 401 must not be read as "route
alive".

## Current limitations

- The linked repository `younestsouli2019-bot/Nouveau-dossier-3-` is not
  publicly readable, so this implementation is based on the connected repository
  and the public self-redress design in `swarm-ops-project`.
- Revenue evidence is read from local runtime data (`data/finance/events`,
  `data/sales`, `data/commerce`). In a fresh CI checkout there is no such data,
  so `REVENUE_STALL` is not asserted where revenue cannot be observed — absence
  of evidence is reported separately instead of being invented.
- Mitigations gate behaviour; they do not repair external systems. Placing
  supplier orders, paying carriers and refunding customers still require owner
  accounts and authorization.

## Tests

```bash
npm run test:resilience
```

Covers detection for every signal, the silence-budget escalation, incident
persistence, the four redress actions (trigger, expiry, persistence, dedupe,
rate limit), the settlement gate and the completeness of each finding's
remediation contract.
