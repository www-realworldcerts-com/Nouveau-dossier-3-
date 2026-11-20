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

/**
 * One signed quote is one checkout attempt.
 *
 * The key stays per quote on purpose. A quote carries no buyer identity: its
 * product, amount, currency and redirect URLs are the same for every customer
 * buying that course, so a cart-derived key would make the second buyer of a
 * course replay the first buyer's PayPal order and hand them its approval link.
 * A duplicate order from a page reload is the lesser risk, and a reload that
 * keeps its quote is already replayed by `run`.
 */
export function checkoutAttemptKey(quoteId) {
    const id = String(quoteId || '').trim();
    if (!id) return null;
    return `acp_${crypto.createHash('sha256').update(`acp-order:${id}`).digest('hex').slice(0, 32)}`;
}

const PROBE_SUFFIX = '.acp_probe';

/**
 * Check that a store directory can actually hold an attempt: create the
 * directory, write a uniquely named probe file and remove it again.
 *
 * A configured directory is not necessarily a usable one — a read-only volume,
 * a full disk or a path that is a file all look configured until the first
 * claim fails, by which point a customer is mid-checkout. Probing lets the
 * config check and /health report the real state instead of trusting the
 * setting.
 */
export function probeCheckoutAttemptStore(directory) {
    const configured = typeof directory === 'string' ? directory.trim() : '';
    if (!configured) {
        return { configured: false, ok: false, code: null, error: null, directory: null };
    }
    const resolved = path.resolve(configured);
    const probe = path.join(resolved, `${PROBE_SUFFIX}${process.pid}_${crypto.randomBytes(6).toString('hex')}`);
    let failure = null;
    try {
        fsSync.mkdirSync(resolved, { recursive: true });
        // 'wx' fails instead of overwriting anything already at the probe path.
        fsSync.writeFileSync(probe, 'probe', { flag: 'wx' });
    } catch (error) {
        failure = error;
    }
    try {
        fsSync.unlinkSync(probe);
    } catch {
        // Nothing to remove when the write itself failed.
    }
    if (failure) {
        return {
            configured: true,
            ok: false,
            code: typeof failure.code === 'string' && failure.code ? failure.code : 'PROBE_FAILED',
            error: String(failure.message || failure),
            directory: resolved
        };
    }
    // Writability is all a probe can prove; sharing and restart survival are
    // decided by `classifyCheckoutAttemptStorage`.
    return { configured: true, ok: true, code: null, error: null, directory: resolved };
}

// Linux `statfs` type values (f_type). A network filesystem is the only positive
// evidence of shared storage readable from the path itself.
const NETWORK_FILESYSTEM_TYPES = new Set([
    0x6969, // nfs
    0xff534d42, // cifs
    0xfe534d42, // smb2
    0x517b, // smb
    0x01021997 // 9p
]);
// Memory-backed filesystems cannot outlive a restart, let alone an instance.
const VOLATILE_FILESYSTEM_TYPES = new Set([
    0x01021994, // tmpfs
    0x858458f6, // ramfs
    0x1373 // devtmpfs
]);
const FILESYSTEM_TYPE_NAMES = new Map([
    [0x6969, 'nfs'],
    [0xff534d42, 'cifs'],
    [0xfe534d42, 'smb2'],
    [0x517b, 'smb'],
    [0x01021997, '9p'],
    [0x01021994, 'tmpfs'],
    [0x858458f6, 'ramfs'],
    [0x1373, 'devtmpfs'],
    [0x794c7630, 'overlay'],
    [0xef53, 'ext4'],
    [0x58465342, 'xfs'],
    [0x9123683e, 'btrfs'],
    [0x2fc12fc1, 'zfs']
]);

const SERVERLESS_RUNTIMES = [
    ['VERCEL', 'vercel'],
    ['AWS_LAMBDA_FUNCTION_NAME', 'lambda'],
    ['NETLIFY', 'netlify']
];

function detectServerlessRuntime(env) {
    const has = name => Boolean(String(env?.[name] ?? '').trim());
    for (const [name, runtime] of SERVERLESS_RUNTIMES) {
        if (has(name)) return runtime;
    }
    if (String(env?.AWS_EXECUTION_ENV ?? '').startsWith('AWS_Lambda')) return 'lambda';
    return null;
}

/**
 * Decide whether a store directory can actually be shared, so a deployment
 * cannot report `durable: true` while every instance keeps its own copy.
 *
 * The path is only ever *proved* shared (a network mount) or *proved* not shared
 * (a serverless runtime, which mounts no shared filesystem, or a memory-backed
 * filesystem that cannot survive a restart). Anything else is reported as
 * `unknown` rather than guessed either way, because a plain local volume on a
 * single long-lived host still survives restarts.
 */
