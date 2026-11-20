/**
 * What may be called verified revenue.
 *
 * A revenue event is verified only when the money can be traced to a payment
 * provider transaction id, a bank/Payoneer reference or an on-chain transfer.
 * An id the system produced about itself — `autonomous_execution`, a `PROOF_*`
 * id, a local `LIVE_*` event id, a settlement batch — is not evidence, and an
 * event carrying one is reported as unverified rather than counted as revenue.
 */

const SELF_ISSUED_TYPES = new Set([
    'autonomous_execution',
    'autonomous',
    'self',
    'self_issued',
    'generated',
    'synthetic',
    'simulation',
    'mock'
]);

/** The id shapes a provider actually issues. Anything else is not a receipt. */
const PROVIDER_PATTERNS = [
    ['crypto', /^(?:0x)?[a-f0-9]{64}$/i],
    ['stripe', /^(?:pi|ch|txn|re|py|in)_[A-Za-z0-9]{6,}$/],
    ['paypal', /^[A-Z0-9]{17}$/],
    ['payoneer', /^\d{8,24}$/],
    ['bank', /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/]
];

const VERIFIED_STATUSES = new Set(['verified', 'confirmed', 'settled', 'paid_out', 'paid', 'completed']);

/** Statuses that claim the money is real and so require provider evidence. */
export function detailProvider(value) {
    const id = String(value ?? '').trim();
    if (!id) return null;
    for (const [provider, test] of PROVIDER_PATTERNS) {
        if (test.test(id)) return { provider, psp_id: id };
    }
    return null;
}

export function isProviderTransactionId(value) {
    return Boolean(detailProvider(value));
}

function looksSelfIssued(id, type) {
    if (SELF_ISSUED_TYPES.has(String(type || '').trim().toLowerCase())) return true;
    return /^(?:PROOF|SELF|AUTO|SIM|MOCK|SYNTH)[_-]/i.test(String(id || '').trim());
}

/**
 * Classify one `verification_proof` object.
 * Returns `{ verified, reason, provider, psp_id }` and never throws.
 */
export function classifyRevenueProof(proof) {
    if (!proof || typeof proof !== 'object') {
        return { verified: false, reason: 'proof_missing', provider: null, psp_id: null };
    }
    const type = String(proof.type || '').trim();
    const id = String(proof.psp_id ?? proof.tx_hash ?? '').trim();
    if (!id) {
        return { verified: false, reason: 'psp_id_missing', provider: null, psp_id: null };
    }
    if (looksSelfIssued(id, type)) {
        return { verified: false, reason: 'self_issued_proof', provider: null, psp_id: id };
    }
    const provider = detailProvider(id);
    if (!provider) {
        return { verified: false, reason: 'psp_id_not_provider_transaction', provider: null, psp_id: id };
    }
    return { verified: true, reason: null, provider: provider.provider, psp_id: id };
}

const METADATA_ID_FIELDS = [
    'psp_transaction_id',
    'paypal_transaction_id',
    'transaction_id',
    'bank_reference',
    'bank_ref',
    'tx_hash'
];

/**
 * The verification state of a revenue event. Provider ids in metadata win over
 * a proof object, and a self-issued proof is reported as such rather than
 * treated as missing evidence.
 */
export function verifyRevenueEvent({ metadata = {}, verification_proof: proof = null } = {}) {
    const meta = metadata && typeof metadata === 'object' ? metadata : {};
    for (const field of METADATA_ID_FIELDS) {
        const raw = meta[field];
        if (!raw) continue;
        const provider = detailProvider(raw);
        if (provider) {
            return { verified: true, reason: null, provider: provider.provider, psp_id: provider.psp_id, source: field };
        }
    }
    const candidate = proof || meta.verification_proof || null;
    const classified = candidate
        ? classifyRevenueProof(candidate)
        : { verified: false, reason: 'no_provider_transaction_id', provider: null, psp_id: null };
    const present = METADATA_ID_FIELDS.map(field => [field, meta[field]]).filter(([, value]) => value);
    if (!classified.verified && present.length && classified.reason === 'no_provider_transaction_id') {
        return { ...classified, reason: 'psp_id_not_provider_transaction', psp_id: String(present[0][1]), source: present[0][0] };
    }
    return { ...classified, source: candidate ? 'verification_proof' : null };
}

export function classifyRevenueEvent(event = {}) {
    return verifyRevenueEvent({
        metadata: event?.metadata,
        verification_proof: event?.verification_proof ?? event?.metadata?.verification_proof
    });
}

/**
 * The status an unverified event may carry. A claim of VERIFIED (or settled,
 * paid out, completed) becomes UNVERIFIED; a blank status keeps the existing
 * HALLUCINATION demotion; an honest intermediate status is left alone.
 */
export function demoteUnverifiedStatus(status) {
    const raw = status == null ? '' : String(status).trim();
    if (!raw) return { status: 'hallucination', changed: true };
    if (VERIFIED_STATUSES.has(raw.toLowerCase())) {
        return { status: 'UNVERIFIED', changed: raw !== 'UNVERIFIED' };
    }
    return { status: raw, changed: false };
}

/** Verified vs unverified totals, so an audit never sums the system's own output. */
export function summarizeRevenueEvents(events = []) {
    const byCurrency = new Map();
    const reasons = {};
    let verified = 0;
    let unverified = 0;

    for (const event of events) {
        const verdict = classifyRevenueEvent(event);
        const amount = Number(event?.amount ?? 0) || 0;
        const currency = String(event?.currency || 'USD').toUpperCase();
        if (verdict.verified) verified += 1;
        else {
            unverified += 1;
            reasons[verdict.reason] = (reasons[verdict.reason] || 0) + 1;
        }
        const bucket = byCurrency.get(currency) || { currency, verified: 0, unverified: 0 };
        bucket[verdict.verified ? 'verified' : 'unverified'] += amount;
        byCurrency.set(currency, bucket);
    }

    return {
        events: events.length,
        verified,
        unverified,
        reasons,
        by_currency: [...byCurrency.values()]
    };
}
