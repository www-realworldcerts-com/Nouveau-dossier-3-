import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
    appendAudit,
    heartbeatAgeMs,
    heartbeatPath,
    missingLiveEnv,
    readHeartbeat
} from '../swarm/loop-health.mjs';
import { ProcurementStore } from '../procurement/store.mjs';
import { evaluatePo } from '../procurement/po.mjs';
import { buildContentieuxCases } from '../procurement/contentieux.mjs';
import { RedressEngine } from './redress.mjs';
import { probeVerdictHint } from './webhook-probe.mjs';
import { storefrontVerdictHint } from './storefront-probe.mjs';

/**
 * Silent-failure ("faillite silencieuse") protocol.
 *
 * Silent failure is the failure mode this repository has actually suffered:
 * the loop stopped, nothing recorded it, no alarm fired, and the absence of a
 * signal was mistaken for the absence of a problem. This module treats a
 * missing, stale or blocked signal as a finding, quantifies the obligations
 * that are not being met, and produces a redress plan with an owner action,
 * a deadline and a verification step for every finding.
 *
 * It never moves money. Monetary redress stays owner-gated.
 */

export const SEVERITY_RANK = { low: 1, warning: 2, medium: 2, high: 3, critical: 4 };
export const DEFAULT_MAX_SILENCE_MIN = 90;
export const DEFAULT_STALL_DAYS = 7;
export const DEFAULT_SILENCE_BUDGET_HOURS = 24;

