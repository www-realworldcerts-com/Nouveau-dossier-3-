import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { appendAudit } from '../swarm/loop-health.mjs';

/**
 * Self-redress engine for silent failure ("faillite silencieuse").
 *
 * Four reversible mitigations, persisted to disk so they survive the restart
 * that a crash-looping process would otherwise use to erase its own evidence:
 *
 *   velocity_breaker        confirmed-revenue stall while ticks succeed
 *                           -> halt new settlements for 300s + capital audit
 *   log_monotony_entropy    >70% duplicate outcomes across ticks
 *                           -> shift 15% of publish routing to a backup path
 *   cannibalistic_global_lock  duplicate work on one cycle
 *                           -> 10 minute mutex on that cycle
 *   context_hydration       objective drift
 *                           -> re-inject the frozen prompt genesis
 *
 * The engine never moves money. It only gates behaviour (settlement freeze,
 * routing intent, cycle mutex, prompt injection) and records every action.
 */

export const ACTION_IDS = [
    'velocity_breaker',
    'log_monotony_entropy',
    'cannibalistic_global_lock',
    'context_hydration'
];

const DURATION_MS = {
    velocity_breaker: 300000,
    log_monotony_entropy: 300000,
    cannibalistic_global_lock: 600000,
    context_hydration: 5000
};

const RATE_LIMIT_MS = { context_hydration: 3600000 };
const MAX_LOG = 100;

const LABELS = {
    velocity_breaker: {
        label: 'Velocity Without Revenue Circuit Breaker',
        description: 'Ticks keep succeeding but no externally confirmed revenue appears: halt new settlements for 300 seconds and force a capital-efficiency audit.'
    },
    log_monotony_entropy: {
        label: 'Log Monotony Entropy Injection',
        description: 'Tick outcomes are more than 70% duplicates: shift 15% of publish routing to a backup path to break the loop.'
    },
    cannibalistic_global_lock: {
        label: 'Cannibalistic Competition Global Mutex',
        description: 'Duplicate settlements detected on one cycle: lock that cycle for 10 minutes and dedupe targets.'
    },
    context_hydration: {
        label: 'Context-Window Amnesia State Hydration',
        description: 'The macro objective drifted out of context: re-inject the frozen prompt genesis and north-star KPIs.'
    }
};

export const PROMPT_GENESIS = {
    macro_objective:
        'Generate externally confirmed revenue only. Self-reported, simulated or unverified revenue never counts toward KPIs.',
    north_star_kpis: [
        'confirmed_revenue_total (bank or PSP reference required)',
        'settled_to_confirmed_ratio',
        'verified_deliveries (PO verified against PO, receipt and invoice)'
    ],
    safety_boundaries: [
        'Never mark a settlement successful without an external confirmation reference.',
        'Never move money from a state where confirmed revenue is zero.',
        'Never record a delivery without carrier POD evidence and a 3-way match.',
        'Never clear a money-safety freeze without explicit owner acknowledgement and an audit record.',
        'Never swallow an exception without recording it.',
        'Never let a stopped loop stay silent: a missing signal is a failure, not a success.'
    ],
    operational_constraints: [
        'One active objective per cycle; no duplicate settlements on the same cycle.',
        'Owner-initiated procurement is pre-paid by the swarm; recipients never disburse.',
        'Unverified deliveries stay on hold; no PO closes without verification.',
        'Silence budget: an unresolved finding escalates to critical after 24 hours.'
    ]
};

export const PROMPT_GENESIS_HASH = (() => {
    const text = JSON.stringify(PROMPT_GENESIS);
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
        hash = (hash * 31 + text.charCodeAt(i)) | 0;
    }
    return `genesis-${(hash >>> 0).toString(16)}`;
})();

const iso = value => new Date(value).toISOString();

function freshAction(id) {
    return {
        id,
        ...LABELS[id],
        active: false,
        triggered_count: 0,
        last_triggered_at: null,
        last_cleared_at: null,
        expires_at: null,
        last_trigger_reason: null,
        runtime: {}
    };
}

