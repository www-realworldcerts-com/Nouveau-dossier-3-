/**
 * Blocked-settlement log.
 *
 * `applyPayoutItemUpdate` refuses to mark a revenue row `paid_out` when the
 * money-moved gate does not pass. Until this log existed that refusal reached
 * the process's stderr and nothing else: on a serverless host nobody reads
 * stderr, so PayPal could report the payout as succeeded while the revenue row
 * stayed unpaid, and no incident was ever raised. The audit reads this log back
 * and reports an unresolved block as `REVENUE_SETTLEMENT_BLOCKED`.
 *
 * It is append-only and keyed by the revenue event a line is about. A later
 * `settled` line for the same key closes an earlier `blocked` line, the same
 * way a `DELIVERED` queue line closes an earlier retry: the latest line wins.
 * Nothing here may throw into the webhook path — the payout item has already
 * been written as PayPal reported it, and a full disk must not turn a recorded
 * payout into a failed webhook that PayPal retries.
 */

import fs from 'node:fs';
import path from 'node:path';

export const SETTLEMENT_BLOCK_LOG_ENV = 'SETTLEMENT_BLOCK_LOG';
export const SETTLEMENT_BLOCKED = 'blocked';
export const SETTLEMENT_SETTLED = 'settled';

export function settlementBlockLogPath(root = process.cwd(), env = process.env) {
    return env[SETTLEMENT_BLOCK_LOG_ENV]
        || path.join(root, 'data', 'resilience', 'settlement-blocks.ndjson');
}

/**
 * The key is the revenue row id and nothing else.
 *
 * Every writer passes the same value from the same variable — the payout
 * item's revenue reference — so a refusal and a closing line always meet. A
 * fallback key (the payout transaction id, say) would be a line that can never
 * be closed: the closing writers always carry the revenue id, so they could
 * never match it.
 */
export function settlementBlockKey(record) {
    const revenueId = String(record?.revenue_event_id ?? '').trim();
    return revenueId || null;
}

function append(root, record, env) {
    const key = settlementBlockKey(record);
    if (!key) return { recorded: false, reason: 'no_key' };
    const file = settlementBlockLogPath(root, env);
    const line = { key, at: record.at || new Date().toISOString(), ...record, key };
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, JSON.stringify(line) + '\n');
        return { recorded: true, path: file, key };
    } catch (error) {
        return { recorded: false, path: file, key, error: error?.message ?? String(error) };
    }
}

export function recordSettlementBlock(root = process.cwd(), record = {}, env = process.env) {
    return append(root, { ...record, outcome: SETTLEMENT_BLOCKED }, env);
}

/**
 * A closing line only means something next to a block, so it is never written
 * into a log that does not exist: a deployment that has never refused a
 * settlement keeps no file at all. Once a block exists the log is the record,
 * and every settlement appends a line because only the latest line per row
 * decides whether that row is still open.
 */
export function recordSettlementSettled(root = process.cwd(), record = {}, env = process.env) {
    if (!fs.existsSync(settlementBlockLogPath(root, env))) {
        return { recorded: false, reason: 'no_log' };
    }
    return append(root, { ...record, outcome: SETTLEMENT_SETTLED }, env);
}

export function readSettlementBlocks(root = process.cwd(), { env = process.env } = {}) {
    const file = settlementBlockLogPath(root, env);
    const records = [];
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch {
        return { path: file, records };
    }
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed === 'object') records.push(parsed);
        } catch {
            // A torn final line is a partial append, not a settlement record.
        }
    }
    return { path: file, records };
}

/** The latest line per revenue row, keeping only rows left blocked. */
export function openSettlementBlocks(records = []) {
    const latest = new Map();
    for (const record of records) {
        const key = record?.key || settlementBlockKey(record);
        if (!key) continue;
        latest.set(key, record);
    }
    return [...latest.values()].filter(record => record.outcome !== SETTLEMENT_SETTLED);
}
