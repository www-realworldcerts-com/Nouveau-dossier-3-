import crypto from 'node:crypto';

/**
 * In-process idempotency for quote-backed checkout attempts.
 *
 * A signed quote identifies one checkout attempt. Replaying it returns the
 * order created by the first call instead of creating another PayPal order.
 * The caller also derives a stable PayPal-Request-Id from the same quote so a
 * retry handled by another serverless instance is deduplicated by PayPal.
 */

export function checkoutAttemptKey(quoteId) {
    const id = String(quoteId || '').trim();
    if (!id) return null;
    return `acp_${crypto.createHash('sha256').update(`acp-order:${id}`).digest('hex').slice(0, 32)}`;
}

export function createCheckoutAttemptRegistry({
    ttlMs = 20 * 60 * 1000,
    now = () => Date.now()
} = {}) {
    const attempts = new Map();
    const lifetimeMs = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0
        ? Number(ttlMs)
        : 20 * 60 * 1000;

    function prune() {
        const current = now();
        for (const [key, record] of attempts) {
            if (record.expiresAt <= current) attempts.delete(key);
        }
    }

    async function run(quoteId, create, { expiresAt = null } = {}) {
        const key = checkoutAttemptKey(quoteId);
        if (!key) throw new Error('Checkout attempt requires a quote id');
        prune();

        const existing = attempts.get(key);
        if (existing) {
            const order = existing.order ?? await existing.promise;
            return { key, order, replayed: true };
        }

        const quoteDeadline = expiresAt ? Date.parse(expiresAt) : NaN;
        const deadline = Math.max(
            now() + 60_000,
            Number.isFinite(quoteDeadline) ? quoteDeadline : now() + lifetimeMs
        );
        const record = { expiresAt: deadline, order: null, promise: null };

        const promise = Promise.resolve()
            .then(create)
            .then((order) => {
                record.order = order;
                record.promise = Promise.resolve(order);
                return order;
            }, (error) => {
                attempts.delete(key);
                throw error;
            });
        record.promise = promise;
        attempts.set(key, record);

        const order = await promise;
        return { key, order, replayed: false };
    }

    return {
        run,
        clear: () => attempts.clear(),
        size: () => attempts.size
    };
}
