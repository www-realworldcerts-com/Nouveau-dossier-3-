#!/usr/bin/env node
import fs from 'node:fs';

import {
    DEFAULT_MAX_SILENCE_MIN,
    DEFAULT_SILENCE_BUDGET_HOURS,
    DEFAULT_STALL_DAYS,
    SEVERITY_RANK,
    listMitigations,
    runSilentFailureAudit
} from '../src/resilience/silent-failure.mjs';
import { ACTION_IDS, PROMPT_GENESIS, RedressEngine } from '../src/resilience/redress.mjs';
import { probePaymentWebhook } from '../src/resilience/webhook-probe.mjs';

/**
 * Silent-failure ("faillite silencieuse") CLI: detect, record redress, and
 * operate the reversible mitigations. Exit code 2 means the audit found
 * findings at or above --fail-on, so CI can fail loudly.
 */

function parseArgs(argv) {
    const [command = 'help', ...rest] = argv;
    const flags = {};
    const positional = [];
    for (let i = 0; i < rest.length; i += 1) {
        const token = rest[i];
        if (token.startsWith('--')) {
            const key = token.slice(2);
            const next = rest[i + 1];
            if (next === undefined || next.startsWith('--')) flags[key] = true;
            else {
                flags[key] = next;
                i += 1;
            }
        } else {
            positional.push(token);
        }
    }
    return { command, flags, positional };
}

function printPlan(result, json) {
    if (json) {
        console.log(JSON.stringify({ plan: result.plan, evidence: result.evidence, triggered: result.triggered, written: result.written }, null, 2));
        return;
    }
    const plan = result.plan;
    console.log(`Silent-failure audit — ${plan.generated_at}`);
    console.log(`  classification: ${plan.classification} (${plan.severity})`);
    console.log(`  incident: ${plan.incident_id}`);
    if (!result.findings.length) {
        console.log('  No silent-failure signals detected.');
    } else {
        for (const finding of plan.findings) {
            console.log(`\n  [${finding.severity.toUpperCase()}] ${finding.code} — ${finding.title}`);
            console.log(`      ${finding.detail}`);
            console.log(`      domain: ${finding.domain}; first seen: ${finding.first_seen}; silent: ${finding.silent_hours}h; occurrences: ${finding.occurrences}`);
            console.log(`      containment: ${finding.containment}`);
            console.log(`      owner action (SLA ${finding.sla_hours}h, by ${finding.sla_deadline}): ${finding.owner_action}`);
            console.log(`      remedy: ${finding.remedy}`);
            console.log(`      mitigation: ${finding.mitigation}`);
            console.log(`      verification: ${finding.verification}`);
        }
        console.log('\n  Redress exposure: ' + JSON.stringify(plan.redress.exposure));
        console.log(`  Money movement: ${plan.redress.money_movement}`);
    }
    if (result.triggered?.length) console.log(`  Redress actions triggered: ${result.triggered.join(', ')}`);
    if (result.written?.incident) console.log(`  Incident written: ${result.written.incident}`);
}

function buildEngine(flags) {
    return new RedressEngine({
        root: flags.root || process.cwd(),
        file: flags.file || undefined
    });
}

const HELP = `Silent-failure / faillite silencieuse protocol.

Usage:
  node scripts/silent-failure.mjs <command> [options]

Commands:
  audit            Detect silent failures, apply the silence budget and print the redress plan
  redress          Same as audit --write (records the incident, audit entry and mitigations)
  mitigations      List every implemented preventive control
  status           Show active redress actions and the frozen prompt genesis
  trigger <action> Manually trigger a mitigation (velocity_breaker, log_monotony_entropy,
                   cannibalistic_global_lock --cycle <id>, context_hydration)
  clear <action|all>  Release a mitigation (velocity_breaker accepts --audit-done)
  check-settlements   Exit 0 when settlements are allowed, 3 when frozen

Options:
  --write                    Persist state + incident + audit record
  --json                     Machine-readable output
  --max-silence-min <n>      Heartbeat silence budget (default 90)
  --stall-days <n>           Revenue/PO/fulfillment stall window (default 7)
  --silence-budget-hours <n> Escalate unresolved findings to critical after n hours (default 24)
  --fail-on <severity>       Exit 2 at or above this severity (default high)
  --webhook-url <url>        Probe a payment webhook (comma-separated; also PAYMENT_WEBHOOK_URL)
  --root <dir>               Repository root (default cwd)
  --file <path>              Redress state file (default data/resilience/redress.json)

Exit codes: 0 clear, 1 error, 2 findings found, 3 settlements frozen.`;