export const FINDING_CATALOG = {
    LOOP_HEARTBEAT_MISSING: {
        domain: 'operations',
        severity: 'critical',
        title: 'Swarm loop has never recorded a heartbeat',
        impact: 'No tick is proven to run: sales, payouts and PO tracking are all unowned.',
        containment: 'Treat every autonomous claim as stale; no settlement may be reported as successful.',
        obligation: 'Restore a scheduled loop and prove it with a fresh heartbeat.',
        remedy: 'Configure the live environment, run a bounded tick, confirm the heartbeat file is fresh.',
        mitigation: 'Dead-man switch: the tick workflow fails when the heartbeat is older than 90 minutes.',
        verification: '`node scripts/swarm-tick.mjs --check-only` exits 0.',
        owner_action: 'Set live credentials and run `npm run swarm:tick`.',
        sla_hours: 1
    },
    LOOP_HEARTBEAT_STALE: {
        domain: 'operations',
        severity: 'critical',
        title: 'Swarm loop heartbeat is stale',
        impact: 'The loop may have stopped silently; nothing is executing or earning.',
        containment: 'Fail the pipeline, page the owner and block money-moving tasks.',
        obligation: 'Restart the loop and record why it stopped.',
        remedy: 'Inspect the last tick log, fix the failing step, run a tick and confirm the heartbeat.',
        mitigation: 'Scheduled workflow with `--check-only --max-silence-min 90` plus the supervisor backoff.',
        verification: 'A heartbeat younger than the silence budget exists and the next scheduled tick succeeds.',
        owner_action: 'Run `npm run swarm:doctor`, then `npm run swarm:tick`.',
        sla_hours: 1
    },
    LOOP_BLOCKED: {
        domain: 'revenue',
        severity: 'high',
        title: 'Loop ticks but is blocked from earning',
        impact: 'The system looks alive — fresh heartbeat, green process — while no revenue or delivery can happen.',
        containment: 'Label the loop "running but non-earning"; stop reporting healthy status.',
        obligation: 'Provide the missing configuration so ticks can execute revenue work.',
        remedy: 'Add the missing environment variables/secrets listed in the evidence, then run a live tick.',
        mitigation: 'Doctor preflight and this sentinel classify blocked ticks as findings, not success.',
        verification: 'A tick reports `ok` with `revenue_enabled: true` and missing_env empty.',
        owner_action: 'Set the missing secrets and rerun the tick workflow.',
        sla_hours: 4
    },
    REVENUE_STALL: {
        domain: 'revenue',
        severity: 'high',
        title: 'No confirmed revenue for longer than the stall window',
        impact: 'Operating costs and pre-paid obligations continue while inflow is zero: the definition of silent bankruptcy.',
        containment: 'Halt new settlements and require a capital-efficiency audit before resuming.',
        obligation: 'Restore a revenue path or stop incurring obligations.',
        remedy: 'Audit pricing/publish/checkout, publish approved offers, verify a real payment and record it.',
        mitigation: 'Velocity-without-revenue circuit breaker in the self-redress engine.',
        verification: 'A new externally confirmed revenue event appears in the ledger within the stall window.',
        owner_action: 'Review the sales pipeline and confirm one end-to-end paid order.',
        sla_hours: 24
    },
    PROCUREMENT_DELIVERY_STALL: {
        domain: 'procurement',
        severity: 'high',
        title: 'Placed purchase orders have not been delivered',
        impact: 'Owner funds are committed and the swarm cannot show a successful delivery.',
        containment: 'Keep the POs open; never mark them delivered without carrier evidence.',
        obligation: 'Obtain delivery or a refund for every stalled PO.',
        remedy: 'Contact the carrier/supplier with the tracking number, ingest scans, record POD, verify 3-way match.',
        mitigation: 'PO delivery evidence gate and AMANA scan ingestion.',
        verification: 'Each stalled PO reaches delivered/verified with POD, weight, city and invoice match.',
        owner_action: 'Provide carrier tracking/POD or escalate the order with the supplier.',
        sla_hours: 48
    },
    PROCUREMENT_CONTENTIEUX: {
        domain: 'procurement',
        severity: 'high',
        title: 'Purchase orders need contentieux action',
        impact: 'Paid or committed orders are late, held or unverifiable, so owner funds are exposed without a delivery.',
        containment: 'Keep every listed case open; do not close a PO or release payment without the missing evidence.',
        obligation: 'Resolve every contentieux case by obtaining delivery or a refund.',
        remedy: 'Open the case file, request the missing evidence from the supplier/carrier, and escalate per the case next action.',
        mitigation: 'Contentieux case generation in every audit, with case IDs, amounts and aging.',
        verification: 'The next audit reports zero contentieux cases and no PO older than the stall window.',
        owner_action: 'Work the high-severity cases first and provide carrier POD or supplier refund evidence.',
        sla_hours: 48
    },
    DELIVERY_UNVERIFIED: {
        domain: 'procurement',
        severity: 'medium',
        title: 'Deliveries recorded without completed verification',
        impact: 'Goods may be missing or short while the PO looks fulfilled.',
        containment: 'Keep the PO on hold; no closure and no payout against it.',
        obligation: 'Complete the 3-way match or reject the delivery.',
        remedy: 'Attach the goods receipt and supplier invoice, resolve holds, re-run verification.',
        mitigation: 'Verified-only closure (`close` requires status verified).',
        verification: '`npm run procurement -- verify` exits 0 and the PO status is verified.',
        owner_action: 'Supply the goods receipt and invoice, or confirm the dispute.',
        sla_hours: 24
    },
    FULFILLMENT_BACKLOG: {
        domain: 'fulfillment',
        severity: 'high',
        title: 'Customer fulfillment queue has aged pending items',
        impact: 'Customers paid but received nothing; silent churn and refund exposure.',
        containment: 'Stop new sales promises until the backlog is cleared.',
        obligation: 'Deliver or refund every pending order.',
        remedy: 'Work the fulfillment queue oldest-first and record proof of delivery/refund.',
        mitigation: 'Backlog age detection in this sentinel.',
        verification: 'No PENDING_DELIVERY entry older than the stall window remains.',
        owner_action: 'Fulfil or refund the oldest pending orders.',
        sla_hours: 48
    },
    SILENT_EXCEPTION_SWALLOW: {
        domain: 'code',
        severity: 'medium',
        title: 'Empty catch blocks swallow failures',
        impact: 'Errors disappear and components appear healthy while doing nothing.',
        containment: 'Treat swallowed errors as unknown state until logged.',
        obligation: 'Make every failure observable.',
        remedy: 'Log or rethrow inside each empty catch block; never leave a silent catch.',
        mitigation: 'Static scan in this sentinel fails the audit when silent catches exist.',
        verification: 'The scan reports zero empty catch blocks in src/ and scripts/.',
        owner_action: 'Assign each listed file and add logging/rethrow.',
        sla_hours: 72
    },
    AUDIT_BLINDSPOT: { 
        domain: 'governance',
        severity: 'medium',
        title: 'No audit record within the governance window',
        impact: 'Actions cannot be reconstructed; silent failures leave no evidence trail.',
        containment: 'Freeze policy changes until auditing is restored.',
        obligation: 'Record every autonomous action with a timestamp.',
        remedy: 'Restore audit writes on tick/redress paths and backfill the missing window.',
        mitigation: 'Mandatory audit append in the redress engine and freeze release.',
        verification: 'A new audit entry exists within the governance window.',
        owner_action: 'Check that `audits/autonomous/` is writable and the tick is appending.',
        sla_hours: 72
    },
    STOREFRONT_NOT_TRANSACTIONAL: {
        domain: 'revenue',
        severity: 'critical',
        title: 'Storefront has no transactional runtime',
        impact: 'The domain can answer 200 while serving static HTML from a directory with no API routes: checkout and webhook delivery are impossible, so every marketing visit is dead-end traffic.',
        containment: 'Stop treating the live domain as a working sales channel; do not report sales readiness.',
        obligation: 'Deploy the application build to the domain, or wire the static site to a hosted checkout/payment rail.',
        remedy: 'Confirm which Vercel project is attached to the domain; repoint it at the application repository and root, or add hosted payment links and a reachable webhook.',
        mitigation: 'Storefront capability probe on every tick distinguishes a static build from a working application.',
        verification: 'The homepage exposes an application runtime and /api/webhooks/paypal returns 400 invalid_json.',
        owner_action: 'Repoint the Vercel project serving www.realworldcerts.com at the app root, or attach a hosted checkout to the static site.',
        sla_hours: 24
    },
    STOREFRONT_UNREACHABLE: {
        domain: 'revenue',
        severity: 'warning',
        title: 'Storefront reachability could not be verified',
        impact: 'A network error or edge 5xx hides whether the domain can transact. It is not evidence of a broken deployment, but a sustained outage still blocks sales.',
        containment: 'Do not claim the storefront is healthy or broken while reachability is unknown; retry on the next tick.',
        obligation: 'Confirm the domain answers before drawing any conclusion about the deployed build.',
        remedy: 'Check DNS, the Vercel deployment status and upstream errors; rerun the probe once the edge recovers.',
        mitigation: 'Transport failures are retried with backoff and reported separately from deployment findings.',
        verification: 'A later probe returns application or static_only with an HTTP response from the origin.',
        owner_action: 'Check the Vercel deployment/edge status if this persists beyond one tick.',
        sla_hours: 72
    },
    STOREFRONT_HTTP_ERROR: {
        domain: 'revenue',
        severity: 'warning',
        title: 'Storefront answered with an unexpected HTTP status',
        impact: 'The origin responded, so this is not a network blip, but the page or API is not serving the expected 200/404 contract.',
        containment: 'Do not treat the deployment as verified while the unexpected status persists.',
        obligation: 'Identify which layer returns the status and restore the expected response.',
        remedy: 'Check the deployment logs for the storefront and its health routes (/api/healthz, /health); fix the failing page or API.',
        mitigation: 'HTTP errors are reported separately from static builds and from transport failures.',
        verification: 'The homepage returns 200 and a health route returns 200 or 404.',
        owner_action: 'Inspect the Vercel deployment logs for the failing response.',
        sla_hours: 48
    },
    PAYPAL_UNFULFILLED_ORDERS: {
        domain: 'revenue',
        severity: 'critical',
        title: 'Paid PayPal orders are missing fulfilment',
        impact: 'Buyers were charged and PayPal captured the payment, but no delivery was queued. Missed webhooks become silent revenue loss and refund exposure.',
        containment: 'Stop reporting fulfilment as healthy; do not mark these orders delivered.',
        obligation: 'Deliver or refund every captured order that is absent from the fulfilment queue.',
        remedy: 'Run the reconciliation with --apply (idempotent), then deliver each queued order and fix the webhook path that missed it.',
        mitigation: 'Dry-run reconciliation in every tick; any drift is a critical finding.',
        verification: 'A later dry run reports missing_count 0 and every order has a fulfilment record.',
        owner_action: 'Run `npm run reconcile:paypal -- --apply`, then deliver/refund the listed orders.',
        sla_hours: 4
    },
    PAYPAL_RECONCILIATION_UNAVAILABLE: {
        domain: 'revenue',
        severity: 'medium',
        title: 'PayPal reconciliation could not verify fulfilment',
        impact: 'Paid-but-unfulfilled orders cannot be seen, so webhook drift is unknown.',
        containment: 'Do not read "no missing orders" as verified while this check is failing.',
        obligation: 'Restore read access so every captured order can be compared with the queue.',
        remedy: 'Fix PayPal credentials or reporting API access, then rerun the dry run.',
        mitigation: 'A failed reconciliation is recorded as a finding, never silently skipped.',
        verification: 'The reconciliation returns a report with search_error null.',
        owner_action: 'Check PayPal credentials and reporting API access.',
        sla_hours: 24
    },
    PAYMENT_WEBHOOK_UNREACHABLE: {
        domain: 'revenue',
        severity: 'critical',
        title: 'Payment webhook cannot deliver to the application',
        impact: 'A buyer can pay and never receive the product: the payment succeeds, fulfilment never runs, and PayPal eventually stops retrying. Silent revenue loss with no alarm.',
        containment: 'Treat webhook fulfilment as unavailable; do not rely on the backup delivery path.',
        obligation: 'Restore a reachable, authenticated webhook endpoint and deliver every missed order.',
        remedy: 'Deploy a build containing the webhook route, configure its credentials, remove or bypass the protection layer, then replay missed notifications.',
        mitigation: 'Public reachability probe expects HTTP 400 invalid_json; 404/401/503 are findings, not benign responses.',
        verification: 'POST not-json to the public webhook URL returns 400, and a signed PayPal sandbox notification is fulfilled idempotently.',
        owner_action: 'Fix the deployment surface (route deployed, protection bypass or preview-only SSO) and verify with the P8 acceptance probe.',
        sla_hours: 4
    }
};

