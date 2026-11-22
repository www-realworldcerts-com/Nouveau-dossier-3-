import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildPo, transitionPo } from '../src/procurement/po.mjs';
import { probePaymentWebhook } from '../src/resilience/webhook-probe.mjs';
import {
    FINDING_CATALOG,
    buildRedressPlan,
    detectSilentFailures,
    listMitigations,
    runSilentFailureAudit,
    scanSilentCatchBlocks
} from '../src/resilience/silent-failure.mjs';

const NOW = new Date('2026-11-11T10:00:00Z');
const DAY = 86400000;

function tempRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'silent-'));
}

function request(overrides = {}) {
    return {
        supplier: 'TEMU',
        recipient: { name: 'Test Recipient', city: 'Rabat' },
        origin: 'owner_initiated',
        prepaid_by: 'swarm',
        items: [{ sku: 'SKU-1', title: 'Item', qty: 1, unit_price_mad: 100, expected_min_weight_kg: 0.5 }],
        ...overrides
    };
}

function cleanOptions(overrides = {}) {
    return {
        heartbeat: { status: 'ok', at: new Date(NOW.getTime() - 60000).toISOString(), ok: true },
        revenue: { last_activity_at: new Date(NOW.getTime() - DAY).toISOString(), sources: ['data/finance/events/x.json'] },
        procurement: [],
        fulfillment: [],
        silentCatches: { count: 0, samples: [] },
        auditLatest: new Date(NOW.getTime() - DAY).toISOString(),
        tickMonotony: { samples: 0, duplicate_rate: 0 },
        ...overrides
    };
}

function codes(findings) {
    return findings.map(finding => finding.code);
}

test('a healthy state produces no findings', () => {
    const { findings } = detectSilentFailures({ now: NOW, ...cleanOptions() });
    assert.deepEqual(findings, []);
});

test('a missing heartbeat is critical', () => {
    const { findings } = detectSilentFailures({ now: NOW, ...cleanOptions({ heartbeat: null }) });
    assert.deepEqual(codes(findings), ['LOOP_HEARTBEAT_MISSING']);
    assert.equal(findings[0].severity, 'critical');
});

test('a stale heartbeat is critical and reports its age', () => {
    const heartbeat = { status: 'ok', at: new Date(NOW.getTime() - 2 * 3600000).toISOString() };
    const { findings } = detectSilentFailures({ now: NOW, ...cleanOptions({ heartbeat }), maxSilenceMin: 90 });
    assert.deepEqual(codes(findings), ['LOOP_HEARTBEAT_STALE']);
    assert.match(findings[0].detail, /120 minutes/);
});

test('a fresh but blocked tick is a high-severity silent failure', () => {
    const heartbeat = {
        status: 'blocked',
        at: NOW.toISOString(),
        ok: false,
        blocked_reason: 'missing_env:SWARM_LIVE,PAYPAL_CLIENT_ID',
        missing_env: ['SWARM_LIVE', 'PAYPAL_CLIENT_ID']
    };
    const { findings } = detectSilentFailures({ now: NOW, ...cleanOptions({ heartbeat }) });
    assert.deepEqual(codes(findings), ['LOOP_BLOCKED']);
    assert.equal(findings[0].severity, 'high');
});

test('revenue stall is detected from the latest financial record', () => {
    const revenue = { last_activity_at: '2026-01-01T00:00:00.000Z', sources: ['data/sales/x.json'] };
    const { findings } = detectSilentFailures({ now: NOW, ...cleanOptions({ revenue }) });
    const stall = findings.find(finding => finding.code === 'REVENUE_STALL');
    assert.ok(stall);
    assert.match(stall.detail, /days/);
    assert.ok(stall.evidence.stalled_days > 300);
});

test('absent revenue evidence is not treated as a stall', () => {
    const { findings, evidence } = detectSilentFailures({ now: NOW, ...cleanOptions({ revenue: { last_activity_at: null, sources: [] } }) });
    assert.ok(!codes(findings).includes('REVENUE_STALL'));
    assert.equal(evidence.revenue.last_activity_at, null);
});

test('stalled placed purchase orders aggregate into one finding', () => {
    const old = new Date(NOW.getTime() - 10 * DAY);
    const po = transitionPo(buildPo(request(), { now: old, seq: 1 }), 'placed', { at: old });
    const { findings } = detectSilentFailures({ now: NOW, ...cleanOptions({ procurement: [po] }) });
    const stall = findings.find(finding => finding.code === 'PROCUREMENT_DELIVERY_STALL');
    assert.ok(stall);
    assert.deepEqual(stall.evidence.po_refs, [po.po_ref]);
    assert.equal(stall.evidence.value_mad, 100);
});

