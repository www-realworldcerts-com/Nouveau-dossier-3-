#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    DEFAULT_MAX_SILENCE_MS,
    appendTickLog,
    evaluateLoopHealth,
    heartbeatAgeMs,
    heartbeatPath,
    missingLiveEnv,
    readHeartbeat,
    tickLogPath,
    writeHeartbeat
} from '../src/swarm/loop-health.mjs';

/**
 * One bounded swarm tick.
 *
 * This is the unit the scheduler runs (GitHub Actions every 15 minutes, or
 * `npm start` as a long-lived supervisor). It always writes a heartbeat, even
 * when it cannot run, so silence is detectable. Exit codes:
 *   0  tick ran and the daemon reported ok
 *   1  tick crashed / timed out
 *   2  tick ran but is blocked (missing live env or dependencies)
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

function runNode(script, args, { timeoutMs = 240000, env = process.env } = {}) {
    return new Promise(resolve => {
        const startedAt = Date.now();
        const proc = spawn(process.execPath, [script, ...args], {
            cwd: ROOT,
            env,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            proc.kill('SIGTERM');
            setTimeout(() => {
                try { proc.kill('SIGKILL'); } catch { /* already gone */ }
            }, 10000).unref();
        }, timeoutMs);

        proc.stdout.on('data', chunk => { stdout += chunk.toString(); });
        proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
        proc.on('error', error => {
            clearTimeout(timer);
            resolve({ code: 1, timedOut, stdout, stderr: `${stderr}${error.message}`, ms: Date.now() - startedAt });
        });
        proc.on('close', code => {
            clearTimeout(timer);
            resolve({ code: code ?? 1, timedOut, stdout, stderr, ms: Date.now() - startedAt });
        });
    });
}

function lastJsonLine(text) {
    const lines = String(text || '').split('\n').map(line => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (!lines[i].startsWith('{')) continue;
        try {
            return JSON.parse(lines[i]);
        } catch {
            /* keep looking */
        }
    }
    return null;
}

function tail(text, lines = 15) {
    return String(text || '').trim().split('\n').slice(-lines).join('\n');
}

