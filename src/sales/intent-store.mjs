import path from 'node:path';

import { appendNdjson, readNdjson } from './catalog.mjs';

/**
 * Where checkout funnel events live.
 *
 * A file is fine on a host with a real disk, but a serverless instance mounts
 * no shared filesystem: each instance gets its own copy, so the funnel appears
 * to reset on every cold start. Setting `CHECKOUT_INTENTS_URL` moves the log to
 * a durable append-only endpoint instead, and every instance writes the one log.
 *
 * Either backend stores the intent tracker's event objects unchanged, so
 * `funnelSummaryFromEvents()` reads them without a second schema.
 */

const SERVERLESS_ENV = ['VERCEL', 'AWS_LAMBDA_FUNCTION_NAME', 'NETLIFY'];

export function intentsFile(env = process.env) {
    const configured = String(env.CHECKOUT_INTENTS_FILE || '').trim();
    if (configured) return path.resolve(configured);
    return path.join(path.resolve(env.SALES_DATA_DIR || 'data/sales'), 'course-intents.ndjson');
}

export function isServerlessRuntime(env = process.env) {
    return SERVERLESS_ENV.some(name => Boolean(String(env?.[name] ?? '').trim()));
}

/** Parse whatever an append-only endpoint answers: array, `{events}` or ndjson. */
export function parseIntentEvents(text, contentType = '') {
    const body = String(text ?? '').trim();
    if (!body) return [];
    if (contentType.includes('json') || body.startsWith('[') || body.startsWith('{')) {
        let parsed;
        try {
            parsed = JSON.parse(body);
        } catch {
            parsed = undefined; // ndjson that happens to start with a brace
        }
        if (Array.isArray(parsed)) return parsed;
        if (Array.isArray(parsed?.events)) return parsed.events;
        if (Array.isArray(parsed?.data)) return parsed.data;
        if (parsed && typeof parsed === 'object') return [parsed];
    }
    return body.split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => JSON.parse(line));
}

export function fileIntentStore({ file = intentsFile(), env = process.env } = {}) {
    const serverless = isServerlessRuntime(env);
    return {
        kind: 'file',
        file,
        durable: !serverless,
        reason: serverless ? 'serverless_instance_has_no_shared_filesystem' : null,
        async append(event) {
            appendNdjson(file, [event]);
        },
        async load() {
            return readNdjson(file);
        }
    };
}

/**
 * An HTTP append-only log. `POST {events:[event]}` appends; `GET` returns the
 * log as a JSON array, `{events:[...]}` or ndjson. A bearer token is sent when
 * configured, so the sink can be a private endpoint rather than a public form.
 */
export function remoteIntentStore({ url, token = '', fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
    if (!url) throw new Error('remoteIntentStore requires a url');
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const signal = () => (typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined);
    return {
        kind: 'remote',
        url,
        durable: true,
        reason: null,
        async append(event) {
            const response = await fetchImpl(url, {
                method: 'POST',
                headers,
                body: JSON.stringify({ events: [event] }),
                signal: signal()
            });
            if (!response?.ok) {
                throw new Error(`intent sink rejected the event (HTTP ${response?.status ?? 'unknown'})`);
            }
        },
        async load() {
            const response = await fetchImpl(url, { headers, signal: signal() });
            if (!response?.ok) {
                throw new Error(`intent sink read failed (HTTP ${response?.status ?? 'unknown'})`);
            }
            const text = typeof response.text === 'function' ? await response.text() : '';
            return parseIntentEvents(text, response.headers?.get?.('content-type') || '');
        }
    };
}

/** One configured store: the remote log when there is one, otherwise the file. */
export function resolveIntentStore({ env = process.env, fetchImpl } = {}) {
    const url = String(env.CHECKOUT_INTENTS_URL || '').trim();
    if (url) {
        return remoteIntentStore({
            url,
            token: String(env.CHECKOUT_INTENTS_TOKEN || '').trim(),
            fetchImpl
        });
    }
    return fileIntentStore({ env });
}

/** What `/health` reports about the funnel log, so a reset is never silent. */
export function intentStoreStatus(store = resolveIntentStore()) {
    return {
        kind: store?.kind ?? null,
        durable: store?.durable === true,
        target: store?.kind === 'remote' ? store.url : (store?.file ?? null),
        reason: store?.reason ?? null
    };
}
