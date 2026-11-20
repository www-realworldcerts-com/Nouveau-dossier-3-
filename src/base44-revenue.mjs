import crypto from "node:crypto";
import { demoteUnverifiedStatus, verifyRevenueEvent, RevenueNotProviderVerifiedError } from "./real/revenue-verification.mjs";
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

  if (!cfg.allowNonPositiveAmounts && numericAmount <= 0) {
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
  return entity.create(data);
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
  if (existingId) return { id: existingId, deduped: true };

  try {
    return await entity.create(data);
  } catch (err) {
    const racedId = await findExistingId(entity, filter).catch(() => null);
    if (racedId) return { id: racedId, deduped: true };
    throw err;
  }
}