test('late POs raise a contentieux finding with case IDs, amounts and aging', () => {
    const old = new Date(NOW.getTime() - 15 * DAY);
    const po = transitionPo(buildPo(request(), { now: old, seq: 1 }), 'placed', { at: old });
    const { findings, evidence } = detectSilentFailures({ now: NOW, ...cleanOptions({ procurement: [po] }) });
    const finding = findings.find(item => item.code === 'PROCUREMENT_CONTENTIEUX');
    assert.ok(finding);
    assert.equal(finding.severity, 'medium');
    assert.deepEqual(finding.evidence.case_ids, [`CTX-${po.po_ref}`]);
    assert.equal(finding.evidence.amount_at_stake_mad, 100);
    assert.equal(finding.evidence.cases[0].waiting_days, 15);
    assert.match(finding.detail, /contentieux case/);
    assert.equal(evidence.procurement.contentieux.cases, 1);
    assert.equal(evidence.procurement.contentieux.amount_at_stake_mad, 100);
    assert.equal(evidence.procurement.contentieux_cases.length, 1);
});

test('held POs are contentieux cases even before the stall window', () => {
    const old = new Date(NOW.getTime() - DAY);
    let po = transitionPo(buildPo(request(), { now: old, seq: 1 }), 'placed', { at: old });
    po = { ...po, status: 'on_hold', holds: [{ code: 'HOLD_CITY_MISMATCH', detail: 'wrong city' }] };
    const { findings } = detectSilentFailures({ now: NOW, ...cleanOptions({ procurement: [po] }) });
    const finding = findings.find(item => item.code === 'PROCUREMENT_CONTENTIEUX');
    assert.ok(finding);
    assert.equal(finding.severity, 'high');
    assert.deepEqual(finding.evidence.cases[0].holds, ['HOLD_CITY_MISMATCH']);
});

test('the audit persists the contentieux report for JARVIS', () => {
    const root = tempRoot();
    const old = new Date(NOW.getTime() - 12 * DAY);
    const po = transitionPo(buildPo(request(), { now: old, seq: 1 }), 'placed', { at: old });
    fs.mkdirSync(path.join(root, 'data', 'procurement'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'procurement', 'pos.ndjson'), `${JSON.stringify(po)}\n`);

    runSilentFailureAudit({ root, now: NOW, write: true });
    const report = JSON.parse(fs.readFileSync(path.join(root, 'data', 'resilience', 'contentieux.json'), 'utf8'));
    assert.equal(report.totals.cases, 1);
    assert.equal(report.totals.amount_at_stake_mad, 100);
    assert.equal(report.cases[0].case_id, `CTX-${po.po_ref}`);
});

test('recorded but unverified deliveries are flagged', () => {
    const old = new Date(NOW.getTime() - 5 * DAY);
    let po = transitionPo(buildPo(request(), { now: old, seq: 1 }), 'placed', { at: old });
    po = transitionPo(po, 'shipped', { at: old });
    po = transitionPo(po, 'delivered', { at: old });
    const { findings } = detectSilentFailures({ now: NOW, ...cleanOptions({ procurement: [po] }) });
    assert.ok(codes(findings).includes('DELIVERY_UNVERIFIED'));
});

test('aged pending customer fulfillments are a backlog finding, not a stall', () => {
    const queue = [{ timestamp: new Date(NOW.getTime() - 9 * DAY).toISOString(), status: 'PENDING_DELIVERY', order_id: 'o1' }];
    const { findings } = detectSilentFailures({ now: NOW, ...cleanOptions({ fulfillment: queue }) });
    const backlog = findings.find(finding => finding.code === 'FULFILLMENT_BACKLOG');
    assert.ok(backlog);
    assert.equal(backlog.evidence.pending_count, 1);
    assert.ok(!codes(findings).includes('FULFILLMENT_QUEUE_STALLED'), 'the same aged order must not raise both findings');
});

test('backlog counts only orders whose latest line is still pending', () => {
    const queue = [
        // Old pending line, later resolved in different ways.
        { timestamp: new Date(NOW.getTime() - 20 * DAY).toISOString(), status: 'PENDING_DELIVERY', order_id: 'delivered-later' },
        { timestamp: NOW.toISOString(), status: 'DELIVERED', order_id: 'delivered-later' },
        { timestamp: new Date(NOW.getTime() - 20 * DAY).toISOString(), status: 'PENDING_DELIVERY', order_id: 'exhausted-later' },
        { timestamp: NOW.toISOString(), status: 'DELIVERY_EXHAUSTED', order_id: 'exhausted-later' },
        // Still pending: this one must count.
        { timestamp: new Date(NOW.getTime() - 9 * DAY).toISOString(), status: 'PENDING_DELIVERY', order_id: 'still-waiting' }
    ];
    const { findings } = detectSilentFailures({ now: NOW, ...cleanOptions({ fulfillment: queue }) });

    const backlog = findings.find(finding => finding.code === 'FULFILLMENT_BACKLOG');
    assert.ok(backlog, 'the genuinely pending order is still reported');
    assert.equal(backlog.evidence.pending_count, 1);
    assert.doesNotMatch(backlog.detail, /delivered-later|exhausted-later/);

    const exhausted = findings.find(finding => finding.code === 'FULFILLMENT_DELIVERY_EXHAUSTED');
    assert.deepEqual(exhausted.evidence.orders.map(order => order.order_id), ['exhausted-later']);
});