async function main() {
    const flags = parseArgs(process.argv.slice(2));
    const json = Boolean(flags.json);
    const hbFile = heartbeatPath(ROOT);
    const previous = readHeartbeat(hbFile);
    const maxSilenceMs = Number(flags['max-silence-min'] || 45) * 60000 || DEFAULT_MAX_SILENCE_MS;
    const revenueEnabled = Boolean(flags['with-revenue'])
        || String(process.env.SWARM_TICK_REVENUE || '').toLowerCase() === 'true';

    // --check-only is the liveness probe: it answers "is anything ticking at
    // all?" without needing credentials, so CI can page on a dead scheduler.
    if (flags['check-only']) {
        const ageMs = heartbeatAgeMs(previous);
        const alive = Boolean(previous) && ageMs <= maxSilenceMs;
        const payload = {
            alive,
            heartbeat: previous,
            heartbeat_age_minutes: Number.isFinite(ageMs) ? Math.round(ageMs / 60) : null,
            max_silence_minutes: Math.round(maxSilenceMs / 60000),
            heartbeat_path: hbFile,
            log_path: tickLogPath(ROOT)
        };
        if (json) console.log(JSON.stringify(payload, null, 2));
        else if (alive) console.log(`swarm loop alive: last heartbeat ${payload.heartbeat_age_minutes}m ago (${previous.status || 'unknown'})`);
        else console.log(`swarm loop DEAD: ${previous ? `last heartbeat ${payload.heartbeat_age_minutes}m ago` : 'no heartbeat ever recorded'}`);
        process.exitCode = alive ? 0 : 1;
        return;
    }

    const startedAt = new Date();
    const dependenciesInstalled = fs.existsSync(path.join(ROOT, 'node_modules'));
    const missingEnv = missingLiveEnv(process.env);
    const preHealth = evaluateLoopHealth({
        heartbeat: previous,
        root: ROOT,
        maxSilenceMs,
        requireLive: false
    });

    if (!json) {
        if (previous) {
            const age = Math.round(heartbeatAgeMs(previous) / 60000);
            console.log(`previous heartbeat: ${age}m ago (${previous.status || 'unknown'})`);
        } else {
            console.log('previous heartbeat: none — this is the first tick after the outage');
        }
        for (const warning of preHealth.warnings) console.log(`::warning::${warning}`);
        if (missingEnv.length) console.log(`::warning::live env missing: ${missingEnv.join(', ')}`);
        if (!dependenciesInstalled) console.log('::warning::node_modules missing — run npm ci');
    }

    writeHeartbeat(hbFile, { status: 'running', pid: process.pid, started_at: startedAt.toISOString() });

    const result = {
        at: startedAt.toISOString(),
        status: 'blocked',
        ok: false,
        missing_env: missingEnv,
        dependencies_installed: dependenciesInstalled,
        tick_age_before_ms: previous ? heartbeatAgeMs(previous) : null,
        duration_ms: 0,
        daemon: null,
        revenue: null
    };

    if (!dependenciesInstalled) {
        result.blocked_reason = 'dependencies_missing';
    } else {
        const daemon = await runNode('src/autonomous-daemon.mjs', ['--all-good-summary'], {
            timeoutMs: Number(flags.timeout || 240) * 1000
        });
        result.duration_ms += daemon.ms;
        const summary = lastJsonLine(daemon.stdout);
        result.daemon = {
            exit_code: daemon.code,
            timed_out: daemon.timedOut,
            summary,
            stderr: daemon.code === 0 ? undefined : tail(daemon.stderr || daemon.stdout)
        };

        if (revenueEnabled) {
            const revenue = await runNode('scripts/run-swarm-orchestrated.mjs', [], {
                timeoutMs: Number(flags.timeout || 240) * 1000
            });
            result.duration_ms += revenue.ms;
            result.revenue = {
                exit_code: revenue.code,
                timed_out: revenue.timedOut,
                stderr: revenue.code === 0 ? undefined : tail(revenue.stderr || revenue.stdout)
            };
        }

        const daemonOk = daemon.code === 0 && !daemon.timedOut;
        const revenueOk = result.revenue ? result.revenue.exit_code === 0 : true;
        if (daemonOk && revenueOk) {
            result.status = 'ok';
            result.ok = true;
        } else if (missingEnv.length) {
            result.status = 'blocked';
            result.blocked_reason = `missing_env:${missingEnv.join(',')}`;
        } else {
            result.status = 'failed';
            result.blocked_reason = daemon.timedOut ? 'daemon_timeout' : 'daemon_failed';
        }
    }

    const finishedAt = new Date();
    writeHeartbeat(hbFile, {
        status: result.status,
        ok: result.ok,
        tick_at: result.at,
        finished_at: finishedAt.toISOString(),
        duration_ms: result.duration_ms,
        blocked_reason: result.blocked_reason || null,
        missing_env: missingEnv,
        revenue_enabled: revenueEnabled,
        last_success_at: result.ok ? finishedAt.toISOString() : previous?.last_success_at || null,
        last_error: result.daemon?.stderr || result.revenue?.stderr || null
    }, finishedAt);
    appendTickLog(ROOT, result);

    if (json) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        console.log(`tick ${result.status} in ${Math.round(result.duration_ms / 1000)}s${result.blocked_reason ? ` — ${result.blocked_reason}` : ''}`);
        if (result.daemon?.summary) console.log(`daemon: ${JSON.stringify(result.daemon.summary).slice(0, 400)}`);
        if (result.status !== 'ok') console.log('::warning::swarm tick did not complete cleanly; see data/swarm-tick-log.ndjson');
    }

    process.exitCode = result.ok ? 0 : result.status === 'blocked' ? 2 : 1;
}

main().catch(error => {
    const hbFile = heartbeatPath(ROOT);
    const failedAt = new Date();
    try {
        writeHeartbeat(hbFile, {
            status: 'failed',
            ok: false,
            tick_at: failedAt.toISOString(),
            last_error: error.message
        }, failedAt);
        appendTickLog(ROOT, { at: failedAt.toISOString(), status: 'failed', ok: false, error: error.message });
    } catch { /* never let heartbeat logging mask the failure */ }
    console.error(`swarm-tick: ${error.message}`);
    process.exit(1);
});
