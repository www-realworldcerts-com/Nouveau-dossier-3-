import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RUNS_DIR = 'ShopifyActivationRuns';
const LOCK_FILE = 'ShopifyActivation.lock';
const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000;

function iso(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error('Invalid activation timestamp');
    return date.toISOString();
}

export function activationRunsDirectory(dataDir) {
    if (!dataDir) throw new Error('Activation runs require a data directory');
    return path.join(path.resolve(dataDir), RUNS_DIR);
}

export function activationLockPath(dataDir) {
    if (!dataDir) throw new Error('Activation runs require a data directory');
    return path.join(path.resolve(dataDir), LOCK_FILE);
}

export function normalizeActivationRunId(value) {
    const runId = String(value || '').trim().replace(/\.json$/i, '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
        throw new Error('Invalid activation run id');
    }
    return runId;
}

export function activationRunPath(dataDir, runId) {
    return path.join(
        activationRunsDirectory(dataDir),
        `${normalizeActivationRunId(runId)}.json`
    );
}

export function newActivationRunId(now = new Date()) {
    const stamp = iso(now).replace(/[-:.TZ]/g, '').slice(0, 14);
    return `${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

function readLock(dataDir) {
    try {
        return JSON.parse(fs.readFileSync(activationLockPath(dataDir), 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        return { invalid: true, error: error.message };
    }
}

function processIsAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

function lockCanBeReclaimed(lock, dataDir, { now = new Date(), staleAfterMs = DEFAULT_STALE_AFTER_MS } = {}) {
    if (!lock || lock.invalid) {
        try {
            return Date.now() - fs.statSync(activationLockPath(dataDir)).mtimeMs > staleAfterMs;
        } catch {
            return true;
        }
    }
    const startedAt = Date.parse(lock.started_at || '');
    const lockAge = Number.isFinite(startedAt) ? Date.now() - startedAt : null;
    const stale = lockAge !== null && lockAge > staleAfterMs;
    if (lock.hostname && lock.hostname !== os.hostname()) return stale;
    return stale || !processIsAlive(Number(lock.pid));
}

/**
 * Acquire an exclusive, machine-local activation lock. A crashed process can
 * be resumed immediately on the same host; locks from another host are only
 * reclaimed after the stale window.
 */
export function acquireActivationLock({
    dataDir,
    runId,
    domain = '',
    now = new Date(),
    pid = process.pid,
    staleAfterMs = DEFAULT_STALE_AFTER_MS
} = {}) {
    const safeRunId = normalizeActivationRunId(runId);
    const lockPath = activationLockPath(dataDir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });

    const payload = {
        run_id: safeRunId,
        pid,
        hostname: os.hostname(),
        domain: String(domain || ''),
        started_at: iso(now)
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const fd = fs.openSync(lockPath, 'wx', 0o600);
            try {
                fs.writeFileSync(fd, JSON.stringify(payload, null, 2));
            } finally {
                fs.closeSync(fd);
            }
            return {
                ok: true,
                run_id: safeRunId,
                lock_path: lockPath,
                lock: payload
            };
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const holder = readLock(dataDir);
            if (!lockCanBeReclaimed(holder, dataDir, { now, staleAfterMs })) {
                return {
                    ok: false,
                    reason: 'activation_locked',
                    lock_path: lockPath,
                    lock: holder
                };
            }
            try {
                fs.unlinkSync(lockPath);
            } catch (unlinkError) {
                if (unlinkError.code !== 'ENOENT') throw unlinkError;
            }
        }
    }

    return {
        ok: false,
        reason: 'activation_lock_unavailable',
        lock_path: lockPath,
        lock: readLock(dataDir)
    };
}

export function releaseActivationLock(lock) {
    if (!lock?.ok || !lock.run_id || !lock.lock_path) return false;
    const lockPath = lock.lock_path;
    try {
        const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (holder.run_id !== lock.run_id) return false;
        fs.unlinkSync(lockPath);
        return true;
    } catch (error) {
        return error.code === 'ENOENT';
    }
}

export function saveActivationRun(dataDir, report) {
    const reportPath = activationRunPath(dataDir, report.run_id);
    const directory = path.dirname(reportPath);
    fs.mkdirSync(directory, { recursive: true });
    const payload = {
        ...report,
        report_path: reportPath,
        updated_at: report.updated_at || iso(report.updated_at)
    };
    const temporary = `${reportPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), { mode: 0o600 });
        fs.renameSync(temporary, reportPath);
    } catch (error) {
        try {
            fs.unlinkSync(temporary);
        } catch {
            // Best effort cleanup only.
        }
        throw error;
    }
    return reportPath;
}

export function loadActivationRun(dataDir, runId) {
    try {
        return JSON.parse(fs.readFileSync(activationRunPath(dataDir, runId), 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

export function latestActivationRun(dataDir, { inProgressOnly = false } = {}) {
    let files;
    try {
        files = fs.readdirSync(activationRunsDirectory(dataDir));
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
    const runs = files
        .filter(file => file.endsWith('.json'))
        .map(file => {
            try {
                const report = JSON.parse(fs.readFileSync(path.join(activationRunsDirectory(dataDir), file), 'utf8'));
                return { report, modified: fs.statSync(path.join(activationRunsDirectory(dataDir), file)).mtimeMs };
            } catch {
                return null;
            }
        })
        .filter(Boolean)
        .filter(row => !inProgressOnly || row.report.status === 'in_progress')
        .sort((left, right) => {
            const leftTime = Date.parse(left.report.started_at || '') || left.modified;
            const rightTime = Date.parse(right.report.started_at || '') || right.modified;
            return rightTime - leftTime;
        });
    return runs[0]?.report || null;
}

export function resolveActivationRun(dataDir, value) {
    if (value === true || value === 'latest') {
        return latestActivationRun(dataDir, { inProgressOnly: true });
    }
    return loadActivationRun(dataDir, value);
}
