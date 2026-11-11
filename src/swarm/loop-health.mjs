import fs from 'node:fs';
import path from 'node:path';

/**
 * Loop health primitives: heartbeat, live-mode preflight and stale-freeze
 * detection. The swarm loop died silently because nothing recorded whether it
 * was running; every entry point now writes a heartbeat and every check reads it.
 */

export const DEFAULT_MAX_SILENCE_MS = 45 * 60 * 1000;
export const DEFAULT_FREEZE_STALE_HOURS = 72;

export const REQUIRED_LIVE_ENV = [
    'SWARM_LIVE',
    'BASE44_APP_ID',
    'BASE44_SERVICE_TOKEN',
    'PAYPAL_CLIENT_ID',
    'PAYPAL_CLIENT_SECRET'
];

export function heartbeatPath(root = process.cwd()) {
    return path.join(root, 'data', 'swarm-heartbeat.json');
}

export function tickLogPath(root = process.cwd()) {
    return path.join(root, 'data', 'swarm-tick-log.ndjson');
}

export function readJsonSafe(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

export function writeJsonAtomic(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
}

export function readHeartbeat(file = heartbeatPath()) {
    return readJsonSafe(file);
}

export function writeHeartbeat(file, patch, now = new Date()) {
    const previous = readHeartbeat(file) || {};
    const next = {
        ...previous,
        ...patch,
        at: (now instanceof Date ? now : new Date(now)).toISOString(),
        updated_at: new Date().toISOString()
    };
    writeJsonAtomic(file, next);
    return next;
}

export function heartbeatAgeMs(heartbeat, now = Date.now()) {
    const at = Date.parse(heartbeat?.at || heartbeat?.updated_at || '');
    if (!Number.isFinite(at)) return Infinity;
    return Math.max(0, now - at);
}

export function isHeartbeatStale(heartbeat, { maxSilenceMs = DEFAULT_MAX_SILENCE_MS, now = Date.now() } = {}) {
    if (!heartbeat) return true;
    return heartbeatAgeMs(heartbeat, now) > maxSilenceMs;
}

export function isPlaceholderValue(value) {
    if (value == null) return true;
    const text = String(value).trim();
    if (!text) return true;
    if (/^<\s*YOUR_[A-Z0-9_]+\s*>$/i.test(text)) return true;
    if (/^YOUR_[A-Z0-9_]+$/i.test(text)) return true;
    if (/^(REPLACE_ME|CHANGEME|TODO|xxxxx*|sk_live_xxxxx)$/i.test(text)) return true;
    return false;
}

export function missingLiveEnv(env = process.env) {
    const missing = [];
    for (const name of REQUIRED_LIVE_ENV) {
        const value = env[name];
        if (name === 'SWARM_LIVE') {
            if (String(value ?? '').toLowerCase() !== 'true') missing.push(name);
            continue;
        }
        if (isPlaceholderValue(value)) missing.push(name);
    }
    return missing;
}

export function freezeAgeHours(freeze, now = Date.now()) {
    const since = Date.parse(freeze?.since || freeze?.updatedAt || '');
    if (!Number.isFinite(since)) return Infinity;
    return Math.max(0, (now - since) / 3600000);
}

export function isStaleFreeze(freeze, { now = Date.now(), staleHours = DEFAULT_FREEZE_STALE_HOURS } = {}) {
    if (freeze?.active !== true) return false;
    return freezeAgeHours(freeze, now) >= staleHours;
}

/** SwarmMemory stores an array of [key, value] pairs; daemon state is a plain object. */
export function getEntry(data, key) {
    if (Array.isArray(data)) {
        const found = data.find(entry => Array.isArray(entry) && entry[0] === key);
        return found ? found[1] : undefined;
    }
    if (data && typeof data === 'object') return data[key];
    return undefined;
}

export function setEntry(data, key, value) {
    if (Array.isArray(data)) {
        const found = data.find(entry => Array.isArray(entry) && entry[0] === key);
        if (found) found[1] = value;
        else data.push([key, value]);
        return data;
    }
    return { ...(data || {}), [key]: value };
}

const STATE_FILES = [
    { rel: '.autonomous-state.json', key: null },
    { rel: path.join('data', 'swarm-memory.json'), key: 'daemon-state' }
];

export function readDaemonStateFiles(root = process.cwd()) {
    const rows = [];
    for (const { rel, key } of STATE_FILES) {
        const file = path.join(root, rel);
        const data = readJsonSafe(file);
        if (!data) continue;
        const state = key ? getEntry(data, key) : data;
        if (!state || typeof state !== 'object') continue;
        rows.push({ file, rel, key, state, freeze: state.freeze || null });
    }
    return rows;
}

/**
 * Clear a stale freeze in place, preserving sibling state. Returns whether
 * anything changed so callers can audit the action.
 */
export function clearFreezeInFile(file, { reason, by = 'owner', now = new Date() } = {}) {
    const data = readJsonSafe(file);
    if (!data) return { changed: false, file, reason: 'unreadable_or_missing' };
    const stamp = (now instanceof Date ? now : new Date(now)).toISOString();
    const apply = state => {
        if (!state || typeof state !== 'object' || state.freeze?.active !== true) return false;
        state.freeze = {
            ...state.freeze,
            active: false,
            cleared_at: stamp,
            cleared_by: by,
            clear_reason: reason || 'stale freeze cleared by doctor',
            violations: state.freeze.violations || []
        };
        return true;
    };

    let changed = false;
    if (Array.isArray(data)) {
        const entry = data.find(row => Array.isArray(row) && row[0] === 'daemon-state');
        if (entry) changed = apply(entry[1]);
    } else if (data && typeof data === 'object') {
        changed = apply(data);
    }
    if (changed) writeJsonAtomic(file, data);
    return { changed, file };
}

export function appendAudit(root = process.cwd(), entry, now = new Date()) {
    const at = now instanceof Date ? now : new Date(now);
    const dir = path.join(root, 'audits', 'autonomous');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${at.toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ timestamp: at.toISOString(), autonomous: true, ...entry }) + '\n');
    return file;
}

