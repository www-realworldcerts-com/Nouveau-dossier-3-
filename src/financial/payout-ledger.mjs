import fs from 'node:fs';
import path from 'node:path';

/**
 * Persistent payout ledger.
 *
 * Every exported payout is recorded as `submitted`; a later bank/Payoneer
 * confirmation moves it to `credited`. The ledger is keyed by both earning_id
 * and item_id so a batch that reuses either identifier can never be exported.
 *
 * Historical payout batches are also scanned (read-only) because the ledger
 * only knows about exports made after it existed. That is deliberately
 * conservative: an identifier that appears in any batch is treated as already
 * committed.
 */

export const LEDGER_VERSION = 1;
export const DEFAULT_LEDGER_FILE = path.join('data', 'financial', 'payout_ledger.json');
export const DEFAULT_HISTORY_DIR = path.join('data', 'autonomous', 'ledger');

export class PayoutLedgerConflictError extends Error {
    constructor(conflicts) {
        const summary = conflicts
            .slice(0, 5)
            .map(conflict => `${conflict.kind}:${conflict.value} (${conflict.source}${conflict.batch_id ? ` ${conflict.batch_id}` : ''})`)
            .join(', ');
        super(`Refusing payout export: ${conflicts.length} identifier(s) already recorded — ${summary}`);
        this.name = 'PayoutLedgerConflictError';
        this.code = 'PAYOUT_ALREADY_EXPORTED';
        this.conflicts = conflicts;
    }
}

export function emptyLedger() {
    return {
        version: LEDGER_VERSION,
        updated_at: null,
        items: {},
        statement_imports: {}
    };
}

function normalizeLedger(value) {
    if (!value || typeof value !== 'object') return emptyLedger();
    const items = value.items && typeof value.items === 'object' && !Array.isArray(value.items)
        ? value.items
        : {};
    return {
        version: LEDGER_VERSION,
        updated_at: value.updated_at || null,
        items,
        statement_imports: value.statement_imports && typeof value.statement_imports === 'object'
            ? value.statement_imports
            : {}
    };
}

export function loadPayoutLedger(file) {
    const resolved = path.resolve(file);
    if (!fs.existsSync(resolved)) return emptyLedger();
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    return normalizeLedger(parsed);
}

