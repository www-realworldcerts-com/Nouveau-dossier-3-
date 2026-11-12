import crypto from 'node:crypto';

/**
 * Purchase-order lifecycle for the swarm's procurement requests.
 *
 * The repository had no procurement engine at all: the requests in
 * procurement.txt and the Temu order in temu.txt describe real POs, but nothing
 * ever created, placed, shipped, verified or closed one, which is why there has
 * never been a successful recorded delivery. This module is the PO state
 * machine plus the evidence rules (carrier POD, weight, city, timeline and
 * 3-way match) that decide whether a delivery actually succeeded.
 */

export const STATUSES = ['draft', 'placed', 'shipped', 'delivered', 'on_hold', 'verified', 'closed'];

export const TRANSITIONS = {
    draft: ['placed', 'on_hold'],
    placed: ['shipped', 'on_hold'],
    shipped: ['delivered', 'on_hold'],
    delivered: ['verified', 'on_hold'],
    on_hold: ['placed', 'shipped', 'delivered', 'verified'],
    verified: ['closed'],
    closed: []
};

const OUTSTANDING = new Set(['placed', 'shipped', 'delivered', 'on_hold']);
const NEXT_ACTION = {
    draft: 'submit the PO to the supplier',
    placed: 'record the carrier shipment',
    shipped: 'await delivery and POD, then record delivery evidence',
    delivered: 'run 3-way verification with the goods receipt and invoice',
    on_hold: 'resolve the holds, then re-verify',
    verified: 'close the PO',
    closed: null
};

function iso(value) {
    return (value instanceof Date ? value : new Date(value)).toISOString();
}

function round(value, digits = 3) {
    return Math.round(value * 10 ** digits) / 10 ** digits;
}

export function slugPart(value, max = 12) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, max);
}

/** PO-TEMU-RAIS-WAFAE-270926-01 */
export function createPoRef({ supplier, recipient, date = new Date(), seq = 1 }) {
    const at = date instanceof Date ? date : new Date(date);
    const dd = String(at.getUTCDate()).padStart(2, '0');
    const mm = String(at.getUTCMonth() + 1).padStart(2, '0');
    const yy = String(at.getUTCFullYear()).slice(-2);
    return `PO-${slugPart(supplier, 8)}-${slugPart(recipient, 10)}-${dd}${mm}${yy}-${String(seq).padStart(2, '0')}`;
}

export function validateProcurementRequest(request) {
    const errors = [];
    if (!request || typeof request !== 'object') {
        return { ok: false, errors: ['request must be an object'], request: null };
    }
    const origin = String(request.origin || 'owner_initiated');
    const recipient = request.recipient || {};
    if (!String(request.supplier || '').trim()) errors.push('supplier is required');
    if (!String(recipient.name || '').trim()) errors.push('recipient.name is required');
    if (!String(recipient.city || '').trim()) errors.push('recipient.city is required');
    if (!['owner_initiated', 'third_party'].includes(origin)) {
        errors.push(`origin must be owner_initiated or third_party, got ${origin}`);
    }

    const items = Array.isArray(request.items) ? request.items : [];
    if (!items.length) errors.push('at least one item is required');
    items.forEach((item, index) => {
        if (!String(item?.title || item?.sku || '').trim()) errors.push(`items[${index}] needs a title or sku`);
        if (!Number.isInteger(Number(item?.qty)) || Number(item.qty) <= 0) {
            errors.push(`items[${index}] qty must be a positive integer`);
        }
        if (!Number.isFinite(Number(item?.unit_price_mad)) || Number(item.unit_price_mad) < 0) {
            errors.push(`items[${index}] unit_price_mad must be >= 0`);
        }
    });

    // Owner-initiated POs are pre-paid by the swarm: recipients never disburse.
    const recipientCharge = request.recipient_charge === true;
    const prepaidBy = String(request.prepaid_by || (origin === 'owner_initiated' ? 'swarm' : 'none'));
    if (origin === 'owner_initiated') {
        if (prepaidBy !== 'swarm') errors.push('owner-initiated POs must be pre-paid by the swarm');
        if (recipientCharge) errors.push('recipients of owner-initiated POs must not disburse funds');
    }

    return {
        ok: errors.length === 0,
        errors,
        request: {
            ...request,
            origin,
            prepaid_by: prepaidBy,
            recipient_charge: recipientCharge,
            currency: String(request.currency || 'MAD').toUpperCase()
        }
    };
}