export function appendTickLog(root, entry, { maxLines = 500 } = {}) {
    const file = tickLogPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length > maxLines) {
        fs.writeFileSync(file, lines.slice(-maxLines).join('\n') + '\n');
    }
    return file;
}

export function evaluateLoopHealth({
    env = process.env,
    heartbeat = null,
    root = process.cwd(),
    now = Date.now(),
    maxSilenceMs = DEFAULT_MAX_SILENCE_MS,
    freezeStaleHours = DEFAULT_FREEZE_STALE_HOURS,
    requireLive = true
} = {}) {
    const blockers = [];
    const warnings = [];

    if (requireLive) {
        const missing = missingLiveEnv(env);
        if (missing.length) blockers.push(`missing_env:${missing.join(',')}`);
    }

    if (!heartbeat) {
        blockers.push('no_heartbeat');
    } else {
        const age = heartbeatAgeMs(heartbeat, now);
        if (age > maxSilenceMs) blockers.push(`heartbeat_stale:${Math.round(age / 60000)}m`);
    }

    const freezes = readDaemonStateFiles(root).filter(row => row.freeze?.active === true);
    for (const row of freezes) {
        const hours = freezeAgeHours(row.freeze, now);
        if (hours >= freezeStaleHours) {
            warnings.push(`stale_freeze:${row.rel}:${Number.isFinite(hours) ? Math.round(hours) : '?'}h`);
        } else {
            warnings.push(`freeze_active:${row.rel}`);
        }
    }

    return {
        ok: blockers.length === 0,
        blockers,
        warnings,
        heartbeat_age_ms: heartbeat ? heartbeatAgeMs(heartbeat, now) : null,
        freezes
    };
}