const REVENUE_DIRS = ['data/sales', 'data/finance/events', 'data/commerce'];
const DATE_KEYS = new Set(['timestamp', 'created_at', 'at', 'settled_at', 'date', 'updated_at']);

const iso = value => new Date(value).toISOString();
const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function walkFiles(dir, visit, state, maxFiles) {
    if (state.scanned >= maxFiles) return;
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (state.scanned >= maxFiles) return;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walkFiles(file, visit, state, maxFiles);
        else if (entry.isFile() && /\.json$/i.test(entry.name)) {
            state.scanned += 1;
            visit(file);
        }
    }
}

/**
 * Latest externally-confirmed revenue timestamp. Only records that look
 * financial (amount/revenue/total or a settled_at field) are considered, so a
 * setup report cannot masquerade as revenue activity.
 */
export function readRevenueEvidence(root = process.cwd(), { maxFiles = 300 } = {}) {
    let latest = 0;
    const sources = [];
    const state = { scanned: 0 };
    for (const rel of REVENUE_DIRS) {
        walkFiles(path.join(root, rel), file => {
            const data = readJson(file);
            if (!data) return;
            const visit = (node, depth = 0) => {
                if (!node || typeof node !== 'object' || depth > 4) return;
                if (Array.isArray(node)) {
                    for (const item of node) visit(item, depth + 1);
                    return;
                }
                const financial = ['amount', 'revenue', 'total', 'settled_at']
                    .some(key => (key === 'settled_at' ? key in node : Number.isFinite(Number(node[key]))));
                if (financial) {
                    for (const [key, value] of Object.entries(node)) {
                        if (!DATE_KEYS.has(key) || typeof value !== 'string') continue;
                        const time = Date.parse(value);
                        if (Number.isFinite(time) && time > latest) {
                            latest = time;
                            sources.length = 0;
                            sources.push(file);
                        }
                    }
                }
                for (const value of Object.values(node)) {
                    if (value && typeof value === 'object') visit(value, depth + 1);
                }
            };
            visit(data);
        }, state, maxFiles);
    }
    return {
        last_activity_at: latest ? iso(latest) : null,
        sources: [...new Set(sources)],
        scanned_files: state.scanned
    };
}

