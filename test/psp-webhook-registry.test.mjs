import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    entryMatchesId,
    fileWebhookRegistry,
    findVerifiedWebhook,
    identifiersFromPayPalEvent,
    isRegisteredWebhookId,
    parseRegistryEntries,
    recordVerifiedWebhook,
    registryStatus,
    remoteWebhookRegistry
} from '../src/real/psp/webhook-registry.mjs';
import { agreesWithVerifiedAmount, assertPSPWebhookExists } from '../src/real/psp/psp-webhooks.mjs';
import { ProofValidator } from '../src/real/proof-validator.mjs';

const CAPTURE_ID = '5O190127TN364715T';

function tempRegistryFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-registry-'));
    return path.join(dir, 'verified-webhooks.ndjson');
}

function captureEvent(evt = {}) {
    return {
        id: 'WH-EVENT-0001',
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: { id: CAPTURE_ID, status: 'COMPLETED', amount: { value: '42.00', currency_code: 'USD' } },
        ...evt
    };
}

test('a well-formed id that no webhook ever named is not a confirmation', async () => {
    const registry = fileWebhookRegistry({ file: tempRegistryFile(), env: {} });

    // The old check accepted this because it is longer than five characters.
    assert.equal(await assertPSPWebhookExists('84C' + 'Z'.repeat(20), { registry }), false);
    assert.equal(await assertPSPWebhookExists(CAPTURE_ID, { registry }), false);
});

test('a recorded webhook confirms its capture, event and transmission ids only', async () => {
    const registry = fileWebhookRegistry({ file: tempRegistryFile(), env: {} });
    const identifiers = identifiersFromPayPalEvent(captureEvent(), 'TRANSMISSION-1');

    const result = await recordVerifiedWebhook(identifiers, { registry });
    assert.equal(result.recorded, true);

    assert.equal(await assertPSPWebhookExists(CAPTURE_ID, { registry }), true);
    assert.equal(await assertPSPWebhookExists('WH-EVENT-0001', { registry }), true);
    assert.equal(await assertPSPWebhookExists('TRANSMISSION-1', { registry }), true);
    assert.equal(await assertPSPWebhookExists('5O190127TN364715X', { registry }), false);
    assert.equal(await assertPSPWebhookExists('', { registry }), false);

    const [entry] = await registry.entries();
    assert.equal(entry.provider, 'paypal');
    assert.equal(entry.psp_id, CAPTURE_ID);
    assert.match(entry.verified_at, /^\d{4}-\d{2}-\d{2}T/);
    // The amount PayPal stated is kept: it is the only number on the money path
    // the provider itself gave us.
    assert.equal(identifiers.amount, 42);
    assert.equal(identifiers.currency, 'USD');
    assert.equal(entry.amount, 42);
    assert.equal(entry.currency, 'USD');
});

test('the receipt for a capture carries the amount the provider confirmed', async () => {
    const registry = fileWebhookRegistry({ file: tempRegistryFile(), env: {} });
    await recordVerifiedWebhook(identifiersFromPayPalEvent(captureEvent(), 'TRANSMISSION-5'), { registry });

    const receipt = await findVerifiedWebhook(CAPTURE_ID, { registry });
    assert.equal(receipt.amount, 42);
    assert.equal(receipt.currency, 'USD');
    assert.equal(await findVerifiedWebhook('5O190127TN364715X', { registry }), null, 'an unnamed id has no receipt');
    assert.equal(await findVerifiedWebhook('', { registry }), null);
});

test('a receipt recorded before amounts were kept states no number', async () => {
    const registry = fileWebhookRegistry({ file: tempRegistryFile(), env: {} });
    await recordVerifiedWebhook({ provider: 'paypal', psp_id: CAPTURE_ID }, { registry });

    assert.equal(await assertPSPWebhookExists(CAPTURE_ID, { registry }), true);
    const receipt = await findVerifiedWebhook(CAPTURE_ID, { registry });
    assert.equal(agreesWithVerifiedAmount({ amount: 19, currency: 'USD' }, receipt), true, 'legacy receipts cannot contradict a row');
});

test('a proof agrees with a receipt only on amount and currency', () => {
    const receipt = { amount: 42, currency: 'USD' };

    assert.equal(agreesWithVerifiedAmount({ amount: 42, currency: 'usd' }, receipt), true);
    assert.equal(agreesWithVerifiedAmount({ amount: 41.99, currency: 'USD' }, receipt), false);
    assert.equal(agreesWithVerifiedAmount({ amount: 42, currency: 'EUR' }, receipt), false);
    assert.equal(agreesWithVerifiedAmount({ amount: 0, currency: 'USD' }, null), true, 'no receipt contradicts nothing');
    assert.equal(agreesWithVerifiedAmount({ amount: 0, currency: 'USD' }, { provider: 'paypal' }), true, 'a receipt with no amount contradicts nothing');
});

