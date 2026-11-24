#!/usr/bin/env node
// One-off backfill: bind settlement-evidence blocks for revenue rows recorded
// before capture ingest wrote them.
//
// Settlement refuses a row with no bound block (`settlement_evidence_missing`),
// which is what stops a row authorising its own payout — and what strands every
// row captured before ingest-time binding existed. This walks the production
// ledger and binds one block per eligible row, from the row's own provider
// evidence.
//
// It writes evidence and nothing else: no status changes, no settlement, no
// overwrite. A row whose existing block disagrees with its evidence is reported
// and left exactly as it is. A row whose psp id no verified webhook named is
// refused: the registry, not the row, decides whether the provider confirmed
// the money. A refused row that stays unsettleable (an amount the verified
// webhook contradicts) is also written to the settlement block log, so the
// audit raises it instead of leaving it stranded.
//
//   node scripts/backfill-settlement-evidence.mjs                 # report only
//   node scripts/backfill-settlement-evidence.mjs --apply         # write blocks
//   node scripts/backfill-settlement-evidence.mjs --apply --json  # machine-readable
//
// Env it uses: BASE44_APP_ID / BASE44_SERVICE_TOKEN (or BASE44_OFFLINE +
// BASE44_OFFLINE_STORE_PATH), BASE44_REVENUE_ENTITY, PSP_WEBHOOK_REGISTRY_FILE,
// and EVIDENCE_CHAIN_PATH — the last must point at the chain the settlement path
// reads, or the blocks land where nothing looks for them.
//
// The scan is newest first and bounded (`--limit`, default 5000). A run that
// hits the cap reports `truncated`, because the rows it did not look at are the
// oldest ones and they stay unbound.

import { pathToFileURL } from 'node:url';

import { buildBase44Client } from '../src/base44-client.mjs';
import {
    getRevenueConfigFromEnv,
    settlementEvidenceAgrees,
    settlementEvidenceProof
} from '../src/base44-revenue.mjs';
import { EvidenceIntegrityChain } from '../src/real/evidence-integrity.mjs';
import { recordSettlementEvidenceAmountMismatch } from '../src/resilience/settlement-blocks.mjs';
import { findVerifiedWebhook } from '../src/real/psp/webhook-registry.mjs';
import { agreesWithVerifiedAmount } from '../src/real/psp/psp-webhooks.mjs';

/**
 * Rows as the ledger returns them, newest first, bounded by `maxRows`.
 *
 * The whole row is fetched rather than a field projection: a row written by an
 * older writer may carry its proof at the top level (`verification_proof`)
 * instead of in metadata, and that fallback is what lets such a row be bound.
 */
async function listRows(entity, { pageSize = 250, maxRows = 5000 } = {}) {
    const rows = [];
    let offset = 0;
    while (rows.length < maxRows) {
        const page = await entity.list('-created_date', pageSize, offset);
        if (!Array.isArray(page) || page.length === 0) break;
        rows.push(...page);
        offset += page.length;
        if (page.length < pageSize) break;
    }
    return { rows: rows.slice(0, maxRows), truncated: rows.length >= maxRows };
}

/**
 * Bind the missing evidence block for every eligible revenue row.
 *
 * Never settles anything and never overwrites a block. Returns an outcome for
 * every row it read that has a ledger id, so a run can be read before it is
 * trusted.
 */
