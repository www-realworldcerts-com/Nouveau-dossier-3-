import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import test from 'node:test';

process.env.PAYPAL_WEBHOOK_ID = 'WH-TEST-123';
process.env.PAYPAL_CLIENT_ID = 'test-client';
process.env.PAYPAL_CLIENT_SECRET = 'test-secret';
process.env.SWARM_LIVE = 'false';

const probe = String.raw`
import handler from './api/index.mjs';

function call(url, method) {
  return new Promise(resolve => {
    const req = {
      method,
      url,
      headers: { host: 'localhost', 'user-agent': 'test', accept: '*/*' },
      socket: { remoteAddress: '127.0.0.1' }
    };
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(key, value) { this.headers[key] = value; },
      getHeader(key) { return this.headers[key]; },
      writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers || {}); return this; },
      end(body) { resolve({ status: this.statusCode, body: String(body) }); }
    };
    handler(req, res).catch(error => resolve({ status: 0, error: error.message }));
  });
}

const health = await call('/health', 'GET');
const webhook = await call('/api/webhooks/paypal', 'GET');
process.stdout.write(JSON.stringify({ health, webhook }) + '\n');
`;

test('the Vercel wrapper serves /health and the webhook alias without binding a port', () => {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 30000,
        env: { ...process.env, VERCEL: '1' }
    });
    assert.equal(run.status, 0, run.stderr);
    const lastLine = run.stdout.trim().split('\n').at(-1);
    const result = JSON.parse(lastLine);
    assert.equal(result.health.status, 200);
    assert.equal(result.webhook.status, 405);
    assert.match(run.stdout, /"embedded":true/);
    assert.doesNotMatch(run.stdout, /"listening":true/);
});

function jsonResponse(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: name => (String(name).toLowerCase() === 'content-type' ? 'application/json' : null) },
        text: async () => JSON.stringify(body),
        json: async () => body
    };
}

function mockResponse() {
    return {
        statusCode: 200,
        headers: {},
        body: null,
        setHeader(key, value) { this.headers[key] = value; },
        getHeader(key) { return this.headers[key]; },
        writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers || {}); return this; },
        end(body) { this.body = String(body ?? ''); this.done = true; }
    };
}

test('the handler reads the exact raw bytes from a request stream', async () => {
    const { readRawBody } = await import('../src/paypal-webhook-server.mjs');
    const raw = '{\n  "id": "WH-EVT-1",   "nested": { "b": 2, "a": 1 }\n}';
    const req = Readable.from([Buffer.from(raw, 'utf8')]);
    assert.equal(await readRawBody(req, { limitBytes: 10000 }), raw);

    await assert.rejects(
        () => readRawBody({ readableEnded: true, body: { id: 'WH-EVT-1' } }, { limitBytes: 10000 }),
        /parsed before signature verification/
    );
    assert.equal(
        await readRawBody({ readableEnded: true, rawBody: Buffer.from(raw, 'utf8') }, { limitBytes: 10000 }),
        raw
    );
});

test('a streamed webhook body reaches signature verification intact', async () => {
    const { default: handler } = await import('../api/index.mjs');
    const raw = '{\n  "id": "WH-EVT-42",  "event_type": "PAYMENT.CAPTURE.COMPLETED",\n  "resource": { "id": "CAP-42" }\n}';
    let verifiedEvent = null;
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url, init) => {
        if (String(url).includes('/v1/oauth2/token')) {
            return jsonResponse({ access_token: 'token', expires_in: 3600 });
        }
        if (String(url).includes('/verify-webhook-signature')) {
            verifiedEvent = JSON.parse(init.body).webhook_event;
            return jsonResponse({ verification_status: 'FAILURE' });
        }
        throw new Error(`unexpected fetch: ${url}`);
    };

    try {
        const req = Readable.from([Buffer.from(raw, 'utf8')]);
        Object.assign(req, {
            method: 'POST',
            url: '/api/webhooks/paypal',
            headers: {
                host: 'localhost',
                'user-agent': 'test',
                accept: '*/*',
                'content-type': 'application/json'
            },
            socket: { remoteAddress: '127.0.0.1' }
        });
        const res = mockResponse();
        await handler(req, res);

        // A FAILURE (401) proves the body was read and verified; an empty or
        // unreadable body would have stopped earlier with a 400.
        assert.equal(res.statusCode, 401);
        assert.equal(verifiedEvent.id, 'WH-EVT-42');
        assert.equal(verifiedEvent.event_type, 'PAYMENT.CAPTURE.COMPLETED');
    } finally {
        globalThis.fetch = originalFetch;
    }
});
