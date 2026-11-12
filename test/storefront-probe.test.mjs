import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DEFAULT_STOREFRONT_URL,
    fetchWithRetry,
    isTransientNetworkError,
    probeStorefront,
    resolveStorefrontUrl
} from '../src/resilience/storefront-probe.mjs';
import { detectSilentFailures } from '../src/resilience/silent-failure.mjs';
import { buildTickAuditArgs } from '../src/swarm/tick-audit.mjs';

const sleepNone = async () => {};
const retryOptions = { retryDelayMs: 1, sleepImpl: sleepNone };

function fakeFetch({ html = '', health = 404 } = {}) {
    return async url => ({
        status: String(url).endsWith('/api/healthz') ? health : 200,
        text: async () => html
    });
}

function networkError(code) {
    return Object.assign(new Error(`connect ${code}`), { cause: { code } });
}

test('a static HTML build without an application runtime is static_only', async () => {
    const probe = await probeStorefront('https://shop.example/', {
        fetchImpl: fakeFetch({ html: '<html><a href="/checkout/paypal">Pay</a></html>', health: 404 })
    });
    assert.equal(probe.verdict, 'static_only');
    assert.equal(probe.ok, false);
    assert.equal(probe.checkout_link, true);
    assert.equal(probe.app_runtime, false);
    assert.equal(probe.attempts, 1);
});

test('a Next application with a live API is application', async () => {
    const probe = await probeStorefront('https://shop.example/', {
        fetchImpl: fakeFetch({ html: '<script src="/_next/static/chunk.js"></script>', health: 200 })
    });
    assert.equal(probe.verdict, 'application');
    assert.equal(probe.ok, true);
});

test('an application build with a missing API is application_without_api', async () => {
    const probe = await probeStorefront('https://shop.example/', {
        fetchImpl: fakeFetch({ html: '<script id="__NEXT_DATA__"></script>', health: 404 })
    });
    assert.equal(probe.verdict, 'application_without_api');
    assert.equal(probe.ok, false);
});

test('the storefront defaults to the production domain without configuration', () => {
    assert.equal(resolveStorefrontUrl({ env: {} }), DEFAULT_STOREFRONT_URL);
    assert.equal(DEFAULT_STOREFRONT_URL, 'https://www.realworldcerts.com');
});

test('STOREFRONT_URL overrides the default and the flag overrides the env', () => {
    assert.equal(
        resolveStorefrontUrl({ env: { STOREFRONT_URL: 'https://staging.example' } }),
        'https://staging.example'
    );
    assert.equal(
        resolveStorefrontUrl({ flag: 'https://flag.example', env: { STOREFRONT_URL: 'https://staging.example' } }),
        'https://flag.example'
    );
});

test('an empty flag or env value still falls back to production', () => {
    assert.equal(resolveStorefrontUrl({ flag: '', env: { STOREFRONT_URL: '  ' } }), DEFAULT_STOREFRONT_URL);
});

test('a transient blip recovers on retry and produces no finding', async () => {
    let homeCalls = 0;
    const fetchImpl = async url => {
        if (String(url).endsWith('/api/healthz')) return { status: 200, text: async () => '' };
        homeCalls += 1;
        if (homeCalls === 1) throw networkError('ECONNRESET');
        return { status: 200, text: async () => '<script src="/_next/static/app.js"></script>' };
    };
    const probe = await probeStorefront('https://shop.example/', { fetchImpl, ...retryOptions });
    assert.equal(probe.verdict, 'application');
    assert.equal(homeCalls, 2);
    const { findings } = detectSilentFailures({ now: new Date(), storefrontProbe: probe });
    assert.deepEqual(findings.filter(item => item.code.startsWith('STOREFRONT_')), []);
});

test('a 503 edge error recovers on retry without a finding', async () => {
    let homeCalls = 0;
    const fetchImpl = async url => {
        if (String(url).endsWith('/api/healthz')) return { status: 200, text: async () => '' };
        homeCalls += 1;
        return { status: homeCalls === 1 ? 503 : 200, text: async () => '<script src="/_next/static/app.js"></script>' };
    };
    const probe = await probeStorefront('https://shop.example/', { fetchImpl, ...retryOptions });
    assert.equal(probe.verdict, 'application');
    assert.equal(homeCalls, 2);
});