test('a queue that stops advancing is a stalled-drain finding', () => {
    const queue = [
        { timestamp: new Date(NOW.getTime() - 30 * DAY).toISOString(), status: 'PENDING_DELIVERY', order_id: 'stuck' },
        // The last line the drain wrote: an attempt failed and nothing followed.
        { timestamp: new Date(NOW.getTime() - 9 * DAY).toISOString(), status: 'PENDING_EMAIL', order_id: 'stuck' },
        { timestamp: new Date(NOW.getTime() - 30 * DAY).toISOString(), status: 'PENDING_DELIVERY', order_id: 'moving' },
        { timestamp: new Date(NOW.getTime() - 3600000).toISOString(), status: 'PENDING_EMAIL', order_id: 'moving' }
    ];
    const { findings, evidence } = detectSilentFailures({ now: NOW, ...cleanOptions({ fulfillment: queue }) });

    const stalled = findings.find(finding => finding.code === 'FULFILLMENT_QUEUE_STALLED');
    assert.ok(stalled, 'an abandoned drain-tracked order is reported even when backlog does not cover it');
    assert.equal(stalled.severity, 'high');
    assert.equal(stalled.evidence.stalled_count, 1);
    assert.equal(stalled.evidence.orders[0].order_id, 'stuck');
    assert.equal(stalled.evidence.orders[0].status, 'PENDING_EMAIL');
    assert.equal(stalled.evidence.orders[0].stalled_days, 9);
    assert.match(stalled.detail, /stuck/);
    assert.equal(evidence.fulfillment.queue_stalled, 1);
    // 'moving' still has a fresh line, so its 30-day-old PENDING_DELIVERY line
    // is neither a backlog nor a stall.
    assert.ok(!codes(findings).includes('FULFILLMENT_BACKLOG'));
});

test('a retry inside the stall window means the queue is still advancing', () => {
    const queue = [
        { timestamp: new Date(NOW.getTime() - 20 * DAY).toISOString(), status: 'PENDING_DELIVERY', order_id: 'ORDER-11' },
        {
            timestamp: new Date(NOW.getTime() - 2 * 3600000).toISOString(),
            status: 'PENDING_EMAIL',
            order_id: 'ORDER-11',
            drain: { attempts: 2, last_reason: 'resend_timeout', next_attempt_at: new Date(NOW.getTime() + 13 * 60000).toISOString() }
        }
    ];
    const { findings } = detectSilentFailures({ now: NOW, ...cleanOptions({ fulfillment: queue }) });
    assert.ok(!codes(findings).includes('FULFILLMENT_QUEUE_STALLED'));
});

test('a queue line without a timestamp cannot be called stalled', () => {
    // Every writer stamps an ISO timestamp, so an undated line is a corrupt
    // append: it cannot be aged, and must not report a stall forever.
    const queue = [{ status: 'PENDING_EMAIL', order_id: 'undated' }];
    const { findings } = detectSilentFailures({ now: NOW, ...cleanOptions({ fulfillment: queue }) });
    assert.ok(!codes(findings).includes('FULFILLMENT_QUEUE_STALLED'));
});

test('delivered and exhausted orders are not a stalled queue', () => {
    const queue = [
        { timestamp: new Date(NOW.getTime() - 20 * DAY).toISOString(), status: 'DELIVERED', order_id: 'done' },
        { timestamp: new Date(NOW.getTime() - 20 * DAY).toISOString(), status: 'DELIVERY_EXHAUSTED', order_id: 'dead' }
    ];
    const { findings } = detectSilentFailures({ now: NOW, ...cleanOptions({ fulfillment: queue }) });
    assert.ok(!codes(findings).includes('FULFILLMENT_QUEUE_STALLED'));
    assert.ok(codes(findings).includes('FULFILLMENT_DELIVERY_EXHAUSTED'));
});

