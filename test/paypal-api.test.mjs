import assert from 'node:assert/strict';
import test from 'node:test';

process.env.PAYPAL_CLIENT_ID = 'test-client';
process.env.PAYPAL_CLIENT_SECRET = 'test-secret';
process.env.SWARM_LIVE = 'false';
delete process.env.PAYPAL_MODE;

const {
    getPayPalAccessToken,
    paypalRequest,
    clearPayPalTokenCache
} = await import('../src/paypal-api.mjs');

function response({ ok, status, body, headers = {} }) {
    return {
        ok,
        status,
        headers: { get: name => headers[String(name).toLowerCase()] ?? null },
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
        json: async () => (typeof body === 'string' ? JSON.parse(body) : body)
    };
}

function installFetch(handler) {
    const original = globalThis.fetch;
    globalThis.fetch = handler;
    return () => { globalThis.fetch = original; };
}

test('access tokens are cached until shortly before expiry', async () => {
    clearPayPalTokenCache();
    let tokenCalls = 0;
    const restore = installFetch(async () => {
        tokenCalls += 1;
        return response({ ok: true, status: 200, body: { access_token: 'token-1', expires_in: 3600 } });
    });
    try {
        assert.equal(await getPayPalAccessToken(), 'token-1');
        assert.equal(await getPayPalAccessToken(), 'token-1');
        assert.equal(tokenCalls, 1);
    } finally {
        restore();
    }
});

test('a 401 forces one token refresh and repeats the request', async () => {
    clearPayPalTokenCache();
    let tokenCalls = 0;
    let apiCalls = 0;
    const restore = installFetch(async url => {
        if (String(url).includes('/v1/oauth2/token')) {
            tokenCalls += 1;
            return response({ ok: true, status: 200, body: { access_token: `token-${tokenCalls}`, expires_in: 3600 } });
        }
        apiCalls += 1;
        if (apiCalls === 1) return response({ ok: false, status: 401, body: { name: 'AUTHENTICATION_FAILURE' } });
        return response({ ok: true, status: 200, body: { ok: true }, headers: { 'content-type': 'application/json' } });
    });
    try {
        const token = await getPayPalAccessToken();
        const result = await paypalRequest('/v1/checkout/orders/ORDER-1', { token });
        assert.deepEqual(result, { ok: true });
        assert.equal(apiCalls, 2);
        assert.equal(tokenCalls, 2);
    } finally {
        restore();
    }
});

test('API errors expose the PayPal debug_id for support', async () => {
    clearPayPalTokenCache();
    const restore = installFetch(async url => {
        if (String(url).includes('/v1/oauth2/token')) {
            return response({ ok: true, status: 200, body: { access_token: 'token', expires_in: 3600 } });
        }
        return response({
            ok: false,
            status: 422,
            body: { name: 'UNPROCESSABLE_ENTITY', message: 'bad', debug_id: 'abc123def456' }
        });
    });
    try {
        const token = await getPayPalAccessToken();
        await assert.rejects(
            () => paypalRequest('/v1/checkout/orders', { method: 'POST', token, body: {} }),
            error => /debug_id=abc123def456/.test(error.message) && /UNPROCESSABLE_ENTITY/.test(error.message)
        );
    } finally {
        restore();
    }
});
