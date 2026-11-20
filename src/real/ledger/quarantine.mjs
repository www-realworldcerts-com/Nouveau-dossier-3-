/**
 * Quarantine revenue records whose stored status claims VERIFIED without a
 * payment-provider transaction id.
 *
 * `revenue-proof-audit` demotes such a record at read time, which keeps the
 * totals honest but leaves the file asserting money that never arrived. Every
 * other reader — payout batches, dashboards, a person opening the JSON — still
 * sees `VERIFIED`. This module rewrites the record once, keeps the evidence
 * that made it unverified, and is safe to run again: a second pass finds
 * nothing to change and writes no bytes.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
    classifyRevenueEvent,
    assertStorableRevenueStatus,
    demoteUnverifiedStatus
} from '../revenue-verification.mjs';
import {
    decryptBuffer,
    decryptSensitiveFields,
    encryptBuffer,
    encryptSensitiveFields,
    readEncryptedJson,
    writeJsonAtomic
} from '../../security/data-at-rest.mjs';

/** Revenue events only: an amount plus a revenue id or a proof. Payout `items`
 * rows and `earning` records in the same directory are obligations, not
 * revenue, and are never touched. Mirrors `scripts/revenue-proof-audit.mjs`. */
export function revenueEventsIn(value) {
    const found = [];
    const consider = (node) => {
        if (!node || typeof node !== 'object' || Array.isArray(node)) return;
        const isRevenue = Number.isFinite(Number(node.amount)) && node.currency
            && (node.event_id || node.verification_proof || node.metadata?.verification_proof);
        if (isRevenue) found.push(node);
    };
    consider(value);
    if (value && typeof value === 'object' && value.data && typeof value.data === 'object' && !Array.isArray(value.data)) {
        consider(value.data);
    }
    return found;
}

/**
 * Read a ledger file in either stored shape: a plaintext JSON document (whose
 * sensitive fields may individually be `enc:v1:` values), or a whole-file
 * sealed record (`DATAENC1` envelope from `encryptBuffer`). The sealed shape is
 * tried first because its JSON only exists after decryption. Returns the parsed
 * value plus how it was stored, so a write can put the bytes back the same way;
 * `null` means genuinely unreadable.
 */
function readRecord(file) {
    let raw;
    try {
        raw = fs.readFileSync(file);
    } catch {
        return null;
    }
    try {
        const parsed = JSON.parse(decryptBuffer(raw).toString('utf8'));
        return { value: decryptSensitiveFields(parsed), wholeFileEncrypted: true };
    } catch {
        // Not a sealed file; fall through to the plaintext shapes.
    }
    try {
        return { value: readEncryptedJson(file), wholeFileEncrypted: false };
    } catch {
        try {
            return { value: JSON.parse(raw.toString('utf8')), wholeFileEncrypted: false };
        } catch {
            return null;
        }
    }
}

/**
 * Write a record back in the shape it was read in. A sealed file must stay
 * sealed: the migration rewrites records, it never downgrades encryption. The
 * envelope is re-created (new IV), with field-level encryption applied first so
 * sensitive fields keep their own protection.
 */
function writeRecord(file, value, { wholeFileEncrypted }) {
    if (!wholeFileEncrypted) {
        writeJsonAtomic(file, value);
        return;
    }
    const resolved = path.resolve(file);
    const json = `${JSON.stringify(encryptSensitiveFields(value), null, 2)}\n`;
    const sealed = encryptBuffer(Buffer.from(json, 'utf8'));
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const tmp = `${resolved}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, sealed, { mode: 0o600 });
    fs.renameSync(tmp, resolved);
}

/**
 * Demote one record if it claims a verified status without provider evidence.
 * Returns a report instead of throwing so a whole directory can be processed;
 * the rewritten record is checked with `assertStorableRevenueStatus` first, so
 * a quarantine that would still claim verified money is refused rather than
 * written.
 */
export function quarantineRecord(record, { now = new Date().toISOString() } = {}) {
    const declared = record?.status == null ? '' : String(record.status).trim();
    const verdict = classifyRevenueEvent(record);
    if (verdict.verified) {
        return { changed: false, reason: 'provider_verified', record, declared, verdict };
    }

    const demoted = demoteUnverifiedStatus(declared);
    if (!demoted.changed) {
        return { changed: false, reason: 'already_unverified', record, declared, verdict };
    }

    const quarantine = {
        previous_status: declared || null,
        reason: verdict.reason,
        psp_id: verdict.psp_id,
        amount: Number(record.amount) || null,
        currency: record.currency ?? null,
        quarantined_at: now,
        quarantined_by: 'scripts/quarantine-unverified-revenue.mjs'
    };
    const history = Array.isArray(record.quarantine_history) ? record.quarantine_history.slice() : [];
    if (record.quarantine) history.push(record.quarantine);

    const next = {
        ...record,
        status: demoted.status,
        quarantine,
        ...(history.length > 0 ? { quarantine_history: history } : {})
    };
    // An empty history is noise; only keep the key when there is history.
    if (history.length === 0) delete next.quarantine_history;

    // Postcondition: nothing this module writes may claim verified money.
    assertStorableRevenueStatus(next, { label: 'quarantined revenue event' });

    return { changed: true, reason: verdict.reason, record: next, declared, verdict };
}

export function quarantineFile(file, { apply = false, now = new Date().toISOString() } = {}) {
    const stored = readRecord(file);
    if (!stored) return { file, changed: 0, unreadable: true, events: [] };
    const { value } = stored;

    const events = [];
    let changed = 0;
    for (const record of revenueEventsIn(value)) {
        const report = quarantineRecord(record, { now });
        events.push({
            event_id: record.event_id ?? record.id ?? null,
            amount: Number(record.amount) || 0,
            currency: record.currency ?? null,
            previous_status: report.declared || null,
            status: report.record?.status ?? null,
            changed: report.changed,
            reason: report.reason,
            psp_id: report.verdict?.psp_id ?? null
        });
        if (report.changed) {
            // Replace the node inside the container it came from, so a record
            // under `data` is rewritten there and the rest of the file survives.
            for (const key of Object.keys(record)) delete record[key];
            Object.assign(record, report.record);
            changed += 1;
        }
    }

    if (changed > 0 && apply) writeRecord(file, value, stored);
    return { file, changed, unreadable: false, events };
}

export function quarantineDirectory(dir, { apply = false, now = new Date().toISOString() } = {}) {
    const resolved = path.resolve(dir);
    if (!fs.existsSync(resolved)) {
        return { directory: resolved, files: [], changed: 0, unreadable: 0, missing: true };
    }
    const files = [];
    let changed = 0;
    let unreadable = 0;
    for (const name of fs.readdirSync(resolved).filter((file) => file.endsWith('.json')).sort()) {
        const result = quarantineFile(path.join(resolved, name), { apply, now });
        if (result.unreadable) unreadable += 1;
        changed += result.changed;
        if (result.events.length > 0) files.push(result);
    }
    return { directory: resolved, files, changed, unreadable, missing: false, applied: apply };
}
