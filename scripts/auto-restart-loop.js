import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../src/load-env.mjs';
import { heartbeatPath, writeHeartbeat } from '../src/swarm/loop-health.mjs';
import { runTickAudit } from '../src/swarm/tick-audit.mjs';

/**
 * Long-lived supervisor for local/VM deployment (`npm start`).
 *
 * It runs the same bounded tick the CI scheduler runs, at a fixed interval,
 * with exponential backoff on failure and a pid lock so two supervisors cannot
 * fight over the same state. The previous version relaunched a one-shot
 * orchestrator every 5 seconds with BASE44_OFFLINE=true forced, which defeated
 * live mode and produced a crash-loop instead of a loop.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const TICK_SCRIPT = path.join(ROOT_DIR, 'scripts', 'swarm-tick.mjs');
const LOCK_FILE = path.join(ROOT_DIR, 'data', 'swarm-loop.lock');

const intervalMs = Math.max(60000, Number(process.env.SWARM_LOOP_INTERVAL_MS || 15 * 60 * 1000));
const maxBackoffMs = Math.max(intervalMs, Number(process.env.SWARM_LOOP_MAX_BACKOFF_MS || 30 * 60 * 1000));
// Run the same audit the CI workflow runs, including the PayPal dry-run
// reconciliation, after every local tick. Disable with SWARM_TICK_AUDIT=false.
const auditEnabled = String(process.env.SWARM_TICK_AUDIT ?? 'true').toLowerCase() !== 'false';

let stopping = false;
let backoffMs = 0;

function acquireLock() {
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
    if (fs.existsSync(LOCK_FILE)) {
        const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
        if (Number.isFinite(pid) && pid !== process.pid) {
            try {
                process.kill(pid, 0);
                console.error(`swarm loop already running as pid ${pid}; refusing to start a second supervisor.`);
                process.exit(1);
            } catch {
                console.warn(`removing stale loop lock for pid ${pid}`);
            }
        }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
}

function releaseLock() {
    try {
        if (Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()) === process.pid) fs.rmSync(LOCK_FILE, { force: true });
    } catch { /* nothing to release */ }
}

function runTick() {
    return new Promise(resolve => {
        const proc = spawn(process.execPath, [TICK_SCRIPT], {
            cwd: ROOT_DIR,
            stdio: 'inherit',
            env: process.env
        });
        proc.on('close', code => resolve(code ?? 1));
        proc.on('error', error => {
            console.error('failed to spawn swarm tick:', error.message);
            resolve(1);
        });
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function loop() {
    acquireLock();
    writeHeartbeat(heartbeatPath(ROOT_DIR), {
        supervisor: 'auto-restart-loop',
        supervisor_pid: process.pid,
        status: 'starting',
        interval_ms: intervalMs
    });

    while (!stopping) {
        const code = await runTick();
        if (stopping) break;

        if (auditEnabled) {
            const audit = await runTickAudit({ root: ROOT_DIR });
            if (stopping) break;
            if (audit.timedOut) {
                console.error('tick audit timed out; findings may be incomplete');
            } else if (audit.code === 2) {
                console.error('tick audit reported findings; see data/resilience/incidents');
            } else if (audit.code !== 0) {
                console.error(`tick audit exited ${audit.code}; see logs above`);
            }
        }

        if (code === 0) {
            backoffMs = 0;
        } else {
            // Exit code 2 means "blocked by configuration", not a crash: retry
            // at the normal cadence so a fixed env recovers without a restart.
            backoffMs = code === 2
                ? intervalMs
                : Math.min(maxBackoffMs, backoffMs ? backoffMs * 2 : 60000);
            console.error(`tick exited ${code}; next attempt in ${Math.round(backoffMs / 1000)}s`);
        }

        writeHeartbeat(heartbeatPath(ROOT_DIR), {
            supervisor: 'auto-restart-loop',
            supervisor_pid: process.pid,
            status: code === 0 ? 'supervising' : 'backoff',
            next_tick_in_ms: backoffMs || intervalMs
        });

        const waitMs = backoffMs || intervalMs;
        const deadline = Date.now() + waitMs;
        while (!stopping && Date.now() < deadline) {
            await sleep(Math.min(5000, deadline - Date.now()));
        }
    }

    releaseLock();
    console.log('swarm loop stopped.');
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        if (stopping) process.exit(0);
        stopping = true;
        console.log(`received ${signal}; finishing current tick before exit.`);
    });
}

process.on('exit', releaseLock);

loop().catch(error => {
    console.error('swarm supervisor failed:', error.message);
    releaseLock();
    process.exit(1);
});
