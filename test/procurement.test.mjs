import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    buildPo,
    buildProcurementReport,
    computeTotals,
    createPoRef,
    threeWayMatch,
    transitionPo,
    validateDeliveryEvidence,
    validateProcurementRequest
} from '../src/procurement/po.mjs';
import { ProcurementAgent } from '../src/procurement/agent.mjs';
import { ProcurementStore } from '../src/procurement/store.mjs';
import { parseAmanaScans } from '../src/procurement/carriers/amana.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const fixture = name => JSON.parse(fs.readFileSync(path.join(here, 'fixtures/procurement', name), 'utf8'));

const T0 = new Date('2026-09-27T09:00:00+01:00');
const T1 = new Date('2026-09-28T12:00:00+01:00');
const PO_REF = 'PO-TEMU-TEST-RECIP-270926-01';

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'procurement-'));
}

function makeAgent({ now = () => T0, dir = tempDir() } = {}) {
    return new ProcurementAgent({ dir, now });
}

function deliveredAgent() {
    const clock = { value: T0 };
    const agent = new ProcurementAgent({ dir: tempDir(), now: () => clock.value });
    const { created } = agent.ingestRequests({ ...fixture('request-happy.json'), po_ref: PO_REF }, { place: true });
    assert.equal(created[0].po_ref, PO_REF);
    clock.value = new Date('2026-09-27T15:00:00+01:00');
    agent.ship(PO_REF, { carrier: 'AMANA', tracking: 'AMANA-OWNER-TEMU-270926', shipped_at: '2026-09-27T14:05:00+01:00' });
    clock.value = T1;
    return { agent, clock };
}

test('PO reference follows the supplier-recipient-date-seq format', () => {
    assert.equal(
        createPoRef({ supplier: 'TEMU', recipient: 'Rais Wafae', date: new Date('2026-09-27T12:00:00Z'), seq: 1 }),
        'PO-TEMU-RAIS-WAFAE-270926-01'
    );
    assert.equal(
        createPoRef({ supplier: 'Jumia', recipient: 'Bouznika', date: new Date('2026-11-02T12:00:00Z'), seq: 7 }),
        'PO-JUMIA-BOUZNIKA-021126-07'
    );
});

test('totals, item count and expected minimum weight', () => {
    const totals = computeTotals(fixture('request-happy.json').items);
    assert.equal(totals.subtotal_mad, 3302);
    assert.equal(totals.item_count, 7);
    assert.equal(totals.expected_min_weight_kg, 1.5);
});

test('owner-initiated POs must be pre-paid by the swarm and never charge the recipient', () => {
    const request = fixture('request-happy.json');
    assert.equal(validateProcurementRequest(request).ok, true);

    const charged = validateProcurementRequest({ ...request, recipient_charge: true });
    assert.equal(charged.ok, false);
    assert.match(charged.errors.join(' '), /must not disburse/);

    const notPrepaid = validateProcurementRequest({ ...request, prepaid_by: 'recipient' });
    assert.equal(notPrepaid.ok, false);
    assert.match(notPrepaid.errors.join(' '), /pre-paid by the swarm/);

    const thirdParty = validateProcurementRequest({
        ...request,
        origin: 'third_party',
        prepaid_by: 'none',
        recipient_charge: true
    });
    assert.equal(thirdParty.ok, true);
});

test('invalid requests are rejected before a PO exists', () => {
    const request = fixture('request-happy.json');
    assert.equal(validateProcurementRequest({ ...request, items: [] }).ok, false);
    assert.equal(validateProcurementRequest({ ...request, supplier: '' }).ok, false);

    const badQty = validateProcurementRequest({
        ...request,
        items: [{ title: 'Bad', qty: 0, unit_price_mad: 10 }]
    });
    assert.equal(badQty.ok, false);
    assert.match(badQty.errors.join(' '), /qty must be a positive integer/);

    assert.throws(() => buildPo({ ...request, items: [] }, { now: T0 }), /Invalid procurement request/);
});

test('PO starts as a draft with a full status history', () => {
    const po = buildPo({ ...fixture('request-happy.json'), po_ref: PO_REF }, { now: T0, seq: 1 });
    assert.equal(po.status, 'draft');
    assert.equal(po.subtotal_mad, 3302);
    assert.equal(po.expected_min_weight_kg, 1.5);
    assert.equal(po.status_history.length, 1);
    assert.equal(po.prepaid_by, 'swarm');
});

test('the state machine refuses illegal transitions and accepts the delivery chain', () => {
    const po = buildPo({ ...fixture('request-happy.json'), po_ref: PO_REF }, { now: T0 });
    assert.throws(() => transitionPo(po, 'delivered'), /Illegal PO transition draft -> delivered/);

    let next = transitionPo(po, 'placed', { at: T0 });
    next = transitionPo(next, 'shipped', { at: T0 });
    next = transitionPo(next, 'delivered', { at: T0 });
    next = transitionPo(next, 'verified', { at: T0 });
    next = transitionPo(next, 'closed', { at: T0 });
    assert.equal(next.status, 'closed');
    assert.equal(next.status_history.length, 6);
    assert.equal(next.holds.length, 0);
});