export function readProcurementPos(root = process.cwd()) {
    const dir = path.join(root, 'data', 'procurement');
    if (!fs.existsSync(path.join(dir, 'pos.ndjson'))) return [];
    return new ProcurementStore({ dir }).listPos();
}

export function readFulfillmentQueue(root = process.cwd()) {
    const file = path.join(root, 'logs', 'fulfillment_queue.log');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
            try {
                return JSON.parse(line);
            } catch {
                return null;
            }
        })
        .filter(Boolean);
}

export function scanSilentCatchBlocks(root = process.cwd(), { dirs = ['src', 'scripts'] } = {}) {
    const pattern = /catch\s*(?:\([^)]*\))?\s*\{\s*(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*\}/g;
    const samples = [];
    let count = 0;
    const walk = dir => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const file = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (['node_modules', '.git', 'test', 'tests'].includes(entry.name)) continue;
                walk(file);
                continue;
            }
            if (!/\.(?:mjs|cjs|js)$/i.test(entry.name)) continue;
            const content = fs.readFileSync(file, 'utf8');
            for (const match of content.matchAll(pattern)) {
                count += 1;
                if (samples.length < 10) {
                    const line = content.slice(0, match.index).split('\n').length;
                    samples.push(`${path.relative(root, file)}:${line}`);
                }
            }
        }
    };
    for (const rel of dirs) walk(path.join(root, rel));
    return { count, samples, dirs };
}

export function latestAuditAt(root = process.cwd()) {
    const dir = path.join(root, 'audits', 'autonomous');
    if (!fs.existsSync(dir)) return null;
    let latest = 0;
    for (const name of fs.readdirSync(dir)) {
        try {
            latest = Math.max(latest, fs.statSync(path.join(dir, name)).mtimeMs);
        } catch {
            // ignore unreadable entries
        }
    }
    return latest ? iso(latest) : null;
}

export function readTickMonotony(root = process.cwd()) {
    const file = path.join(root, 'data', 'swarm-tick-log.ndjson');
    if (!fs.existsSync(file)) return { samples: 0, duplicate_rate: 0 };
    const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-20)
        .map(line => {
            try {
                return JSON.parse(line);
            } catch {
                return null;
            }
        })
        .filter(Boolean);
    if (rows.length < 5) return { samples: rows.length, duplicate_rate: 0 };
    const statuses = rows.map(row => String(row.status || row.outcome || 'unknown'));
    const unique = new Set(statuses).size;
    return { samples: rows.length, duplicate_rate: round(1 - unique / statuses.length, 2) };
}

