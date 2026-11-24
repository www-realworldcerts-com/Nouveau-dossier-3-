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
// the money.
//
//   node scripts/backfill-settlement-evidence.mjs                 # report only
//   node scripts/backfill-settlement-evidence.mjs --apply         # write blocks
//   node scripts/backfill-settlement-evidence.mjs --apply --json  # machine-readable
//
// Env it uses: BASE44_APP_ID / BASE44_SERVICE_TOKEN (or BASE44_OFFLINE +
// BASE44_OFFLINE_STORE_PATH), BASE44_REVENUE_ENTITY, PSP_WEBHOOK_REGISTRY_FILE,
// and EVIDENCE_CHAIN_PATH — the last must point at the chain the settlement path
// reads, or the blocks land where nothing looks for them.

import { pathToFileURL } from 'node:url';

import { buildBase44Client } from '../src/base44-client.mjs';
import {
    getRevenueConfigFromEnv,
    settlementEvidenceAgrees,
    settlementEvidenceProof
} from '../src/base44-revenue.mjs';
import { EvidenceIntegrityChain } from '../src/real/evidence-integrity.mjs';
import { assertPSPWebhookExists } from '../src/real/psp/psp-webhooks.mjs';

async function listRows(entity, { pageSize, maxRows }) {
    const rows = [];
    let offset = 0;
    while (rows.length < maxRows) {
        const page = await entity.list('-created_date', pageSize, offset);
        if (!Array.isArray(page) || page.length === 0) break;
        rows.push(...page);
        offset += page.length;
        if (page.length < pageSize) break;
    }
    return rows.slice(0, maxRows);
}

/**
 * Bind the missing evidence block for every eligible revenue row.
 *
 * Never settles anything and never overwrites a block. Returns every row it
 * looked at with its outcome, so a run can be read before it is trusted.
 */
export async function backfillSettlementEvidence({
    base44,
    cfg = getRevenueConfigFromEnv(),
    apply = false,
    pageSize = 250,
    maxRows = 5000,
    registryCheck = assertPSPWebhookExists,
    chain = EvidenceIntegrityChain
} = {}) {
    if (!base44) throw new Error('Base44 client not configured (missing BASE44_APP_ID / BASE44_SERVICE_TOKEN)');

    const entity = base44.asServiceRole.entities[cfg.entityName];
    const metadataField = cfg.fieldMap.metadata;
    const rows = await listRows(entity, { pageSize, maxRows });
    const results = [];

    for (const row of rows) {
        const id = String(row?.id ?? '').trim();
        if (!id) continue;

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

        // The registry is the authority on whether a provider confirmed this id,
        // so a provider-shaped string that no verified webhook named is refused
        // here rather than bound and left to fail the gate later.
        if (!(await registryCheck(evidence.proof.psp_id))) {
            results.push({
                id,
                outcome: 'refused',
                reason: 'psp_id_not_named_by_verified_webhook',
                psp_id: evidence.proof.psp_id
            });
            continue;
        }

        const existing = await chain.fetchBlockForEvent(id).catch(() => null);
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
            const block = await chain.addBlock(id, evidence.proof);
            results.push({ id, outcome: 'bound', psp_id: evidence.proof.psp_id, hash: block?.hash ?? null });
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