test('an order the drain exhausted becomes a recorded silent-failure finding', () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'logs', 'fulfillment_queue.log'), [
        JSON.stringify({ timestamp: '2026-11-10T09:00:00.000Z', status: 'PENDING_EMAIL', order_id: 'ORDER-9' }),
        JSON.stringify({
            timestamp: '2026-11-11T09:00:00.000Z',
            status: 'DELIVERY_EXHAUSTED',
            order_id: 'ORDER-9',
            action_required: 'Delivery failed 5 time(s): missing payer email',
            drain: { attempts: 5, last_reason: 'missing payer email', next_attempt_at: null }
        })
    ].join('\n') + '\n');

    // env: {} so a developer's FULFILLMENT_QUEUE_FILE cannot redirect this read.
    const { findings, evidence } = detectSilentFailures({
        now: NOW,
        root,
        env: {},
        ...cleanOptions({ fulfillment: undefined })
    });

    const finding = findings.find(item => item.code === 'FULFILLMENT_DELIVERY_EXHAUSTED');
    assert.ok(finding);
    assert.equal(finding.severity, 'critical');
    assert.match(finding.detail, /ORDER-9/);
    assert.equal(finding.evidence.orders[0].attempts, 5);
    assert.equal(finding.evidence.orders[0].last_reason, 'missing payer email');
    assert.equal(evidence.fulfillment.delivery_exhausted, 1);

    // The same finding is written to the incident ledger, not just detected.
    const result = runSilentFailureAudit({
        root,
        now: NOW,
        env: {},
        write: true,
        engine: { evaluate: () => ({ triggered: [] }) }
    });
    assert.ok(result.written.incident);
    const incident = JSON.parse(fs.readFileSync(result.written.incident, 'utf8'));
    const recorded = incident.plan.findings.find(item => item.code === 'FULFILLMENT_DELIVERY_EXHAUSTED');
    assert.ok(recorded);
    assert.equal(recorded.severity, 'critical');
    assert.equal(recorded.evidence.orders[0].order_id, 'ORDER-9');
    fs.rmSync(root, { recursive: true, force: true });
});

test('a paid order later delivered clears its exhausted finding', () => {
    const queue = [
        { timestamp: '2026-11-10T09:00:00.000Z', status: 'DELIVERY_EXHAUSTED', order_id: 'ORDER-10' },
        { timestamp: '2026-11-11T09:00:00.000Z', status: 'DELIVERED', order_id: 'ORDER-10' }
    ];
    const { findings } = detectSilentFailures({ now: NOW, ...cleanOptions({ fulfillment: queue }) });
    assert.ok(!codes(findings).includes('FULFILLMENT_DELIVERY_EXHAUSTED'));
});

test('empty catch blocks are found and logged catch blocks are ignored', () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'silent.mjs'), 'try { go(); } catch {}\n');
    fs.writeFileSync(path.join(root, 'src', 'logged.mjs'), 'try { go(); } catch (error) { console.error(error); }\n');
    fs.writeFileSync(path.join(root, 'src', 'commented.mjs'), 'try { go(); } catch (error) {\n  // ignored on purpose\n}\n');

    const scan = scanSilentCatchBlocks(root);
    assert.equal(scan.count, 2);
    assert.equal(scan.samples.length, 2);

    const { findings } = detectSilentFailures({ now: NOW, ...cleanOptions({ silentCatches: scan }) });
    assert.ok(codes(findings).includes('SILENT_EXCEPTION_SWALLOW'));
});

test('an audit blindspot is reported when the loop ticks but nothing is audited', () => {
    const { findings } = detectSilentFailures({ now: NOW, ...cleanOptions({ auditLatest: new Date(NOW.getTime() - 10 * DAY).toISOString() }) });
    assert.ok(codes(findings).includes('AUDIT_BLINDSPOT'));
});

test('silence budget escalates an unresolved finding to critical', () => {
    const root = tempRoot();
    const first = runSilentFailureAudit({ root, now: NOW, heartbeat: null, write: true });
    assert.equal(first.findings[0].severity, 'critical');

    const later = new Date(NOW.getTime() + 30 * 3600000);
    const second = runSilentFailureAudit({ root, now: later, heartbeat: null, write: true });
    assert.equal(second.findings[0].severity, 'critical');
    assert.equal(second.findings[0].escalated, true);
    assert.equal(second.findings[0].occurrences, 2);
    assert.match(second.findings[0].detail, /silence budget/);
});

test('the redress plan carries obligations, deadlines, exposure and mitigations', () => {
    const { findings, evidence } = detectSilentFailures({ now: NOW, ...cleanOptions({ heartbeat: null }) });
    const plan = buildRedressPlan(findings, { now: NOW, evidence });
    assert.equal(plan.protocol, 'faillite-silencieuse/remediation-v1');
    assert.match(plan.incident_id, /^SF-\d{8}-[a-f0-9]{8}$/);
    assert.equal(plan.findings.length, 1);
    assert.ok(plan.findings[0].sla_deadline);
    assert.equal(plan.redress.obligations.length, 1);
    assert.match(plan.redress.money_movement, /never moves money/);
    assert.ok(plan.mitigations.length >= 10);
    assert.equal(plan.severity, 'critical');
});

test('writing an audit persists the incident, the audit trail and finding state', () => {
    const root = tempRoot();
    const result = runSilentFailureAudit({ root, now: NOW, heartbeat: null, write: true });
    assert.ok(result.written.incident);
    assert.ok(fs.existsSync(result.written.incident));
    assert.ok(fs.existsSync(result.written.state));

    const auditDir = path.join(root, 'audits', 'autonomous');
    assert.ok(fs.existsSync(auditDir));
    assert.ok(fs.readdirSync(auditDir).length > 0);

    const state = JSON.parse(fs.readFileSync(result.written.state, 'utf8'));
    assert.equal(state.findings.LOOP_HEARTBEAT_MISSING.occurrences, 1);
});

