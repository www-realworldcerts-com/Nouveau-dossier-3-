import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

/**
 * Quote-backed checkout attempt idempotency.
 *
 * A signed quote identifies one checkout attempt. Replaying it returns the
 * order created by the first call instead of creating another PayPal order.
 * The caller also derives a stable PayPal-Request-Id from the same quote so a
 * retry handled by another serverless instance is deduplicated by PayPal.
 *
 * With a store directory configured, the attempt is a small JSON record on
 * durable storage: creation is claimed through an exclusive lock file and the
 * order is published with an atomic rename. A later process, or another
 * instance reading the same volume, replays the stored order after a restart.
 * Without a directory the registry keeps the in-process behaviour, which
 * cannot survive a restart and is not shared between instances.
 */

const DEFAULT_TTL_MS = 20 * 60 * 1000;
const DEFAULT_CLAIM_TIMEOUT_MS = 10_000;
const DEFAULT_CLAIM_STALE_MS = 60_000;
const DEFAULT_POLL_MS = 25;
const RECORD_VERSION = 1;
const RECORD_SUFFIX = '.json';
const CLAIM_SUFFIX = '.lock';

export const CHECKOUT_ATTEMPT_IN_PROGRESS = 'CHECKOUT_ATTEMPT_IN_PROGRESS';

/**
 * Another creator holds the claim for this quote and has not published its
 * order yet. Nothing was created by this call, so retrying the same request
 * after a short delay is safe; it must never create a second order.
 */
export class CheckoutAttemptInProgressError extends Error {
    constructor() {
        super(`${CHECKOUT_ATTEMPT_IN_PROGRESS}: another instance is still creating this order`);
        this.name = 'CheckoutAttemptInProgressError';
        this.code = CHECKOUT_ATTEMPT_IN_PROGRESS;
        this.retryable = true;
        this.retryAfterMs = 2000;
    }
}

export function checkoutAttemptKey(quoteId) {
    const id = String(quoteId || '').trim();
    if (!id) return null;
    return `acp_${crypto.createHash('sha256').update(`acp-order:${id}`).digest('hex').slice(0, 32)}`;
}

function positiveInt(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Attempts live at least until the quote expires so a replay after the quote
 * deadline cannot create a second order. A missing or unparseable quote
 * expiry falls back to the registry lifetime.
 */
function attemptDeadline(nowMs, ttlMs, expiresAt) {
    const quoteDeadline = expiresAt ? Date.parse(expiresAt) : NaN;
    return Math.max(
        nowMs + 60_000,
        Number.isFinite(quoteDeadline) ? quoteDeadline : nowMs + ttlMs
    );
}

function createMemoryRegistry({ ttlMs, now }) {
    const attempts = new Map();

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

        const deadline = attemptDeadline(now(), ttlMs, expiresAt);
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
        durable: false,
        run,
        clear: () => attempts.clear(),
        size: () => attempts.size
    };
}

