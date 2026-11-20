import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkoutIntentEvent, recordFunnelEvent } from '../src/sales/checkout-funnel.mjs';
import { funnelSummary, funnelSummaryFromEvents } from '../src/sales/intent-tracker.mjs';
import {
    fileIntentStore,
    intentStoreStatus,
    intentsFile,
    parseIntentEvents,
    remoteIntentStore,
    resolveIntentStore
} from '../src/sales/intent-store.mjs';

const CATALOG = { currency: 'USD', fx: { USD: 1, MAD: 10, EUR: 0.92 } };
const COURSE = { slug: 'financial-risk-manager-test-bank', price_cents: 1900 };

function intent(sessionId) {
    return checkoutIntentEvent({ course: COURSE, catalog: CATALOG, sessionId });
}

test('a file store is durable on a host and instance-local on serverless', () => {
    const host = fileIntentStore({ file: 'x.ndjson', env: {} });
    assert.equal(host.durable, true);
    assert.equal(host.reason, null);

    const serverless = fileIntentStore({ file: 'x.ndjson', env: { VERCEL: '1' } });
    assert.equal(serverless.durable, false);
    assert.equal(serverless.reason, 'serverless_instance_has_no_shared_filesystem');

    assert.deepEqual(intentStoreStatus(serverless), {
        kind: 'file',
        durable: false,
        target: 'x.ndjson',
        reason: 'serverless_instance_has_no_shared_filesystem'
    });
});

test('a configured URL selects the remote log instead of the file', () => {
    const store = resolveIntentStore({ env: { CHECKOUT_INTENTS_URL: 'https://logs.example/intents', VERCEL: '1' } });
    assert.equal(store.kind, 'remote');
    assert.equal(store.durable, true);
    assert.equal(intentStoreStatus(store).target, 'https://logs.example/intents');

    assert.equal(resolveIntentStore({ env: {} }).kind, 'file');
});

test('the remote log appends with the bearer token and reads both shapes', async () => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
        calls.push({ url, method: init.method, headers: init.headers, body: init.body });
        if (init.method === 'POST') {
            return { ok: true, status: 202 };
        }
        return {
            ok: true,
            status: 200,
            headers: { get: () => 'application/x-ndjson' },
            text: async () => `${JSON.stringify(intent('sess_remote01'))}\n`
        };
    };
    const store = remoteIntentStore({ url: 'https://logs.example/intents', token: 'secret-token', fetchImpl });

    await store.append(intent('sess_remote01'));
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].headers.authorization, 'Bearer secret-token');
    assert.deepEqual(JSON.parse(calls[0].body).events[0].course_id, COURSE.slug);

    const events = await store.load();
    assert.equal(calls[1].method, undefined, 'a read is a plain GET');
    assert.equal(events.length, 1);
    assert.equal(events[0].course_id, COURSE.slug);
});

test('an endpoint answering JSON arrays or {events} is understood', () => {
    assert.equal(parseIntentEvents('[{"a":1}]', 'application/json').length, 1);
    assert.equal(parseIntentEvents('{"events":[{"a":1},{"a":2}]}', 'application/json').length, 2);
    assert.equal(parseIntentEvents('{"a":1}\n{"a":2}\n', 'text/plain').length, 2);
    assert.deepEqual(parseIntentEvents('', 'application/json'), []);
});

test('a rejected append and a failed read are reported, never thrown into checkout', async () => {
    const fetching = remoteIntentStore({
        url: 'https://logs.example/intents',
        fetchImpl: async () => ({ ok: false, status: 503 })
    });
    const event = intent('sess_failure01');

    await assert.rejects(() => fetching.append(event), /HTTP 503/);
    await assert.rejects(() => fetching.load(), /HTTP 503/);

    const recorded = await recordFunnelEvent(event, { store: fetching });
    assert.equal(recorded.ok, false);
    assert.match(recorded.reason, /log_unavailable/);
});

test('dedupe works against the remote log, so a cold start does not double count', async () => {
    const log = [];
    let reads = 0;
    const store = remoteIntentStore({
        url: 'https://logs.example/intents',
        fetchImpl: async (url, init = {}) => {
            if (init.method === 'POST') {
                log.push(...JSON.parse(init.body).events);
                return { ok: true, status: 200 };
            }
            reads += 1;
            return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(log) };
        }
    });

    const event = intent('sess_remote02');
    assert.equal((await recordFunnelEvent(event, { store })).duplicate, false);
    assert.equal((await recordFunnelEvent(event, { store })).duplicate, true);
    assert.equal(log.length, 1, 'one event reached the remote log');
    assert.equal(reads, 2);
});

test('funnelSummary and funnelSummaryFromEvents agree on the same events', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'intent-store-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'course-intents.ndjson');

    await recordFunnelEvent(intent('sess_summary01'), { file });
    await recordFunnelEvent(
        { ...intent('sess_summary01'), course_id: 'second-course' },
        { file }
    );

    const now = new Date('2026-11-20T00:00:00.000Z');
    const events = fileIntentStore({ file, env: {} }).load();
    assert.deepEqual(
        funnelSummary(file, { days: 30, now }),
        funnelSummaryFromEvents(await events, { days: 30, now })
    );
    assert.equal(funnelSummaryFromEvents(await events, { days: 30, now }).counts.checkout_intent, 2);
});

test('the file path still follows CHECKOUT_INTENTS_FILE and SALES_DATA_DIR', () => {
    assert.equal(intentsFile({ CHECKOUT_INTENTS_FILE: 'tmp/funnel.ndjson' }), path.resolve('tmp/funnel.ndjson'));
    assert.equal(
        intentsFile({ SALES_DATA_DIR: 'tmp/sales' }),
        path.join(path.resolve('tmp/sales'), 'course-intents.ndjson')
    );
});