test('a clean write records state but no incident', () => {
    const root = tempRoot();
    const result = runSilentFailureAudit({ root, now: NOW, ...cleanOptions(), write: true });
    assert.equal(result.findings.length, 0);
    assert.equal(result.written.incident, null);
});

test('webhook probe classifies reachable, undeployed, protected and unconfigured hosts', async () => {
    const fake = status => async () => ({ status });
    assert.equal((await probePaymentWebhook('https://host/api/webhooks/paypal', { fetchImpl: fake(400) })).verdict, 'reachable');
    assert.equal((await probePaymentWebhook('https://host/api/webhooks/paypal', { fetchImpl: fake(404) })).verdict, 'route_not_deployed');
    assert.equal((await probePaymentWebhook('https://host/api/webhooks/paypal', { fetchImpl: fake(401) })).verdict, 'protection_blocking');
    assert.equal((await probePaymentWebhook('https://host/api/webhooks/paypal', { fetchImpl: fake(503) })).verdict, 'webhook_not_configured');
    assert.equal((await probePaymentWebhook('https://host/api/webhooks/paypal', { fetchImpl: fake(500) })).verdict, 'server_error');

    const refused = async () => { throw new Error('ECONNREFUSED'); };
    const unreachable = await probePaymentWebhook('https://host/api/webhooks/paypal', { fetchImpl: refused });
    assert.equal(unreachable.verdict, 'unreachable');
    assert.equal(unreachable.ok, false);
});

test('an invalid webhook URL is rejected instead of probed', async () => {
    await assert.rejects(
        () => probePaymentWebhook('true', { fetchImpl: async () => ({ status: 400 }) }),
        /invalid webhook URL/
    );
    await assert.rejects(
        () => probePaymentWebhook('ftp://host/webhook', { fetchImpl: async () => ({ status: 400 }) }),
        /protocol/
    );
});

test('a bare --webhook-url flag fails validation with a clear message', () => {
    const cli = path.join(process.cwd(), 'scripts', 'silent-failure.mjs');
    const run = spawnSync(process.execPath, [cli, 'audit', '--webhook-url'], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /--webhook-url requires a value/);
    assert.doesNotMatch(run.stdout, /true/);
});

test('a dead payment webhook is a critical silent-failure finding', () => {
    const probes = [
        { url: 'https://www.realworldcerts.com/api/webhooks/paypal', status: 404, verdict: 'route_not_deployed', ok: false },
        { url: 'https://supply-chain-swarm.vercel.app/api/webhooks/paypal', status: 401, verdict: 'protection_blocking', ok: false }
    ];
    const { findings } = detectSilentFailures({ now: NOW, ...cleanOptions({ webhookProbes: probes }) });
    const webhook = findings.find(finding => finding.code === 'PAYMENT_WEBHOOK_UNREACHABLE');
    assert.ok(webhook);
    assert.equal(webhook.severity, 'critical');
    assert.match(webhook.detail, /404/);
    assert.match(webhook.detail, /401/);
});

test('paid orders missing from the fulfilment queue are a critical finding', () => {
    const paypalReconciliation = {
        report: {
            missing_count: 2,
            missing: [
                { order_id: 'ORD-1', revenue: 49, currency: 'USD' },
                { order_id: 'ORD-2', revenue: 10, currency: 'USD' }
            ]
        }
    };
    const { findings, evidence } = detectSilentFailures({ now: NOW, ...cleanOptions({ paypalReconciliation }) });
    const finding = findings.find(item => item.code === 'PAYPAL_UNFULFILLED_ORDERS');
    assert.ok(finding);
    assert.equal(finding.severity, 'critical');
    assert.deepEqual(finding.evidence.order_ids, ['ORD-1', 'ORD-2']);
    assert.equal(evidence.paypal_reconciliation.report.missing_count, 2);
});

test('a captured order priced below the catalog is a high finding', () => {
    const paypalReconciliation = {
        report: {
            missing_count: 0,
            price_mismatch_count: 1,
            price_mismatches: [{
                order_id: 'ORD-PRICE',
                product_id: 'course-one',
                currency: 'USD',
                expected: 19,
                actual: 18,
                delta: -1
            }],
            price_unchecked: []
        }
    };
    const { findings } = detectSilentFailures({ now: NOW, ...cleanOptions({ paypalReconciliation }) });
    const finding = findings.find(item => item.code === 'PAYPAL_ORDER_PRICE_DRIFT');
    assert.ok(finding);
    assert.equal(finding.severity, 'high');
    assert.deepEqual(finding.evidence.order_ids, ['ORD-PRICE']);
    assert.equal(finding.evidence.mismatches[0].actual, 18);
});