export async function backfillSettlementEvidence({
    base44,
    cfg = getRevenueConfigFromEnv(),
    apply = false,
    maxRows = 5000
} = {}) {
    if (!base44) throw new Error('Base44 client not configured (missing BASE44_APP_ID / BASE44_SERVICE_TOKEN)');

    const entity = base44.asServiceRole.entities[cfg.entityName];
    const metadataField = cfg.fieldMap.metadata;
    const { rows, truncated } = await listRows(entity, { maxRows });
    const results = [];

    for (const row of rows) {
        const id = String(row?.id ?? '').trim();
        if (!id) {
            results.push({ id: null, outcome: 'skipped', reason: 'id_missing' });
            continue;
        }

        // Money already out needs no block: the gate reads one only when a row
        // is about to be marked `paid_out`.
        const status = String(row?.[cfg.fieldMap.status] ?? '').trim().toLowerCase();
        if (status === 'paid_out' || status === 'settled') {
            results.push({ id, outcome: 'skipped', reason: 'already_settled' });
            continue;
        }

        const amount = Number(row?.[cfg.fieldMap.amount]);
        if (!Number.isFinite(amount) || amount <= 0) {
            // A reversal is a negative row: it is evidence of money leaving, not
            // a payout, and the settlement path never pays it.
            results.push({ id, outcome: 'skipped', reason: 'non_positive_amount' });
            continue;
        }

        const metadata = (metadataField ? row[metadataField] : null) ?? {};
        const evidence = settlementEvidenceProof({
            amount,
            currency: row?.[cfg.fieldMap.currency],
            occurredAt: row?.[cfg.fieldMap.occurredAt],
            metadata,
            verification_proof: metadata?.verification_proof ?? row?.verification_proof
        });
        if (!evidence.verified) {
            results.push({ id, outcome: 'refused', reason: evidence.reason, psp_id: evidence.psp_id });
            continue;
        }

        // The registry is the authority on whether a provider confirmed this
        // id and on the amount it confirmed, so one receipt answers both: an
        // id no verified webhook named is refused here rather than bound and
        // left to fail the gate later, and a receipt recording another amount
        // is refused because the block would carry the row's own number into a
        // payment nobody made.
        const receipt = await findVerifiedWebhook(evidence.proof.psp_id);
        if (!receipt) {
            results.push({
                id,
                outcome: 'refused',
                reason: 'psp_id_not_named_by_verified_webhook',
                psp_id: evidence.proof.psp_id
            });
            continue;
        }

        if (!agreesWithVerifiedAmount(evidence.proof, receipt)) {
            const detail =
                `the verified webhook for ${evidence.proof.psp_id} recorded ${receipt.amount} ${receipt.currency}, ` +
                `the row records ${evidence.proof.amount} ${evidence.proof.currency}`;
            // A refused row is not a failed run, so the report alone would leave
            // this row unsettleable with no incident. Record it where the audit
            // reads, exactly as capture ingest does.
            process.stderr.write(
                `FINDING SETTLEMENT_EVIDENCE_AMOUNT_MISMATCH [critical] capture ${evidence.proof.psp_id} was ` +
                `recorded as revenue event ${id}, but ${detail}. That row cannot be settled until its amount is reconciled.\n`
            );
            recordSettlementEvidenceAmountMismatch(process.cwd(), {
                revenue_event_id: id,
                psp_transaction_id: evidence.proof.psp_id,
                reason: 'provider_amount_mismatch',
                error: detail,
                source: 'settlement_evidence_backfill'
            });
            results.push({
                id,
                outcome: 'refused',
                reason: 'provider_amount_mismatch',
                psp_id: evidence.proof.psp_id
            });
            continue;
        }

        const existing = await EvidenceIntegrityChain.fetchBlockForEvent(id).catch(() => null);
        if (existing) {
            const agrees = settlementEvidenceAgrees(existing.proof, evidence.proof);
            results.push({
                id,
                outcome: agrees ? 'already_bound' : 'refused',
                reason: agrees ? null : 'evidence_mismatch',
                psp_id: evidence.proof.psp_id
            });
            continue;
        }

        if (!apply) {
            results.push({ id, outcome: 'would_bind', psp_id: evidence.proof.psp_id });
            continue;
        }

        try {
            await EvidenceIntegrityChain.addBlock(id, evidence.proof);
            results.push({ id, outcome: 'bound', psp_id: evidence.proof.psp_id });
        } catch (error) {
            results.push({
                id,
                outcome: 'failed',
                reason: 'evidence_chain_write_failed',
                error: String(error?.message ?? error)
            });
        }
    }

    const count = outcome => results.filter(result => result.outcome === outcome).length;
    return {
        applied: apply,
        truncated,
        scanned: rows.length,
        results,
        summary: {
            bound: count('bound'),
            would_bind: count('would_bind'),
            already_bound: count('already_bound'),
            skipped: count('skipped'),
            refused: count('refused'),
            failed: count('failed')
        }
    };
}

function printReport(report) {
    console.log(report.applied
        ? 'Settlement-evidence backfill (APPLY): blocks written where missing'
        : 'Settlement-evidence backfill (report only; pass --apply to write)');
    console.log(`Scanned ${report.scanned} revenue row(s)`);
    if (report.truncated) {
        console.log(`! The scan stopped at its ${report.scanned}-row cap; older rows were not looked at. Re-run with a larger --limit to reach them.`);
    }
    const { summary } = report;
    if (report.applied) console.log(`  bound         ${summary.bound}`);
    else console.log(`  would bind    ${summary.would_bind}`);
    console.log(`  already bound ${summary.already_bound}`);
    console.log(`  skipped       ${summary.skipped}`);
    console.log(`  refused       ${summary.refused}`);
    console.log(`  failed        ${summary.failed}`);
    for (const result of report.results) {
        if (result.outcome === 'refused' || result.outcome === 'failed') {
            const detail = result.reason || 'unknown';
            const psp = result.psp_id ? ` (${result.psp_id})` : '';
            console.log(`  ${result.outcome.toUpperCase()} ${result.id}: ${detail}${psp}`);
        }
    }
    if (summary.refused) {
        console.log('\nRefused rows are left untouched. A refused row cannot be settled until its evidence is reconciled; do not hand-edit its proof to make this pass.');
    }
}

async function main() {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
        console.log('Usage: node scripts/backfill-settlement-evidence.mjs [--apply] [--json] [--limit N]');
        return 0;
    }
    const apply = args.includes('--apply');
    const json = args.includes('--json');
    const limitIndex = args.indexOf('--limit');
    const maxRows = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 5000;
    if (limitIndex >= 0 && (!Number.isFinite(maxRows) || maxRows <= 0)) {
        console.error('--limit needs a positive number');
        return 1;
    }

    const base44 = await buildBase44Client();
    const report = await backfillSettlementEvidence({ base44, apply, maxRows });

    if (json) console.log(JSON.stringify(report, null, 2));
    else printReport(report);

    return report.summary.failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    main()
        .then(code => process.exit(code))
        .catch(error => {
            console.error(`backfill failed: ${error?.message ?? error}`);
            process.exit(1);
        });
}