export function computeTotals(items = []) {
    const subtotal = round(items.reduce((sum, item) => sum + Number(item.qty) * Number(item.unit_price_mad), 0), 2);
    const itemCount = items.reduce((sum, item) => sum + Number(item.qty), 0);
    const minWeight = round(items.reduce(
        (sum, item) => sum + Number(item.qty) * (Number.isFinite(Number(item.expected_min_weight_kg)) ? Number(item.expected_min_weight_kg) : 0.1),
        0
    ), 3);
    return { subtotal_mad: subtotal, item_count: itemCount, expected_min_weight_kg: minWeight };
}

export function buildPo(request, { now = new Date(), seq = 1 } = {}) {
    const validation = validateProcurementRequest(request);
    if (!validation.ok) {
        throw new Error(`Invalid procurement request: ${validation.errors.join('; ')}`);
    }
    const req = validation.request;
    const at = now instanceof Date ? now : new Date(now);
    const totals = computeTotals(req.items);
    return {
        po_ref: req.po_ref || createPoRef({ supplier: req.supplier, recipient: req.recipient.name, date: at, seq }),
        external_id: req.external_id || null,
        supplier: req.supplier,
        carrier: req.carrier || null,
        recipient: {
            name: req.recipient.name,
            city: req.recipient.city,
            phone: req.recipient.phone || null,
            address: req.recipient.address || null
        },
        origin: req.origin,
        prepaid_by: req.prepaid_by,
        recipient_charge: req.recipient_charge,
        currency: req.currency,
        items: req.items.map(item => ({
            sku: item.sku || null,
            title: item.title || item.sku,
            qty: Number(item.qty),
            unit_price_mad: Number(item.unit_price_mad),
            expected_min_weight_kg: Number.isFinite(Number(item.expected_min_weight_kg))
                ? Number(item.expected_min_weight_kg)
                : 0.1
        })),
        ...totals,
        expected_delivery_at: req.expected_delivery_at || null,
        status: 'draft',
        holds: [],
        tracking: null,
        delivery: null,
        verification: null,
        created_at: iso(at),
        updated_at: iso(at),
        status_history: [{ status: 'draft', at: iso(at), actor: req.requested_by || 'swarm' }]
    };
}

export function transitionPo(po, next, { at = new Date(), actor = 'system', holds = null } = {}) {
    if (!STATUSES.includes(next)) throw new Error(`Unknown PO status ${next}`);
    const allowed = TRANSITIONS[po.status] || [];
    if (!allowed.includes(next)) {
        throw new Error(`Illegal PO transition ${po.status} -> ${next} for ${po.po_ref}`);
    }
    const stamp = iso(at);
    const updated = {
        ...po,
        status: next,
        updated_at: stamp,
        status_history: [...(po.status_history || []), { status: next, at: stamp, actor }],
        [`${next}_at`]: stamp
    };
    if (next === 'on_hold') updated.holds = holds || po.holds || [];
    else updated.holds = [];
    return updated;
}

export function expectedMinWeightKg(po) {
    if (Number.isFinite(Number(po.expected_min_weight_kg)) && Number(po.expected_min_weight_kg) > 0) {
        return Number(po.expected_min_weight_kg);
    }
    return computeTotals(po.items).expected_min_weight_kg;
}

const BARE_HASH = /^[a-f0-9]{64}$/i;
const PREFIXED_POD = /^[A-Za-z][A-Za-z0-9._-]*:[^:]+:.+$/;

/**
 * Evidence rules taken from the operator's Temu delivery spec: carrier-prefixed
 * POD hash (not a bare 64-hex digest), weight above the expected minimum,
 * destination city matching the PO, and a coherent timeline.
 */