test('captured orders with quote metadata gaps are a high finding', () => {
    const paypalReconciliation = {
        report: {
            missing_count: 0,
            quote_metadata_finding_count: 2,
            quote_metadata_findings: [
                { order_id: 'ORD-MISSING', quote_metadata_status: 'missing', quote_metadata_reason: 'missing_quote_metadata' },
                { order_id: 'ORD-STALE', quote_metadata_status: 'stale', quote_metadata_reason: 'catalog_digest_mismatch' }
            ],
            quote_metadata_legacy: []
        }
    };
    const { findings } = detectSilentFailures({ now: NOW, ...cleanOptions({ paypalReconciliation }) });
    const finding = findings.find(item => item.code === 'PAYPAL_QUOTE_METADATA_DRIFT');
    assert.ok(finding);
    assert.equal(finding.severity, 'high');
    assert.deepEqual(finding.evidence.order_ids, ['ORD-MISSING', 'ORD-STALE']);
    assert.equal(finding.evidence.findings[1].quote_metadata_status, 'stale');
});

test('a clean reconciliation adds no finding', () => {
    const paypalReconciliation = { report: { missing_count: 0, missing: [] } };
    const { findings } = detectSilentFailures({ now: NOW, ...cleanOptions({ paypalReconciliation }) });
    assert.deepEqual(findings, []);
});

test('price drift between catalog, checkout and Shopify is a high finding', () => {
    const shopifyPriceDrift = {
        status: 'drift',
        checked_at: NOW.toISOString(),
        checked: { catalog_courses: 2, checkout_prices: 2, shopify_products: 2, shopify_variants: 2 },
        affected_courses: 1,
        drift: [{ course_id: 'course-one', sources: ['checkout'], reasons: ['checkout:price_mismatch'], observations: [] }],
        unavailable: []
    };
    const { findings, evidence } = detectSilentFailures({ now: NOW, ...cleanOptions({ shopifyPriceDrift }) });
    const finding = findings.find(item => item.code === 'SHOPIFY_PRICE_DRIFT');
    assert.ok(finding);
    assert.equal(finding.severity, 'high');
    assert.equal(finding.evidence.affected_courses, 1);
    assert.equal(evidence.shopify_price_drift.status, 'drift');
});

test('an unavailable price audit is reported instead of a clean result', () => {
    const shopifyPriceDrift = {
        status: 'unavailable',
        checked_at: NOW.toISOString(),
        drift: [],
        unchecked: [{ source: 'shopify', course_id: 'course-one', reason: 'price_unavailable' }],
        unavailable: ['missing_shopify_admin_credentials']
    };
    const { findings } = detectSilentFailures({ now: NOW, ...cleanOptions({ shopifyPriceDrift }) });
    const finding = findings.find(item => item.code === 'SHOPIFY_PRICE_DRIFT_UNCHECKED');
    assert.ok(finding);
    assert.equal(finding.severity, 'medium');
    assert.match(finding.detail, /missing_shopify_admin_credentials/);
    assert.match(finding.detail, /price_unavailable/);
});

test('a failed reconciliation is a medium finding, never a silent zero', () => {
    const { findings } = detectSilentFailures({
        now: NOW,
        ...cleanOptions({ paypalReconciliation: { error: 'reporting API unavailable' } })
    });
    const finding = findings.find(item => item.code === 'PAYPAL_RECONCILIATION_UNAVAILABLE');
    assert.ok(finding);
    assert.equal(finding.severity, 'medium');
    assert.match(finding.detail, /reporting API unavailable/);
});

function driftReport(courseIds, overrides = {}) {
    return {
        status: 'drift',
        checked_at: NOW.toISOString(),
        checked: { catalog_courses: 2, checkout_prices: 2, shopify_products: 2, shopify_variants: 2 },
        affected_courses: courseIds.length,
        drift: courseIds.map(courseId => ({
            course_id: courseId,
            sources: ['checkout'],
            reasons: ['checkout:price_mismatch'],
            observations: []
        })),
        unchecked: [],
        unavailable: [],
        ...overrides
    };
}

function auditAt(root, now, shopifyPriceDrift) {
    return runSilentFailureAudit({
        root,
        now,
        heartbeat: { status: 'ok', at: new Date(now.getTime() - 60000).toISOString(), ok: true },
        shopifyPriceDrift,
        write: true
    });
}

test('drift fingerprints are stable when the report order changes', () => {
    const first = detectSilentFailures({
        now: NOW,
        ...cleanOptions({ shopifyPriceDrift: driftReport(['course-one', 'course-two']) })
    });
    const second = detectSilentFailures({
        now: NOW,
        ...cleanOptions({ shopifyPriceDrift: driftReport(['course-two', 'course-one']) })
    });
    const firstFinding = first.findings.find(item => item.code === 'SHOPIFY_PRICE_DRIFT');
    const secondFinding = second.findings.find(item => item.code === 'SHOPIFY_PRICE_DRIFT');
    assert.equal(firstFinding.drift_fingerprints.length, 2);
    assert.deepEqual(
        [...firstFinding.drift_fingerprints].sort(),
        [...secondFinding.drift_fingerprints].sort()
    );
});