export function detectSilentFailures({
    root = process.cwd(),
    now = new Date(),
    env = process.env,
    heartbeat,
    maxSilenceMin = DEFAULT_MAX_SILENCE_MIN,
    stallDays = DEFAULT_STALL_DAYS,
    revenue,
    procurement,
    fulfillment,
    silentCatches,
    auditLatest,
    tickMonotony,
    webhookProbes,
    paypalReconciliation,
    storefrontProbe
} = {}) {
    const at = now instanceof Date ? now : new Date(now);
    const findings = [];
    const add = (code, detail, evidence, severity) => {
        const meta = FINDING_CATALOG[code];
        findings.push({
            code,
            domain: meta.domain,
            severity: severity || meta.severity,
            title: meta.title,
            detail,
            evidence: evidence || null,
            detected_at: iso(at)
        });
    };

    const hb = heartbeat === undefined ? readHeartbeat(heartbeatPath(root)) : heartbeat;
    let heartbeatStatus = null;
    let heartbeatAge = null;
    if (!hb) {
        add('LOOP_HEARTBEAT_MISSING', 'No heartbeat file exists: no tick has ever been recorded.', {
            path: heartbeatPath(root)
        });
    } else {
        heartbeatAge = heartbeatAgeMs(hb, at.getTime());
        heartbeatStatus = hb.status || (hb.ok === false ? 'blocked' : 'ok');
        if (heartbeatAge > maxSilenceMin * 60000) {
            add('LOOP_HEARTBEAT_STALE', `Last heartbeat was ${round(heartbeatAge / 60000)} minutes ago (budget ${maxSilenceMin} minutes).`, {
                last_tick: hb.at || hb.tick_at || null,
                status: heartbeatStatus,
                last_error: hb.last_error || null
            });
        } else if (heartbeatStatus === 'blocked' || hb.ok === false) {
            const missing = hb.missing_env || missingLiveEnv(env);
            add('LOOP_BLOCKED', hb.blocked_reason || `Tick reports blocked with missing env: ${missing.join(', ')}`, {
                heartbeat_status: heartbeatStatus,
                missing_env: missing,
                revenue_enabled: hb.revenue_enabled ?? null,
                last_success_at: hb.last_success_at ?? null
            });
        }
    }

    const rev = revenue === undefined ? readRevenueEvidence(root) : revenue;
    let stallDaysObserved = null;
    if (rev?.last_activity_at) {
        stallDaysObserved = round((at.getTime() - Date.parse(rev.last_activity_at)) / 86400000, 1);
        if (stallDaysObserved >= stallDays) {
            add('REVENUE_STALL', `No financially-relevant record for ${stallDaysObserved} days (stall window ${stallDays} days).`, {
                last_activity_at: rev.last_activity_at,
                sources: rev.sources || [],
                stalled_days: stallDaysObserved
            });
        }
    }

    const pos = procurement === undefined ? readProcurementPos(root) : procurement;
    const views = pos.map(po => evaluatePo(po, { now: at }));
    const stalled = views.filter(view => ['placed', 'shipped'].includes(view.status) && view.waiting_days >= stallDays);
    const unverified = views.filter(view => {
        if (!['delivered', 'on_hold'].includes(view.status)) return false;
        const po = pos.find(candidate => candidate.po_ref === view.po_ref);
        const since = Date.parse(po?.delivered_at || po?.updated_at || po?.created_at || '');
        const age = Number.isFinite(since) ? (at.getTime() - since) / 86400000 : Infinity;
        return age >= Math.max(1, stallDays / 2);
    });
    if (stalled.length) {
        add('PROCUREMENT_DELIVERY_STALL', `${stalled.length} PO(s) placed but not delivered within ${stallDays} days.`, {
            po_refs: stalled.map(view => view.po_ref),
            waiting_days: stalled.map(view => ({ po_ref: view.po_ref, days: view.waiting_days })),
            value_mad: round(stalled.reduce((sum, view) => sum + Number(view.subtotal_mad || 0), 0), 2)
        });
    }
    if (unverified.length) {
        add('DELIVERY_UNVERIFIED', `${unverified.length} delivery record(s) not verified/closed.`, {
            po_refs: unverified.map(view => view.po_ref),
            statuses: unverified.map(view => ({ po_ref: view.po_ref, status: view.status, holds: view.holds }))
        });
    }

    const contentieux = buildContentieuxCases(pos, { now: at, minDays: stallDays });
    if (contentieux.cases.length) {
        const severityRank = { low: 1, medium: 2, high: 3 };
        const highest = [...contentieux.cases].sort((a, b) => severityRank[b.severity] - severityRank[a.severity])[0];
        const oldest = Math.max(...contentieux.cases.map(item => item.waiting_days));
        add(
            'PROCUREMENT_CONTENTIEUX',
            `${contentieux.cases.length} contentieux case(s), ${contentieux.totals.amount_mad} MAD at stake, oldest ${round(oldest)} days.`,
            {
                case_ids: contentieux.cases.map(item => item.case_id),
                cases: contentieux.cases.map(item => ({
                    case_id: item.case_id,
                    po_ref: item.po_ref,
                    supplier: item.supplier,
                    status: item.status,
                    amount_mad: item.amount_mad,
                    waiting_days: item.waiting_days,
                    severity: item.severity,
                    holds: item.holds.map(hold => hold.code),
                    next_action: item.next_action
                })),
                amount_at_stake_mad: contentieux.totals.amount_mad,
                oldest_waiting_days: round(oldest),
                high_severity: contentieux.totals.high
            },
            highest.severity
        );
    }

    const queue = fulfillment === undefined ? readFulfillmentQueue(root) : fulfillment;
    const pending = queue.filter(entry => String(entry.status || '').toUpperCase() === 'PENDING_DELIVERY');
    const pendingDays = pending.map(entry => {
        const time = Date.parse(entry.timestamp || '');
        return Number.isFinite(time) ? (at.getTime() - time) / 86400000 : Infinity;
    });
    const oldestPending = pendingDays.length ? Math.max(...pendingDays) : 0;
    if (pending.length && oldestPending >= stallDays) {
        add('FULFILLMENT_BACKLOG', `${pending.length} customer order(s) pending delivery, oldest ${round(oldestPending)} days.`, {
            pending_count: pending.length,
            oldest_days: round(oldestPending)
        });
    }

    const catches = silentCatches === undefined ? scanSilentCatchBlocks(root) : silentCatches;
    if (catches?.count > 0) {
        add('SILENT_EXCEPTION_SWALLOW', `${catches.count} empty catch block(s) hide failures.`, {
            count: catches.count,
            samples: catches.samples || []
        });
    }

    const audit = auditLatest === undefined ? latestAuditAt(root) : auditLatest;
    const auditAgeDays = audit ? (at.getTime() - Date.parse(audit)) / 86400000 : null;
    if (hb && heartbeatAge !== null && heartbeatAge <= maxSilenceMin * 60000 && audit && auditAgeDays > 7) {
        add('AUDIT_BLINDSPOT', `No audit entry for ${round(auditAgeDays)} days while the loop reports ticks.`, {
            latest_audit_at: audit,
            age_days: round(auditAgeDays)
        });
    }

    if (paypalReconciliation && typeof paypalReconciliation === 'object') {
        if (paypalReconciliation.report) {
            const report = paypalReconciliation.report;
            if (Number(report.missing_count) > 0) {
                add('PAYPAL_UNFULFILLED_ORDERS', `${report.missing_count} captured order(s) are absent from the fulfilment queue.`, {
                    order_ids: (report.missing || []).map(order => order.order_id),
                    missing: report.missing || [],
                    window: report.window || null
                });
            }
        } else if (paypalReconciliation.error) {
            add('PAYPAL_RECONCILIATION_UNAVAILABLE', paypalReconciliation.error, {
                reason: paypalReconciliation.error
            });
        }
    }

    if (storefrontProbe && typeof storefrontProbe === 'object' && !storefrontProbe.ok) {
        const verdict = storefrontProbe.verdict;
        const code = verdict === 'unreachable'
            ? 'STOREFRONT_UNREACHABLE'
            : (verdict === 'http_error' ? 'STOREFRONT_HTTP_ERROR' : 'STOREFRONT_NOT_TRANSACTIONAL');
        add(code, `${storefrontProbe.url} -> ${verdict}: ${storefrontVerdictHint(verdict)}`, {
            status: storefrontProbe.status,
            health_status: storefrontProbe.health_status,
            health_path: storefrontProbe.health_path || null,
            health_error: storefrontProbe.health_error || null,
            app_runtime: storefrontProbe.app_runtime,
            api_alive: storefrontProbe.api_alive,
            checkout_link: storefrontProbe.checkout_link,
            verdict,
            attempts: storefrontProbe.attempts || null,
            error: storefrontProbe.error || null
        });
    }

    const probes = webhookProbes || [];
    const failingProbes = probes.filter(probe => !probe.ok);
    if (failingProbes.length) {
        add('PAYMENT_WEBHOOK_UNREACHABLE', failingProbes.map(probe => `${probe.url} -> ${probe.status ?? 'no response'} (${probe.verdict}: ${probeVerdictHint(probe.verdict)})`).join('; '), {
            probes: failingProbes
        });
    }

    const monotony = tickMonotony === undefined ? readTickMonotony(root) : tickMonotony;
    const duplicates = pos.length
        ? Object.entries(pos.reduce((acc, po) => {
            if (!po.external_id) return acc;
            acc[po.external_id] = (acc[po.external_id] || 0) + 1;
            return acc;
        }, {})).filter(([, count]) => count > 1)
            .map(([external_id, count]) => ({ external_id, count }))
        : [];

    return {
        findings,
        evidence: {
            heartbeat: hb ? { status: heartbeatStatus, age_ms: heartbeatAge } : { status: 'missing', age_ms: null },
            revenue: { ...rev, stalled_days: stallDaysObserved },
            procurement: {
                total: pos.length,
                stalled: stalled.length,
                unverified: unverified.length,
                stalled_value_mad: round(stalled.reduce((sum, view) => sum + Number(view.subtotal_mad || 0), 0), 2),
                contentieux: {
                    cases: contentieux.cases.length,
                    amount_at_stake_mad: contentieux.totals.amount_mad,
                    oldest_waiting_days: contentieux.cases.length
                        ? round(Math.max(...contentieux.cases.map(item => item.waiting_days)))
                        : 0,
                    high_severity: contentieux.totals.high
                },
                contentieux_cases: contentieux.cases
            },
            fulfillment: { pending: pending.length, oldest_days: round(oldestPending) },
            silent_catches: catches,
            audit: { latest_at: audit, age_days: auditAgeDays === null ? null : round(auditAgeDays) },
            webhook_probes: probes,
            paypal_reconciliation: paypalReconciliation || null,
            storefront_probe: storefrontProbe || null,
            monotony,
            duplicates: { count: duplicates.reduce((sum, row) => sum + (row.count - 1), 0), cycles: duplicates, cycle_id: duplicates.length ? 'procurement' : null }
        }
    };
}

