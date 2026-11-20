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
import { readEncryptedJson, writeJsonAtomic } from '../../security/data-at-rest.mjs';

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

function readRecord(file) {
    try {
        return readEncryptedJson(file);
    } catch {
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            return null;
        }
    }
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
    const value = readRecord(file);
    if (!value) return { file, changed: 0, unreadable: true, events: [] };

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

    if (changed > 0 && apply) writeJsonAtomic(file, value);
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