test('delivery evidence accepts a carrier POD with weight, city and coherent timeline', () => {
    const po = buildPo({ ...fixture('request-happy.json'), po_ref: PO_REF }, { now: T0 });
    const result = validateDeliveryEvidence(po, fixture('delivery-happy.json'), { now: T1 });
    assert.equal(result.ok, true, JSON.stringify(result.holds));
    assert.equal(result.checks.length, 6);
});

test('delivery evidence holds on a bare 64-hex digest instead of a carrier POD', () => {
    const po = buildPo({ ...fixture('request-happy.json'), po_ref: PO_REF }, { now: T0 });
    const result = validateDeliveryEvidence(po, fixture('delivery-bare-hash.json'), { now: T1 });
    assert.equal(result.ok, false);
    assert.ok(result.holds.some(hold => hold.code === 'HOLD_NO_REAL_DELIVERY_PROOF_HASH'));
});

test('delivery evidence holds on low weight, wrong city and impossible timelines', () => {
    const po = buildPo({ ...fixture('request-happy.json'), po_ref: PO_REF }, { now: T0 });
    const happy = fixture('delivery-happy.json');

    const light = validateDeliveryEvidence(po, { ...happy, weight_kg: 1.0 }, { now: T1 });
    assert.ok(light.holds.some(hold => hold.code === 'HOLD_WEIGHT_BELOW_MIN'));

    const wrongCity = validateDeliveryEvidence(po, { ...happy, destination_city: 'Casablanca' }, { now: T1 });
    assert.ok(wrongCity.holds.some(hold => hold.code === 'HOLD_CITY_MISMATCH'));

    const future = validateDeliveryEvidence(po, happy, { now: T0 });
    assert.ok(future.holds.some(hold => hold.code === 'HOLD_FUTURE_DELIVERY'));

    const earlyShip = validateDeliveryEvidence(po, { ...happy, shipped_at: '2026-09-20T08:00:00+01:00' }, { now: T1 });
    assert.ok(earlyShip.holds.some(hold => hold.code === 'HOLD_TIMELINE_INCONSISTENT'));

    const swapped = validateDeliveryEvidence(po, {
        ...happy,
        shipped_at: '2026-09-28T10:00:00+01:00',
        delivered_at: '2026-09-27T10:00:00+01:00'
    }, { now: T1 });
    assert.ok(swapped.holds.some(hold => hold.code === 'HOLD_DELIVERY_BEFORE_SHIPMENT'));
});

test('3-way match passes when PO, goods receipt and invoice agree', () => {
    const po = buildPo({ ...fixture('request-happy.json'), po_ref: PO_REF }, { now: T0 });
    const result = threeWayMatch(po, { receipt: fixture('receipt.json'), invoice: fixture('invoice.json'), now: T1 });
    assert.equal(result.ok, true, JSON.stringify(result.holds));
    assert.equal(result.checks.length, 5);
});

test('3-way match holds on quantity, total, reference and placeholder confirmer', () => {
    const po = buildPo({ ...fixture('request-happy.json'), po_ref: PO_REF }, { now: T0 });
    const receipt = fixture('receipt.json');
    const invoice = fixture('invoice.json');

    const short = threeWayMatch(po, {
        receipt: { ...receipt, items: receipt.items.slice(0, 3) },
        invoice,
        now: T1
    });
    assert.ok(short.holds.some(hold => hold.code === 'HOLD_QUANTITY_MISMATCH'));

    const wrongTotal = threeWayMatch(po, { receipt, invoice: { ...invoice, total_mad: 3299 }, now: T1 });
    assert.ok(wrongTotal.holds.some(hold => hold.code === 'HOLD_INVOICE_TOTAL_MISMATCH'));

    const wrongRef = threeWayMatch(po, { receipt, invoice: { ...invoice, po_ref: 'PO-OTHER' }, now: T1 });
    assert.ok(wrongRef.holds.some(hold => hold.code === 'HOLD_PO_REF_MISMATCH'));

    const autoConfirmer = threeWayMatch(po, { receipt: { ...receipt, confirmed_by: 'system-auto' }, invoice, now: T1 });
    assert.ok(autoConfirmer.holds.some(hold => hold.code === 'HOLD_RECEIPT_CONFIRMER_INVALID'));
});

