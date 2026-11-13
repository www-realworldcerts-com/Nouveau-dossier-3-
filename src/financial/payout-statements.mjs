import crypto from 'node:crypto';

/**
 * Bank/Payoneer statement import for submitted payouts.
 *
 * Statements are matched to ledger entries by an explicit reference first and
 * only then by amount + currency + date window. A row is never guessed onto a
 * payout when more than one candidate fits. Fees and FX data are stored on the
 * settlement so the credited amount can be reconciled rather than assumed.
 */

const FIELD_ALIASES = {
    date: ['date', 'date operation', 'date valeur', 'operation date', 'transaction date', 'date de l operation'],
    reference: ['reference id', 'reference', 'ref', 'reference operation', 'libelle reference', 'transaction reference', 'external transaction id', 'payout id', 'id transaction', 'transaction id'],
    description: ['description', 'libelle', 'libelle operation', 'details', 'memo', 'narrative', 'note'],
    amount: ['amount', 'montant', 'transaction amount', 'montant operation'],
    credit: ['credit', 'credit amount', 'montant credit'],
    debit: ['debit', 'debit amount', 'montant debit'],
    currency: ['currency', 'devise', 'monnaie'],
    fee: ['fee', 'fees', 'frais', 'commission', 'frais bancaires'],
    status: ['status', 'statut', 'etat', 'transaction status'],
    type: ['type', 'transaction type', 'operation type', 'type operation'],
    fxRate: ['fx rate', 'taux de change', 'exchange rate', 'rate'],
    netAmount: ['net amount', 'montant net', 'net'],
    transactionId: ['id', 'transaction id', 'transaction number', 'numero operation']
};

