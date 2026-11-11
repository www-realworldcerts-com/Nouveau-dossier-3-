import fs from 'node:fs';
import path from 'node:path';

/**
 * Egress connectivity watchdog for the swarm loop.
 *
 * The daemon and revenue runner both instantiate `new NetworkGuard({ intervalMs })`
 * and `await guard.start()`. This module was missing from the tree, so every
 * process that imported the runner died at module resolution before it could
 * tick. It is a reachability monitor, not a firewall: it answers "can this host
 * still reach the payment and identity endpoints?" and records transitions.
 */

const DEFAULT_TIMEOUT_MS = 8000;

export function defaultEndpoints(env = process.env) {
    const configured = String(env.NETWORK_GUARD_ENDPOINTS || '').trim();
    if (configured) {
        return configured
            .split(',')
            .map(url => url.trim())
            .filter(Boolean)
            .map(url => ({ name: new URL(url).hostname, url }));
    }
    return [
        { name: 'paypal', url: `${env.PAYPAL_API_BASE_URL || 'https://api-m.paypal.com'}/` },
        { name: 'egress', url: 'https://api.ipify.org?format=json' }
    ];
}

async function probe(endpoint, { fetchImpl, timeoutMs }) {
    const startedAt = Date.now();
    try {
        const response = await fetchImpl(endpoint.url, {
            method: 'GET',
            redirect: 'manual',
            signal: AbortSignal.timeout(timeoutMs)
        });
        // Any HTTP response proves egress works; 401/404 are still reachable.
        return {
            name: endpoint.name,
            url: endpoint.url,
            ok: true,
            status: response.status,
            latency_ms: Date.now() - startedAt
        };
    } catch (error) {
        return {
            name: endpoint.name,
            url: endpoint.url,
            ok: false,
            status: 0,
            latency_ms: Date.now() - startedAt,
            error: error?.name === 'TimeoutError' ? 'timeout' : error?.message || String(error)
        };
    }
}

export class NetworkGuard {
    constructor({
        intervalMs = 30000,
        endpoints = null,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        fetchImpl = globalThis.fetch,
        onAlert = null,
        logPath = null
    } = {}) {
        this.intervalMs = Math.max(5000, Number(intervalMs) || 30000);
        this.endpoints = endpoints || defaultEndpoints();
        this.timeoutMs = timeoutMs;
        this.fetchImpl = fetchImpl;
        this.onAlert = onAlert;
        this.logPath = logPath;
        this.timer = null;
        this.running = false;
        this.last = null;
        this.transitions = [];
    }

    async check() {
        const results = await Promise.all(
            this.endpoints.map(endpoint => probe(endpoint, { fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs }))
        );
        const ok = results.every(result => result.ok);
        const previous = this.last;
        const checkedAt = new Date().toISOString();
        this.last = { ok, checked_at: checkedAt, results };

        if (previous && previous.ok !== ok) {
            const failures = results.filter(result => !result.ok).map(result => `${result.name}:${result.error || result.status}`);
            this.transitions.push({ at: checkedAt, from: previous.ok, to: ok, failures });
            try {
                this.onAlert?.(
                    ok ? 'NetworkGuard: egress restored' : 'NetworkGuard: egress degraded',
                    ok ? `All ${results.length} endpoints reachable.` : `Unreachable: ${failures.join(', ')}`
                );
            } catch { /* alerts must never break the guard */ }
        }

        if (this.logPath) {
            try {
                fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
                fs.appendFileSync(this.logPath, JSON.stringify(this.last) + '\n');
            } catch { /* logging is best-effort */ }
        }
        return this.last;
    }

    /** Never throws: the daemon starts this during boot and must not fail on a probe. */
    async start() {
        if (this.running) return this;
        this.running = true;
        this.startedAt = new Date().toISOString();
        this.check().catch(() => {});
        this.timer = setInterval(() => {
            this.check().catch(() => {});
        }, this.intervalMs);
        this.timer.unref?.();
        return this;
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.running = false;
    }

    status() {
        return {
            running: this.running,
            started_at: this.startedAt || null,
            interval_ms: this.intervalMs,
            endpoints: this.endpoints.map(endpoint => endpoint.name),
            last: this.last,
            transitions: this.transitions.slice(-10)
        };
    }
}

export default NetworkGuard;