test('agent drives a PO from request to closed after a verified delivery', () => {
    const { agent, clock } = deliveredAgent();
    const delivery = agent.deliver(PO_REF, {
        evidence: fixture('delivery-happy.json'),
        receipt: fixture('receipt.json'),
        invoice: fixture('invoice.json')
    });
    assert.equal(delivery.ok, true, JSON.stringify(delivery.holds));
    assert.equal(delivery.po.status, 'verified');

    clock.value = new Date('2026-09-29T09:00:00+01:00');
    const closed = agent.close(PO_REF);
    assert.equal(closed.status, 'closed');

    const report = agent.status();
    assert.equal(report.total_pos, 1);
    assert.equal(report.counts.closed, 1);
    assert.equal(report.verified_total_mad, 3302);
    assert.equal(report.outstanding.length, 0);

    const events = agent.store.events(PO_REF).map(event => event.type);
    assert.deepEqual(events, ['created', 'placed', 'shipped', 'delivered', 'verified', 'closed']);
});

test('a fake POD puts the PO on hold and verification refuses to pass', () => {
    const { agent } = deliveredAgent();
    const delivery = agent.deliver(PO_REF, { evidence: fixture('delivery-bare-hash.json') });
    assert.equal(delivery.ok, false);
    assert.equal(delivery.po.status, 'on_hold');
    assert.deepEqual(delivery.holds.map(hold => hold.code), ['HOLD_NO_REAL_DELIVERY_PROOF_HASH']);

    const verification = agent.verify(PO_REF, { receipt: fixture('receipt.json'), invoice: fixture('invoice.json') });
    assert.equal(verification.ok, false);
    assert.equal(verification.po.status, 'on_hold');
    assert.ok(verification.holds.some(hold => hold.code === 'HOLD_NO_REAL_DELIVERY_PROOF_HASH'));
});

test('verification without a receipt and invoice cannot mark a delivery successful', () => {
    const { agent } = deliveredAgent();
    agent.deliver(PO_REF, { evidence: fixture('delivery-happy.json') });
    const result = agent.verify(PO_REF);
    assert.equal(result.ok, false);
    assert.deepEqual(
        result.holds.map(hold => hold.code).sort(),
        ['HOLD_MISSING_GOODS_RECEIPT', 'HOLD_MISSING_INVOICE']
    );
    assert.equal(result.po.status, 'on_hold');
});

test('carrier scan ingestion advances a draft PO to delivered', () => {
    const clock = { value: T0 };
    const agent = new ProcurementAgent({ dir: tempDir(), now: () => clock.value });
    agent.ingestRequests({ ...fixture('request-happy.json'), po_ref: PO_REF });
    clock.value = T1;
    const result = agent.ingestTracking(fixture('amana-scans.json'));
    assert.equal(result.po.po_ref, PO_REF);
    assert.equal(result.po.status, 'delivered');
    assert.equal(result.po.tracking.number, 'AMANA-OWNER-TEMU-270926');
    assert.equal(result.po.delivery.weight_kg, 2.55);
    assert.equal(result.scans.length, 3);
    assert.equal(parseAmanaScans(fixture('amana-scans.json')).delivery.signed_by, 'TEST RECIPIENT');
});

test('ingestion is idempotent per external id and stores survive a new agent', () => {
    const dir = tempDir();
    const agent = makeAgent({ dir });
    const first = agent.ingestRequests(fixture('request-happy.json'));
    const second = agent.ingestRequests(fixture('request-happy.json'));
    assert.equal(first.created.length, 1);
    assert.equal(second.created.length, 0);
    assert.equal(second.skipped[0].reason, 'already_ingested');

    const reopened = new ProcurementStore({ dir });
    assert.equal(reopened.listPos().length, 1);
    assert.equal(reopened.listPos()[0].subtotal_mad, 3302);
});

test('an ingested PO is pre-paid and never asks the recipient for money', () => {
    const agent = makeAgent();
    const { created } = agent.ingestRequests(fixture('request-happy.json'));
    assert.equal(created[0].prepaid_by, 'swarm');
    assert.equal(created[0].recipient_charge, false);
    assert.equal(created[0].origin, 'owner_initiated');
});

test('report lists waiting deliveries with age and the next action', () => {
    const clock = { value: T0 };
    const agent = new ProcurementAgent({ dir: tempDir(), now: () => clock.value });
    agent.ingestRequests({ ...fixture('request-happy.json'), po_ref: PO_REF }, { place: true });
    clock.value = new Date('2026-09-30T09:00:00+01:00');
    const report = buildProcurementReport(agent.list(), { now: clock.value });
    assert.equal(report.outstanding.length, 1);
    assert.equal(report.outstanding[0].po_ref, PO_REF);
    assert.equal(report.outstanding[0].waiting_days, 3);
    assert.equal(report.outstanding[0].next_action, 'record the carrier shipment');
});

test('guard rails: unknown POs, delivery before shipment and closing an unverified PO', () => {
    const agent = makeAgent();
    assert.throws(() => agent.place('PO-NOPE'), /Unknown PO/);

    agent.ingestRequests({ ...fixture('request-happy.json'), po_ref: PO_REF }, { place: true });
    assert.throws(() => agent.deliver(PO_REF, { evidence: fixture('delivery-happy.json') }), /must be shipped/);
    assert.throws(() => agent.close(PO_REF), /Illegal PO transition placed -> closed/);
});
