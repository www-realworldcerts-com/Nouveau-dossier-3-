import crypto from "node:crypto";
import { demoteUnverifiedStatus, verifyRevenueEvent, RevenueNotProviderVerifiedError } from "./real/revenue-verification.mjs";
import { EvidenceIntegrityChain } from "./real/evidence-integrity.mjs";
import { MoneyMovedGate } from "./real/money-moved-gate.mjs";
import { reversalWithoutCaptureFinding } from "./real/ledger/reversals.mjs";
import { recordSettlementEvidenceUnbound } from "./resilience/settlement-blocks.mjs";
import { computeConstitutionHash } from "./policy/constitution.mjs";
import { getConstitutionState, computeConstitutionHashFromFile } from "./bootstrap/constitution-validator.mjs";

function safeJsonParse(maybeJson, fallback) {
  if (!maybeJson) return fallback;
  try {
    return JSON.parse(maybeJson);
  } catch {
    return fallback;
  }
}

export function getRevenueConfigFromEnv() {
  const entityName = process.env.BASE44_REVENUE_ENTITY ?? "RevenueEvent";
  const defaultCurrency = process.env.BASE44_DEFAULT_CURRENCY ?? "USD";
  const allowNonPositiveAmounts =
    (process.env.BASE44_ALLOW_NON_POSITIVE_REVENUE ?? "false").toLowerCase() === "true";
  const mapFromEnv = safeJsonParse(process.env.BASE44_REVENUE_FIELD_MAP, null);

  const fieldMap = mapFromEnv ?? {
    amount: "amount",
    currency: "currency",
    occurredAt: "occurred_at",
    source: "source",
    externalId: "event_id", // Mapped to event_id as per Base44 schema requirement
    status: "status",
    payoutBatchId: "payout_batch_id",
    eventHash: "event_hash",
    missionId: "mission_id",
    missionTitle: "mission_title",
    agentIds: "agent_ids",
    metadata: "metadata"
  };

  return { entityName, defaultCurrency, allowNonPositiveAmounts, fieldMap };
}

function normalizeIsoDate(value) {
  const raw = value == null ? "" : String(value);
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return raw;
  return new Date(t).toISOString();
}

function normalizeAmountString(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return n.toFixed(2);
}

