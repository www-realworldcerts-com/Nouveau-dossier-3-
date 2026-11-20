import path from 'node:path';

import { appendNdjson, readNdjson } from '../../sales/catalog.mjs';

/**
 * Registry of webhooks we actually received and PayPal actually verified.
 *
 * `assertPSPWebhookExists()` used to accept any id longer than five characters,
 * so a proof that named a made-up capture id passed as "confirmed". This store
 * is the authority instead: only an id that appears in a webhook whose
 * signature PayPal returned SUCCESS for can confirm money.
 *
 * A file works on a host with a real disk. A serverless instance has no shared
 * filesystem, so `PSP_WEBHOOK_REGISTRY_URL` moves the registry to a durable
 * append-only endpoint; otherwise `registryStatus()` reports the store as not
 * durable and `/health` says so, rather than letting it look healthy while
 * every receipt dies with the instance.
 */

const SERVERLESS_ENV = ['VERCEL', 'AWS_LAMBDA_FUNCTION_NAME', 'NETLIFY'];

export function normalizeWebhookId(value) {
    return String(value ?? '').trim();
}

export function webhookRegistryFile(env = process.env) {
    const configured = normalizeWebhookId(env.PSP_WEBHOOK_REGISTRY_FILE);
    if (configured) return path.resolve(configured);
    return path.resolve('data/psp/verified-webhooks.ndjson');
}

export function isServerlessRuntime(env = process.env) {
    return SERVERLESS_ENV.some(name => Boolean(String(env?.[name] ?? '').trim()));
}

/** Which PayPal identifiers can name a received webhook. */
export function identifiersFromPayPalEvent(evt, transmissionId = '') {
    const resource = evt?.resource ?? {};
    return {
        provider: 'paypal',
        psp_id: normalizeWebhookId(resource?.id || resource?.transaction_id || resource?.capture_id),
        event_id: normalizeWebhookId(evt?.id),
        transmission_id: normalizeWebhookId(transmissionId)
    };
}

export function entryMatchesId(entry, id) {
    const target = normalizeWebhookId(id);
    if (!target) return false;
    return [entry?.psp_id, entry?.event_id, entry?.transmission_id]
        .some(value => normalizeWebhookId(value) === target);
}

/** Parse a remote registry answer: array, `{webhooks}`, `{data}` or ndjson. */
export function parseRegistryEntries(text, contentType = '') {
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
        if (Array.isArray(parsed?.webhooks)) return parsed.webhooks;
        if (Array.isArray(parsed?.data)) return parsed.data;
        if (parsed && typeof parsed === 'object') return [parsed];
    }
    return body.split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => JSON.parse(line));
}

function readEntries(file) {
    try {
        return readNdjson(file);
    } catch {
        // A corrupted registry must not read as a confirmation.
        return [];
    }
}

export function fileWebhookRegistry({ file = webhookRegistryFile(), env = process.env } = {}) {
    const serverless = isServerlessRuntime(env);
    return {
        kind: 'file',
        file,
        durable: !serverless,
        reason: serverless ? 'serverless_instance_has_no_shared_filesystem' : null,
        async record(entry) {
            const existing = readEntries(file);
            if (existing.some(row => entryMatchesId(row, entry.psp_id) && normalizeWebhookId(row.psp_id) === normalizeWebhookId(entry.psp_id))) {
                return { recorded: false, reason: 'already_recorded', entry };
            }
            appendNdjson(file, [entry]);
            return { recorded: true, entry };
        },
        async entries() {
            return readEntries(file);
        },
        async has(id) {
            return readEntries(file).some(row => entryMatchesId(row, id));
        }
    };
}

/**
 * An HTTP registry. `POST {webhooks:[entry]}` appends; `GET` returns the
 * registry as a JSON array, `{webhooks:[...]}` or ndjson. Optional bearer token.
 */
export function remoteWebhookRegistry({ url, token = '', fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
    if (!url) throw new Error('remoteWebhookRegistry requires a url');
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const signal = () => (typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined);
    return {
        kind: 'remote',
        url,
        durable: true,
        reason: null,
        async record(entry) {
            const response = await fetchImpl(url, {
                method: 'POST',
                headers,
                body: JSON.stringify({ webhooks: [entry] }),
                signal: signal()
            });
            if (!response?.ok) {
                throw new Error(`webhook registry rejected the receipt (HTTP ${response?.status ?? 'unknown'})`);
            }
            return { recorded: true, entry };
        },
        async entries() {
            const response = await fetchImpl(url, { headers, signal: signal() });
            if (!response?.ok) {
                throw new Error(`webhook registry read failed (HTTP ${response?.status ?? 'unknown'})`);
            }
            const text = typeof response.text === 'function' ? await response.text() : '';
            return parseRegistryEntries(text, response.headers?.get?.('content-type') || '');
        },
        async has(id) {
            const rows = await this.entries();
            return rows.some(row => entryMatchesId(row, id));
        }
    };
}

export function resolveWebhookRegistry({ env = process.env, fetchImpl } = {}) {
    const url = normalizeWebhookId(env.PSP_WEBHOOK_REGISTRY_URL);
    if (url) {
        return remoteWebhookRegistry({
            url,
            token: normalizeWebhookId(env.PSP_WEBHOOK_REGISTRY_TOKEN),
            fetchImpl
        });
    }
    return fileWebhookRegistry({ env });
}

export function registryStatus(store = resolveWebhookRegistry()) {
    return {
        kind: store?.kind ?? null,
        durable: store?.durable === true,
        target: store?.kind === 'remote' ? store.url : (store?.file ?? null),
        reason: store?.reason ?? null
    };
}

/**
 * Record one SUCCESS-verified webhook. A receipt without a provider
 * transaction id is refused: it could never confirm money.
 */
export async function recordVerifiedWebhook(record, { registry } = {}) {
    const pspId = normalizeWebhookId(record?.psp_id);
    if (!pspId) {
        return { recorded: false, reason: 'no_provider_transaction_id' };
    }
    const store = registry ?? resolveWebhookRegistry();
    return store.record({
        ...record,
        psp_id: pspId,
        provider: normalizeWebhookId(record?.provider) || 'paypal',
        verified_at: record?.verified_at ?? new Date().toISOString()
    });
}

export async function isRegisteredWebhookId(id, { registry } = {}) {
    const target = normalizeWebhookId(id);
    if (!target) return false;
    const store = registry ?? resolveWebhookRegistry();
    return store.has(target);
}