function createDurableRegistry({ directory, ttlMs, now, claimTimeoutMs, claimStaleMs, pollIntervalMs }) {
    const dir = path.resolve(directory);
    const inflight = new Map();

    const recordFile = key => path.join(dir, `${key}${RECORD_SUFFIX}`);
    const claimFile = key => path.join(dir, `${key}${CLAIM_SUFFIX}`);

    async function readRecord(key) {
        let raw;
        try {
            raw = await fs.readFile(recordFile(key), 'utf8');
        } catch (error) {
            if (error?.code === 'ENOENT') return null;
            throw error;
        }
        let record;
        try {
            record = JSON.parse(raw);
        } catch {
            return null;
        }
        if (!record || record.v !== RECORD_VERSION || !record.order || typeof record.order !== 'object') {
            return null;
        }
        const expiresAt = Number(record.expires_at);
        if (Number.isFinite(expiresAt) && expiresAt <= now()) {
            await fs.unlink(recordFile(key)).catch(() => {});
            return null;
        }
        return record;
    }

    async function writeRecord(key, quoteId, order, expiresAt) {
        await fs.mkdir(dir, { recursive: true });
        const record = {
            v: RECORD_VERSION,
            quote_id: String(quoteId),
            key,
            order,
            created_at: new Date(now()).toISOString(),
            expires_at: attemptDeadline(now(), ttlMs, expiresAt)
        };
        const temporary = `${recordFile(key)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
        await fs.writeFile(temporary, `${JSON.stringify(record)}\n`, 'utf8');
        // rename is atomic on a POSIX volume, so a reader never sees half a record
        await fs.rename(temporary, recordFile(key));
    }

    async function claimIsStale(key) {
        try {
            const stats = await fs.stat(claimFile(key));
            return Date.now() - stats.mtimeMs > claimStaleMs;
        } catch (error) {
            if (error?.code === 'ENOENT') return true;
            throw error;
        }
    }

    /**
     * Claim creation for this key, or return the record another creator already
     * published while we waited. A claim older than claimStaleMs was abandoned
     * by a crashed creator and is taken over, so it cannot block every retry
     * for the attempt's lifetime.
     */
    async function acquireClaim(key) {
        const deadline = Date.now() + claimTimeoutMs;
        await fs.mkdir(dir, { recursive: true });
        for (;;) {
            try {
                const handle = await fs.open(claimFile(key), 'wx');
                try {
                    await handle.writeFile(String(process.pid));
                } finally {
                    await handle.close();
                }
                return null;
            } catch (error) {
                if (error?.code !== 'EEXIST') throw error;
            }
            // Another instance may have finished between the failed create and here.
            const published = await readRecord(key);
            if (published) return published;
            if (await claimIsStale(key)) {
                await fs.unlink(claimFile(key)).catch(() => {});
                continue;
            }
            if (Date.now() >= deadline) {
                throw new CheckoutAttemptInProgressError();
            }
            await sleep(pollIntervalMs);
        }
    }

    async function releaseClaim(key) {
        await fs.unlink(claimFile(key)).catch(() => {});
    }

    async function run(quoteId, create, { expiresAt = null } = {}) {
        const key = checkoutAttemptKey(quoteId);
        if (!key) throw new Error('Checkout attempt requires a quote id');

        const existing = await readRecord(key);
        if (existing) return { key, order: existing.order, replayed: true };

        const pending = inflight.get(key);
        if (pending) return { key, order: await pending, replayed: true };

        const publishedElsewhere = await acquireClaim(key);
        if (publishedElsewhere) return { key, order: publishedElsewhere.order, replayed: true };

        // A creator that published its order and died before releasing the
        // claim leaves a record behind. Replay it instead of creating another.
        const published = await readRecord(key);
        if (published) {
            await releaseClaim(key);
            return { key, order: published.order, replayed: true };
        }

        const creation = (async () => {
            const order = await create();
            await writeRecord(key, quoteId, order, expiresAt);
            return order;
        })();
        inflight.set(key, creation);
        try {
            const order = await creation;
            return { key, order, replayed: false };
        } finally {
            inflight.delete(key);
            await releaseClaim(key);
        }
    }

    return {
        durable: true,
        run,
        // Published records only; claims and truncated temp files are not attempts.
        size: () => {
            try {
                return fsSync.readdirSync(dir).filter(name => name.endsWith(RECORD_SUFFIX)).length;
            } catch {
                return 0;
            }
        }
    };
}

export function createCheckoutAttemptRegistry({
    directory = null,
    ttlMs = DEFAULT_TTL_MS,
    now = () => Date.now(),
    claimTimeoutMs = DEFAULT_CLAIM_TIMEOUT_MS,
    claimStaleMs = DEFAULT_CLAIM_STALE_MS,
    pollIntervalMs = DEFAULT_POLL_MS
} = {}) {
    const base = {
        ttlMs: positiveInt(ttlMs, DEFAULT_TTL_MS),
        now: typeof now === 'function' ? now : () => Date.now(),
        claimTimeoutMs: positiveInt(claimTimeoutMs, DEFAULT_CLAIM_TIMEOUT_MS),
        claimStaleMs: positiveInt(claimStaleMs, DEFAULT_CLAIM_STALE_MS),
        pollIntervalMs: positiveInt(pollIntervalMs, DEFAULT_POLL_MS)
    };
    const storeDirectory = typeof directory === 'string' ? directory.trim() : '';
    return storeDirectory
        ? createDurableRegistry({ ...base, directory: storeDirectory })
        : createMemoryRegistry(base);
}
