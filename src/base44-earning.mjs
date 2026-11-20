function safeJsonParse(maybeJson, fallback) {
  if (!maybeJson) return fallback;
  try {
    return JSON.parse(maybeJson);
  } catch {
    return fallback;
  }
}

export function getEarningConfigFromEnv() {
  const entityName = process.env.BASE44_EARNING_ENTITY ?? "Earning";
  const defaultCurrency = process.env.BASE44_DEFAULT_CURRENCY ?? "USD";
  const mapFromEnv = safeJsonParse(process.env.BASE44_EARNING_FIELD_MAP, null);

  const fieldMap = mapFromEnv ?? {
    earningId: "earning_id",
    amount: "amount",
    currency: "currency",
    occurredAt: "occurred_at",
    source: "source",
    beneficiary: "beneficiary",
    status: "status",
    settlementId: "settlement_id",
    metadata: "metadata"
  };

  return { entityName, defaultCurrency, fieldMap };
}

async function findExistingId(entity, filter) {
  const existing = await entity.filter(filter, "-created_date", 1, 0);
  if (Array.isArray(existing) && existing[0]?.id) return existing[0].id;
  return null;
}

import { requireProviderBackedRevenue } from './real/revenue-verification.mjs';

function buildEarningData(cfg, earning, { dryRun = false } = {}) {
  const data = {};
  const map = cfg.fieldMap;

  const earningId = earning.earningId ?? earning.earning_id ?? null;
  if (!earningId) throw new Error("Earning requires earningId");

  const amount = Number(earning.amount);
  if (!amount || Number.isNaN(amount) || amount <= 0) throw new Error("Earning amount must be > 0");

  const currency = earning.currency ?? cfg.defaultCurrency;
  const occurredAt = earning.occurredAt ?? earning.occurred_at ?? new Date().toISOString();

  // An earning is a claim that money exists and is owed, so it must carry the
  // provider transaction that produced it. Refusing here keeps fabricated rows
  // out of the payout batches that read this entity.
  const evidence = {
    ...(earning.metadata && typeof earning.metadata === 'object' ? earning.metadata : {})
  };
  for (const field of [
    'psp_transaction_id', 'provider_transaction_id', 'transaction_id', 'payment_id',
    'paypal_capture_id', 'stripe_charge_id', 'stripe_payment_intent', 'tx_hash', 'bank_ref'
  ]) {
    if (earning[field]) evidence[field] = earning[field];
  }
  const proofTransaction =
    earning.psp_proof?.transaction_id ?? earning.psp_proof?.psp_id ??
    earning.verification_proof?.psp_id ?? earning.verification_proof?.transaction_id ?? null;
  if (proofTransaction && !evidence.psp_transaction_id) evidence.psp_transaction_id = proofTransaction;

  if (!dryRun) {
    requireProviderBackedRevenue(
      { externalId: String(earningId), amount, currency, metadata: evidence, verification_proof: earning.verification_proof ?? null },
      { label: 'earning' }
    );
  }

  data[map.earningId] = String(earningId);
  data[map.amount] = amount;
  data[map.currency] = String(currency);
  data[map.occurredAt] = String(occurredAt);
  data[map.source] = earning.source ?? null;
  data[map.beneficiary] = earning.beneficiary ?? null;
  data[map.status] = earning.status ?? "settled_externally_pending";
  if (earning.settlementId != null) data[map.settlementId] = earning.settlementId;
  const metadata = { ...(earning.metadata && typeof earning.metadata === 'object' ? earning.metadata : {}) };
  if (evidence.psp_transaction_id) metadata.psp_transaction_id = evidence.psp_transaction_id;
  data[map.metadata] = metadata;

  return data;
}

export async function createBase44EarningIdempotent(base44, cfg, earning, { dryRun = false } = {}) {
  const data = buildEarningData(cfg, earning, { dryRun });
  if (dryRun) return { dryRun: true, entity: cfg.entityName, data };

  if (!base44) {
    throw new Error("Base44 client not configured (missing BASE44_APP_ID / BASE44_SERVICE_TOKEN)");
  }

  const enable = (process.env.BASE44_ENABLE_EARNING_WRITES ?? "false").toLowerCase() === "true";
  if (!enable) {
    throw new Error("Refusing to create earnings without BASE44_ENABLE_EARNING_WRITES=true");
  }

  const entity = base44.asServiceRole.entities[cfg.entityName];
  const existingId = await findExistingId(entity, { [cfg.fieldMap.earningId]: data[cfg.fieldMap.earningId] });
  if (existingId) return { id: existingId, deduped: true };

  try {
    return await entity.create(data);
  } catch (err) {
    const racedId = await findExistingId(entity, { [cfg.fieldMap.earningId]: data[cfg.fieldMap.earningId] }).catch(
      () => null
    );
    if (racedId) return { id: racedId, deduped: true };
    throw err;
  }
}

export async function updateBase44EarningById(base44, cfg, id, patch) {
  if (!base44) {
    throw new Error("Base44 client not configured (missing BASE44_APP_ID / BASE44_SERVICE_TOKEN)");
  }
  const entity = base44.asServiceRole.entities[cfg.entityName];
  return entity.update(id, patch);
}