test('a receipt without a provider transaction id is refused and writes nothing', async () => {
    const file = tempRegistryFile();
    const registry = fileWebhookRegistry({ file, env: {} });

    const result = await recordVerifiedWebhook(
        identifiersFromPayPalEvent({ id: 'WH-EVENT-ONLY', resource: {} }),
        { registry }
    );

    assert.deepEqual(result, { recorded: false, reason: 'no_provider_transaction_id' });
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(await registry.entries(), []);
});

test('replaying the same webhook keeps one receipt', async () => {
    const registry = fileWebhookRegistry({ file: tempRegistryFile(), env: {} });
    const identifiers = identifiersFromPayPalEvent(captureEvent(), 'TRANSMISSION-1');

    assert.equal((await recordVerifiedWebhook(identifiers, { registry })).recorded, true);
    const again = await recordVerifiedWebhook(identifiers, { registry });

    assert.equal(again.recorded, false);
    assert.equal(again.reason, 'already_recorded');
    assert.equal((await registry.entries()).length, 1);
});

test('a corrupted registry fails closed instead of confirming money', async () => {
    const file = tempRegistryFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json}\n', 'utf8');

    const registry = fileWebhookRegistry({ file, env: {} });
    assert.equal(await assertPSPWebhookExists(CAPTURE_ID, { registry }), false);
});

test('the registry reports when a serverless instance cannot keep it', async () => {
    const file = tempRegistryFile();
    assert.equal(registryStatus(fileWebhookRegistry({ file, env: {} })).durable, true);

    const status = registryStatus(fileWebhookRegistry({ file, env: { VERCEL: '1' } }));
    assert.equal(status.kind, 'file');
    assert.equal(status.durable, false);
    assert.equal(status.reason, 'serverless_instance_has_no_shared_filesystem');
});

test('a remote registry appends receipts and answers membership', async () => {
    const calls = [];
    const stored = [];
    const fetchImpl = async (url, init = {}) => {
        calls.push({ url, method: init.method ?? 'GET', body: init.body, auth: init.headers?.authorization });
        if (init.method === 'POST') {
            stored.push(...JSON.parse(init.body).webhooks);
            return { ok: true, status: 200 };
        }
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ webhooks: stored }),
            headers: { get: () => 'application/json' }
        };
    };

    const registry = remoteWebhookRegistry({ url: 'https://registry.example/webhooks', token: 'secret', fetchImpl });

    await recordVerifiedWebhook(identifiersFromPayPalEvent(captureEvent(), 'T-2'), { registry });
    assert.equal(await isRegisteredWebhookId(CAPTURE_ID, { registry }), true);
    assert.equal(await isRegisteredWebhookId('5O190127TN364715X', { registry }), false);

    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].auth, 'Bearer secret');
    assert.equal(JSON.parse(calls[0].body).webhooks[0].psp_id, CAPTURE_ID);
});

test('registry answers parse as array, wrapper, single object or ndjson', () => {
    const rows = [{ psp_id: CAPTURE_ID }];
    assert.deepEqual(parseRegistryEntries(JSON.stringify(rows), 'application/json'), rows);
    assert.deepEqual(parseRegistryEntries(JSON.stringify({ webhooks: rows }), 'application/json'), rows);
    assert.deepEqual(parseRegistryEntries(JSON.stringify(rows[0]), 'application/json'), rows);
    assert.deepEqual(parseRegistryEntries(`${JSON.stringify(rows[0])}\n`, 'text/plain'), rows);
    assert.deepEqual(parseRegistryEntries(''), []);
});

test('entry matching ignores blank ids', () => {
    const entry = { psp_id: CAPTURE_ID, event_id: 'WH-EVENT-0001', transmission_id: 'T-3' };
    assert.equal(entryMatchesId(entry, CAPTURE_ID), true);
    assert.equal(entryMatchesId(entry, 'T-3'), true);
    assert.equal(entryMatchesId(entry, ''), false);
    assert.equal(entryMatchesId(entry, null), false);
});

test('ProofValidator refuses a psp id until its webhook is recorded', async () => {
    const file = tempRegistryFile();
    const previous = process.env.PSP_WEBHOOK_REGISTRY_FILE;
    process.env.PSP_WEBHOOK_REGISTRY_FILE = file;

    const event = {
        amount: 42,
        currency: 'USD',
        occurredAt: '2026-11-20T10:00:00.000Z',
        verification_proof: {
            type: 'psp_transaction_id',
            psp_id: CAPTURE_ID,
            amount: 42,
            currency: 'USD',
            timestamp: '2026-11-20T10:00:00.000Z',
            recipient: 'younestsouli2019@gmail.com'
        }
    };

    try {
        await assert.rejects(
            () => ProofValidator.assertValid(event),
            /INVARIANT_FAIL: psp_confirmation_missing/
        );

        await recordVerifiedWebhook(identifiersFromPayPalEvent(captureEvent(), 'TRANSMISSION-4'));

        await ProofValidator.assertValid(event);
    } finally {
        if (previous === undefined) delete process.env.PSP_WEBHOOK_REGISTRY_FILE;
        else process.env.PSP_WEBHOOK_REGISTRY_FILE = previous;
    }
});