function freshState(nowIso) {
    return {
        version: 1,
        enabled: true,
        generated_at: nowIso,
        last_evaluation_at: null,
        actions: Object.fromEntries(ACTION_IDS.map(id => [id, freshAction(id)])),
        log: []
    };
}

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

export class RedressEngine {
    constructor({ root = process.cwd(), file = path.join('data', 'resilience', 'redress.json'), now = () => Date.now(), audit = true } = {}) {
        this.root = root;
        this.file = path.isAbsolute(file) ? file : path.join(root, file);
        this.now = now;
        this.auditEnabled = audit;
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const saved = readJson(this.file);
        const base = freshState(iso(this.now()));
        this.state = saved
            ? {
                ...base,
                ...saved,
                actions: {
                    ...base.actions,
                    ...Object.fromEntries(Object.entries(saved.actions || {}).map(([id, action]) => [id, { ...base.actions[id], ...action }]))
                },
                log: Array.isArray(saved.log) ? saved.log.slice(0, MAX_LOG) : []
            }
            : base;
        this._expire();
    }

    save() {
        this.state.generated_at = iso(this.now());
        const temp = `${this.file}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(this.state, null, 2));
        fs.renameSync(temp, this.file);
    }

    _audit(action, event, reason) {
        if (!this.auditEnabled) return;
        try {
            appendAudit(this.root, {
                level: 'policy',
                message: `Self-redress ${event}: ${action}`,
                data: { action, event, reason }
            });
        } catch (error) {
            // An audit failure must be visible, never silent.
            console.error(`redress audit append failed: ${error.message}`);
        }
    }

    _log(action, event, reason, evidence = undefined) {
        this.state.log.unshift({
            id: `SRE-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`,
            action,
            event,
            at: iso(this.now()),
            reason,
            evidence: evidence || null
        });
        if (this.state.log.length > MAX_LOG) this.state.log.length = MAX_LOG;
    }

    _expire() {
        const now = this.now();
        let changed = false;
        for (const id of ACTION_IDS) {
            const action = this.state.actions[id];
            if (!action?.active || !action.expires_at) continue;
            if (now < Date.parse(action.expires_at)) continue;
            action.active = false;
            action.last_cleared_at = iso(now);
            action.runtime = { ...action.runtime, expired_at: iso(now) };
            this._log(id, 'cleared', 'ttl expired');
            changed = true;
        }
        if (changed) this.save();
        return changed;
    }

    setEnabled(enabled) {
        this.state.enabled = Boolean(enabled);
        this.save();
    }

    trigger(id, { reason = 'manual trigger', evidence, cycleId = null, actor = 'system' } = {}) {
        if (!ACTION_IDS.includes(id)) throw new Error(`Unknown redress action: ${id}`);
        if (id === 'cannibalistic_global_lock' && !cycleId) throw new Error('cannibalistic_global_lock requires a cycleId');
        const now = this.now();
        this._expire();
        if (!this.state.enabled) return { triggered: false, reason: 'disabled' };

        const action = this.state.actions[id];
        if (action.active) {
            this._log(id, 'skipped', 'already active', { actor });
            this.save();
            return { triggered: false, reason: 'already_active' };
        }

        const limit = RATE_LIMIT_MS[id] || 0;
        const last = Date.parse(action.last_triggered_at || '') || 0;
        if (limit && now - last < limit) {
            const retry = limit - (now - last);
            this._log(id, 'skipped', 'rate limited', { retry_after_ms: retry });
            this.save();
            return { triggered: false, reason: 'rate_limited', retry_after_ms: retry };
        }

        const runtime = {
            velocity_breaker: { freeze_until_ms: now + DURATION_MS[id], audit_required: true },
            log_monotony_entropy: { shift_pct: 0.15, backup_path: 'shopify-backup-channel' },
            cannibalistic_global_lock: { locked_cycle: cycleId, lock_expires_at: now + DURATION_MS[id] },
            context_hydration: { genesis_hash: PROMPT_GENESIS_HASH, hydrated_agents: 0 }
        }[id];

        Object.assign(action, {
            active: true,
            triggered_count: action.triggered_count + 1,
            last_triggered_at: iso(now),
            last_trigger_reason: reason,
            expires_at: iso(now + DURATION_MS[id]),
            runtime
        });
        this._log(id, 'triggered', reason, evidence);
        this._audit(id, 'triggered', reason);
        this.save();
        return { triggered: true, action: JSON.parse(JSON.stringify(action)) };
    }

    clear(id, { reason = 'operator override', auditDone = true } = {}) {
        if (id !== 'all' && !ACTION_IDS.includes(id)) throw new Error(`Unknown redress action: ${id}`);
        const ids = id === 'all' ? ACTION_IDS : [id];
        for (const actionId of ids) {
            const action = this.state.actions[actionId];
            if (!action?.active) continue;
            action.active = false;
            action.expires_at = null;
            action.last_cleared_at = iso(this.now());
            if (actionId === 'velocity_breaker') {
                action.runtime = { ...action.runtime, audit_required: !auditDone };
            }
            this._log(actionId, 'cleared', reason, { audit_done: auditDone });
            this._audit(actionId, 'cleared', reason);
        }
        this.save();
    }

    activeIds() {
        this._expire();
        return ACTION_IDS.filter(id => this.state.actions[id]?.active);
    }

    isSettlementAllowed() {
        return !this.activeIds().includes('velocity_breaker');
    }

    isCycleLocked(cycleId) {
        if (!this.activeIds().includes('cannibalistic_global_lock')) return false;
        return this.state.actions.cannibalistic_global_lock.runtime.locked_cycle === cycleId;
    }

    getRouteShiftPct() {
        return this.activeIds().includes('log_monotony_entropy')
            ? Number(this.state.actions.log_monotony_entropy.runtime.shift_pct || 0)
            : 0;
    }

    getBackupPath() {
        return this.activeIds().includes('log_monotony_entropy')
            ? this.state.actions.log_monotony_entropy.runtime.backup_path || null
            : null;
    }

    hydrateContext(reason = 'context drift detected') {
        const result = this.trigger('context_hydration', { reason });
        if (!result.triggered) return null;
        return { genesis: PROMPT_GENESIS, genesis_hash: PROMPT_GENESIS_HASH };
    }

    evaluate(signals = {}) {
        if (!this.state.enabled) return { triggered: [], active: [] };
        const now = this.now();
        const last = Date.parse(this.state.last_evaluation_at || '') || 0;
        if (now - last < 60000) return { triggered: [], active: this.activeIds() };
        this.state.last_evaluation_at = iso(now);

        const triggered = [];
        const fire = (id, options) => {
            if (this.trigger(id, options).triggered) triggered.push(id);
        };

        if (Number(signals.revenue_stall_days || 0) >= Number(signals.stall_days || 7) && signals.heartbeat_ok) {
            fire('velocity_breaker', {
                reason: `${signals.revenue_stall_days}d without confirmed revenue while ticks keep succeeding`,
                evidence: { revenue_stall_days: signals.revenue_stall_days }
            });
        }
        if (Number(signals.duplicate_rate || 0) > 0.7) {
            fire('log_monotony_entropy', {
                reason: `${Math.round(signals.duplicate_rate * 100)}% duplicate tick outcomes`,
                evidence: { duplicate_rate: signals.duplicate_rate }
            });
        }
        if (Number(signals.duplicate_settlements_on_cycle || 0) > 0 && signals.current_cycle_id) {
            fire('cannibalistic_global_lock', {
                cycleId: signals.current_cycle_id,
                reason: `${signals.duplicate_settlements_on_cycle} duplicate settlements on ${signals.current_cycle_id}`
            });
        }
        if (signals.context_drift_detected) {
            fire('context_hydration', { reason: 'context drift detected' });
        }

        this.save();
        return { triggered, active: this.activeIds() };
    }

    snapshot() {
        this._expire();
        return JSON.parse(JSON.stringify(this.state));
    }
}

export default RedressEngine;
