import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { EvidenceIntegrityChain } from '../src/real/evidence-integrity.mjs';

function tempChain(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-chain-lock-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'evidence-chain.json');
    process.env.EVIDENCE_CHAIN_PATH = file;
    return { file, lock: `${file}.lock` };
}

function proof(pspId, amount) {
    return { type: 'psp_transaction_id', psp_id: pspId, amount, currency: 'USD' };
}

test('captures recorded at the same time add their blocks to one chain', async t => {
    const { file, lock } = tempChain(t);

    const captures = [
        ['5O190127TN364715T', 19],
        ['8AB23344CD556677J', 42],
        ['3XY99887ZZ112233K', 7],
        ['9QQ11122WW334455L', 120],
        ['2MM66778NN990011P', 65]
    ];

    // Every append reads the last block before writing, so without the lock they
    // all read the same predecessor and each rewrite overwrites the others.
    await Promise.all(captures.map(([eventId, amount]) => EvidenceIntegrityChain.addBlock(eventId, proof(eventId, amount))));

    const chain = JSON.parse(fs.readFileSync(file, 'utf8'));

    assert.equal(chain.length, captures.length, 'every capture has exactly one block');
    assert.deepEqual(
        chain.map(block => block.eventId).sort(),
        captures.map(([eventId]) => eventId).sort(),
        'no capture is lost and none is recorded twice'
    );

    // One chain, not two branches: each block names the previous block's hash.
    assert.equal(chain[0].prevHash, 'GENESIS');
    for (let i = 1; i < chain.length; i += 1) {
        assert.equal(chain[i].prevHash, chain[i - 1].hash, `block ${i} links to block ${i - 1}`);
    }

    for (const [eventId] of captures) {
        assert.equal(await EvidenceIntegrityChain.assertEventBound(eventId), true);
    }

    assert.equal(fs.existsSync(lock), false, 'the lock is released after the append');
    assert.equal(fs.existsSync(`${file}.tmp`), false, 'no staging file is left behind');
});

test('a lock left by a dead writer is stolen instead of wedging the chain', async t => {
    const { file, lock } = tempChain(t);

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(lock, '');
    const longAgo = new Date(Date.now() - 5 * 60 * 1000);
    fs.utimesSync(lock, longAgo, longAgo);

    const block = await EvidenceIntegrityChain.addBlock('5O190127TN364715T', proof('5O190127TN364715T', 19));

    assert.equal(block.prevHash, 'GENESIS');
    assert.equal(fs.existsSync(lock), false);
    assert.equal((await EvidenceIntegrityChain.fetchBlockForEvent('5O190127TN364715T')).hash, block.hash);
});

test('a fresh lock is waited for, not stolen', async t => {
    const { file, lock } = tempChain(t);

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(lock, '');

    const pending = EvidenceIntegrityChain.addBlock('8AB23344CD556677J', proof('8AB23344CD556677J', 42));
    setTimeout(() => fs.unlinkSync(lock), 50);
    const block = await pending;

    assert.equal(block.eventId, '8AB23344CD556677J');
    assert.equal(fs.existsSync(lock), false);
});
