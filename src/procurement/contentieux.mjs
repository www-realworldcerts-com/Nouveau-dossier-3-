import { buildProcurementReport } from './po.mjs';

/**
 * Contentieux (dispute) case files for purchase orders that are late, held or
 * delivered without the evidence needed to verify them.
 *
 * The module deliberately does not invent proof: a case lists what is missing
 * so the owner can obtain it from the supplier or carrier before any claim is
 * filed. Amounts are in MAD, the PO currency.
 */

const EVIDENCE = {
    placed: [
        { id: 'supplier_order_confirmation', label: 'Supplier order confirmation', present: () => false },
        { id: 'carrier_tracking', label: 'Carrier name and tracking number', present: () => false },
        { id: 'shipment_scan', label: 'Pickup or hub scan', present: () => false }
    ],
    shipped: [
        { id: 'carrier_pod', label: 'Carrier-prefixed proof of delivery', present: po => Boolean(po.delivery?.pod_reference) },
        { id: 'delivered_weight', label: 'Delivered weight in kg', present: po => Number(po.delivery?.weight_kg) > 0 },
        { id: 'destination_city', label: 'Destination city matching the PO', present: po => Boolean(po.delivery?.destination_city) },
        { id: 'delivery_timestamp', label: 'Delivery timestamp after shipment', present: po => Boolean(po.delivery?.delivered_at) }
    ],
    delivered: [
        { id: 'carrier_pod', label: 'Carrier-prefixed proof of delivery', present: po => Boolean(po.delivery?.pod_reference) },
        { id: 'delivered_weight', label: 'Delivered weight in kg', present: po => Number(po.delivery?.weight_kg) > 0 },
        { id: 'destination_city', label: 'Destination city matching the PO', present: po => Boolean(po.delivery?.destination_city) },
        { id: 'delivery_timestamp', label: 'Delivery timestamp after shipment', present: po => Boolean(po.delivery?.delivered_at) },
        { id: 'goods_receipt', label: 'Goods receipt with a named confirmer', present: () => false },
        { id: 'supplier_invoice', label: 'Supplier invoice for the PO', present: () => false },
        { id: 'three_way_match', label: 'PO vs receipt vs invoice match', present: () => false }
    ],
    on_hold: [
        { id: 'hold_resolution', label: 'Evidence resolving every hold code', present: () => false },
        { id: 'goods_receipt', label: 'Goods receipt with a named confirmer', present: () => false },
        { id: 'supplier_invoice', label: 'Supplier invoice for the PO', present: () => false }
    ]
};

const HOLD_MEANING = {
    HOLD_NO_REAL_DELIVERY_PROOF_HASH: 'carrier POD reference is missing or not carrier-prefixed',
    HOLD_WEIGHT_BELOW_MIN: 'delivered weight is below the expected minimum',
    HOLD_CITY_MISMATCH: 'destination city does not match the recipient city',
    HOLD_TIMELINE_INCONSISTENT: 'shipment predates the PO',
    HOLD_DELIVERY_BEFORE_SHIPMENT: 'delivery timestamp is before shipment',
    HOLD_FUTURE_DELIVERY: 'delivery timestamp is in the future',
    HOLD_MISSING_GOODS_RECEIPT: 'goods receipt is missing',
    HOLD_MISSING_INVOICE: 'supplier invoice is missing',
    HOLD_PO_REF_MISMATCH: 'receipt or invoice belongs to another PO',
    HOLD_QUANTITY_MISMATCH: 'received quantity differs from the PO',
    HOLD_INVOICE_TOTAL_MISMATCH: 'invoice total differs from the PO',
    HOLD_RECEIPT_CONFIRMER_INVALID: 'receipt confirmer is a placeholder',
    HOLD_RECEIPT_BEFORE_SHIPMENT: 'goods receipt predates shipment'
};

function round(value, places = 2) {
    const factor = 10 ** places;
    return Math.round(value * factor) / factor;
}

function severityOf({ amount, waitingDays, status }) {
    if (status === 'on_hold' || amount >= 2000 || waitingDays >= 30) return 'high';
    if (amount >= 500 || waitingDays >= 14) return 'medium';
    return 'low';
}

/**
 * Build dispute cases from the latest PO snapshots.
 * On-hold POs are always included; other statuses only after `minDays`.
 */