async function main() {
    const { command, flags, positional } = parseArgs(process.argv.slice(2));
    const json = Boolean(flags.json);
    if (command === 'help' || flags.help) return console.log(HELP);

    if (command === 'mitigations') {
        const mitigations = listMitigations();
        if (json) return console.log(JSON.stringify(mitigations, null, 2));
        console.log('Silent-failure mitigations');
        for (const item of mitigations) console.log(`  [${item.status}] ${item.id.padEnd(28)} ${item.control} (${item.where})`);
        return;
    }

    if (command === 'status') {
        const engine = buildEngine(flags);
        const snapshot = engine.snapshot();
        const payload = {
            enabled: snapshot.enabled,
            active: engine.activeIds(),
            settlement_allowed: engine.isSettlementAllowed(),
            route_shift_pct: engine.getRouteShiftPct(),
            backup_path: engine.getBackupPath(),
            actions: snapshot.actions,
            recent_log: snapshot.log.slice(0, 10),
            prompt_genesis: PROMPT_GENESIS
        };
        if (json) return console.log(JSON.stringify(payload, null, 2));
        console.log(`Self-redress: ${snapshot.enabled ? 'enabled' : 'disabled'}; active: ${payload.active.join(', ') || 'none'}`);
        console.log(`Settlements: ${payload.settlement_allowed ? 'allowed' : 'FROZEN'}`);
        if (payload.route_shift_pct) console.log(`Routing shift: ${payload.route_shift_pct * 100}% via ${payload.backup_path}`);
        for (const entry of payload.recent_log.slice(0, 5)) {
            console.log(`  ${entry.at} ${entry.event.padEnd(9)} ${entry.action.padEnd(28)} ${entry.reason}`);
        }
        return;
    }

    if (command === 'check-settlements') {
        const engine = buildEngine(flags);
        if (!engine.isSettlementAllowed()) {
            console.error('SETTLEMENTS_FROZEN: velocity-without-revenue circuit breaker is active.');
            return (process.exitCode = 3);
        }
        return;
    }

    if (command === 'trigger') {
        const action = positional[0];
        if (!ACTION_IDS.includes(action)) throw new Error(`Unknown redress action: ${action || '(missing)'}`);
        const engine = buildEngine(flags);
        const result = engine.trigger(action, {
            reason: typeof flags.reason === 'string' ? flags.reason : 'manual trigger',
            cycleId: flags.cycle,
            actor: 'operator'
        });
        if (json) return console.log(JSON.stringify({ result, state: engine.snapshot() }, null, 2));
        console.log(result.triggered ? `triggered ${action}` : `not triggered: ${result.reason}`);
        return;
    }

    if (command === 'clear') {
        const action = positional[0] || 'all';
        const engine = buildEngine(flags);
        engine.clear(action, { reason: typeof flags.reason === 'string' ? flags.reason : 'operator override', auditDone: Boolean(flags['audit-done']) });
        console.log(json ? JSON.stringify(engine.snapshot(), null, 2) : `cleared ${action}`);
        return;
    }

    if (command === 'audit' || command === 'redress') {
        const failOn = String(flags['fail-on'] || 'high').toLowerCase();
        if (!SEVERITY_RANK[failOn] && failOn !== 'none') throw new Error(`Unknown --fail-on severity: ${failOn}`);
        if (flags['webhook-url'] === true) {
            throw new Error('--webhook-url requires a value (comma-separated http(s) URLs)');
        }
        const webhookUrls = String(flags['webhook-url'] || process.env.PAYMENT_WEBHOOK_URL || '')
            .split(',')
            .map(url => url.trim())
            .filter(Boolean);
        if (!webhookUrls.length && flags['webhook-url'] === '') {
            console.log('webhook probe skipped: --webhook-url was empty');
        }
        const webhookProbes = await Promise.all(webhookUrls.map(url => probePaymentWebhook(url)));
        const result = runSilentFailureAudit({
            root: flags.root || process.cwd(),
            maxSilenceMin: Number(flags['max-silence-min'] || DEFAULT_MAX_SILENCE_MIN),
            stallDays: Number(flags['stall-days'] || DEFAULT_STALL_DAYS),
            silenceBudgetHours: Number(flags['silence-budget-hours'] || DEFAULT_SILENCE_BUDGET_HOURS),
            write: command === 'redress' || Boolean(flags.write),
            webhookProbes
        });
        printPlan(result, json);
        if (failOn !== 'none' && result.findings.some(finding => SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[failOn])) {
            process.exitCode = 2;
        }
        return;
    }

    console.log(HELP);
}

main().catch(error => {
    console.error(`silent-failure: ${error.message}`);
    process.exit(1);
});
