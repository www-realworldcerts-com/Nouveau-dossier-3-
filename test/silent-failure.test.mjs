import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
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

test('recorded but unverified deliveries are flagged', () => {
    const old = new Date(NOW.getTime() - 5 * DAY);
    let po = transitionPo(buildPo(request(), { now: old, seq: 1 }), 'placed', { at: old });
    po = transitionPo(po, 'shipped', { at: old });
    po = transitionPo(po, 'delivered', { at: old });
    const { findings } = detectSilentFailures({ now: NOW, ...cleanOptions({ procurement: [po] }) });
    assert.ok(codes(findings).includes('DELIVERY_UNVERIFIED'));
});

test('aged pending customer fulfillments are flagged', () => {
    const queue = [{ timestamp: new Date(NOW.getTime() - 9 * DAY).toISOString(), status: 'PENDING_DELIVERY', order_id: 'o1' }];
    const { findings } = detectSilentFailures({ now: NOW, ...cleanOptions({ fulfillment: queue }) });
    const backlog = findings.find(finding => finding.code === 'FULFILLMENT_BACKLOG');
    assert.ok(backlog);
    assert.equal(backlog.evidence.pending_count, 1);
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

test('a clean reconciliation adds no finding', () => {
    const paypalReconciliation = { report: { missing_count: 0, missing: [] } };
    const { findings } = detectSilentFailures({ now: NOW, ...cleanOptions({ paypalReconciliation }) });
    assert.deepEqual(findings, []);
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
        assert.ok(['low', 'medium', 'high', 'critical'].includes(meta.severity), `${code} has an invalid severity`);
    }
    assert.ok(listMitigations().every(item => item.status === 'implemented'));
});