function computeEventHash({ sourceId, amount, confirmationDateIso, sourceType, recipientOrDescription }) {
  const parts = [
    String(sourceId ?? ""),
    String(amount ?? ""),
    String(confirmationDateIso ?? ""),
    String(sourceType ?? ""),
    String(recipientOrDescription ?? "")
  ];
  const input = parts.join("|");
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function buildRevenueData(cfg, event, { dryRun = false } = {}) {
  const data = {};
  const { fieldMap } = cfg;

  if (event.amount == null || Number.isNaN(Number(event.amount))) {
    // WARN instead of THROW to prevent crashing on bad data
    console.warn(`⚠️  Revenue event ${event.externalId ?? 'unknown'} has invalid amount: ${event.amount}. Defaulting to 0.`);
    event.amount = 0;
  }
  
  const numericAmount = Number(event.amount);

  // A reversal is a deliberate negative row, not bad data.
  if (!cfg.allowNonPositiveAmounts && numericAmount <= 0 && !event.metadata?.reversal_of) {
    console.warn(`⚠️  Revenue event ${event.externalId} amount <= 0 (${numericAmount}). Proceeding despite policy.`);
    // throw new Error("Revenue event amount must be > 0");
  }

  data[fieldMap.amount] = numericAmount;
  data[fieldMap.currency] = event.currency;
  data[fieldMap.occurredAt] = event.occurredAt;
  data[fieldMap.source] = event.source;
  data[fieldMap.externalId] = event.externalId;
  data[fieldMap.metadata] = event.metadata ?? {};
  try {
    const state = getConstitutionState();
    const ch = state?.lastValidHash
      || computeConstitutionHashFromFile(process.env.CONSTITUTION_JSON_FILE || './swarm.constitution.json')
      || computeConstitutionHash();
    if (ch) data[fieldMap.metadata].constitution_hash = ch;
  } catch {}

  if (fieldMap.status && event.status != null) data[fieldMap.status] = event.status;
  if (fieldMap.payoutBatchId && event.payoutBatchId != null) data[fieldMap.payoutBatchId] = event.payoutBatchId;

  // Enforce Revenue Verification: a provider transaction id is the only thing
  // that may be called VERIFIED. A local id (`LIVE_...`), a settlement batch, a
  // mission id, or a proof the system issued about itself (`autonomous_execution`)
  // is not evidence, so such an event is never recorded as verified whatever the
  // caller claimed — the ledger would otherwise inflate its own audit numbers.
  const verification = verifyRevenueEvent({
    metadata: event.metadata,
    verification_proof: event.verification_proof ?? event.metadata?.verification_proof
  });

  // Refuse the record outright. Demoting the status still leaves a row that a
  // payout batch can pick up, which is how invented revenue reaches a transfer.
  if (!verification.verified && !dryRun) {
    throw new RevenueNotProviderVerifiedError(verification.reason, {
      label: `revenue event from ${event.source ?? 'unknown source'}`,
      id: event.externalId ?? null,
      amount: event.amount,
      currency: event.currency
    });
  }

  if (fieldMap.metadata) {
    data[fieldMap.metadata] = {
      ...(data[fieldMap.metadata] || {}),
      verification: {
        verified: verification.verified,
        reason: verification.reason,
        provider: verification.provider,
        psp_id: verification.verified ? verification.psp_id : null,
        evidence: verification.source
      }
    };
  }

  if (fieldMap.status && !verification.verified) {
    const declared = data[fieldMap.status] ?? null;
    const demoted = demoteUnverifiedStatus(declared);
    if (demoted.changed) {
      console.warn(
        `⚠️  Revenue Event ${event.externalId} has no payment-provider transaction id (${verification.reason}); recorded as ${demoted.status} instead of ${declared ?? "(none)"}.`
      );
    }
    data[fieldMap.status] = demoted.status;
  }

  if (fieldMap.eventHash) {
    const occurredAtIso = normalizeIsoDate(event.occurredAt);
    const amountStr = normalizeAmountString(event.amount);
    const recipientOrDescription =
      event?.metadata?.recipient_id ??
      event?.metadata?.recipient ??
      event?.metadata?.description ??
      event?.missionId ??
      event?.missionTitle ??
      "";

    data[fieldMap.eventHash] = computeEventHash({
      sourceId: event.externalId,
      amount: amountStr,
      confirmationDateIso: occurredAtIso,
      sourceType: event.source,
      recipientOrDescription
    });
  }

  if (event.missionId) data[fieldMap.missionId] = event.missionId;
  if (event.missionTitle) data[fieldMap.missionTitle] = event.missionTitle;
  if (event.agentIds) data[fieldMap.agentIds] = event.agentIds;

  return data;
}

/** The proof shape a settlement is authorised by. */
const SETTLEMENT_PROOF_TYPE = "psp_transaction_id";

/**
 * Bind the settlement-evidence block for one revenue row.
 *
 * The block is the evidence a later payout is checked against, so it is written
 * when the capture is recorded rather than rebuilt at payout time. A settlement
 * that constructs its own proof is authorising itself from whatever the row
 * says at that moment, which is exactly what the chain exists to prevent.
 *
 * Only a provider transaction id can be bound, and the block records the row's
 * own psp id, amount and currency. Never throws: a capture whose block cannot be
 * written is still recorded (the money did move) but reported, and its
 * settlement is refused until a block exists.
 */
/**
 * The provider evidence a revenue row is settled against, or the reason it has
 * none. One definition, shared by ingest, the settlement gate and the one-off
 * backfill, so "the evidence for this row" cannot mean two different things.
 */
export function settlementEvidenceProof(event = {}) {
  const metadata = event?.metadata && typeof event.metadata === "object" ? event.metadata : {};
  const verification = verifyRevenueEvent({
    metadata,
    verification_proof: event?.verification_proof ?? metadata?.verification_proof
  });
  if (!verification.verified) {
    return { verified: false, reason: verification.reason, psp_id: verification.psp_id ?? null };
  }
  return {
    verified: true,
    reason: null,
    verification,
    proof: {
      type: SETTLEMENT_PROOF_TYPE,
      psp_id: verification.psp_id,
      amount: Number(event.amount),
      currency: String(event.currency ?? "USD").toUpperCase(),
      timestamp: event.occurredAt ?? new Date().toISOString()
    }
  };
}

/** Whether a block bound earlier is about the same money as `proof`. */
export function settlementEvidenceAgrees(bound, proof) {
  const evidence = bound && typeof bound === "object" ? bound : {};
  return (
    String(evidence.psp_id ?? "") === String(proof?.psp_id ?? "") &&
    Number(evidence.amount) === Number(proof?.amount) &&
    String(evidence.currency ?? "").toUpperCase() === String(proof?.currency ?? "").toUpperCase()
  );
}

async function bindSettlementEvidence({ revenueEventId, event = {} } = {}) {
  const id = String(revenueEventId ?? "").trim();
  if (!id) return { bound: false, reason: "revenue_event_id_missing" };

  const evidence = settlementEvidenceProof(event);
  if (!evidence.verified) {
    return { bound: false, reason: evidence.reason, psp_id: evidence.psp_id };
  }
  const { proof } = evidence;

  try {
    // A replay must not chain a second block for the same row.
    const existing = await EvidenceIntegrityChain.fetchBlockForEvent(id).catch(() => null);
    if (!existing) await EvidenceIntegrityChain.addBlock(id, proof);
    return { bound: true, psp_id: proof.psp_id };
  } catch (err) {
    const message = String(err?.message ?? err);
    process.stderr.write(
      `FINDING SETTLEMENT_EVIDENCE_UNBOUND [critical] capture ${proof.psp_id} was recorded as revenue ` +
      `event ${id}, but its settlement evidence could not be bound: ${message}. ` +
      `That row cannot be settled until the block exists.\n`
    );
    // stderr is discarded on a serverless host, so the same failure goes into
    // the log the audit reads back. Without this the order is simply never paid
    // out and nothing raises an incident.
    recordSettlementEvidenceUnbound(process.cwd(), {
      revenue_event_id: id,
      psp_transaction_id: proof.psp_id,
      reason: "evidence_chain_write_failed",
      error: message,
      source: "revenue_ingest"
    });
    return { bound: false, reason: "evidence_chain_write_failed", error: message, psp_id: proof.psp_id };
  }
}

async function findExistingId(entity, filter) {
  const existing = await entity.filter(filter, "-created_date", 1, 0);
  if (Array.isArray(existing) && existing[0]?.id) return existing[0].id;
  return null;
}

export async function createBase44RevenueEvent(base44, cfg, event, { dryRun } = {}) {
  const data = buildRevenueData(cfg, event, { dryRun });

  if (dryRun) return { dryRun: true, entity: cfg.entityName, data };

  if (!base44) {
    throw new Error("Base44 client not configured (missing BASE44_APP_ID / BASE44_SERVICE_TOKEN)");
  }

  const entity = base44.asServiceRole.entities[cfg.entityName];
  const created = await entity.create(data);
  // The sale's evidence is bound here, on the write path that records it.
  const evidence = await bindSettlementEvidence({ revenueEventId: created?.id, event });
  return { ...created, evidence };
}

/** The capture ids a Base44 revenue row can identify itself by. */
function captureIds(row, metadataField) {
  const meta = row?.[metadataField] ?? {};
  const proof = meta?.verification_proof ?? null;
  return [meta.paypal_capture_id, meta.psp_transaction_id, proof?.psp_id]
    .filter((value) => value != null && String(value).trim() !== "")
    .map((value) => String(value).trim());
}

/** Revenue rows, newest first, bounded so a huge entity cannot hang a webhook. */
async function listRevenueRows(entity, cfg, { pageSize = 250, maxRows = 5000 } = {}) {
  const fields = [
    "id",
    cfg.fieldMap.amount,
    cfg.fieldMap.currency,
    cfg.fieldMap.occurredAt,
    cfg.fieldMap.externalId,
    cfg.fieldMap.status,
    cfg.fieldMap.metadata
  ].filter(Boolean);
  const rows = [];
  let offset = 0;
  while (rows.length < maxRows) {
    const page = await entity.list("-created_date", pageSize, offset, fields);
    if (!Array.isArray(page) || page.length === 0) break;
    rows.push(...page);
    offset += page.length;
    if (page.length < pageSize) break;
  }
  return { rows: rows.slice(0, maxRows), truncated: rows.length >= maxRows };
}

const BASE44_REVERSAL_TYPES = new Set(["refunded", "reversed", "disputed"]);

/**
 * Reverse a verified PayPal refund, reversal or dispute in the Base44 ledger.
 *
 * The production totals live in `RevenueEvent`, so a negative row keyed to the
 * capture PayPal says was refunded is what makes those totals honest. A
 * reversal whose capture row cannot be found there is returned as a critical
 * finding instead of being written against nothing.
 */
export async function createBase44RevenueReversal(base44, cfg, reversal, { pageSize, maxRows } = {}) {
  const type = String(reversal?.type ?? "").trim().toLowerCase();
  if (!BASE44_REVERSAL_TYPES.has(type)) {
    throw new Error(`Not a refund, reversal or dispute: ${reversal?.type ?? "(none)"}`);
  }
  const captureId = String(reversal?.original_capture_id ?? "").trim();
  const now = new Date().toISOString();
  const metadataField = cfg.fieldMap.metadata;
  const ledger = `the Base44 ${cfg.entityName} ledger`;

  const unmatched = (reason) => ({
    applied: false,
    reason,
    finding: reversalWithoutCaptureFinding(reversal, {
      captureId: captureId || null,
      reason,
      now,
      ledger
    })
  });

  if (!captureId) return unmatched("capture_id_missing");
  if (!base44) throw new Error("Base44 client not configured (missing BASE44_APP_ID / BASE44_SERVICE_TOKEN)");

  const entity = base44.asServiceRole.entities[cfg.entityName];
  const { rows, truncated } = await listRevenueRows(entity, cfg, { pageSize, maxRows });
  const capture = rows.find((row) =>
    !row?.[metadataField]?.reversal_of &&
    captureIds(row, metadataField).includes(captureId)
  );
  if (!capture) return unmatched(truncated ? "capture_search_truncated" : "capture_not_found");

  const declared = Number(reversal?.amount);
  const captured = Math.abs(Number(capture?.[cfg.fieldMap.amount]));
  const amount =
    Number.isFinite(declared) && declared > 0
      ? declared
      : Number.isFinite(captured) && captured > 0
        ? captured
        : null;
  if (amount == null) return unmatched("capture_amount_missing");

  const currency = String(
    reversal?.currency || capture?.[cfg.fieldMap.currency] || cfg.defaultCurrency || ""
  ).toUpperCase();
  const occurredAt = reversal?.occurredAt ?? now;
  const reversalEventId = String(reversal?.externalId || `${type}_${captureId}`);
  const refundId = reversal?.metadata?.paypal_refund_id ?? null;
  const disputeId = reversal?.metadata?.paypal_dispute_id ?? null;

  const event = {
    amount: -amount,
    currency,
    occurredAt,
    source: "paypal",
    externalId: reversalEventId,
    // The capture id is provider evidence, so the negative row is VERIFIED and
    // counts in the totals it corrects.
    status: "VERIFIED",
    metadata: {
      psp_transaction_id: captureId,
      reversal_of: captureId,
      reversal_type: type,
      paypal_event_type: reversal?.metadata?.paypal_event_type ?? null,
      paypal_event_id: reversal?.metadata?.paypal_event_id ?? null,
      ...(refundId ? { paypal_refund_id: refundId } : {}),
      ...(disputeId ? { paypal_dispute_id: disputeId } : {})
    },
    verification_proof: {
      type: "paypal_capture_reversal",
      psp_id: captureId,
      amount,
      currency,
      timestamp: occurredAt,
      ...(refundId ? { refund_id: refundId } : {}),
      ...(disputeId ? { dispute_id: disputeId } : {})
    }
  };

  const written = await createBase44RevenueEventIdempotent(base44, cfg, event, { dryRun: false });
  const captureEventId = capture?.[cfg.fieldMap.externalId] ?? null;

  if (written?.deduped) {
    return { applied: false, reason: "already_reversed", reversal_event_id: reversalEventId, capture_event_id: captureEventId };
  }

  return {
    applied: true,
    reason: "reversed",
    reversal_event_id: reversalEventId,
    capture_event_id: captureEventId,
    revenue_event_id: written?.id ?? null
  };
}

/**
 * Reversal rows as they exist in the production ledger.
 *
 * `createBase44RevenueReversal` writes a negative row whose metadata names the
 * capture (`reversal_of`) and the reversal kind (`reversal_type`), while its
 * own `status` column says `VERIFIED` because the capture id is provider
 * evidence. The silent-failure audit reads reversals in the ledger-file shape,
 * where `status` is the reversal kind (`refunded`, `reversed`, `disputed`), so
 * this reader normalises at the boundary instead of teaching the audit two
 * record shapes.
 *
 * Only rows whose metadata names a capture are reversals; every other revenue
 * row is skipped. `since` bounds the scan to the audit window; `truncated`
 * says the scan hit its row cap and the audit cannot claim it saw everything.
 */
export async function readBase44RevenueReversals(base44, cfg, { pageSize, maxRows, since = null } = {}) {
  if (!base44) throw new Error("Base44 client not configured (missing BASE44_APP_ID / BASE44_SERVICE_TOKEN)");

  const entity = base44.asServiceRole.entities[cfg.entityName];
  const { rows, truncated } = await listRevenueRows(entity, cfg, { pageSize, maxRows });
  const metadataField = cfg.fieldMap.metadata;
  const sinceMs = since ? Date.parse(since) : NaN;
  const records = [];

  for (const row of rows) {
    const meta = (metadataField ? row?.[metadataField] : null) ?? {};
    const captureId = String(meta.reversal_of ?? "").trim();
    if (!captureId) continue;

    const occurredAt = row?.[cfg.fieldMap.occurredAt] ?? row?.created_date ?? null;
    const occurredMs = Date.parse(occurredAt || "");
    if (Number.isFinite(sinceMs) && Number.isFinite(occurredMs) && occurredMs < sinceMs) continue;

    const amount = Number(row?.[cfg.fieldMap.amount]);
    const reversalType = String(meta.reversal_type ?? "").trim().toLowerCase() || null;
    records.push({
      file: `base44:${row?.id ?? captureId}`,
      source: "base44",
      record: {
        event_id: row?.[cfg.fieldMap.externalId] ?? null,
        amount: Number.isFinite(amount) ? amount : null,
        currency: String(row?.[cfg.fieldMap.currency] ?? "").toUpperCase() || null,
        occurred_at: occurredAt,
        // The audit reads `status` as the reversal kind; the ledger's own
        // column is kept beside it rather than overwritten.
        status: reversalType || "reversal",
        ledger_status: row?.[cfg.fieldMap.status] ?? null,
        reversal_of: captureId,
        reversal_type: reversalType,
        ...(meta.paypal_refund_id ? { paypal_refund_id: meta.paypal_refund_id } : {}),
        ...(meta.paypal_dispute_id ? { paypal_dispute_id: meta.paypal_dispute_id } : {}),
        base44_record_id: row?.id ?? null
      }
    });
  }

  return {
    directory: `base44:${cfg.entityName}`,
    records,
    scanned: rows.length,
    truncated
  };
}

export async function createBase44RevenueEventIdempotent(base44, cfg, event, { dryRun } = {}) {
  const data = buildRevenueData(cfg, event, { dryRun });

  if (dryRun) return { dryRun: true, entity: cfg.entityName, data };

  if (!base44) {
    throw new Error("Base44 client not configured (missing BASE44_APP_ID / BASE44_SERVICE_TOKEN)");
  }

  const entity = base44.asServiceRole.entities[cfg.entityName];
  const filter = { [cfg.fieldMap.externalId]: event.externalId };
  if (cfg.fieldMap.source && event.source != null) filter[cfg.fieldMap.source] = event.source;

  const existingId = await findExistingId(entity, filter);
  if (existingId) {
    // A replay of a capture already recorded: bind only if it never was, which
    // backfills a row written before ingest-time binding existed.
    const evidence = await bindSettlementEvidence({ revenueEventId: existingId, event });
    return { id: existingId, deduped: true, evidence };
  }

  let created;
  try {
    created = await entity.create(data);
  } catch (err) {
    const racedId = await findExistingId(entity, filter).catch(() => null);
    if (racedId) {
      const evidence = await bindSettlementEvidence({ revenueEventId: racedId, event });
      return { id: racedId, deduped: true, evidence };
    }
    throw err;
  }

  // The block a later payout is checked against is written now, with the
  // capture, not reconstructed when the money is about to move.
  const evidence = await bindSettlementEvidence({ revenueEventId: created?.id, event });
  return { ...created, evidence };
}

/** A revenue row by its ledger id, or null. */
async function findRevenueRowById(entity, revenueEventId) {
  const rows = await entity.filter({ id: revenueEventId }, "-created_date", 1, 0);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/**
 * The settlement gate for one Base44 revenue row.
 *
 * Writing `paid_out` is the claim that money left the account, so it may only
 * land after `MoneyMovedGate` approves the row. The deployed PayPal webhook
 * handler used to write that status straight through while the script-side
 * `ledger-sync.mjs` gated the same transition; both paths run this now.
 *
 * The proof is the row's **own** provider evidence, never the payout id that
 * happens to be completing: otherwise any real transfer could settle a row
 * whose money was invented. A row with no provider transaction id is refused,
 * as is a provider id no verified webhook named.
 *
 * Never throws. The caller must write nothing when `ok` is false and report
 * `reason` instead of letting the settlement disappear.
 */
export async function authorizeRevenueSettlement(base44, cfg, options = {}) {
  try {
    return await decideRevenueSettlement(base44, cfg, options);
  } catch (err) {
    // A throw here would 500 a payout webhook PayPal has already marked as
    // succeeded, so the refusal is reported like every other one.
    return { ok: false, reason: "gate_error", error: String(err?.message ?? err) };
  }
}

/** The decision itself. The exported wrapper is what guarantees no throwing. */
async function decideRevenueSettlement(base44, cfg, { revenueEventId } = {}) {
  const id = String(revenueEventId ?? "").trim();
  if (!id) return { ok: false, reason: "revenue_event_id_missing" };
  if (!base44) return { ok: false, reason: "base44_not_configured" };

  const entity = base44.asServiceRole.entities[cfg.entityName];
  const row = await findRevenueRowById(entity, id).catch(() => null);
  if (!row) return { ok: false, reason: "revenue_event_not_found" };

  const metadataField = cfg.fieldMap.metadata;
  const metadata = (metadataField ? row[metadataField] : null) ?? {};
  const verification = verifyRevenueEvent({
    metadata,
    verification_proof: metadata?.verification_proof ?? row.verification_proof
  });
  if (!verification.verified) {
    return {
      ok: false,
      reason: verification.reason,
      psp_id: verification.psp_id ?? null,
      detail: "the revenue row carries no provider transaction id, so it cannot be settled"
    };
  }

  const amount = Number(row[cfg.fieldMap.amount]);
  const proof = {
    type: "psp_transaction_id",
    psp_id: verification.psp_id,
    amount: Number.isFinite(amount) ? amount : 0,
    currency: String(row[cfg.fieldMap.currency] ?? cfg.defaultCurrency ?? "").toUpperCase(),
    timestamp: row[cfg.fieldMap.occurredAt] ?? new Date().toISOString()
  };

  const gateEvent = {
    id,
    amount: proof.amount,
    currency: proof.currency,
    occurredAt: proof.timestamp,
    created_at: row.created_date ?? proof.timestamp,
    metadata,
    verification_proof: proof,
    // The claim under test is the status this write is about to set; the row's
    // evidence is what has to back it.
    status: "paid_out",
    settled: false
  };

  // The evidence was bound when the capture was ingested. Rebuilding it here
  // would let the row authorise its own payout from whatever it says now, so a
  // missing or disagreeing block is a refusal, never a write.
  const block = await EvidenceIntegrityChain.fetchBlockForEvent(id).catch(() => null);
  if (!block) {
    return {
      ok: false,
      reason: "settlement_evidence_missing",
      psp_id: verification.psp_id,
      detail: "no settlement-evidence block was bound when this capture was recorded; it is not rebuilt at payout time"
    };
  }
  // The block must be about this same money. Timestamps are not compared: the
  // block records when the sale was announced, the row when it occurred.
  const bound = block.proof ?? {};
  if (!settlementEvidenceAgrees(bound, proof)) {
    return {
      ok: false,
      reason: "settlement_evidence_mismatch",
      psp_id: verification.psp_id,
      detail: `bound evidence ${bound.psp_id ?? "(none)"} ${bound.amount ?? "?"} ${bound.currency ?? "?"} does not match the row's ${proof.psp_id} ${proof.amount} ${proof.currency}`
    };
  }

  try {
    await MoneyMovedGate.assertMoneyMoved(gateEvent);
  } catch (err) {
    return {
      ok: false,
      reason: "gate_refused",
      psp_id: verification.psp_id,
      error: String(err?.message ?? err)
    };
  }

  return {
    ok: true,
    reason: null,
    provider: verification.provider,
    psp_id: verification.psp_id,
    evidence: verification.source
  };
}