export function listMitigations() {
    return [
        { id: 'heartbeat_contract', control: 'Every tick writes a heartbeat; absent signal counts as failure.', status: 'implemented', where: 'src/swarm/loop-health.mjs' },
        { id: 'dead_man_switch', control: 'Scheduled CI fails when no heartbeat was written for 90 minutes.', status: 'implemented', where: '.github/workflows/swarm-tick.yml' },
        { id: 'silence_budget', control: 'Unresolved findings escalate to critical after 24 hours.', status: 'implemented', where: 'src/resilience/silent-failure.mjs' },
        { id: 'fail_loud_sentinel', control: 'Silent-failure audit exits non-zero at or above the configured severity.', status: 'implemented', where: 'scripts/silent-failure.mjs' },
        { id: 'error_swallow_ban', control: 'Static scan reports empty catch blocks.', status: 'implemented', where: 'src/resilience/silent-failure.mjs' },
        { id: 'delivery_verification_gate', control: 'POs cannot close without POD evidence and 3-way match.', status: 'implemented', where: 'src/procurement/' },
        { id: 'pre_paid_invariant', control: 'Owner-initiated procurement must be pre-paid by the swarm; recipients are never charged.', status: 'implemented', where: 'src/procurement/po.mjs' },
        { id: 'owner_gated_freeze_release', control: 'A stale money-safety freeze is cleared only with --ack-owner and an audit entry.', status: 'implemented', where: 'scripts/swarm-doctor.mjs' },
        { id: 'self_redress_actions', control: 'Reversible velocity breaker, routing entropy, cycle mutex and context hydration.', status: 'implemented', where: 'src/resilience/redress.mjs' },
        { id: 'settlement_freeze_gate', control: 'Settlement assertions fail while the velocity breaker is active.', status: 'implemented', where: 'src/real/money-moved-gate.mjs' },
        { id: 'audit_trail', control: 'Every trigger, clear and incident is appended to audits/autonomous/.', status: 'implemented', where: 'src/resilience/redress.mjs' },
        { id: 'owner_gated_money', control: 'No redress or audit path moves money; monetary remedies require explicit owner authorization.', status: 'implemented', where: 'docs/SILENT_FAILURE_REMEDIATION.md' }
    ];
}