test('persistent network failures are WARN-unreachable, never critical', async () => {
    let calls = 0;
    const probe = await probeStorefront('https://shop.example/', {
        fetchImpl: async () => { calls += 1; throw networkError('ETIMEDOUT'); },
        ...retryOptions
    });
    assert.equal(calls, 3, 'three total attempts');
    assert.equal(probe.verdict, 'unreachable');
    assert.equal(probe.attempts, 3);
    assert.match(probe.error, /ETIMEDOUT/);

    const { findings } = detectSilentFailures({ now: new Date(), storefrontProbe: probe });
    const finding = findings.find(item => item.code === 'STOREFRONT_UNREACHABLE');
    assert.ok(finding);
    assert.equal(finding.severity, 'warning');
    assert.ok(!findings.some(item => item.code === 'STOREFRONT_NOT_TRANSACTIONAL'));
});

test('a persistent 503 is WARN-unreachable and retried', async () => {
    let calls = 0;
    const probe = await probeStorefront('https://shop.example/', {
        fetchImpl: async () => { calls += 1; return { status: 503, text: async () => '' }; },
        ...retryOptions
    });
    assert.equal(calls, 3);
    assert.equal(probe.verdict, 'unreachable');
    const { findings } = detectSilentFailures({ now: new Date(), storefrontProbe: probe });
    assert.equal(findings.find(item => item.code === 'STOREFRONT_UNREACHABLE').severity, 'warning');
});

test('an unexpected homepage 404 is WARN-http_error, not a static build', async () => {
    const probe = await probeStorefront('https://shop.example/', {
        fetchImpl: async () => ({ status: 404, text: async () => 'not found' }),
        ...retryOptions
    });
    assert.equal(probe.verdict, 'http_error');
    const { findings } = detectSilentFailures({ now: new Date(), storefrontProbe: probe });
    assert.equal(findings.find(item => item.code === 'STOREFRONT_HTTP_ERROR').severity, 'warning');
});

test('a static 200 on the first try is immediately critical with no retry', async () => {
    let calls = 0;
    const probe = await probeStorefront('https://shop.example/', {
        fetchImpl: async url => {
            if (String(url).endsWith('/api/healthz')) return { status: 404, text: async () => '' };
            calls += 1;
            return { status: 200, text: async () => '<html><a href="/checkout/paypal">Pay</a></html>' };
        },
        ...retryOptions
    });
    assert.equal(calls, 1);
    assert.equal(probe.verdict, 'static_only');
    const { findings } = detectSilentFailures({ now: new Date(), storefrontProbe: probe });
    const finding = findings.find(item => item.code === 'STOREFRONT_NOT_TRANSACTIONAL');
    assert.ok(finding);
    assert.equal(finding.severity, 'critical');
});

test('fetchWithRetry does not retry a deterministic 404', async () => {
    let calls = 0;
    const result = await fetchWithRetry('https://shop.example/', {
        fetchImpl: async () => { calls += 1; return { status: 404 }; },
        ...retryOptions
    });
    assert.equal(calls, 1);
    assert.equal(result.ok, true);
    assert.equal(result.response.status, 404);
});

test('isTransientNetworkError recognises timeouts and socket codes', () => {
    assert.equal(isTransientNetworkError(Object.assign(new Error('aborted'), { name: 'TimeoutError' })), true);
    assert.equal(isTransientNetworkError(networkError('ENOTFOUND')), true);
    assert.equal(isTransientNetworkError(new Error('fetch failed')), true);
    assert.equal(isTransientNetworkError(new Error('invalid json')), false);
});

test('a transactional storefront adds no finding', () => {
    const storefrontProbe = {
        url: 'https://shop.example/',
        status: 200,
        health_status: 200,
        verdict: 'application',
        ok: true,
        app_runtime: true,
        api_alive: true
    };
    const { findings } = detectSilentFailures({ now: new Date(), storefrontProbe });
    assert.ok(!findings.some(item => item.code.startsWith('STOREFRONT_')));
});

test('the tick audit forwards the storefront URL when configured', () => {
    const args = buildTickAuditArgs({ storefrontUrl: 'https://www.realworldcerts.com' });
    const index = args.indexOf('--storefront-url');
    assert.notEqual(index, -1);
    assert.equal(args[index + 1], 'https://www.realworldcerts.com');
    assert.ok(args.includes('--reconcile-paypal'));
});

test('probeStorefront rejects a non-http URL', async () => {
    await assert.rejects(() => probeStorefront('file:///etc/passwd'), /invalid storefront URL/);
});