export function validateDeliveryEvidence(po, evidence = {}, { now = new Date() } = {}) {
    const checks = [];
    const holds = [];
    const at = now instanceof Date ? now : new Date(now);
    const minWeight = expectedMinWeightKg(po);

    const pod = String(evidence.pod_reference || '');
    const podOk = PREFIXED_POD.test(pod) && !BARE_HASH.test(pod);
    checks.push({ name: 'delivery_proof_hash', ok: podOk, detail: pod ? 'carrier-prefixed POD' : 'missing POD reference' });
    if (!podOk) {
        holds.push({
            code: 'HOLD_NO_REAL_DELIVERY_PROOF_HASH',
            detail: 'POD must be a carrier-prefixed hash such as POD:AMANA-sha256:<digest>, not a bare 64-hex digest'
        });
    }

    const weight = Number(evidence.weight_kg);
    const weightOk = Number.isFinite(weight) && weight >= minWeight + 0.05;
    checks.push({ name: 'weight', ok: weightOk, detail: `${weight || 0}kg vs minimum ${minWeight}kg + 0.05` });
    if (!weightOk) {
        holds.push({ code: 'HOLD_WEIGHT_BELOW_MIN', detail: `weight ${weight || 0}kg is below the expected minimum ${minWeight}kg` });
    }

    const city = String(evidence.destination_city || '').toLowerCase();
    const cityOk = Boolean(city) && city.includes(String(po.recipient?.city || '').toLowerCase());
    checks.push({ name: 'destination_city', ok: cityOk, detail: `${evidence.destination_city || 'missing'} should contain ${po.recipient?.city}` });
    if (!cityOk) {
        holds.push({ code: 'HOLD_CITY_MISMATCH', detail: `destination ${evidence.destination_city || 'missing'} does not match ${po.recipient?.city}` });
    }

    const createdAt = Date.parse(po.created_at);
    const shippedAt = Date.parse(evidence.shipped_at);
    const deliveredAt = Date.parse(evidence.delivered_at);

    const timelineShippedOk = Number.isFinite(shippedAt) && shippedAt >= createdAt - 2 * 3600000;
    checks.push({ name: 'shipped_after_creation', ok: timelineShippedOk, detail: 'shipment must not predate the PO by more than 2 hours' });
    if (!timelineShippedOk) {
        holds.push({ code: 'HOLD_TIMELINE_INCONSISTENT', detail: 'shipped_at predates the PO creation by more than 2 hours' });
    }

    const deliveryAfterShipOk = Number.isFinite(deliveredAt) && Number.isFinite(shippedAt) && deliveredAt >= shippedAt;
    checks.push({ name: 'delivered_after_shipped', ok: deliveryAfterShipOk, detail: 'delivery must follow shipment' });
    if (!deliveryAfterShipOk) {
        holds.push({ code: 'HOLD_DELIVERY_BEFORE_SHIPMENT', detail: 'delivered_at is missing or earlier than shipped_at' });
    }

    const futureOk = Number.isFinite(deliveredAt) && deliveredAt <= at.getTime() + 300000;
    checks.push({ name: 'delivery_not_in_future', ok: futureOk, detail: 'delivery timestamp must not be in the future' });
    if (!futureOk) {
        holds.push({ code: 'HOLD_FUTURE_DELIVERY', detail: 'delivered_at is in the future' });
    }

    return { ok: holds.length === 0, holds, checks };
}

