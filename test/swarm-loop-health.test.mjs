import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    appendAudit,
    appendTickLog,
    clearFreezeInFile,
    evaluateLoopHealth,
    freezeAgeHours,
    getEntry,
    heartbeatAgeMs,
    isHeartbeatStale,
    isStaleFreeze,
    missingLiveEnv,
    readDaemonStateFiles,
    readHeartbeat,
    setEntry,
    tickLogPath,
    writeHeartbeat
} from '../src/swarm/loop-health.mjs';

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-loop-'));
}

const NOW = Date.parse('2026-11-11T12:00:00Z');

describe('heartbeat', () => {
    it('writes, merges and reads a heartbeat', () => {
        const dir = tempDir();
        const file = path.join(dir, 'data', 'swarm-heartbeat.json');
        writeHeartbeat(file, { status: 'running', pid: 1 }, new Date(NOW));
        writeHeartbeat(file, { status: 'ok', ok: true }, new Date(NOW + 60000));
        const heartbeat = readHeartbeat(file);
        assert.equal(heartbeat.status, 'ok');
        assert.equal(heartbeat.ok, true);
        assert.equal(heartbeat.pid, 1, 'previous fields survive a merge');
        assert.equal(heartbeat.at, '2026-11-11T12:01:00.000Z');
    });

    it('computes age and staleness', () => {
        const heartbeat = { at: new Date(NOW).toISOString() };
        assert.equal(heartbeatAgeMs(heartbeat, NOW + 5 * 60000), 5 * 60000);
        assert.equal(heartbeatAgeMs({}, NOW), Infinity);
        assert.equal(isHeartbeatStale(heartbeat, { now: NOW + 30 * 60000, maxSilenceMs: 45 * 60000 }), false);
        assert.equal(isHeartbeatStale(heartbeat, { now: NOW + 60 * 60000, maxSilenceMs: 45 * 60000 }), true);
        assert.equal(isHeartbeatStale(null), true);
    });

    it('detects missing live credentials, including placeholders', () => {
        assert.deepEqual(missingLiveEnv({}), [
            'SWARM_LIVE',
            'BASE44_APP_ID',
            'BASE44_SERVICE_TOKEN',
            'PAYPAL_CLIENT_ID',
            'PAYPAL_CLIENT_SECRET'
        ]);
        assert.deepEqual(
            missingLiveEnv({
                SWARM_LIVE: 'true',
                BASE44_APP_ID: 'app_1',
                BASE44_SERVICE_TOKEN: 'tok',
                PAYPAL_CLIENT_ID: 'client',
                PAYPAL_CLIENT_SECRET: 'secret'
            }),
            []
        );
        assert.ok(missingLiveEnv({
            SWARM_LIVE: 'false',
            BASE44_APP_ID: '<YOUR_BASE44_APP_ID>',
            BASE44_SERVICE_TOKEN: 'CHANGEME',
            PAYPAL_CLIENT_ID: 'client',
            PAYPAL_CLIENT_SECRET: 'secret'
        }).includes('SWARM_LIVE'));
    });
});