export function classifyCheckoutAttemptStorage({ directory, env = process.env, filesystemType = null } = {}) {
    const configured = typeof directory === 'string' ? directory.trim() : '';
    if (!configured) {
        return { configured: false, storage: null, filesystem: null, volatile: false, runtime: null };
    }
    const knownType = Number.isFinite(filesystemType);
    const filesystem = !knownType
        ? null
        : FILESYSTEM_TYPE_NAMES.get(filesystemType) ?? `0x${filesystemType.toString(16)}`;
    const runtime = detectServerlessRuntime(env);
    const shared = knownType && NETWORK_FILESYSTEM_TYPES.has(filesystemType);
    const volatile = knownType && VOLATILE_FILESYSTEM_TYPES.has(filesystemType);
    return {
        configured: true,
        storage: shared ? 'shared' : (runtime || volatile ? 'instance_local' : 'unknown'),
        filesystem,
        volatile,
        runtime
    };
}

export function assessCheckoutAttemptStoreStorage(directory, env = process.env) {
    const configured = typeof directory === 'string' ? directory.trim() : '';
    let filesystemType = null;
    if (configured) {
        try {
            const stats = typeof fsSync.statfsSync === 'function'
                ? fsSync.statfsSync(path.resolve(configured))
                : null;
            if (stats && Number.isFinite(stats.type)) filesystemType = stats.type;
        } catch {
            // A missing directory or a platform without statfs is reported by
            // the writability probe; storage stays unknown here.
        }
    }
    return classifyCheckoutAttemptStorage({ directory: configured, env, filesystemType });
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
    return Math.max(nowMs + 60_000, Number.isFinite(quoteDeadline) ? quoteDeadline : nowMs + ttlMs);
}

/**
 * Facts from the signed price quote, stored with the attempt so a capture can
 * still be compared with what the buyer was quoted after the quote token is
 * gone. Anything malformed is dropped rather than stored as a half fact.
 */
function normalizeQuoteFacts(quote) {
    if (!quote || typeof quote !== 'object') return null;
    const amount = Number(quote.amount_cents);
    const currency = String(quote.currency || '').trim().toUpperCase();
    const version = quote.catalog_version === undefined || quote.catalog_version === null
        ? ''
        : String(quote.catalog_version);
    const digest = quote.catalog_digest === undefined || quote.catalog_digest === null
        ? ''
        : String(quote.catalog_digest);
    if (!Number.isInteger(amount) || amount <= 0) return null;
    if (!/^[A-Z]{3}$/.test(currency)) return null;
    if (!version || !digest) return null;
    return { amount_cents: amount, currency, catalog_version: version, catalog_digest: digest };
}