test('captured order price drifts get a stable per-order fingerprint', () => {
    const paypalReconciliation = {
        report: {
            missing_count: 0,
            missing: [],
            price_mismatch_count: 1,
            price_mismatches: [{
                order_id: 'ORDER-1',
                product_id: 'course-one',
                expected: 19,
                actual: 18,
                currency: 'USD'
            }],
            price_unchecked: [],
            price_catalog_error: null,
            window: { from: '2026-11-01T00:00:00Z', to: '2026-11-11T00:00:00Z' }
        }
    };
    const first = detectSilentFailures({ now: NOW, ...cleanOptions({ paypalReconciliation }) });
    const second = detectSilentFailures({ now: NOW, ...cleanOptions({ paypalReconciliation }) });
    const firstFinding = first.findings.find(item => item.code === 'PAYPAL_ORDER_PRICE_DRIFT');
    const secondFinding = second.findings.find(item => item.code === 'PAYPAL_ORDER_PRICE_DRIFT');
    assert.equal(firstFinding.drift_fingerprints.length, 1);
    assert.equal(firstFinding.drifts[0].subject, 'ORDER-1');
    assert.equal(firstFinding.drift_fingerprints[0], secondFinding.drift_fingerprints[0]);
});

test('a new drift does not inherit an already-escalated drift state', () => {
    const root = tempRoot();
    const first = auditAt(root, NOW, driftReport(['course-one']));
    assert.equal(first.findings[0].drifts.length, 1);
    assert.equal(first.findings[0].new_drifts.length, 1);

    const later = new Date(NOW.getTime() + 30 * 3600000);
    const second = auditAt(root, later, driftReport(['course-one', 'course-two']));
    const finding = second.findings.find(item => item.code === 'SHOPIFY_PRICE_DRIFT');
    assert.equal(finding.escalated, true);
    assert.equal(finding.new_drifts.length, 1);

    const oldDrift = finding.drifts.find(drift => drift.subject === 'course-one');
    const newDrift = finding.drifts.find(drift => drift.subject === 'course-two');
    assert.equal(oldDrift.escalated, true);
    assert.equal(newDrift.escalated, false);
    assert.equal(newDrift.severity, 'high');
    assert.equal(finding.new_drifts[0], newDrift.fingerprint);
    assert.deepEqual(finding.newly_escalated_drifts, [oldDrift.fingerprint]);
    assert.ok(!finding.newly_escalated_drifts.includes(newDrift.fingerprint));

    const state = JSON.parse(fs.readFileSync(second.written.state, 'utf8'));
    assert.equal(Object.keys(state.drifts).length, 2);
    assert.equal(state.drifts[oldDrift.fingerprint].escalated, true);
    assert.equal(state.drifts[newDrift.fingerprint].escalated, false);
    assert.equal(state.findings.SHOPIFY_PRICE_DRIFT.new_drift_fingerprints.length, 1);
});

test('a resolved drift is moved from open state into resolution history', () => {
    const root = tempRoot();
    const first = auditAt(root, NOW, driftReport(['course-one', 'course-two']));
    const open = first.findings[0].drifts.map(drift => drift.fingerprint);

    const later = new Date(NOW.getTime() + 2 * 3600000);
    const clean = { ...driftReport([]), status: 'ok' };
    const second = auditAt(root, later, clean);
    assert.equal(second.findings.length, 0);
    assert.equal(second.resolved_drifts.length, 2);
    assert.equal(second.state.drifts && Object.keys(second.state.drifts).length, 0);
    assert.equal(second.state.resolved_drifts.length, 2);
    assert.deepEqual(second.resolved_drifts.map(drift => drift.fingerprint).sort(), [...open].sort());
    assert.equal(second.resolved_drifts.every(drift => drift.status === 'resolved' && drift.resolved_at), true);
    assert.equal(second.plan.resolved_drifts.length, 2);
});

test('an unavailable price audit keeps prior drifts open instead of resolving them', () => {
    const root = tempRoot();
    const first = auditAt(root, NOW, driftReport(['course-one']));
    const fingerprint = first.findings[0].drifts[0].fingerprint;

    const later = new Date(NOW.getTime() + 2 * 3600000);
    const unavailable = {
        status: 'unavailable',
        checked_at: later.toISOString(),
        drift: [],
        unchecked: [],
        unavailable: ['checkout_origin_unavailable: CHECKOUT_PRICE_ORIGIN_URL is not configured']
    };
    const second = auditAt(root, later, unavailable);
    assert.equal(second.resolved_drifts.length, 0);
    assert.equal(second.state.drifts[fingerprint].status, 'open');
    assert.ok(second.state.drifts[fingerprint].unchecked_at);
    assert.equal(second.state.resolved_drifts.length, 0);
    assert.ok(second.findings.some(finding => finding.code === 'SHOPIFY_PRICE_DRIFT_UNCHECKED'));
});