export function buildContentieuxCases(pos, { now = new Date(), minDays = 7 } = {}) {
    const at = now instanceof Date ? now : new Date(now);
    const report = buildProcurementReport(pos, { now: at });
    const byRef = new Map(pos.map(po => [po.po_ref, po]));
    const threshold = Number.isFinite(Number(minDays)) ? Number(minDays) : 7;

    const cases = report.outstanding
        .filter(row => row.status === 'on_hold' || row.waiting_days >= threshold)
        .map(row => {
            const po = byRef.get(row.po_ref) || {};
            const checklist = (EVIDENCE[row.status] || EVIDENCE.placed).map(item => ({
                id: item.id,
                label: item.label,
                present: Boolean(item.present(po))
            }));
            return {
                case_id: `CTX-${row.po_ref}`,
                po_ref: row.po_ref,
                supplier: row.supplier,
                recipient: row.recipient,
                amount_mad: Number(row.subtotal_mad) || 0,
                status: row.status,
                waiting_days: row.waiting_days,
                opened_at: po.placed_at || po.created_at || null,
                severity: severityOf({
                    amount: Number(row.subtotal_mad) || 0,
                    waitingDays: row.waiting_days,
                    status: row.status
                }),
                holds: row.holds.map(code => ({ code, meaning: HOLD_MEANING[code] || 'unrecognised hold' })),
                evidence: checklist,
                missing_evidence: checklist.filter(item => !item.present).map(item => item.id),
                next_action: row.next_action,
                recommended: row.status === 'on_hold'
                    ? 'Send the supplier a written claim with the hold codes and request replacement or refund; keep the PO open.'
                    : 'Request the missing evidence from the supplier or carrier before filing a claim; do not close the PO.'
            };
        })
        .sort((a, b) => {
            const rank = { high: 0, medium: 1, low: 2 };
            return rank[a.severity] - rank[b.severity] || b.waiting_days - a.waiting_days;
        });

    return {
        generated_at: at.toISOString(),
        min_days: threshold,
        total_pos: report.total_pos,
        cases,
        totals: {
            cases: cases.length,
            amount_mad: round(cases.reduce((sum, item) => sum + item.amount_mad, 0)),
            high: cases.filter(item => item.severity === 'high').length
        }
    };
}

function formatDate(value) {
    if (!value) return 'unknown';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString().slice(0, 10);
}

/** Render the report as a printable Markdown case file. */
export function renderContentieuxMarkdown(report) {
    const lines = [
        '# Procurement contentieux — open delivery cases',
        '',
        `Generated: ${report.generated_at}`,
        `POs recorded: ${report.total_pos}; cases: ${report.totals.cases}; amount at stake: ${report.totals.amount_mad} MAD; high severity: ${report.totals.high}`,
        '',
        'This is an operational case file, not legal advice. Never record a delivery without carrier proof and a 3-way match.',
        ''
    ];

    if (!report.cases.length) {
        lines.push('No PO meets the dispute threshold.');
        return lines.join('\n');
    }

    lines.push('| Case | PO | Supplier | Amount MAD | Status | Waiting | Severity |');
    lines.push('| --- | --- | --- | ---: | --- | ---: | --- |');
    for (const item of report.cases) {
        lines.push(`| ${item.case_id} | ${item.po_ref} | ${item.supplier} | ${item.amount_mad.toFixed(2)} | ${item.status} | ${item.waiting_days}d | ${item.severity} |`);
    }

    for (const item of report.cases) {
        lines.push('', `## ${item.case_id}`, '');
        lines.push(`- PO: ${item.po_ref}`);
        lines.push(`- Supplier: ${item.supplier}`);
        lines.push(`- Recipient: ${item.recipient || 'unknown'}`);
        lines.push(`- Amount: ${item.amount_mad.toFixed(2)} MAD`);
        lines.push(`- Opened: ${formatDate(item.opened_at)}; waiting ${item.waiting_days} days`);
        lines.push(`- Status: ${item.status}; severity: ${item.severity}`);
        if (item.holds.length) {
            lines.push('- Holds:');
            for (const hold of item.holds) lines.push(`  - ${hold.code}: ${hold.meaning}`);
        }
        lines.push('- Evidence checklist:');
        for (const evidence of item.evidence) {
            lines.push(`  - [${evidence.present ? 'x' : ' '}] ${evidence.label} (${evidence.id})`);
        }
        lines.push(`- Next action: ${item.next_action || 'review the PO'}`);
        lines.push(`- Recommended: ${item.recommended}`);
    }

    return lines.join('\n');
}

export default buildContentieuxCases;