describe('daemon state and freezes', () => {
    it('reads swarm memory pairs and plain daemon state', () => {
        const dir = tempDir();
        fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'data', 'swarm-memory.json'),
            JSON.stringify([['daemon-state', { freeze: { active: true, since: '2026-01-04T04:51:11.384Z' } }], ['other', 1]])
        );
        fs.writeFileSync(
            path.join(dir, '.autonomous-state.json'),
            JSON.stringify({ freeze: { active: false }, consecutiveFailures: 0 })
        );
        const rows = readDaemonStateFiles(dir);
        assert.equal(rows.length, 2);
        assert.equal(rows[0].rel, '.autonomous-state.json');
        assert.equal(rows[1].freeze.active, true);
    });

    it('detects stale freezes by age', () => {
        const freeze = { active: true, since: '2026-01-04T04:51:11.384Z' };
        assert.ok(freezeAgeHours(freeze, NOW) > 3000);
        assert.equal(isStaleFreeze(freeze, { now: NOW, staleHours: 72 }), true);
        assert.equal(isStaleFreeze({ active: true, since: new Date(NOW - 3600000).toISOString() }, { now: NOW }), false);
        assert.equal(isStaleFreeze({ active: false }, { now: NOW }), false);
    });

    it('clears a freeze in both state formats without touching siblings', () => {
        const dir = tempDir();
        const memoryFile = path.join(dir, 'data', 'swarm-memory.json');
        fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
        fs.writeFileSync(memoryFile, JSON.stringify([
            ['daemon-state', { lastDeadmanAt: 5, freeze: { active: true, since: '2026-01-04T04:51:11.384Z', violations: [{ type: 'webhook_missing' }] } }],
            ['policy:global:safe_mode', false]
        ]));
        const cleared = clearFreezeInFile(memoryFile, { reason: 'test', by: 'suite', now: new Date(NOW) });
        assert.equal(cleared.changed, true);
        const data = JSON.parse(fs.readFileSync(memoryFile, 'utf8'));
        const state = getEntry(data, 'daemon-state');
        assert.equal(state.freeze.active, false);
        assert.equal(state.freeze.clear_reason, 'test');
        assert.equal(state.lastDeadmanAt, 5, 'sibling fields preserved');
        assert.deepEqual(state.freeze.violations, [{ type: 'webhook_missing' }]);
        assert.equal(getEntry(data, 'policy:global:safe_mode'), false, 'other entries preserved');
        assert.equal(clearFreezeInFile(memoryFile, { reason: 'again' }).changed, false);

        const plainFile = path.join(dir, '.autonomous-state.json');
        fs.writeFileSync(plainFile, JSON.stringify({ freeze: { active: true, since: '2026-01-04T04:51:11.384Z' }, lastBackupAt: 0 }));
        assert.equal(clearFreezeInFile(plainFile, { reason: 'stale', now: new Date(NOW) }).changed, true);
        const plain = JSON.parse(fs.readFileSync(plainFile, 'utf8'));
        assert.equal(plain.freeze.active, false);
        assert.equal(plain.lastBackupAt, 0);
    });

    it('sets entries in both formats', () => {
        const pairs = [['a', 1]];
        setEntry(pairs, 'b', 2);
        setEntry(pairs, 'a', 3);
        assert.deepEqual(pairs, [['a', 3], ['b', 2]]);
        assert.deepEqual(setEntry({ a: 1 }, 'b', 2), { a: 1, b: 2 });
    });
});

describe('loop health evaluation', () => {
    const configuredEnv = {
        SWARM_LIVE: 'true',
        BASE44_APP_ID: 'app',
        BASE44_SERVICE_TOKEN: 'token',
        PAYPAL_CLIENT_ID: 'id',
        PAYPAL_CLIENT_SECRET: 'secret'
    };

    it('blocks when credentials or heartbeat are missing', () => {
        const health = evaluateLoopHealth({ env: {}, heartbeat: null, root: tempDir(), now: NOW });
        assert.equal(health.ok, false);
        assert.ok(health.blockers.some(entry => entry.startsWith('missing_env:')));
        assert.ok(health.blockers.includes('no_heartbeat'));
    });

    it('blocks a silent loop even with valid credentials', () => {
        const heartbeat = { at: new Date(NOW - 3 * 3600000).toISOString(), status: 'ok' };
        const health = evaluateLoopHealth({ env: configuredEnv, heartbeat, root: tempDir(), now: NOW, maxSilenceMs: 45 * 60000 });
        assert.equal(health.ok, false);
        assert.ok(health.blockers[0].startsWith('heartbeat_stale:'));
    });

    it('passes a fresh heartbeat and warns on a stale freeze', () => {
        const dir = tempDir();
        fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'data', 'swarm-memory.json'),
            JSON.stringify([['daemon-state', { freeze: { active: true, since: '2026-01-04T04:51:11.384Z' } }]])
        );
        const health = evaluateLoopHealth({
            env: configuredEnv,
            heartbeat: { at: new Date(NOW - 60000).toISOString() },
            root: dir,
            now: NOW
        });
        assert.equal(health.ok, true);
        assert.deepEqual(health.blockers, []);
        assert.ok(health.warnings.some(warning => warning.startsWith('stale_freeze:')));
    });
});

describe('tick bookkeeping', () => {
    it('appends audit entries and trims the tick log', () => {
        const dir = tempDir();
        const auditFile = appendAudit(dir, { level: 'policy', message: 'test' }, new Date(NOW));
        assert.equal(path.basename(auditFile), '2026-11-11.jsonl');
        const audit = fs.readFileSync(auditFile, 'utf8').trim();
        assert.match(audit, /"message":"test"/);

        for (let i = 0; i < 5; i += 1) {
            appendTickLog(dir, { at: new Date(NOW + i).toISOString(), status: 'ok', i }, { maxLines: 3 });
        }
        const lines = fs.readFileSync(tickLogPath(dir), 'utf8').trim().split('\n');
        assert.equal(lines.length, 3);
        assert.equal(JSON.parse(lines.at(-1)).i, 4);
    });
});
