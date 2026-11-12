import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_STOREFRONT_URL, probeStorefront, resolveStorefrontUrl } from '../src/resilience/storefront-probe.mjs';
import { detectSilentFailures } from '../src/resilience/silent-failure.mjs';
import { buildTickAuditArgs } from '../src/swarm/tick-audit.mjs';

function fakeFetch({ html = '', health = 404 } = {}) {
    return async url => ({
        status: String(url).endsWith('/api/healthz') ? health : 200,
        text: async () => html
    });
}

test('a static HTML build without an application runtime is static_only', async () => {
    const probe = await probeStorefront('https://shop.example/', {
        fetchImpl: fakeFetch({ html: '<html><a href="/checkout/paypal">Pay</a></html>', health: 404 })
    });
    assert.equal(probe.verdict, 'static_only');
    assert.equal(probe.ok, false);
    assert.equal(probe.checkout_link, true);
    assert.equal(probe.app_runtime, false);
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

test('a network failure is unreachable, not static_only', async () => {
    const probe = await probeStorefront('https://shop.example/', {
        fetchImpl: async () => { throw new Error('ECONNREFUSED'); }
    });
    assert.equal(probe.verdict, 'unreachable');
    assert.match(probe.error, /ECONNREFUSED/);
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

test('probeStorefront rejects a non-http URL', async () => {
    await assert.rejects(() => probeStorefront('file:///etc/passwd'), /invalid storefront URL/);
});

test('a non-transactional storefront is a critical finding', () => {
    const storefrontProbe = {
        url: 'https://shop.example/',
        status: 200,
        health_status: 404,
        verdict: 'static_only',
        ok: false,
        app_runtime: false,
        api_alive: false,
        checkout_link: true
    };
    const { findings } = detectSilentFailures({ now: new Date(), storefrontProbe });
    const finding = findings.find(item => item.code === 'STOREFRONT_NOT_TRANSACTIONAL');
    assert.ok(finding);
    assert.equal(finding.severity, 'critical');
    assert.equal(finding.evidence.verdict, 'static_only');
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
    assert.ok(!findings.some(item => item.code === 'STOREFRONT_NOT_TRANSACTIONAL'));
});

test('the tick audit forwards the storefront URL when configured', () => {
    const args = buildTickAuditArgs({ storefrontUrl: 'https://www.realworldcerts.com' });
    const index = args.indexOf('--storefront-url');
    assert.notEqual(index, -1);
    assert.equal(args[index + 1], 'https://www.realworldcerts.com');
    assert.ok(args.includes('--reconcile-paypal'));
});