export function buildRedressPlan(findings, { now = new Date(), evidence = {} } = {}) {
    const at = now instanceof Date ? now : new Date(now);
    const sorted = [...findings].sort((a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0));
    const severity = sorted.length ? sorted[0].severity : 'none';
    const digest = crypto.createHash('sha256')
        .update(`${sorted.map(finding => finding.code).join('|')}|${at.toISOString().slice(0, 10)}`)
        .digest('hex')
        .slice(0, 8);

    return {
        protocol: 'faillite-silencieuse/remediation-v1',
        incident_id: `SF-${at.toISOString().slice(0, 10).replace(/-/g, '')}-${digest}`,
        generated_at: iso(at),
        classification: sorted.length ? 'silent_failure_detected' : 'clear',
        severity,
        summary: sorted.length
            ? `${sorted.length} silent-failure finding(s); highest severity ${severity}`
            : 'No silent-failure signals detected',        findings: sorted.map(finding => {
            const meta = FINDING_CATALOG[finding.code] || {};
            const deadline = new Date(at.getTime() + Number(meta.sla_hours || 24) * 3600000);
            return {
                ...meta,
                ...finding,
                severity: finding.severity || meta.severity,
                sla_hours: meta.sla_hours || 24,
                sla_deadline: iso(deadline),
                silent_hours: finding.silent_hours ?? 0,
                occurrences: finding.occurrences ?? 1,
                first_seen: finding.first_seen || iso(at),
                escalated: Boolean(finding.escalated)
            };
        }),
        redress: {
            obligations: sorted.map(finding => ({
                code: finding.code,
                obligation: FINDING_CATALOG[finding.code]?.obligation || 'Resolve the finding.',
                owner_action: FINDING_CATALOG[finding.code]?.owner_action || 'Owner review required.',
                deadline: iso(new Date(at.getTime() + Number(FINDING_CATALOG[finding.code]?.sla_hours || 24) * 3600000))
            })),
            exposure: {
                stalled_po_value_mad: evidence.procurement?.stalled_value_mad || 0,
                unverified_po_value_mad: evidence.procurement?.unverified_value_mad || 0,
                contentieux_amount_mad: evidence.procurement?.contentieux?.amount_at_stake_mad || 0,
                contentieux_cases: evidence.procurement?.contentieux?.cases || 0,
                pending_fulfillments: evidence.fulfillment?.pending || 0,
                revenue_stalled_days: evidence.revenue?.stalled_days ?? null,
                swallowed_exceptions: evidence.silent_catches?.count || 0
            },
            money_movement: 'none — this protocol never moves money; monetary remedies require explicit owner authorization',
            postconditions: [
                'Every finding has a completed owner action and a passing verification.',
                'The next audit reports no finding at or above the configured severity.',
                'The incident record and audit entries are retained as evidence.'
            ],
            residual_risk: sorted.length
                ? 'Open until every owner action is completed and verified; escalation continues while findings persist.'
                : 'None detected at audit time.'
        },
        mitigations: listMitigations()
    };
}

