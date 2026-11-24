import fs from 'node:fs';
import path from 'node:path';

import { writeJsonPlainAtomic } from '../security/data-at-rest.mjs';

/**
 * Persisted emergency stop.
 *
 * `emergencyStop()` used to be in-memory only, while the daemon runs a
 * settlement cycle immediately on startup: a restart — including the one an
 * operator or a supervisor performs *because* money was misbehaving — cleared
 * the latch and the next cycle paid. The latch is a file now, written
 * atomically, so the stop survives restarts and the daemon refuses to start,
 * to run `--once` and to accept a manual trigger while it exists.
 *
 * Presence of the file is the latch. An unreadable or corrupt file counts as
 * latched: halting payouts is recoverable, paying after a stop is not.
 *
 * Clearing is deliberate — `--clear-emergency-stop`, or deleting the file —
 * so nobody restarts back into paying by accident.
 */

export const SETTLEMENT_EMERGENCY_STOP_ENV = 'SETTLEMENT_EMERGENCY_STOP_FILE';
export const DEFAULT_SETTLEMENT_EMERGENCY_STOP_FILE = path.join(
    'data',
    'financial',
    'settlement-emergency-stop.json'
);

export function emergencyStopFilePath(root = process.cwd(), env = process.env) {
    const configured = String(env?.[SETTLEMENT_EMERGENCY_STOP_ENV] ?? '').trim();
    if (configured) return path.resolve(configured);
    return path.resolve(root, DEFAULT_SETTLEMENT_EMERGENCY_STOP_FILE);
}

export function readEmergencyStop(root = process.cwd(), { env = process.env } = {}) {
    const file = emergencyStopFilePath(root, env);
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return { path: file, stopped: false, at: null, reason: null, by: null, error: null };
        }
        return { path: file, stopped: true, at: null, reason: null, by: null, error: String(error?.message ?? error) };
    }
    try {
        const parsed = JSON.parse(text);
        return {
            path: file,
            stopped: true,
            at: parsed?.stopped_at ?? null,
            reason: parsed?.reason ?? null,
            by: parsed?.by ?? null,
            error: null
        };
    } catch (error) {
        return {
            path: file,
            stopped: true,
            at: null,
            reason: null,
            by: null,
            error: `the stop latch is unreadable: ${error?.message ?? error}`
        };
    }
}

export function latchEmergencyStop(root = process.cwd(), { reason = null, by = null } = {}, { env = process.env } = {}) {
    const file = emergencyStopFilePath(root, env);
    const at = new Date().toISOString();
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeJsonPlainAtomic(file, { stopped_at: at, reason, by });
        return { stopped: true, path: file, at, reason, by, error: null };
    } catch (error) {
        return { stopped: false, path: file, at, reason, by, error: String(error?.message ?? error) };
    }
}

export function clearEmergencyStop(root = process.cwd(), { env = process.env } = {}) {
    const file = emergencyStopFilePath(root, env);
    if (!fs.existsSync(file)) return { cleared: false, reason: 'not_stopped', path: file };
    try {
        fs.rmSync(file);
        return { cleared: true, path: file };
    } catch (error) {
        return { cleared: false, reason: 'unlink_failed', path: file, error: String(error?.message ?? error) };
    }
}
