import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ProcurementAgent } from '../src/procurement/agent.mjs';
import { buildContentieuxCases, renderContentieuxMarkdown } from '../src/procurement/contentieux.mjs';
import { run } from '../scripts/contentieux.mjs';

const NOW = new Date('2026-11-13T12:00:00Z');

function daysAgo(days) {
    return new Date(NOW.getTime() - days * 86400000).toISOString();
}

function po(overrides = {}) {
    return {
        po_ref: 'PO-TEMU-TEST-131126-01',
        supplier: 'TEMU',
        recipient: { name: 'Rais Wafae', city: 'Rabat' },
        subtotal_mad: 1500,
        status: 'shipped',
        created_at: daysAgo(20),
        placed_at: daysAgo(12),
        holds: [],
        delivery: null,
        ...overrides
    };
}

test('late POs become cases with the evidence that is still missing', () => {
    const report = buildContentieuxCases([
        po({
            status: 'delivered',
            subtotal_mad: 2500,
            placed_at: daysAgo(20),
            delivery: {
                pod_reference: 'POD:AMANA-sha256:abc',
                weight_kg: 2.5,
                destination_city: 'Agdal, Rabat',
                delivered_at: daysAgo(18)
            }
        })
    ], { now: NOW });

    assert.equal(report.cases.length, 1);
    const item = report.cases[0];
    assert.equal(item.case_id, 'CTX-PO-TEMU-TEST-131126-01');
    assert.equal(item.severity, 'high');
    assert.deepEqual(item.missing_evidence, ['goods_receipt', 'supplier_invoice', 'three_way_match']);
    assert.equal(item.evidence.find(evidence => evidence.id === 'carrier_pod').present, true);
    assert.equal(item.evidence.find(evidence => evidence.id === 'destination_city').present, true);
});

test('held POs are always included and fresh POs are not', () => {
    const report = buildContentieuxCases([
        po({
            po_ref: 'PO-HELD-131126-01',
            status: 'on_hold',
            placed_at: daysAgo(1),
            subtotal_mad: 100,
            holds: [{ code: 'HOLD_CITY_MISMATCH', detail: 'Casablanca should contain Rabat' }]
        }),
        po({ po_ref: 'PO-FRESH-131126-01', status: 'placed', placed_at: daysAgo(2) })
    ], { now: NOW, minDays: 7 });

    assert.equal(report.cases.length, 1);
    const held = report.cases[0];
    assert.equal(held.po_ref, 'PO-HELD-131126-01');
    assert.equal(held.severity, 'high');
    assert.equal(held.holds[0].meaning, 'destination city does not match the recipient city');
    assert.deepEqual(held.missing_evidence, ['hold_resolution', 'goods_receipt', 'supplier_invoice']);
});

test('the Markdown case file states the amount at stake and the no-fabrication rule', () => {
    const report = buildContentieuxCases([
        po({ po_ref: 'PO-A-131126-01', subtotal_mad: 800, placed_at: daysAgo(9) }),
        po({ po_ref: 'PO-B-131126-01', subtotal_mad: 200, placed_at: daysAgo(15) })
    ], { now: NOW });
    const markdown = renderContentieuxMarkdown(report);

    assert.match(markdown, /cases: 2; amount at stake: 1000 MAD/);
    assert.match(markdown, /Never record a delivery without carrier proof/);
    assert.match(markdown, /## CTX-PO-B-131126-01/);
    assert.match(markdown, /- \[ \] Carrier-prefixed proof of delivery/);
});

test('an empty ledger renders a clean no-case report', () => {
    const report = buildContentieuxCases([], { now: NOW });
    assert.equal(report.cases.length, 0);
    assert.match(renderContentieuxMarkdown(report), /No PO meets the dispute threshold/);
});

test('CLI reads the procurement store and returns the same case set', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contentieux-'));
    const clock = { value: new Date('2026-10-01T09:00:00Z') };
    const agent = new ProcurementAgent({ dir, now: () => clock.value });
    agent.ingestRequests({
        external_id: 'CTX-CLI-1',
        supplier: 'TEMU',
        origin: 'owner_initiated',
        prepaid_by: 'swarm',
        recipient_charge: false,
        recipient: { name: 'Test Recipient', city: 'Rabat' },
        items: [{ sku: 'SKU-1', qty: 1, unit_price_mad: 600, expected_min_weight_kg: 0.5 }]
    }, { place: true });

    const report = run(['--data-dir', dir, '--json', '--min-days', '7'], { stdout: () => {} });
    assert.equal(report.cases.length, 1);
    assert.equal(report.cases[0].status, 'placed');
    assert.equal(report.cases[0].amount_mad, 600);
});