export function runSilentFailureAudit({
    root = process.cwd(),
    now = new Date(),
    env = process.env,
    heartbeat,
    maxSilenceMin = DEFAULT_MAX_SILENCE_MIN,
    stallDays = DEFAULT_STALL_DAYS,
    silenceBudgetHours = DEFAULT_SILENCE_BUDGET_HOURS,
    write = false,
    engine = null,
    webhookProbes = [],
    paypalReconciliation = null,
    storefrontProbe = null
} = {}) {
    const at = now instanceof Date ? now : new Date(now);
    const detected = detectSilentFailures({ root, now: at, env, heartbeat, maxSilenceMin, stallDays, webhookProbes, paypalReconciliation, storefrontProbe });
    const stamp = iso(at);
    const stateFile = path.join(root, 'data', 'resilience', 'silent-state.json');
    const previous = readJson(stateFile) || { findings: {} };
    const nextFindings = {};

    for (const finding of detected.findings) {
        const prior = previous.findings?.[finding.code];
        const firstSeen = prior?.first_seen || stamp;
        const silentHours = round((at.getTime() - Date.parse(firstSeen)) / 3600000, 1);
        finding.first_seen = firstSeen;
        finding.silent_hours = silentHours;
        finding.occurrences = Number(prior?.occurrences || 0) + 1;
        if (silentHours >= silenceBudgetHours) {
            finding.escalated = true;
            if (SEVERITY_RANK[finding.severity] < SEVERITY_RANK.critical) finding.severity = 'critical';
            finding.detail = `${finding.detail} (unresolved for ${silentHours}h; silence budget ${silenceBudgetHours}h exceeded)`;
        }
        nextFindings[finding.code] = {
            first_seen: firstSeen,
            last_seen: stamp,
            occurrences: finding.occurrences,
            severity: finding.severity
        };
    }

    const plan = buildRedressPlan(detected.findings, { now: at, evidence: detected.evidence });
    let triggered = [];
    let written = null;

    if (write) {
        const incidentDir = path.join(root, 'data', 'resilience', 'incidents');
        fs.mkdirSync(incidentDir, { recursive: true });
        fs.mkdirSync(path.dirname(stateFile), { recursive: true });
        fs.writeFileSync(stateFile, JSON.stringify({ updated_at: stamp, findings: nextFindings }, null, 2));
        fs.writeFileSync(
            path.join(root, 'data', 'resilience', 'contentieux.json'),
            JSON.stringify({
                generated_at: stamp,
                total_pos: detected.evidence.procurement?.total || 0,
                min_days: stallDays,
                totals: detected.evidence.procurement?.contentieux || { cases: 0, amount_at_stake_mad: 0, oldest_waiting_days: 0, high_severity: 0 },
                cases: detected.evidence.procurement?.contentieux_cases || []
            }, null, 2)
        );
        if (detected.findings.length) {
            const incidentFile = path.join(incidentDir, `${plan.incident_id}.json`);
            fs.writeFileSync(incidentFile, JSON.stringify({ plan, evidence: detected.evidence }, null, 2));
            appendAudit(root, {
                level: 'policy',
                message: 'Silent-failure audit recorded',
                data: {
                    incident_id: plan.incident_id,
                    severity: plan.severity,
                    codes: detected.findings.map(finding => finding.code)
                }
            }, at);
            written = { incident: incidentFile, state: stateFile };
        } else {
            written = { incident: null, state: stateFile };
        }

        const redressEngine = engine || new RedressEngine({ root });
        triggered = redressEngine.evaluate({
            revenue_stall_days: detected.evidence.revenue?.stalled_days ?? 0,
            heartbeat_ok: detected.evidence.heartbeat?.status === 'ok',
            stall_days: stallDays,
            duplicate_rate: detected.evidence.monotony?.duplicate_rate || 0,
            duplicate_settlements_on_cycle: detected.evidence.duplicates?.count || 0,
            current_cycle_id: detected.evidence.duplicates?.cycle_id || null,
            context_drift_detected: false
        }).triggered;
    }

    return {
        findings: detected.findings,
        evidence: detected.evidence,
        plan,
        state: { updated_at: stamp, findings: nextFindings },
        triggered,
        written
    };
}

export default runSilentFailureAudit;
