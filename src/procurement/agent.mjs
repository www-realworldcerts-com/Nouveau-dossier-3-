import {
    buildPo,
    buildProcurementReport,
    createPoRef,
    transitionPo,
    threeWayMatch,
    validateDeliveryEvidence,
    validateProcurementRequest
} from './po.mjs';
import { ProcurementStore } from './store.mjs';
import { parseAmanaScans } from './carriers/amana.mjs';

const iso = value => (value instanceof Date ? value : new Date(value)).toISOString();

/** Stay on hold from any non-terminal status without an illegal self-transition. */
function holdPo(po, holds, at, actor) {
    if (po.status === 'on_hold') {
        return { ...po, holds, updated_at: iso(at) };
    }
    return transitionPo(po, 'on_hold', { at, actor, holds });
}

/**
 * Autonomous procurement agent: creates POs from operator requests, advances
 * them through placement/shipment/delivery, verifies delivery evidence with a
 * 3-way match and reports everything still outstanding.
 *
 * It does not place orders with suppliers: Jumia, parfummaroc, superfood.ma and
 * AMANA have no API credentials in this repository. The agent records and
 * enforces the truth of a PO so "successful delivery" is provable.
 */
export class ProcurementAgent {
    constructor({ dir, store, now = () => new Date() } = {}) {
        this.store = store || new ProcurementStore({ dir });
        this.now = now;
    }

    list() {
        return this.store.listPos();
    }

    require(poRef) {
        const po = this.store.find(poRef);
        if (!po) throw new Error(`Unknown PO: ${poRef}`);
        return po;
    }

    save(po, type, data = {}) {
        const at = iso(this.now());
        const next = { ...po, updated_at: at };
        this.store.save(next);
        this.store.appendEvent({ po_ref: next.po_ref, type, at, status: next.status, data });
        return next;
    }

    nextSeq(supplier, recipientName, at) {
        const prefix = createPoRef({ supplier, recipient: recipientName, date: at, seq: 1 }).replace(/-01$/, '');
        const existing = this.store.listPos().filter(po => String(po.po_ref).startsWith(prefix)).length;
        return existing + 1;
    }

    ingestRequests(payload, { place = false, createdAt = null } = {}) {
        const requests = Array.isArray(payload) ? payload : payload?.requests || [payload];
        const created = [];
        const skipped = [];
        for (const request of requests) {
            const validation = validateProcurementRequest(request);
            if (!validation.ok) {
                throw new Error(`Invalid procurement request: ${validation.errors.join('; ')}`);
            }
            const existing = request.external_id
                ? this.store.listPos().find(po => po.external_id === request.external_id)
                : null;
            if (existing) {
                skipped.push({ external_id: request.external_id, po_ref: existing.po_ref, reason: 'already_ingested' });
                continue;
            }
            const at = createdAt ? new Date(createdAt) : this.now();
            const seq = this.nextSeq(request.supplier, request.recipient.name, at);
            let po = buildPo(request, { now: at, seq });
            if (this.store.find(po.po_ref)) {
                po = { ...po, po_ref: createPoRef({ supplier: request.supplier, recipient: request.recipient.name, date: at, seq: seq + 1 }) };
            }
            po = this.save(po, 'created', { external_id: po.external_id });
            if (place) po = this.place(po.po_ref, { actor: request.requested_by || 'swarm' });
            created.push(po);
        }
        return { created, skipped };
    }

    place(poRef, { actor = 'operator' } = {}) {
        const po = this.require(poRef);
        return this.save(transitionPo(po, 'placed', { at: this.now(), actor }), 'placed');
    }

    ship(poRef, { carrier, tracking, shipped_at, scans = [] } = {}) {
        const po = this.require(poRef);
        if (!carrier) throw new Error('carrier is required to record a shipment');
        if (!tracking) throw new Error('tracking number is required to record a shipment');
        const at = this.now();
        const next = transitionPo({ ...po, carrier: String(carrier).toUpperCase() }, 'shipped', { at, actor: 'carrier' });
        next.tracking = {
            number: String(tracking),
            carrier: String(carrier).toUpperCase(),
            shipped_at: shipped_at ? iso(shipped_at) : iso(at),
            scans
        };
        return this.save(next, 'shipped', { carrier: next.carrier, tracking: next.tracking.number });
    }

