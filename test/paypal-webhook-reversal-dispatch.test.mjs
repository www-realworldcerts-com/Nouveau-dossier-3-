import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { dispatchVerifiedPayPalReversal } from '../src/real/ledger/reversal-dispatch.mjs';
import { REVENUE_REVERSAL_WITHOUT_CAPTURE } from '../src/real/ledger/reversals.mjs';

const CAPTURE_ID = '3C679366HH908993F';
const MISSING_CAPTURE_ID = '2GG279541U471931P';
const REFUND_ID = '8AB12345CD678901E';

function tempLedger({ capture = true } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reversal-dispatch-'));
    if (capture) {
        fs.writeFileSync(
            path.join(dir, 'revenue_capture.json'),
            JSON.stringify({
                event_id: 'capture-event-1',
                amount: 30,
                currency: 'USD',
                occurred_at: '2026-02-01T10:00:00.000Z',
                status: 'verified',
                verification_proof: {
                    type: 'psp_transaction_id',
                    psp_id: CAPTURE_ID,
                    amount: 30,
                    currency: 'USD'
                }
            }, null, 2)
        );
    }
    return dir;
}

function reversalFiles(dir) {
    return fs.readdirSync(dir).filter((name) => name.startsWith('reversal_'));
}

function readReversals(dir) {
    return reversalFiles(dir).map((name) =>
        JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
    );
}

function refundEvent({ captureId = CAPTURE_ID, eventId = 'WH-REFUND-1' } = {}) {
    return {
        id: eventId,
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        create_time: '2026-02-10T09:00:00.000Z',
        resource: {
            id: REFUND_ID,
            status: 'COMPLETED',
            amount: { value: '30.00', currency_code: 'USD' },
            links: [
                { rel: 'self', href: `https://api.paypal.com/v2/payments/refunds/${REFUND_ID}` },
                { rel: 'up', href: `https://api.paypal.com/v2/payments/captures/${captureId}` }
            ]
        }
    };
}

test('a verified refund writes a negative event keyed to the original capture', () => {
    const dir = tempLedger();
    const result = dispatchVerifiedPayPalReversal(refundEvent(), { dir });

    assert.equal(result.dispatched, true);
    assert.equal(result.applied, true);
    assert.equal(result.reason, 'reversed');
    assert.equal(result.capture_event_id, 'capture-event-1');

    const [written] = readReversals(dir);
    assert.equal(written.amount, -30);
    assert.equal(written.currency, 'USD');
    assert.equal(written.reversal_of, CAPTURE_ID);
    assert.equal(written.status, 'refunded');
    assert.equal(written.verification_proof.psp_id, CAPTURE_ID);

    // The capture itself is untouched, so the two rows net to zero.
    const capture = JSON.parse(fs.readFileSync(path.join(dir, 'revenue_capture.json'), 'utf8'));
    assert.equal(capture.amount, 30);
    assert.equal(capture.status, 'verified');
});

test('a replayed notification does not reverse the same capture twice', () => {
    const dir = tempLedger();
    const first = dispatchVerifiedPayPalReversal(refundEvent(), { dir });
    const replay = dispatchVerifiedPayPalReversal(refundEvent({ eventId: 'WH-REFUND-1-replay' }), { dir });

    assert.equal(first.applied, true);
    assert.equal(replay.applied, false);
    assert.equal(replay.reason, 'already_reversed');
    assert.equal(reversalFiles(dir).length, 1);
});

test('a reversal with no matching capture reports a critical finding and writes nothing', () => {
    const dir = tempLedger();
    const result = dispatchVerifiedPayPalReversal(refundEvent({ captureId: MISSING_CAPTURE_ID }), { dir });

    assert.equal(result.applied, false);
    assert.equal(result.reason, 'capture_not_found');
    assert.equal(result.finding.code, REVENUE_REVERSAL_WITHOUT_CAPTURE);
    assert.equal(result.finding.severity, 'critical');
    assert.equal(result.finding.evidence.capture_id, MISSING_CAPTURE_ID);
    assert.equal(result.finding.evidence.amount, 30);
    assert.deepEqual(reversalFiles(dir), []);
});

test('an ordinary capture completion is not dispatched as a reversal', () => {
    const dir = tempLedger();
    const result = dispatchVerifiedPayPalReversal({
        id: 'WH-CAPTURE-1',
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: { id: CAPTURE_ID, amount: { value: '30.00', currency_code: 'USD' } }
    }, { dir });

    assert.equal(result.dispatched, false);
    assert.equal(result.reason, 'not_a_reversal');
    assert.deepEqual(reversalFiles(dir), []);
});

// The live path: the Vercel handler verifies with PayPal, then must reverse
// without an operator running the CLI.

const handlerLedger = tempLedger();
process.env.PAYPAL_WEBHOOK_ID = 'WH-TEST-123';
process.env.PAYPAL_CLIENT_ID = 'test-client';
process.env.PAYPAL_CLIENT_SECRET = 'test-secret';
process.env.SWARM_LIVE = 'false';
process.env.REVENUE_LEDGER_DIR = handlerLedger;
process.env.PSP_WEBHOOK_REGISTRY_FILE = path.join(handlerLedger, 'verified-webhooks.ndjson');

function jsonResponse(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify(body),
        json: async () => body
    };
}

test('the PayPal webhook dispatches a verified refund to the ledger reversal', async () => {
    const { default: handler } = await import('../api/index.mjs');
    const event = refundEvent({ eventId: 'WH-REFUND-LIVE-1' });
    const bodies = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url, init) => {
        if (String(url).includes('/v1/oauth2/token')) {
            return jsonResponse({ access_token: 'token', expires_in: 3600 });
        }
        if (String(url).includes('/verify-webhook-signature')) {
            bodies.push(JSON.parse(init.body).webhook_event);
            return jsonResponse({ verification_status: 'SUCCESS' });
        }
        throw new Error(`unexpected fetch: ${url}`);
    };

    try {
        const raw = JSON.stringify(event);
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
        const res = {
            statusCode: 200,
            headers: {},
            body: null,
            setHeader(key, value) { this.headers[key] = value; },
            getHeader(key) { return this.headers[key]; },
            writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers || {}); return this; },
            end(body) { this.body = String(body ?? ''); }
        };

        await handler(req, res);

        assert.equal(res.statusCode, 200, res.body);
        assert.equal(bodies[0].event_type, 'PAYMENT.CAPTURE.REFUNDED');
        const payload = JSON.parse(res.body);
        assert.equal(payload.reversal.dispatched, true);
        assert.equal(payload.reversal.applied, true);
        assert.equal(payload.reversal.reason, 'reversed');
        assert.equal(payload.reversal.finding, null);

        const [written] = readReversals(handlerLedger);
        assert.equal(written.amount, -30);
        assert.equal(written.reversal_of, CAPTURE_ID);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
