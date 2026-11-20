import path from 'node:path';

import { appendIntent, loadIntents, makeSessionId, normalizeReferrer } from './intent-tracker.mjs';

/**
 * Checkout funnel instrumentation.
 *
 * `checkout_intent` is recorded when /buy is opened for a named course, and
 * `paid_order` when a capture settles. Both use the intent tracker's existing
 * schema, so `funnelSummary()` reports them with no second data path. The
 * tracker speaks MAD/EUR, so `price_mad` and `price_eur` are derived from the
 * catalog FX table (1 catalog unit -> N target) instead of assumed, and the
 * charged amount is carried alongside in `amount_cents`/`currency`.
 *
 * Recording is best effort by design: an observability write must never fail a
 * checkout, so a failure is logged and dropped rather than raised.
 */

export const CHECKOUT_SESSION_COOKIE = 'rwc_sid';

export function intentsFile(env = process.env) {
    const configured = String(env.CHECKOUT_INTENTS_FILE || '').trim();
    if (configured) return path.resolve(configured);
    return path.join(path.resolve(env.SALES_DATA_DIR || 'data/sales'), 'course-intents.ndjson');
}

function parseCookie(header, name) {
    for (const part of String(header || '').split(';')) {
        const index = part.indexOf('=');
        if (index <= 0) continue;
        if (part.slice(0, index).trim() !== name) continue;
        return decodeURIComponent(part.slice(index + 1).trim());
    }
    return null;
}

/**
 * The checkout session, carried in a cookie so an intent and the order it
 * becomes share one id. Without a cookie a fresh id is used; `create: false`
 * never sets one (capture is also called server-to-server).
 */
export function checkoutSession(cookieHeader, { create = true } = {}) {
    const existing = parseCookie(cookieHeader, CHECKOUT_SESSION_COOKIE);
    if (/^sess_[A-Za-z0-9_]{6,80}$/.test(String(existing || ''))) {
        return { id: existing, setCookie: null };
    }
    const id = makeSessionId();
    if (!create) return { id, setCookie: null };
    return {
        id,
        setCookie: `${CHECKOUT_SESSION_COOKIE}=${id}; Path=/; Max-Age=86400; SameSite=Lax; HttpOnly`
    };
}

function money({ amountCents, catalog }) {
    const cents = Number(amountCents);
    if (!Number.isInteger(cents) || cents <= 0) return null;
    const fx = catalog?.fx || {};
    const madRate = Number(fx.MAD);
    if (!Number.isFinite(madRate) || madRate <= 0) return null;
    const eurRate = Number(fx.EUR);
    const units = cents / 100;
    return {
        amount_cents: cents,
        currency: String(catalog?.currency || 'USD').toUpperCase(),
        price_mad: Math.round(units * madRate),
        price_eur: Number.isFinite(eurRate) && eurRate > 0 ? Math.round(units * eurRate) : undefined
    };
}

export function checkoutIntentEvent({ course, catalog, sessionId, referrer, now = new Date() }) {
    if (!course?.slug) return null;
    const priced = money({ amountCents: course.price_cents, catalog });
    if (!priced) return null;
    return {
        event: 'checkout_intent',
        timestamp: new Date(now).toISOString(),
        session_id: String(sessionId || makeSessionId(course.slug)),
        course_id: String(course.slug),
        ...priced,
        source: 'checkout_page',
        referrer: normalizeReferrer(referrer)
    };
}

export function paidOrderEvent({ orderId, courseId, amountCents, catalog, sessionId, now = new Date() }) {
    if (!courseId) return null;
    const priced = money({ amountCents, catalog });
    if (!priced) return null;
    return {
        event: 'paid_order',
        timestamp: new Date(now).toISOString(),
        session_id: String(sessionId || makeSessionId(String(orderId || courseId))),
        course_id: String(courseId),
        order_id: orderId ? String(orderId) : undefined,
        ...priced,
        source: 'paypal_capture'
    };
}

/**
 * Append `event` unless the funnel already holds it. A reload of /buy for the
 * same session and course is one intent, and a replayed capture is one order.
 */
export function recordFunnelEvent(event, { file = intentsFile() } = {}) {
    if (!event) return { ok: false, reason: 'no_event' };
    try {
        const existing = loadIntents(file);
        const duplicate = event.event === 'paid_order'
            ? existing.some(row => row?.event === 'paid_order' && row?.order_id && row.order_id === event.order_id)
            : existing.some(row =>
                row?.event === 'checkout_intent'
                && row?.session_id === event.session_id
                && row?.course_id === event.course_id);
        if (duplicate) return { ok: true, duplicate: true, event };
        appendIntent(event, file);
        return { ok: true, duplicate: false, event };
    } catch (error) {
        console.warn(`[checkout-funnel] ${event?.event || 'event'} not recorded: ${error?.message ?? error}`);
        return { ok: false, reason: error?.message ?? String(error), event };
    }
}