function normalize(value) {
    return String(value ?? '')
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function normalizeAll(list) {
    return list.map(normalize);
}

function detectDelimiter(text) {
    const firstLine = String(text).split(/\r?\n/, 1)[0] || '';
    const counts = { ';': 0, '\t': 0, ',': 0 };
    let quoted = false;
    for (const char of firstLine) {
        if (char === '"') quoted = !quoted;
        if (!quoted && char in counts) counts[char] += 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

/** RFC4180-ish CSV parser with delimiter detection and quoted newlines. */
export function parseCsv(text, { delimiter = null } = {}) {
    const input = String(text ?? '').replace(/^\uFEFF/, '');
    const sep = delimiter || detectDelimiter(input);
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;

    for (let i = 0; i < input.length; i += 1) {
        const char = input[i];
        if (quoted) {
            if (char === '"' && input[i + 1] === '"') {
                field += '"';
                i += 1;
            } else if (char === '"') {
                quoted = false;
            } else {
                field += char;
            }
            continue;
        }
        if (char === '"') {
            quoted = true;
            continue;
        }
        if (char === sep) {
            row.push(field);
            field = '';
            continue;
        }
        if (char === '\n' || char === '\r') {
            if (char === '\r' && input[i + 1] === '\n') i += 1;
            row.push(field);
            field = '';
            if (row.some(cell => cell.trim() !== '')) rows.push(row);
            row = [];
            continue;
        }
        field += char;
    }
    row.push(field);
    if (row.some(cell => cell.trim() !== '')) rows.push(row);

    if (!rows.length) return [];
    const headers = rows[0].map(header => header.trim());
    return rows.slice(1).map(cells => Object.fromEntries(
        headers.map((header, index) => [header, cells[index] ?? ''])
    ));
}

export function parseAmount(raw) {
    if (typeof raw === 'number') return raw;
    let value = String(raw ?? '').trim();
    if (!value) return NaN;
    const negative = /^\(.*\)$/.test(value) || /^-/.test(value);
    value = value.replace(/[^\d.,-]/g, '');
    if (!value) return NaN;
    if (value.includes(',') && value.includes('.')) {
        value = value.lastIndexOf(',') > value.lastIndexOf('.')
            ? value.replace(/\./g, '').replace(',', '.')
            : value.replace(/,/g, '');
    } else if (value.includes(',')) {
        const parts = value.split(',');
        value = parts.length === 2 && parts[1].length <= 2
            ? `${parts[0]}.${parts[1]}`
            : value.replace(/,/g, '');
    }
    value = value.replace(/^-/, '');
    const number = Number(value);
    if (!Number.isFinite(number)) return NaN;
    return negative ? -number : number;
}

/** Parse common statement dates; source decides ambiguous DD/MM vs MM/DD. */
export function parseStatementDate(raw, { source = 'attijari' } = {}) {
    const value = String(raw ?? '').trim();
    if (!value) return null;
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
    }
    const match = value.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
    if (!match) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
    }
    let [, first, second, year] = match;
    year = year.length === 2 ? `20${year}` : year;
    let day = Number(first);
    let month = Number(second);
    if (day > 12 && month <= 12) {
        // day-first is the only valid reading
    } else if (month > 12 && day <= 12) {
        [day, month] = [month, day];
    } else if (source === 'payoneer') {
        [day, month] = [month, day];
    }
    const date = new Date(Date.UTC(Number(year), month - 1, day));
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function findHeader(headers, field, mapping = {}) {
    if (mapping[field]) {
        const wanted = normalize(mapping[field]);
        return headers.find(header => normalize(header) === wanted) || null;
    }
    const aliases = normalizeAll(FIELD_ALIASES[field] || []);
    for (const alias of aliases) {
        const header = headers.find(candidate => normalize(candidate) === alias);
        if (header) return header;
    }
    return null;
}

function classifyStatus({ status, type, description, amount }) {
    const text = normalize(`${status} ${type} ${description}`);
    if (/\b(returned|return|reversal|reversed|retour|rembourse|refund|chargeback)\b/.test(text)) return 'returned';
    if (/\b(failed|failure|rejected|refused|refus|echec|cancelled|canceled|annule|declined)\b/.test(text)) return 'failed';
    if (/\b(credited|completed|complete|success|successful|settled|effectue|recu)\b/.test(text)) return 'credited';
    return amount > 0 ? 'credited' : 'outgoing';
}

function fingerprintOf(tx, source) {
    return crypto.createHash('sha256')
        .update(JSON.stringify({
            source,
            date: tx.date,
            reference: tx.reference,
            amount: tx.amount,
            currency: tx.currency,
            status: tx.status,
            description: tx.description
        }))
        .digest('hex');
}

/**
 * Turn raw statement rows into normalized transactions. Supports CSV rows or
 * already-parsed objects, with an optional header mapping override.
 */
export function normalizeTransactions(rows, {
    source = 'attijari',
    mapping = {},
    defaultCurrency = null
} = {}) {
    if (!Array.isArray(rows) || !rows.length) {
        return { transactions: [], columns: {}, issues: [] };
    }
    const headers = Object.keys(rows[0]);
    const columns = {};
    for (const field of Object.keys(FIELD_ALIASES)) {
        columns[field] = findHeader(headers, field, mapping);
    }
    if (!columns.amount && !columns.credit && !columns.debit) {
        throw new Error('Statement has no amount, credit or debit column');
    }

    const issues = [];
    const transactions = [];
    rows.forEach((row, index) => {
        const pick = field => (columns[field] ? row[columns[field]] : undefined);
        const amountField = parseAmount(pick('amount'));
        const credit = parseAmount(pick('credit'));
        const debit = parseAmount(pick('debit'));
        let amount = Number.isFinite(amountField) && amountField !== 0
            ? amountField
            : (Number.isFinite(credit) && credit !== 0 ? credit : -Math.abs(debit || 0));
        if (!Number.isFinite(amount) || amount === 0) {
            issues.push({ line: index + 2, reason: 'unreadable amount', raw: pick('amount') });
            return;
        }
        const currency = String(pick('currency') || defaultCurrency || '').toUpperCase() || null;
        const status = classifyStatus({
            status: pick('status'),
            type: pick('type'),
            description: `${pick('description') || ''} ${pick('reference') || ''}`,
            amount
        });
        const fee = Math.abs(parseAmount(pick('fee')) || 0);
        const net = parseAmount(pick('netAmount'));
        const fxRate = parseAmount(pick('fxRate'));
        const reference = String(pick('reference') || pick('transactionId') || '').trim() || null;
        const transactionId = String(pick('transactionId') || '').trim() || null;
        const date = parseStatementDate(pick('date'), { source });
        if (!date) issues.push({ line: index + 2, reason: 'unreadable date', raw: pick('date') });

        const tx = {
            line: index + 2,
            date,
            reference,
            transaction_id: transactionId,
            description: String(pick('description') || '').trim() || null,
            amount,
            currency,
            fee: Number.isFinite(fee) ? fee : 0,
            net_amount: Number.isFinite(net) ? net : null,
            fx_rate: Number.isFinite(fxRate) ? fxRate : null,
            status
        };
        tx.fingerprint = fingerprintOf(tx, source);
        transactions.push(tx);
    });

    return { transactions, columns, issues };
}

function payoutReferences(item) {
    return [item.reference, item.item_id, item.earning_id, item.payout_key]
        .map(value => String(value ?? '').trim())
        .filter(Boolean);
}

function withinWindow(txDate, submittedAt, days) {
    if (!txDate || !submittedAt) return true;
    const tx = Date.parse(txDate);
    const submitted = Date.parse(submittedAt);
    if (!Number.isFinite(tx) || !Number.isFinite(submitted)) return true;
    return Math.abs(tx - submitted) <= days * 86400000;
}

function explicitMatches(tx, items) {
    const haystack = normalize(`${tx.reference || ''} ${tx.description || ''}`);
    if (!haystack) return [];
    return items.filter(item => payoutReferences(item).some(reference => {
        const needle = normalize(reference);
        return needle.length >= 3 && haystack.includes(needle);
    }));
}

function amountMatches(tx, items, { dateWindowDays, tolerance }) {
    if (tx.status !== 'credited' || tx.amount <= 0) return [];
    return items.filter(item =>
        item.status === 'submitted' &&
        String(item.currency || '').toUpperCase() === String(tx.currency || '').toUpperCase() &&
        Math.abs(Number(item.amount) - tx.amount) <= tolerance &&
        withinWindow(tx.date, item.submitted_at, dateWindowDays)
    );
}

function uniqueByPayout(items) {
    return [...new Map(items.map(item => [item.payout_key, item])).values()];
}

function findMatch(tx, ledger, options) {
    const items = Object.values(ledger.items || {});
    const explicit = uniqueByPayout(explicitMatches(tx, items));
    if (explicit.length === 1) return { item: explicit[0], method: 'reference' };
    if (explicit.length > 1) return { ambiguous: explicit, method: 'reference' };

    const byAmount = uniqueByPayout(amountMatches(tx, items, options));
    if (byAmount.length === 1) return { item: byAmount[0], method: 'amount_date' };
    if (byAmount.length > 1) return { ambiguous: byAmount, method: 'amount_date' };
    return {};
}

function round(value, places = 2) {
    const factor = 10 ** places;
    return Math.round(value * factor) / factor;
}

function settlementFigures(item, tx) {
    const payoutCurrency = String(item.currency || '').toUpperCase();
    const statementCurrency = String(tx.currency || payoutCurrency).toUpperCase();
    if (!statementCurrency || statementCurrency === payoutCurrency) {
        return {
            amount_difference: round(tx.amount - Number(item.amount)),
            fx_rate: null,
            fx_difference: null
        };
    }
    const rate = tx.fx_rate ?? (tx.amount > 0 ? round(tx.amount / Number(item.amount), 6) : null);
    const difference = tx.fx_rate
        ? round(tx.amount - Number(item.amount) * tx.fx_rate)
        : null;
    return {
        amount_difference: null,
        fx_rate: rate,
        fx_difference: difference
    };
}

function canApply(item, status) {
    if (item.status === status) return false;
    if (item.status === 'submitted') return true;
    if (item.status === 'credited' && status === 'returned') return true;
    return false;
}

/**
 * Match statement transactions against the ledger and return a new ledger plus
 * a report. Pure: the caller decides whether to persist it.
 */
export function planStatementImport(ledger, transactions, {
    source = 'attijari',
    file = null,
    at = new Date(),
    dateWindowDays = 10,
    tolerance = 0.01
} = {}) {
    const stamp = new Date(at).toISOString();
    const next = {
        version: ledger.version,
        updated_at: ledger.updated_at,
        items: { ...ledger.items },
        statement_imports: { ...(ledger.statement_imports || {}) }
    };
    const report = {
        source,
        file,
        imported_at: stamp,
        transactions: transactions.length,
        applied: [],
        already_applied: [],
        skipped: [],
        unmatched: [],
        ambiguous: [],
        conflicts: [],
        outgoing: [],
        issues: []
    };
    const options = { dateWindowDays, tolerance };

    for (const tx of transactions) {
        if (tx.status === 'outgoing') {
            report.outgoing.push({ line: tx.line, date: tx.date, amount: tx.amount, reference: tx.reference });
            continue;
        }
        if (next.statement_imports[tx.fingerprint]) {
            report.already_applied.push({ line: tx.line, fingerprint: tx.fingerprint });
            continue;
        }
        const match = findMatch(tx, next, options);
        if (match.ambiguous) {
            report.ambiguous.push({
                line: tx.line,
                reference: tx.reference,
                amount: tx.amount,
                candidates: match.ambiguous.map(item => item.payout_key)
            });
            continue;
        }
        if (!match.item) {
            report.unmatched.push({
                line: tx.line,
                date: tx.date,
                reference: tx.reference,
                amount: tx.amount,
                currency: tx.currency,
                status: tx.status
            });
            continue;
        }

        const item = match.item;
        const targetStatus = tx.status;
        if (!canApply(item, targetStatus)) {
            if (item.status === targetStatus) {
                report.skipped.push({ line: tx.line, payout: item.payout_key, reason: `already ${targetStatus}` });
                next.statement_imports[tx.fingerprint] = {
                    payout_key: item.payout_key,
                    source,
                    status: targetStatus,
                    file,
                    at: stamp,
                    applied: false
                };
            } else {
                report.conflicts.push({
                    line: tx.line,
                    payout: item.payout_key,
                    current: item.status,
                    incoming: targetStatus
                });
            }
            continue;
        }

        const figures = settlementFigures(item, tx);
        const settlement = {
            source,
            status: targetStatus,
            statement_file: file,
            statement_line: tx.line,
            statement_fingerprint: tx.fingerprint,
            statement_date: tx.date,
            reference: tx.reference,
            description: tx.description,
            amount: tx.amount,
            currency: tx.currency,
            fee: tx.fee,
            net_amount: tx.net_amount,
            fx_rate: figures.fx_rate,
            fx_difference: figures.fx_difference,
            amount_difference: figures.amount_difference,
            matched_by: match.method,
            recorded_at: stamp
        };

        const updated = {
            ...item,
            status: targetStatus,
            settlements: [...(item.settlements || []), settlement],
            last_settlement_at: stamp,
            fees: [
                ...(item.fees || []),
                ...(tx.fee ? [{ amount: round(tx.fee), currency: tx.currency || item.currency }] : [])
            ]
        };
        if (targetStatus === 'credited') updated.credited_at = stamp;
        if (targetStatus === 'failed') updated.failed_at = stamp;
        if (targetStatus === 'returned') updated.returned_at = stamp;

        next.items[item.payout_key] = updated;
        next.statement_imports[tx.fingerprint] = {
            payout_key: item.payout_key,
            source,
            status: targetStatus,
            file,
            at: stamp,
            applied: true
        };
        report.applied.push({
            line: tx.line,
            payout: item.payout_key,
            status: targetStatus,
            amount: tx.amount,
            currency: tx.currency,
            fee: tx.fee,
            fx_rate: figures.fx_rate,
            fx_difference: figures.fx_difference,
            amount_difference: figures.amount_difference,
            matched_by: match.method
        });
    }

    next.updated_at = stamp;
    return { ledger: next, report };
}
