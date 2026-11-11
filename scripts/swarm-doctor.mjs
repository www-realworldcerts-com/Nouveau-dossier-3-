#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    DEFAULT_FREEZE_STALE_HOURS,
    appendAudit,
    clearFreezeInFile,
    freezeAgeHours,
    heartbeatAgeMs,
    heartbeatPath,
    isStaleFreeze,
    missingLiveEnv,
    readDaemonStateFiles,
    readHeartbeat
} from '../src/swarm/loop-health.mjs';

/**
 * Preflight for the swarm loop. Answers "why is the loop not running?" in one
 * command: runtime, dependencies, live credentials, heartbeat freshness and
 * stale freezes. Exits 1 when a blocker would prevent a live tick.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
    const flags = {};
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token.startsWith('--')) continue;
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
            flags[key] = true;
        } else {
            flags[key] = next;
            i += 1;
        }
    }
    return flags;
}

function main() {
    const flags = parseArgs(process.argv.slice(2));
    const json = Boolean(flags.json);
    const maxSilenceMs = Number(flags['max-silence-min'] || 45) * 60000;
    const staleFreezeHours = Number(flags['stale-freeze-hours'] || DEFAULT_FREEZE_STALE_HOURS);
    const now = new Date();

    const nodeMajor = Number(process.versions.node.split('.')[0]);
    const depsInstalled = fs.existsSync(path.join(ROOT, 'node_modules'));
    const missingEnv = missingLiveEnv(process.env);
    const heartbeat = readHeartbeat(heartbeatPath(ROOT));
    const ageMs = heartbeatAgeMs(heartbeat, now.getTime());
    const heartbeatFresh = Boolean(heartbeat) && ageMs <= maxSilenceMs;
    const freezes = readDaemonStateFiles(ROOT).filter(row => row.freeze?.active === true);

    const checks = [
        {
            name: 'node',
            ok: nodeMajor >= 20,
            detail: process.version,
            hint: 'Install Node 20+ (the tick workflow uses 22).'
        },
        {
            name: 'dependencies',
            ok: depsInstalled,
            detail: depsInstalled ? 'installed' : 'node_modules missing',
            hint: 'Run npm ci before ticking.'
        },
        {
            name: 'live_env',
            ok: missingEnv.length === 0,
            detail: missingEnv.length ? `missing ${missingEnv.join(', ')}` : 'configured',
            hint: 'Set the variables from env.real-revenue.template in .env or repository secrets.'
        },
        {
            name: 'heartbeat',
            ok: heartbeatFresh,
            detail: heartbeat
                ? `last tick ${Math.round(ageMs / 60000)}m ago (${heartbeat.status || 'unknown'})`
                : 'no heartbeat recorded — the loop has never ticked',
            hint: 'Run npm run swarm:tick, or enable the Swarm Tick workflow.'
        }
    ];

    const freezeTable = freezes.map(row => ({
        file: row.rel,
        active_since: row.freeze?.since || row.freeze?.updatedAt || null,
        age_hours: Number.isFinite(freezeAgeHours(row.freeze, now.getTime()))
            ? Math.round(freezeAgeHours(row.freeze, now.getTime()))
            : null,
        stale: isStaleFreeze(row.freeze, { now: now.getTime(), staleHours: staleFreezeHours }),
        violations: row.freeze?.violations || []
    }));

    // Clearing a freeze is a money-safety action: it needs an explicit owner
    // acknowledgement and leaves an audit record.
    const cleared = [];
    if (flags['clear-stale-freeze']) {
        if (!flags['ack-owner']) {
            console.error('Refusing to clear a freeze without --ack-owner (this unblocks settlements).');
            process.exit(1);
        }
        const reason = typeof flags.reason === 'string' && flags.reason.trim()
            ? flags.reason.trim()
            : 'owner-acknowledged stale freeze';
        for (const row of freezes) {
            if (!isStaleFreeze(row.freeze, { now: now.getTime(), staleHours: staleFreezeHours })) continue;
            const result = clearFreezeInFile(row.file, { reason, by: process.env.USER || 'owner', now });
            if (result.changed) {
                cleared.push(row.rel);
                appendAudit(ROOT, {
                    level: 'policy',
                    message: 'Stale swarm freeze cleared',
                    data: {
                        file: row.rel,
                        previous: row.freeze,
                        reason,
                        by: process.env.USER || 'owner'
                    }
                }, now);
            }
        }
    }

    const blockers = checks.filter(check => !check.ok);
    const warnings = freezeTable
        .filter(row => !row.stale)
        .map(row => `freeze_active:${row.file}`)
        .concat(freezeTable.filter(row => row.stale).map(row => `stale_freeze:${row.file}`));

    const payload = {
        generated_at: now.toISOString(),
        ok: blockers.length === 0,
        checks,
        blockers: blockers.map(check => check.name),
        warnings,
        freezes: freezeTable,
        cleared,
        paths: {
            heartbeat: heartbeatPath(ROOT),
            daemon_state: '.autonomous-state.json',
            swarm_memory: path.join('data', 'swarm-memory.json')
        }
    };

    if (json) {
        console.log(JSON.stringify(payload, null, 2));
    } else {
        console.log('Swarm loop doctor');
        for (const check of checks) {
            const icon = check.ok ? 'PASS' : 'FAIL';
            console.log(`  [${icon}] ${check.name.padEnd(13)} ${check.detail}`);
        }
        for (const row of freezeTable) {
            const icon = row.stale ? 'WARN' : 'WARN';
            console.log(`  [${icon}] ${'freeze'.padEnd(13)} ${row.file} active since ${row.active_since || 'unknown'} (${row.age_hours}h)`);
        }
        if (cleared.length) console.log(`\ncleared stale freeze in: ${cleared.join(', ')} (audited)`);
        if (blockers.length) {
            console.log('\nBlockers:');
            for (const check of blockers) {
                console.log(`  - ${check.name}: ${check.hint}`);
            }
        } else {
            console.log('\nLoop prerequisites satisfied. Run npm run swarm:tick.');
        }
    }

    process.exitCode = blockers.length === 0 ? 0 : 1;
}

main();
