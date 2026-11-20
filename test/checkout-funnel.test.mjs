import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    checkoutIntentEvent,
    checkoutSession,
    intentsFile,
    paidOrderEvent,
    recordFunnelEvent
} from '../src/sales/checkout-funnel.mjs';
import { funnelSummary } from '../src/sales/intent-tracker.mjs';

const CATALOG = {
    currency: 'USD',
    fx: { USD: 1, MAD: 10, EUR: 0.92 }
};

const COURSE = { slug: 'financial-risk-manager-test-bank', price_cents: 1900 };

async function tempFile(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'checkout-funnel-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    return path.join(dir, 'course-intents.ndjson');
}

test('an intent carries the charged amount and its MAD/EUR conversion', () => {
    const event = checkoutIntentEvent({
        course: COURSE,
        catalog: CATALOG,
        sessionId: 'sess_abc12345',
        referrer: 'https://www.google.com/search?q=frm'
    });

    assert.equal(event.event, 'checkout_intent');
    assert.equal(event.course_id, 'financial-risk-manager-test-bank');
    assert.equal(event.session_id, 'sess_abc12345');
    assert.deepEqual(
        { amount_cents: event.amount_cents, currency: event.currency, price_mad: event.price_mad, price_eur: event.price_eur },
        { amount_cents: 1900, currency: 'USD', price_mad: 190, price_eur: 17 }
    );
    assert.equal(event.referrer, 'google');
    assert.equal(event.source, 'checkout_page');
});

test('no intent is invented when the catalog cannot convert the price', () => {
    assert.equal(checkoutIntentEvent({ course: COURSE, catalog: { currency: 'USD', fx: {} } }), null);
    assert.equal(checkoutIntentEvent({ course: { slug: 'free', price_cents: 0 }, catalog: CATALOG }), null);
    assert.equal(paidOrderEvent({ orderId: 'ORDER-1', courseId: null, amountCents: 1900, catalog: CATALOG }), null);
});

test('the session cookie is reused and only minted once', () => {
    const fresh = checkoutSession('');
    assert.match(fresh.id, /^sess_[A-Za-z0-9_]+$/);
    assert.match(fresh.setCookie, /^rwc_sid=sess_[A-Za-z0-9_]+; Path=\/; Max-Age=86400; SameSite=Lax; HttpOnly$/);

    const reused = checkoutSession(`other=1; rwc_sid=${fresh.id}; theme=dark`);
    assert.deepEqual(reused, { id: fresh.id, setCookie: null });

    const server = checkoutSession('', { create: false });
    assert.equal(server.setCookie, null, 'a server-to-server call never sets a cookie');
});

test('a reload of the same intent and a replayed order are not double counted', async (t) => {
    const file = await tempFile(t);
    const intent = checkoutIntentEvent({ course: COURSE, catalog: CATALOG, sessionId: 'sess_reload01' });
    const order = paidOrderEvent({
        orderId: 'ORDER-1',
        courseId: COURSE.slug,
        amountCents: 1900,
        catalog: CATALOG,
        sessionId: 'sess_reload01'
    });

    assert.equal(recordFunnelEvent(intent, { file }).duplicate, false);
    assert.equal(recordFunnelEvent(intent, { file }).duplicate, true);
    assert.equal(recordFunnelEvent(order, { file }).duplicate, false);
    assert.equal(recordFunnelEvent(order, { file }).duplicate, true);

    const summary = funnelSummary(file, { days: 30 });
    assert.equal(summary.counts.checkout_intent, 1);
    assert.equal(summary.counts.paid_order, 1);
    assert.equal(summary.intent_to_paid_rate, 1);
});

test('two sessions viewing the same course are two intents', async (t) => {
    const file = await tempFile(t);
    recordFunnelEvent(checkoutIntentEvent({ course: COURSE, catalog: CATALOG, sessionId: 'sess_first001' }), { file });
    recordFunnelEvent(checkoutIntentEvent({ course: COURSE, catalog: CATALOG, sessionId: 'sess_second01' }), { file });

    assert.equal(funnelSummary(file, { days: 30 }).counts.checkout_intent, 2);
});

test('a write failure is reported, never thrown into checkout', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'checkout-funnel-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const blocked = path.join(dir, 'nested', 'course-intents.ndjson');
    // A file where a directory is expected makes the append fail.
    await fs.writeFile(path.join(dir, 'nested'), 'not a directory', 'utf8');

    const result = recordFunnelEvent(
        checkoutIntentEvent({ course: COURSE, catalog: CATALOG, sessionId: 'sess_failure01' }),
        { file: blocked }
    );
    assert.equal(result.ok, false);
    assert.ok(result.reason);
});

test('the intents file follows CHECKOUT_INTENTS_FILE and falls back to the sales data dir', () => {
    assert.equal(intentsFile({ CHECKOUT_INTENTS_FILE: 'tmp/funnel.ndjson' }), path.resolve('tmp/funnel.ndjson'));
    assert.equal(
        intentsFile({ SALES_DATA_DIR: 'tmp/sales' }),
        path.join(path.resolve('tmp/sales'), 'course-intents.ndjson')
    );
});