function createMemoryRegistry({ ttlMs, now }) {
    const attempts = new Map();

    function prune() {
        const current = now();
        for (const [key, record] of attempts) {
            if (record.expiresAt <= current) attempts.delete(key);
        }
    }

    async function run(quoteId, create, { expiresAt = null, quote = null } = {}) {
        const key = checkoutAttemptKey(quoteId);
        if (!key) throw new Error('Checkout attempt requires a quote id');
        prune();

        const existing = attempts.get(key);
        if (existing) {
            const order = existing.order ?? await existing.promise;
            return { key, order, replayed: true };
        }

        const deadline = attemptDeadline(now(), ttlMs, expiresAt);
        const record = { expiresAt: deadline, order: null, promise: null, quote: normalizeQuoteFacts(quote) };

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

    /** Read-only lookup used by post-capture reconciliation. */
    async function lookup(quoteId) {
        const key = checkoutAttemptKey(quoteId);
        if (!key) return null;
        prune();
        const record = attempts.get(key);
        if (!record || !record.order) return null;
        return { quote_id: String(quoteId), key, order: record.order, quote: record.quote ?? null };
    }

    return {
        durable: false,
        // Stored records do not exist without a directory, and nothing here is
        // signed, so the reported state matches the durable registry's shape.
        signed: false,
        run,
        lookup,
        clear: () => attempts.clear(),
        size: () => attempts.size
    };
}

/**
 * Records live in a directory that may be shared, so whoever can write there
 * could swap an order id and have a replay hand a customer an order that is not
 * theirs. Every record therefore carries an HMAC over its own fields, keyed by a
 * secret that never touches the store. A record whose signature does not verify
 * is treated as absent: a fresh order is created instead of trusting it.
 */
function signingKeyFor(secret) {
    // Derived, so the attempt store never uses the quote secret directly.
    return crypto.createHmac('sha256', secret).update('acp-attempt-record:v1').digest();
}

/** Stable across key order, so a record signs and verifies to the same bytes. */
function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        const fields = Object.keys(value).sort()
            .map(field => `${JSON.stringify(field)}:${stableStringify(value[field])}`);
        return `{${fields.join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}

function signedPayload(record) {
    return {
        v: record.v,
        quote_id: record.quote_id,
        key: record.key,
        order: record.order,
        quote: record.quote ?? null,
        created_at: record.created_at,
        expires_at: record.expires_at
    };
}

/**
 * Records written before quote facts were signed carry no `quote` field. Their
 * signature covers this older payload, so verifying it keeps an in-flight
 * checkout replayable across the deploy that started signing quote facts.
 *
 * The field list is frozen on purpose: adding a field here would change the
 * bytes those records were signed over and break them.
 */
function legacySignedPayload(record) {
    return {
        v: record.v,
        quote_id: record.quote_id,
        key: record.key,
        order: record.order,
        created_at: record.created_at,
        expires_at: record.expires_at
    };
}

function signPayload(payload, signingKey) {
    return crypto.createHmac('sha256', signingKey)
        .update(stableStringify(payload))
        .digest('hex');
}

function signRecord(record, signingKey) {
    return signPayload(signedPayload(record), signingKey);
}

function signatureVerifies(record, signingKey) {
    const provided = String(record?.sig ?? '');
    if (!/^[a-f0-9]{64}$/.test(provided)) return false;
    const actual = Buffer.from(provided, 'hex');
    if (crypto.timingSafeEqual(actual, Buffer.from(signRecord(record, signingKey), 'hex'))) return true;
    if (record.quote !== undefined) return false;
    return crypto.timingSafeEqual(actual, Buffer.from(signPayload(legacySignedPayload(record), signingKey), 'hex'));
}

function createDurableRegistry({ directory, ttlMs, now, claimTimeoutMs, claimStaleMs, pollIntervalMs, signingSecret }) {
    const dir = path.resolve(directory);
    const inflight = new Map();
    const signingKey = signingSecret ? signingKeyFor(signingSecret) : null;

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
        // An unsigned record is rejected too once a key is configured: the field
        // is not optional, so stripping it is not a way to skip the check.
        // An unverifiable or absent record looks the same to the caller, and both
        // reasons are reported honestly by the capture reconciliation.
        if (signingKey && !signatureVerifies(record, signingKey)) return null;
        const expiresAt = Number(record.expires_at);
        if (Number.isFinite(expiresAt) && expiresAt <= now()) {
            await fs.unlink(recordFile(key)).catch(() => {});
            return null;
        }
        return record;
    }

    async function writeRecord(key, quoteId, order, expiresAt, quote = null) {
        await fs.mkdir(dir, { recursive: true });
        const record = {
            v: RECORD_VERSION,
            quote_id: String(quoteId),
            key,
            order,
            quote: normalizeQuoteFacts(quote),
            created_at: new Date(now()).toISOString(),
            expires_at: attemptDeadline(now(), ttlMs, expiresAt)
        };
        if (signingKey) record.sig = signRecord(record, signingKey);
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

    async function run(quoteId, create, { expiresAt = null, quote = null } = {}) {
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
            await writeRecord(key, quoteId, order, expiresAt, quote);
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

    /**
     * Remove artifacts a crashed creator left behind: expired order records,
     * abandoned claims and truncated temp files. A record without a usable
     * expiry cannot be replayed by `readRecord`, so it is treated like a temp
     * file and removed once it is older than the ttl. Only files older than the
     * stale window go, so a live writer in another instance is never touched.
     * Runs once when the registry is created; safe to call again.
     */
    async function sweep() {
        let names;
        try {
            names = await fs.readdir(dir);
        } catch (error) {
            if (error?.code === 'ENOENT') return { removed: 0 };
            throw error;
        }
        const current = now();
        let removed = 0;
        for (const name of names) {
            const target = path.join(dir, name);
            try {
                if (name.endsWith(RECORD_SUFFIX)) {
                    let expiresAt = NaN;
                    try {
                        expiresAt = Number(JSON.parse(await fs.readFile(target, 'utf8'))?.expires_at);
                    } catch {
                        // Truncated or unreadable: judged by age instead.
                    }
                    const expired = Number.isFinite(expiresAt)
                        ? expiresAt <= current
                        : current - (await fs.stat(target)).mtimeMs > ttlMs;
                    if (expired) {
                        await fs.unlink(target);
                        removed += 1;
                    }
                } else if (name.endsWith(CLAIM_SUFFIX) || name.endsWith('.tmp')) {
                    const stats = await fs.stat(target);
                    if (current - stats.mtimeMs > claimStaleMs) {
                        await fs.unlink(target);
                        removed += 1;
                    }
                }
            } catch {
                // Another instance may have removed it first, or it vanished.
            }
        }
        return { removed };
    }

    /**
     * Read-only lookup for post-capture reconciliation. Unlike `run` it never
     * creates, claims or rewrites anything, and it returns null when the record
     * is missing, expired or does not verify.
     */
    async function lookup(quoteId) {
        const key = checkoutAttemptKey(quoteId);
        if (!key) return null;
        const record = await readRecord(key);
        if (!record) return null;
        return {
            quote_id: record.quote_id ?? String(quoteId),
            key: record.key ?? key,
            order: record.order,
            quote: normalizeQuoteFacts(record.quote)
        };
    }

    return {
        durable: true,
        signed: Boolean(signingKey),
        run,
        lookup,
        sweep,
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
    signingSecret = null,
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
    if (!storeDirectory) return createMemoryRegistry(base);
    // Only persisted records need signing; in-memory attempts never reach a
    // store another writer could tamper with.
    const secret = typeof signingSecret === 'string' ? signingSecret.trim() : '';
    return createDurableRegistry({ ...base, directory: storeDirectory, signingSecret: secret || null });
}