    deliver(poRef, { evidence, receipt, invoice } = {}) {
        const po = this.require(poRef);
        if (!['shipped', 'on_hold'].includes(po.status)) {
            throw new Error(`PO ${poRef} must be shipped before delivery (status ${po.status})`);
        }
        if (!evidence) throw new Error('delivery evidence is required');
        const at = this.now();
        const check = validateDeliveryEvidence(po, evidence, { now: at });
        let next = { ...po, delivery: { ...evidence, recorded_at: iso(at) } };
        if (check.ok) {
            next = transitionPo(next, 'delivered', { at, actor: 'carrier' });
        } else {
            next = holdPo(next, check.holds, at, 'verification');
        }
        next = this.save(next, check.ok ? 'delivered' : 'delivery_hold', { holds: check.holds });
        if (check.ok && receipt && invoice) {
            return this.verify(poRef, { receipt, invoice });
        }
        return { po: next, ok: check.ok, holds: check.holds, checks: check.checks };
    }

    verify(poRef, { evidence, receipt, invoice } = {}) {
        const po = this.require(poRef);
        if (!['delivered', 'on_hold'].includes(po.status)) {
            throw new Error(`PO ${poRef} must be delivered before verification (status ${po.status})`);
        }
        const at = this.now();
        const deliveryEvidence = evidence || po.delivery;
        if (!deliveryEvidence) throw new Error('No delivery evidence recorded for this PO');

        const evidenceCheck = validateDeliveryEvidence(po, deliveryEvidence, { now: at });
        const checks = [...evidenceCheck.checks];
        const holds = [...evidenceCheck.holds];

        if (!receipt) holds.push({ code: 'HOLD_MISSING_GOODS_RECEIPT', detail: 'a goods receipt is required for the 3-way match' });
        if (!invoice) holds.push({ code: 'HOLD_MISSING_INVOICE', detail: 'a supplier invoice is required for the 3-way match' });
        let match = null;
        if (receipt && invoice) {
            match = threeWayMatch(po, { receipt, invoice, now: at });
            checks.push(...match.checks);
            holds.push(...match.holds);
        }

        if (holds.length) {
            const next = holdPo(po, holds, at, 'verification');
            next.verification = { ok: false, at: iso(at), holds, checks, match };
            return {
                po: this.save(next, 'verification_failed', { holds: holds.map(hold => hold.code) }),
                ok: false,
                holds,
                checks
            };
        }

        const next = transitionPo(po, 'verified', { at, actor: 'verification' });
        next.verification = { ok: true, at: iso(at), holds: [], checks, match };
        return { po: this.save(next, 'verified', { checks: checks.length }), ok: true, holds: [], checks };
    }

    close(poRef) {
        const po = this.require(poRef);
        return this.save(transitionPo(po, 'closed', { at: this.now(), actor: 'operator' }), 'closed');
    }

    /** Ingest carrier scans; advances draft → placed → shipped → delivered. */
    ingestTracking(payload) {
        const parsed = parseAmanaScans(payload);
        const poRef = payload?.po_ref
            || this.store.listPos().find(po => po.tracking?.number === parsed.tracking)?.po_ref;
        if (!poRef) throw new Error(`No PO matches tracking ${parsed.tracking || '(missing)'}`);
        let po = this.require(poRef);
        if (po.status === 'draft') po = this.place(po.po_ref, { actor: 'tracking' });
        if (parsed.shipment && po.status === 'placed') {
            po = this.ship(po.po_ref, {
                carrier: parsed.carrier,
                tracking: parsed.tracking,
                shipped_at: parsed.shipment.shipped_at,
                scans: parsed.scans
            });
        }
        let delivery = null;
        if (parsed.delivery && po.status === 'shipped') {
            delivery = this.deliver(po.po_ref, { evidence: parsed.delivery });
            po = delivery.po;
        }
        return { po, shipment: parsed.shipment, delivery, scans: parsed.scans };
    }

    status() {
        return buildProcurementReport(this.list(), { now: this.now() });
    }
}

export default ProcurementAgent;
