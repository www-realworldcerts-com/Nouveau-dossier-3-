import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ACTION_IDS, PROMPT_GENESIS_HASH, RedressEngine } from '../src/resilience/redress.mjs';

const T0 = Date.parse('2026-11-11T10:00:00Z');

function tempRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'redress-'));
}

function makeEngine({ clock = { value: T0 }, root = tempRoot() } = {}) {
    return {
        root,
        clock,
        engine: new RedressEngine({ root, now: () => clock.value, audit: false })
    };
}

test('a fresh engine has no active actions and allows settlements', () => {
    const { engine } = makeEngine();
    assert.deepEqual(engine.activeIds(), []);
    assert.equal(engine.isSettlementAllowed(), true);
    assert.equal(engine.getRouteShiftPct(), 0);
    assert.equal(engine.getBackupPath(), null);
});

test('velocity breaker freezes settlements for 300s and persists across restarts', () => {
    const { root, clock, engine } = makeEngine();
    const result = engine.trigger('velocity_breaker', { reason: '8 days without revenue' });
    assert.equal(result.triggered, true);
    assert.equal(engine.isSettlementAllowed(), false);
    assert.equal(engine.snapshot().actions.velocity_breaker.runtime.audit_required, true);

    const reopened = new RedressEngine({ root, now: () => clock.value, audit: false });
    assert.deepEqual(reopened.activeIds(), ['velocity_breaker']);
    assert.equal(reopened.isSettlementAllowed(), false);
});

test('velocity breaker auto-clears when the freeze expires', () => {
    const { clock, engine } = makeEngine();
    engine.trigger('velocity_breaker', { reason: 'test' });
    clock.value = T0 + 299000;
    assert.equal(engine.isSettlementAllowed(), false);
    clock.value = T0 + 301000;
    assert.equal(engine.isSettlementAllowed(), true);
    assert.deepEqual(engine.activeIds(), []);
});

test('clearing the velocity breaker without an audit leaves the audit requirement set', () => {
    const { engine } = makeEngine();
    engine.trigger('velocity_breaker', { reason: 'test' });
    engine.clear('velocity_breaker', { auditDone: false, reason: 'operator ack' });
    assert.equal(engine.isSettlementAllowed(), true);
    assert.equal(engine.snapshot().actions.velocity_breaker.runtime.audit_required, true);
});

test('log monotony shifts 15% of routing to a backup path for five minutes', () => {
    const { clock, engine } = makeEngine();
    engine.trigger('log_monotony_entropy', { reason: '90% duplicate outcomes' });
    assert.equal(engine.getRouteShiftPct(), 0.15);
    assert.equal(engine.getBackupPath(), 'shopify-backup-channel');
    clock.value = T0 + 301000;
    assert.equal(engine.getRouteShiftPct(), 0);
});

test('cannibalistic lock scopes to one cycle and requires a cycle id', () => {
    const { engine } = makeEngine();
    assert.throws(() => engine.trigger('cannibalistic_global_lock'), /requires a cycleId/);
    engine.trigger('cannibalistic_global_lock', { cycleId: 'cycle-A', reason: 'duplicate settlements' });
    assert.equal(engine.isCycleLocked('cycle-A'), true);
    assert.equal(engine.isCycleLocked('cycle-B'), false);
});

test('evaluate fires the velocity breaker from revenue-stall signals and dedupes the same tick', () => {
    const { engine } = makeEngine();
    const first = engine.evaluate({ revenue_stall_days: 9, heartbeat_ok: true, stall_days: 7 });
    assert.deepEqual(first.triggered, ['velocity_breaker']);
    assert.equal(engine.isSettlementAllowed(), false);

    const second = engine.evaluate({ revenue_stall_days: 9, heartbeat_ok: true, stall_days: 7 });
    assert.deepEqual(second.triggered, []);
});

test('evaluate does not freeze settlements when the heartbeat itself is down', () => {
    const { engine } = makeEngine();
    const result = engine.evaluate({ revenue_stall_days: 9, heartbeat_ok: false, stall_days: 7 });
    assert.deepEqual(result.triggered, []);
});

test('context hydration returns the frozen genesis once per hour', () => {
    const { engine } = makeEngine();
    const hydration = engine.hydrateContext('drift');
    assert.equal(hydration.genesis_hash, PROMPT_GENESIS_HASH);
    assert.ok(Array.isArray(hydration.genesis.safety_boundaries));
    assert.equal(engine.hydrateContext('drift again'), null);
});

test('disabled engine refuses to trigger', () => {
    const { engine } = makeEngine();
    engine.setEnabled(false);
    const result = engine.trigger('velocity_breaker', { reason: 'test' });
    assert.equal(result.triggered, false);
    assert.equal(result.reason, 'disabled');
});

test('unknown actions are rejected and all four actions exist', () => {
    const { engine } = makeEngine();
    assert.equal(ACTION_IDS.length, 4);
    assert.throws(() => engine.trigger('nope'), /Unknown redress action/);
    engine.trigger('velocity_breaker', { reason: 'test' });
    engine.clear('all');
    assert.deepEqual(engine.activeIds(), []);
});
