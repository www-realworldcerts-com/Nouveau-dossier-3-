/**
 * AMANA scan adapter. AMANA (the Moroccan last-mile carrier used for the Temu
 * order) has no public tracking API in this repository, so the agent ingests the
 * scan records the operator or a scraper supplies. The adapter normalizes
 * PICKUP/HUB/DELIVER scans into a shipment and a delivery-evidence object.
 */

const DELIVERY_STATUS = /^(DELIVER|DELIVERED|LIVRE|LIVRÉ)$/i;
const PICKUP_STATUS = /^(PICKUP|COLLECT|ENLEV|ENLEVÉ|EXPEDIE|EXPÉDIÉ)$/i;

function parseTime(value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function parseAmanaScans(input) {
    const payload = Array.isArray(input) ? { scans: input } : (input || {});
    const scans = (payload.scans || []).map(scan => ({
        status: String(scan.status || scan.event || '').toUpperCase(),
        at: parseTime(scan.at || scan.timestamp),
        location: scan.location || null,
        signed_by: scan.signed_by || scan.receiver || null,
        weight_kg: Number.isFinite(Number(scan.weight_kg)) ? Number(scan.weight_kg) : null,
        destination_city: scan.destination_city || null,
        pod_reference: scan.pod_reference || null
    }));
    const tracking = payload.tracking || scans.find(scan => scan.tracking)?.tracking || null;
    const pickup = scans.find(scan => PICKUP_STATUS.test(scan.status));
    const delivered = scans.find(scan => DELIVERY_STATUS.test(scan.status));

    return {
        carrier: String(payload.carrier || 'AMANA').toUpperCase(),
        tracking: tracking ? String(tracking) : null,
        scans,
        shipment: pickup ? { shipped_at: pickup.at, scans } : null,
        delivery: delivered
            ? {
                shipped_at: pickup?.at || null,
                delivered_at: delivered.at,
                destination_city: delivered.destination_city || delivered.location,
                weight_kg: delivered.weight_kg,
                pod_reference: delivered.pod_reference || payload.pod_reference || null,
                signed_by: delivered.signed_by
            }
            : null
    };
}

export default parseAmanaScans;
