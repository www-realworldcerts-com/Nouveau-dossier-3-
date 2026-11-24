import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    clearEmergencyStop,
    emergencyStopFilePath,
    latchEmergencyStop,
    readEmergencyStop
} from '../src/financial/settlement-emergency-stop.mjs';

function tempLatch(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emergency-stop-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return { dir, file: path.join(dir, 'stop.json'), env: { SETTLEMENT_EMERGENCY_STOP_FILE: path.join(dir, 'stop.json') } };
}

test('an absent latch is not a stop', () => {
    const { env } = tempLatch({ after: () => {} });

    const latch = readEmergencyStop('/root', { env });
    assert.equal(latch.stopped, false);
    assert.equal(latch.error, null);
});

test('a latched stop is readable after the process that wrote it is gone', () => {
    const { file, env } = tempLatch({ after: () => {} });

    const written = latchEmergencyStop('/root', { reason: 'money behaviour under review', by: 'owner' }, { env });
    assert.equal(written.stopped, true);
    assert.equal(fs.existsSync(file), true, 'the latch is on disk, not only in memory');

    const latch = readEmergencyStop('/root', { env });
    assert.equal(latch.stopped, true);
    assert.equal(latch.reason, 'money behaviour under review');
    assert.equal(latch.by, 'owner');
    assert.match(latch.at, /^\d{4}-\d{2}-\d{2}T/);
});

test('a corrupt latch counts as stopped instead of paying', () => {
    const { dir, env } = tempLatch({ after: () => {} });
    fs.writeFileSync(path.join(dir, 'stop.json'), '{"stopped_at":');

    const latch = readEmergencyStop('/root', { env });
    assert.equal(latch.stopped, true, 'halting payouts is recoverable; paying after a stop is not');
    assert.match(latch.error, /unreadable/);
});

test('clearing is explicit and idempotent', () => {
    const { file, env } = tempLatch({ after: () => {} });
    assert.equal(clearEmergencyStop('/root', { env }).reason, 'not_stopped');

    latchEmergencyStop('/root', { reason: 'test' }, { env });
    assert.deepEqual(clearEmergencyStop('/root', { env }).cleared, true);
    assert.equal(fs.existsSync(file), false);
    assert.equal(readEmergencyStop('/root', { env }).stopped, false);

    assert.equal(clearEmergencyStop('/root', { env }).cleared, false);
});

test('the latch lives under the root unless the environment moves it', () => {
    assert.equal(
        emergencyStopFilePath('/root', {}),
        path.resolve('/root', 'data', 'financial', 'settlement-emergency-stop.json')
    );
    assert.equal(
        emergencyStopFilePath('/root', { SETTLEMENT_EMERGENCY_STOP_FILE: 'tmp/stop.json' }),
        path.resolve('tmp/stop.json')
    );
});
