import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ProcurementAgent } from '../src/procurement/agent.mjs';
import { run } from '../scripts/import-procurement.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const fixture = name => JSON.parse(fs.readFileSync(path.join(here, 'fixtures/procurement', name), 'utf8'));
const CREATED_AT = '2026-09-27T09:00:00+01:00';

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'procurement-import-test-'));
}

function manifestFor(dir, request, { createdAt = CREATED_AT, place = true } = {}) {
    const file = path.join(dir, 'orders.json');
    fs.writeFileSync(file, JSON.stringify({ orders: [{ created_at: createdAt, place, request }] }));
    return file;
}

function evidenceCopy(dir, mutate) {
    const payload = fixture('amana-scans.json');
    mutate(payload);
    const file = path.join(dir, 'scans.json');
    fs.writeFileSync(file, JSON.stringify(payload));
    return file;
}

function requestWith(poRef) {
    return { ...fixture('request-happy.json'), po_ref: poRef, external_id: `IMPORT-${poRef}` };
}

test('dry-run imports into a temp copy and leaves data/procurement untouched', () => {
    const dir = tempDir();
    const dataDir = path.join(dir, 'data');
    const orders = manifestFor(dir, requestWith('PO-TEMU-TEST-RECIP-270926-01'));
    const report = run([
        '--orders', orders,
        '--evidence', path.join(here, 'fixtures/procurement/amana-scans.json'),
        '--data-dir', dataDir
    ], { stdout: () => {} });

    assert.equal(report.mode, 'dry-run');
    assert.equal(report.orders.created.length, 1);
    assert.equal(report.orders.created[0].po_ref, 'PO-TEMU-TEST-RECIP-270926-01');
    assert.equal(report.orders.created[0].status, 'placed');
    assert.equal(report.evidence.accepted.length, 1);
    assert.equal(report.evidence.accepted[0].status, 'delivered');
    assert.equal(report.contentieux.cases, 1);
    assert.equal(fs.existsSync(path.join(dataDir, 'pos.ndjson')), false);
});

test('apply records the backdated PO and real AMANA delivery evidence', () => {
    const dir = tempDir();
    const dataDir = path.join(dir, 'data');
    const orders = manifestFor(dir, requestWith('PO-TEMU-TEST-RECIP-270926-01'));
    run([
        '--orders', orders,
        '--evidence', path.join(here, 'fixtures/procurement/amana-scans.json'),
        '--data-dir', dataDir,
        '--apply'
    ], { stdout: () => {} });

    const po = new ProcurementAgent({ dir: dataDir }).store.find('PO-TEMU-TEST-RECIP-270926-01');
    assert.ok(po);
    assert.equal(po.status, 'delivered');
    assert.equal(po.placed_at, new Date(CREATED_AT).toISOString());
    assert.equal(po.delivery.pod_reference.startsWith('POD:AMANA-'), true);
    assert.equal(po.delivery.weight_kg, 2.55);
    assert.equal(po.status_history.some(entry => entry.status === 'delivered'), true);
});

test('invalid or missing POD evidence is held, never marked delivered', () => {
    const dir = tempDir();
    const dataDir = path.join(dir, 'data');
    const orders = manifestFor(dir, requestWith('PO-TEMU-TEST-RECIP-270926-01'));
    const scans = evidenceCopy(dir, payload => {
        delete payload.scans[2].pod_reference;
        delete payload.pod_reference;
    });
    const report = run([
        '--orders', orders,
        '--evidence', scans,
        '--data-dir', dataDir,
        '--apply'
    ], { stdout: () => {} });

    const po = new ProcurementAgent({ dir: dataDir }).store.find('PO-TEMU-TEST-RECIP-270926-01');
    assert.equal(po.status, 'on_hold');
    assert.equal(po.delivered_at, undefined);
    assert.ok(po.holds.some(hold => hold.code === 'HOLD_NO_REAL_DELIVERY_PROOF_HASH'));
    assert.equal(report.evidence.held.length, 1);
    assert.equal(report.evidence.accepted.length, 0);
    assert.equal(report.contentieux.cases, 1);
});

test('unmatched evidence is reported, not attached to another PO', () => {
    const dir = tempDir();
    const dataDir = path.join(dir, 'data');
    const scans = evidenceCopy(dir, payload => { payload.po_ref = 'PO-DOES-NOT-EXIST'; });
    const report = run([
        '--orders', manifestFor(dir, requestWith('PO-OTHER-270926-01')),
        '--evidence', scans,
        '--data-dir', dataDir,
        '--apply'
    ], { stdout: () => {} });

    assert.equal(report.evidence.unmatched.length, 1);
    assert.equal(report.evidence.accepted.length, 0);
    const po = new ProcurementAgent({ dir: dataDir }).store.find('PO-OTHER-270926-01');
    assert.equal(po.status, 'placed');
    assert.equal(po.delivery, null);
});

test('re-running is idempotent for orders and does not rewrite a delivered PO', () => {
    const dir = tempDir();
    const dataDir = path.join(dir, 'data');
    const orders = manifestFor(dir, requestWith('PO-TEMU-TEST-RECIP-270926-01'));
    const scans = path.join(here, 'fixtures/procurement/amana-scans.json');
    const args = ['--orders', orders, '--evidence', scans, '--data-dir', dataDir, '--apply'];

    run(args, { stdout: () => {} });
    const second = run(args, { stdout: () => {} });

    assert.equal(second.orders.created.length, 0);
    assert.equal(second.orders.skipped.length, 1);
    assert.equal(second.evidence.skipped.length, 1);
    assert.equal(new ProcurementAgent({ dir: dataDir }).store.find('PO-TEMU-TEST-RECIP-270926-01').status, 'delivered');
});