/** Write through a temp file so a crash cannot leave a half-written ledger. */
export function savePayoutLedger(file, ledger) {
    const resolved = path.resolve(file);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const payload = {
        version: LEDGER_VERSION,
        updated_at: new Date().toISOString(),
        items: ledger.items,
        statement_imports: ledger.statement_imports || {}
    };
    const tmp = `${resolved}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
    fs.renameSync(tmp, resolved);
    return normalizeLedger(payload);
}

function identifiers(entry) {
    const result = [];
    const earning = String(entry.earning_id ?? '').trim();
    const item = String(entry.item_id ?? '').trim();
    if (earning) result.push({ kind: 'earning', value: earning });
    if (item) result.push({ kind: 'item', value: item });
    return result;
}

/** Every identifier a single exported row must reserve. */
export function payoutIdentifiers(entry) {
    return identifiers(entry);
}

/**
 * Scan existing payout batch files without loading them into the ledger.
 * Returns Map<"earning:<id>"|"item:<id>", {batch_id, amount, currency}>.
 */
export function readPayoutHistory(directory = DEFAULT_HISTORY_DIR, { excludeBatchId = null } = {}) {
    const history = new Map();
    const resolved = path.resolve(directory);
    if (!fs.existsSync(resolved)) return history;

    for (const name of fs.readdirSync(resolved)) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(resolved, name);
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            continue;
        }
        const batch = parsed?.data && Array.isArray(parsed.data.items) ? parsed.data : parsed;
        if (!batch || !Array.isArray(batch.items)) continue;
        const batchId = batch.batch_id || parsed?.id || name.replace(/\.json$/, '');
        if (excludeBatchId && String(batchId) === String(excludeBatchId)) continue;
        for (const item of batch.items) {
            for (const identifier of identifiers(item)) {
                const key = `${identifier.kind}:${identifier.value}`;
                if (!history.has(key)) {
                    history.set(key, {
                        batch_id: batchId,
                        amount: Number(item.amount) || 0,
                        currency: item.currency || batch.currency || null
                    });
                }
            }
        }
    }
    return history;
}

/**
 * Find identifiers already present in the ledger or the historical batches.
 * Duplicates inside the same batch are also rejected.
 */
export function findPayoutConflicts(entries, { ledger = emptyLedger(), history = new Map() } = {}) {
    const conflicts = [];
    const seen = new Map();

    for (const entry of entries) {
        const ids = identifiers(entry);
        if (!ids.length) {
            throw new Error(`Payout ${entry.item_id || entry.earning_id || '(unknown)'} has no earning_id or item_id`);
        }
        for (const identifier of ids) {
            const key = `${identifier.kind}:${identifier.value}`;
            if (seen.has(key)) {
                conflicts.push({
                    kind: identifier.kind,
                    value: identifier.value,
                    source: 'batch',
                    batch_id: entry.batch_id || null
                });
                continue;
            }
            seen.set(key, entry);

            const recorded = Object.values(ledger.items || {}).find(item =>
                String(item[`${identifier.kind}_id`] ?? '') === identifier.value
            );
            if (recorded) {
                conflicts.push({
                    kind: identifier.kind,
                    value: identifier.value,
                    source: 'ledger',
                    batch_id: recorded.batch_id || null,
                    status: recorded.status || null
                });
                continue;
            }

            const historical = history.get(key);
            if (historical) {
                conflicts.push({
                    kind: identifier.kind,
                    value: identifier.value,
                    source: 'history',
                    batch_id: historical.batch_id || null
                });
            }
        }
    }

    return conflicts;
}

/**
 * Record exported rows as submitted. Returns a new ledger, leaving the input
 * untouched so a caller can save it atomically.
 */
export function recordSubmitted(ledger, entries, { batchId, csvFile = null, at = new Date() } = {}) {
    const next = normalizeLedger(ledger);
    const stamp = new Date(at).toISOString();
    const items = { ...next.items };

    for (const entry of entries) {
        const earningId = String(entry.earning_id ?? '').trim() || null;
        const itemId = String(entry.item_id ?? '').trim() || null;
        const payoutKey = earningId || itemId;
        if (!payoutKey) throw new Error('Cannot record a payout without an earning_id or item_id');
        items[payoutKey] = {
            payout_key: payoutKey,
            earning_id: earningId,
            item_id: itemId,
            batch_id: batchId,
            amount: Number(entry.amount),
            currency: entry.currency,
            reference: entry.reference,
            description: entry.description ?? null,
            status: 'submitted',
            submitted_at: stamp,
            credited_at: null,
            bank_reference: null,
            csv_file: csvFile
        };
    }

    return {
        version: LEDGER_VERSION,
        updated_at: stamp,
        items,
        statement_imports: next.statement_imports
    };
}

/**
 * Mark a submitted payout as credited. Accepts the earning_id, item_id or
 * payout_key. Marking an already-credited payout is idempotent.
 */
export function markCredited(ledger, reference, { at = new Date(), bankReference = null } = {}) {
    const next = normalizeLedger(ledger);
    const wanted = String(reference ?? '').trim();
    if (!wanted) throw new Error('A payout reference is required');
    const byKey = Object.values(next.items).filter(item => item.payout_key === wanted);
    const found = byKey.length
        ? byKey
        : Object.values(next.items).filter(item =>
            String(item.earning_id ?? '') === wanted || String(item.item_id ?? '') === wanted
        );
    if (found.length !== 1) {
        throw new Error(found.length
            ? `Payout reference ${wanted} is ambiguous`
            : `Payout ${wanted} is not in the ledger`);
    }
    const item = found[0];
    if (item.status === 'credited') return next;

    const stamp = new Date(at).toISOString();
    return {
        version: LEDGER_VERSION,
        updated_at: stamp,
        items: {
            ...next.items,
            [item.payout_key]: {
                ...item,
                status: 'credited',
                credited_at: stamp,
                bank_reference: bankReference || item.bank_reference || null
            }
        },
        statement_imports: next.statement_imports
    };
}

export function summarizeLedger(ledger) {
    const items = Object.values(ledger?.items || {});
    const count = status => items.filter(item => item.status === status).length;
    return {
        total: items.length,
        submitted: count('submitted'),
        credited: count('credited'),
        failed: count('failed'),
        returned: count('returned')
    };
}