/** PO vs goods receipt vs invoice. */
export function threeWayMatch(po, { receipt, invoice, now = new Date() } = {}) {
    const checks = [];
    const holds = [];
    const poQty = po.items.reduce((sum, item) => sum + Number(item.qty), 0);
    const receiptItems = Array.isArray(receipt?.items) ? receipt.items : [];
    const receiptQty = receiptItems.reduce((sum, item) => sum + Number(item.qty || 0), 0);

    const refOk = receipt?.po_ref === po.po_ref && invoice?.po_ref === po.po_ref;
    checks.push({ name: 'po_reference', ok: refOk, detail: `receipt ${receipt?.po_ref || 'missing'} / invoice ${invoice?.po_ref || 'missing'} vs ${po.po_ref}` });
    if (!refOk) holds.push({ code: 'HOLD_PO_REF_MISMATCH', detail: 'receipt or invoice references a different PO' });

    const qtyOk = receiptQty === poQty;
    checks.push({ name: 'quantity', ok: qtyOk, detail: `${receiptQty} received vs ${poQty} ordered` });
    if (!qtyOk) holds.push({ code: 'HOLD_QUANTITY_MISMATCH', detail: `received ${receiptQty} of ${poQty} units` });

    const invoiceTotal = Number(invoice?.total_mad);
    const totalOk = Number.isFinite(invoiceTotal) && Math.abs(invoiceTotal - po.subtotal_mad) <= 0.01;
    checks.push({ name: 'invoice_total', ok: totalOk, detail: `${invoiceTotal || 0} MAD vs ${po.subtotal_mad} MAD` });
    if (!totalOk) holds.push({ code: 'HOLD_INVOICE_TOTAL_MISMATCH', detail: 'invoice total differs from the PO subtotal' });

    const confirmer = String(receipt?.confirmed_by || '').trim();
    const confirmerOk = confirmer.length >= 3 && !['system', 'system-auto', 'auto', 'anonymous'].includes(confirmer.toLowerCase());
    checks.push({ name: 'receipt_confirmer', ok: confirmerOk, detail: confirmer ? `confirmed by ${confirmer}` : 'missing confirmer' });
    if (!confirmerOk) holds.push({ code: 'HOLD_RECEIPT_CONFIRMER_INVALID', detail: 'receipt must be confirmed by a real operator, not an automated placeholder' });

    const shippedAt = Date.parse(po.tracking?.shipped_at || po.delivery?.shipped_at);
    const receivedAt = Date.parse(receipt?.received_at);
    const receiptAfterShipOk = !Number.isFinite(shippedAt) || (Number.isFinite(receivedAt) && receivedAt >= shippedAt);
    checks.push({ name: 'receipt_after_shipment', ok: receiptAfterShipOk, detail: 'goods receipt must follow shipment' });
    if (!receiptAfterShipOk) holds.push({ code: 'HOLD_RECEIPT_BEFORE_SHIPMENT', detail: 'goods receipt predates the shipment' });

    return { ok: holds.length === 0, holds, checks };
}

export function evaluatePo(po, { now = new Date() } = {}) {
    const at = now instanceof Date ? now : new Date(now);
    const outstanding = OUTSTANDING.has(po.status);
    const since = Date.parse(po.placed_at || po.created_at);
    const waitingDays = outstanding && Number.isFinite(since) ? round((at.getTime() - since) / 86400000, 1) : 0;
    const holds = (po.holds || []).map(hold => hold.code);
    return {
        po_ref: po.po_ref,
        status: po.status,
        supplier: po.supplier,
        recipient: po.recipient?.name || null,
        subtotal_mad: po.subtotal_mad,
        waiting_days: waitingDays,
        outstanding,
        holds,
        next_action: NEXT_ACTION[po.status] || null
    };
}

export function buildProcurementReport(pos, { now = new Date() } = {}) {
    const at = now instanceof Date ? now : new Date(now);
    const counts = Object.fromEntries(STATUSES.map(status => [status, 0]));
    const outstanding = [];
    for (const po of pos) {
        counts[po.status] = (counts[po.status] || 0) + 1;
        const view = evaluatePo(po, { now: at });
        if (view.outstanding) outstanding.push(view);
    }
    return {
        generated_at: iso(at),
        total_pos: pos.length,
        counts,
        outstanding: outstanding.sort((a, b) => b.waiting_days - a.waiting_days),
        ready_to_close: pos.filter(po => po.status === 'verified').map(po => po.po_ref),
        verified_total_mad: round(pos.filter(po => ['verified', 'closed'].includes(po.status))
            .reduce((sum, po) => sum + po.subtotal_mad, 0), 2)
    };
}

export function evidenceHash(po) {
    return crypto.createHash('sha256')
        .update(JSON.stringify({ po_ref: po.po_ref, delivery: po.delivery, subtotal: po.subtotal_mad }))
        .digest('hex');
}