test('a skipped reconciliation without credentials adds no finding', () => {
    const paypalReconciliation = { skipped: 'missing_paypal_credentials', missing: ['PAYPAL_CLIENT_ID'] };
    const { findings, evidence } = detectSilentFailures({ now: NOW, ...cleanOptions({ paypalReconciliation }) });
    assert.deepEqual(findings, []);
    assert.equal(evidence.paypal_reconciliation.skipped, 'missing_paypal_credentials');
});

test('the audit skips reconciliation cleanly when PayPal credentials are absent', () => {
    const cli = path.join(process.cwd(), 'scripts', 'silent-failure.mjs');
    const env = { ...process.env };
    delete env.PAYPAL_CLIENT_ID;
    delete env.PAYPAL_CLIENT_SECRET;
    const run = spawnSync(process.execPath, [cli, 'audit', '--reconcile-paypal', '--fail-on', 'none', '--json'], {
        encoding: 'utf8',
        env
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /paypal reconciliation skipped: missing PAYPAL_CLIENT_ID/);
    const payload = JSON.parse(run.stdout.slice(run.stdout.indexOf('{')));
    assert.ok(!payload.plan.findings.some(finding => finding.code === 'PAYPAL_UNFULFILLED_ORDERS'));
    assert.equal(payload.evidence.paypal_reconciliation.skipped, 'missing_paypal_credentials');
});

test('a blocked deployed checkout gate is a critical finding in the incident plan', () => {
    const checkoutGate = {
        url: 'https://checkout.example/health',
        status: 200,
        reported: true,
        blocks: true,
        block_reason: 'CHECKOUT_ATTEMPT_STORE_NOT_DURABLE',
        replay_protection: 'store',
        error: null
    };
    const { findings, evidence } = detectSilentFailures({ now: NOW, ...cleanOptions({ checkoutGate }) });

    const finding = findings.find(item => item.code === 'CHECKOUT_GATE_BLOCKED');
    assert.ok(finding);
    assert.equal(finding.severity, 'critical');
    assert.match(finding.detail, /CHECKOUT_ATTEMPT_STORE_NOT_DURABLE/);
    assert.equal(evidence.checkout_gate.block_reason, 'CHECKOUT_ATTEMPT_STORE_NOT_DURABLE');
});

test('an open or unreported checkout gate adds no finding', () => {
    const open = detectSilentFailures({
        now: NOW,
        ...cleanOptions({ checkoutGate: { url: 'https://checkout.example/health', reported: true, blocks: false } })
    });
    assert.deepEqual(open.findings, []);

    const unreported = detectSilentFailures({
        now: NOW,
        ...cleanOptions({ checkoutGate: { url: 'https://checkout.example/health', reported: false, blocks: false, status: 404 } })
    });
    assert.deepEqual(unreported.findings, []);

    const unconfigured = detectSilentFailures({ now: NOW, ...cleanOptions() });
    assert.equal(unconfigured.evidence.checkout_gate, null);
});

test('the CLI records a blocked checkout gate from CHECKOUT_HEALTH_URL', async (t) => {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            config: {
                checkout_attempts: {
                    blocks_checkout: true,
                    block_reason: 'CHECKOUT_ATTEMPT_STORE_INSTANCE_LOCAL',
                    replay_protection: 'store'
                }
            }
        }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());

    const run = await new Promise(resolve => {
        const child = spawn(process.execPath, [
            path.join(process.cwd(), 'scripts', 'silent-failure.mjs'),
            'audit', '--fail-on', 'none', '--json'
        ], {
            env: { ...process.env, CHECKOUT_HEALTH_URL: `http://127.0.0.1:${server.address().port}/health` }
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('close', status => resolve({ status, stdout, stderr }));
    });
    assert.equal(run.status, 0, run.stderr);

    const payload = JSON.parse(run.stdout.slice(run.stdout.indexOf('{')));
    const finding = payload.plan.findings.find(item => item.code === 'CHECKOUT_GATE_BLOCKED');
    assert.ok(finding, run.stdout);
    assert.match(finding.detail, /CHECKOUT_ATTEMPT_STORE_INSTANCE_LOCAL/);
});

test('a healthy webhook probe adds no finding', () => {
    const probes = [{ url: 'https://host/api/webhooks/paypal', status: 400, verdict: 'reachable', ok: true }];
    const { findings } = detectSilentFailures({ now: NOW, ...cleanOptions({ webhookProbes: probes }) });
    assert.deepEqual(findings, []);
});

test('every catalog finding has a full remediation contract', () => {
    for (const [code, meta] of Object.entries(FINDING_CATALOG)) {
        for (const field of ['title', 'impact', 'containment', 'obligation', 'remedy', 'mitigation', 'verification', 'owner_action', 'sla_hours']) {
            assert.ok(meta[field], `${code} is missing ${field}`);
        }
        assert.ok(['low', 'warning', 'medium', 'high', 'critical'].includes(meta.severity), `${code} has an invalid severity`);
    }
    assert.ok(listMitigations().every(item => item.status === 'implemented'));
});
