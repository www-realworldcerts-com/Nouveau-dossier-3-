import fs from 'node:fs';
import path from 'node:path';
import { appendNdjson, readNdjson } from './catalog.mjs';

/**
 * CheckoutIntent observability (blueprint §4.5).
 *
 * Four funnel events per session: page_view, course_view, checkout_intent,
 * paid_order. Events are appended to ndjson so counts work with no analytics
 * vendor. The module is dependency-free and can be imported directly by the
 * site's checkout route or an internal server action.
 */

export const FUNNEL_EVENTS = ['page_view', 'course_view', 'checkout_intent', 'paid_order'];

const REFERRER_RULES = [
    { source: 'google', test: /google\./i },
    { source: 'bing', test: /bing\./i },
    { source: 'meta', test: /(facebook|fb\.|instagram|meta)\./i },
    { source: 'tiktok', test: /tiktok\./i },
    { source: 'linkedin', test: /linkedin\./i },
    { source: 'youtube', test: /youtube\./i },
    { source: 'whatsapp', test: /whatsapp|wa\.me/i }
];

export function normalizeReferrer(header) {
    if (!header) return 'direct';
    const value = String(header).trim();
    if (!value) return 'direct';
    try {
        const url = new URL(value);
        const match = REFERRER_RULES.find(rule => rule.test.test(url.hostname));
        return match ? match.source : 'referral';
    } catch {
        return 'referral';
    }
}

export function makeSessionId(seed = '') {
    const random = Math.random().toString(36).slice(2, 10);
    const time = Date.now().toString(36);
    return `sess_${time}${seed ? `_${String(seed).slice(0, 8)}` : ''}${random}`;
}

export function buildCheckoutIntent({
    courseId,
    priceMad,
    priceEur,
    sessionId,
    referrer,
    source = 'crypto_checkout',
    now = new Date()
}) {
    if (!courseId) throw new Error('checkout_intent requires courseId');
    const price = Number(priceMad);
    if (!Number.isFinite(price) || price <= 0) throw new Error('checkout_intent requires a positive priceMad');
    return {
        event: 'checkout_intent',
        timestamp: (now instanceof Date ? now : new Date(now)).toISOString(),
        session_id: String(sessionId || makeSessionId()),
        course_id: String(courseId),
        price_mad: Math.round(price),
        price_eur: Number.isFinite(Number(priceEur)) ? Math.round(Number(priceEur)) : undefined,
        source,
        referrer: referrer ? normalizeReferrer(referrer) : 'direct'
    };
}

export function validateIntent(intent) {
    const problems = [];
    if (!FUNNEL_EVENTS.includes(intent?.event)) problems.push(`unknown event ${intent?.event}`);
    if (!intent?.course_id) problems.push('course_id is required');
    if (!intent?.session_id) problems.push('session_id is required');
    if (['checkout_intent', 'paid_order'].includes(intent?.event)
        && !Number.isFinite(Number(intent?.price_mad))) {
        problems.push('price_mad must be numeric');
    }
    if (Number.isNaN(Date.parse(intent?.timestamp))) problems.push('timestamp must be ISO-8601');
    return { ok: problems.length === 0, problems };
}

export function appendIntent(intent, intentsPath) {
    const validation = validateIntent(intent);
    if (!validation.ok) {
        throw new Error(`Invalid intent: ${validation.problems.join('; ')}`);
    }
    appendNdjson(intentsPath, [intent]);
    return intent;
}

export function loadIntents(intentsPath) {
    return readNdjson(intentsPath);
}

export function funnelSummary(intentsPath, { days = 30, now = new Date() } = {}) {
    const events = loadIntents(intentsPath);
    const cutoff = new Date(now).getTime() - days * 24 * 60 * 60 * 1000;
    const scoped = events.filter(event => {
        const ts = Date.parse(event.timestamp);
        return Number.isFinite(ts) && ts >= cutoff;
    });
    const counts = Object.fromEntries(FUNNEL_EVENTS.map(name => [name, 0]));
    const byCourse = new Map();
    const byReferrer = new Map();
    for (const event of scoped) {
        if (event.event in counts) counts[event.event] += 1;
        if (event.course_id) {
            const row = byCourse.get(event.course_id) || { course_id: event.course_id, intents: 0, orders: 0, views: 0 };
            if (event.event === 'checkout_intent') row.intents += 1;
            if (event.event === 'paid_order') row.orders += 1;
            if (event.event === 'course_view') row.views += 1;
            byCourse.set(event.course_id, row);
        }
        if (event.event === 'checkout_intent') {
            const key = event.referrer || 'direct';
            byReferrer.set(key, (byReferrer.get(key) || 0) + 1);
        }
    }
    const intents = counts.checkout_intent;
    return {
        window_days: days,
        generated_at: new Date(now).toISOString(),
        counts,
        intent_to_paid_rate: intents ? Number((counts.paid_order / intents).toFixed(3)) : 0,
        by_course: [...byCourse.values()].sort((a, b) => b.intents - a.intents),
        by_referrer: [...byReferrer.entries()].map(([referrer, count]) => ({ referrer, intents: count }))
    };
}

/** Keep the intent log readable without unbounded growth. */
export function rotateIfLarge(intentsPath, maxBytes = 5 * 1024 * 1024) {
    if (!fs.existsSync(intentsPath)) return false;
    const { size } = fs.statSync(intentsPath);
    if (size < maxBytes) return false;
    const archive = `${intentsPath}.${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(intentsPath, archive);
    fs.mkdirSync(path.dirname(intentsPath), { recursive: true });
    fs.writeFileSync(intentsPath, '');
    return archive;
}
