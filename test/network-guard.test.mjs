import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NetworkGuard, defaultEndpoints } from '../src/security/NetworkGuard.mjs';
import { ensureOwnerSignature, verifySignature } from '../src/security/KeyGuard.mjs';
import { computeConstitutionHashFromFile } from '../src/bootstrap/constitution-validator.mjs';

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-guard-'));
}

describe('NetworkGuard', () => {
    it('treats any HTTP response as reachable and network errors as failures', async () => {
        const fetchImpl = async url => {
            if (String(url).includes('paypal')) return { status: 404 };
            throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { name: 'Error' });
        };
        const guard = new NetworkGuard({
            endpoints: [{ name: 'paypal', url: 'https://api-m.paypal.com/' }, { name: 'egress', url: 'https://api.ipify.org' }],
            fetchImpl
        });
        const result = await guard.check();
        assert.equal(result.ok, false);
        assert.equal(result.results.find(row => row.name === 'paypal').ok, true);
        assert.equal(result.results.find(row => row.name === 'egress').status, 0);
    });

    it('starts, stops and reports transitions without throwing', async () => {
        const alerts = [];
        let reachable = true;
        const guard = new NetworkGuard({
            intervalMs: 5000,
            endpoints: [{ name: 'egress', url: 'https://api.ipify.org' }],
            fetchImpl: async () => {
                if (!reachable) throw new Error('network down');
                return { status: 200 };
            },
            onAlert: (title, body) => alerts.push({ title, body })
        });
        await guard.start();
        await guard.check();
        assert.equal(guard.running, true);
        assert.equal(guard.last.ok, true);
        reachable = false;
        await guard.check();
        assert.equal(guard.last.ok, false);
        assert.equal(alerts.length, 1);
        assert.match(alerts[0].title, /degraded/);
        guard.stop();
        assert.equal(guard.running, false);
        assert.equal(guard.status().endpoints.length, 1);
    });

    it('derives endpoints from configuration', () => {
        assert.deepEqual(
            defaultEndpoints({ NETWORK_GUARD_ENDPOINTS: 'https://api-m.paypal.com,https://example.org/health' })
                .map(endpoint => endpoint.name),
            ['api-m.paypal.com', 'example.org']
        );
        assert.ok(defaultEndpoints({}).length >= 1);
    });
});

describe('KeyGuard', () => {
    it('verifies a real Ed25519 owner signature', async () => {
        const dir = tempDir();
        const constitutionPath = path.join(dir, 'swarm.constitution.json');
        fs.writeFileSync(constitutionPath, JSON.stringify({ name: 'swarm', version: 1 }));
        const hash = computeConstitutionHashFromFile(constitutionPath);
        fs.writeFileSync(path.join(dir, 'constitution.hash.txt'), hash);
        const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
        const signature = crypto.sign(null, Buffer.from(hash), privateKey).toString('base64');
        fs.writeFileSync(path.join(dir, 'owner.signature'), signature);
        const publicPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
        fs.writeFileSync(path.join(dir, 'owner_public.key'), publicPem);

        const result = await ensureOwnerSignature({ root: dir, constitutionPath });
        assert.equal(result.ok, true);
        assert.equal(result.verified, true);
        assert.equal(result.hashMatches, true);
        assert.equal(verifySignature({ signature, constitutionHash: hash, publicKey: publicPem }), true);
    });

    it('never claims verification when the public key is missing', async () => {
        const dir = tempDir();
        const constitutionPath = path.join(dir, 'swarm.constitution.json');
        fs.writeFileSync(constitutionPath, JSON.stringify({ name: 'swarm' }));
        const hash = computeConstitutionHashFromFile(constitutionPath);
        fs.writeFileSync(path.join(dir, 'constitution.hash.txt'), hash);
        fs.writeFileSync(path.join(dir, 'owner.signature'), 'c2lnbmF0dXJl');

        const result = await ensureOwnerSignature({ root: dir, constitutionPath });
        assert.equal(result.ok, true);
        assert.equal(result.verified, false);
        assert.equal(result.reason, 'public_key_missing');
    });

    it('fails on a missing signature or a hash mismatch', async () => {
        const dir = tempDir();
        const constitutionPath = path.join(dir, 'swarm.constitution.json');
        fs.writeFileSync(constitutionPath, JSON.stringify({ name: 'swarm' }));
        const hash = computeConstitutionHashFromFile(constitutionPath);
        fs.writeFileSync(path.join(dir, 'constitution.hash.txt'), hash);

        const missing = await ensureOwnerSignature({ root: dir, constitutionPath });
        assert.equal(missing.ok, false);
        assert.equal(missing.reason, 'signature_missing');

        fs.writeFileSync(path.join(dir, 'owner.signature'), 'sig');
        fs.writeFileSync(path.join(dir, 'constitution.hash.txt'), 'deadbeef');
        const mismatch = await ensureOwnerSignature({ root: dir, constitutionPath });
        assert.equal(mismatch.ok, false);
        assert.equal(mismatch.reason, 'constitution_hash_mismatch');
    });
});
