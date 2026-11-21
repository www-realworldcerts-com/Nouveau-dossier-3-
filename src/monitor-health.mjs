import "./load-env.mjs";
import { buildBase44ServiceClient } from "./base44-client.mjs";
import { getPayPalAccessToken } from "./paypal-api.mjs";
import { maybeSendAlert } from "./alerts.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function hasEnv(name) {
  const v = process.env[name];
  return v != null && String(v).trim() !== "";
}

function isPlaceholderValue(value) {
  if (value == null) return true;
  const v = String(value).trim();
  if (!v) return true;
  if (/^\s*<\s*YOUR_[A-Z0-9_]+\s*>\s*$/i.test(v)) return true;
  if (/^\s*YOUR_[A-Z0-9_]+\s*$/i.test(v)) return true;
  if (/^\s*(REPLACE_ME|CHANGEME|TODO)\s*$/i.test(v)) return true;
  return false;
}

function hasRealEnv(name) {
  const v = process.env[name];
  return !isPlaceholderValue(v);
}

function getEnvBool(name, fallback = false) {
  const v = process.env[name];
  if (v == null) return fallback;
  return String(v).toLowerCase() === "true";
}

function canBuildBase44() {
  try {
    buildBase44ServiceClient();
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

function getIntervalMs() {
  const raw = process.env.HEALTH_INTERVAL_MS ?? "30000";
  const ms = Number(raw);
  if (!ms || Number.isNaN(ms) || ms < 1000) return 30000;
  return ms;
}

function getHealthEntityConfig() {
  return {
    entity: process.env.BASE44_HEALTH_ENTITY ?? "SystemHealth",
    fieldMap: {
      at: process.env.BASE44_HEALTH_FIELD_AT ?? "at",
      ok: process.env.BASE44_HEALTH_FIELD_OK ?? "ok",
      paypalOk: process.env.BASE44_HEALTH_FIELD_PAYPAL_OK ?? "paypal_ok",
      base44Ok: process.env.BASE44_HEALTH_FIELD_BASE44_OK ?? "base44_ok",
      details: process.env.BASE44_HEALTH_FIELD_DETAILS ?? "details"
    }
  };
}

async function writeHealth(base44, cfg, payload) {
  const map = cfg.fieldMap;
  const entity = base44.asServiceRole.entities[cfg.entity];
  const data = {
    [map.at]: payload.at,
    [map.ok]: payload.ok,
    [map.paypalOk]: payload.paypalOk,
    [map.base44Ok]: payload.base44Ok,
    [map.details]: payload.details
  };
  return entity.create(data);
}

async function checkBase44(base44) {
  try {
    const entityName = process.env.BASE44_HEALTH_PING_ENTITY ?? "RevenueEvent";
    const entity = base44.asServiceRole.entities[entityName];
    await entity.list("-created_date", 1, 0, ["id"]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

async function checkPayPal() {
  if (!hasRealEnv("PAYPAL_CLIENT_ID") || !hasRealEnv("PAYPAL_CLIENT_SECRET")) {
    return { ok: false, error: "Missing PayPal credentials (PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET)" };
  }
  try {
    const token = await getPayPalAccessToken();
    if (!token) return { ok: false, error: "Missing token" };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

function buildReadinessSummary() {
  const live = getEnvBool("SWARM_LIVE", false);
  const base44Build = canBuildBase44();
  const base44Configured = base44Build.ok;
  const paypalConfigured = hasRealEnv("PAYPAL_CLIENT_ID") && hasRealEnv("PAYPAL_CLIENT_SECRET");
  const webhookConfigured = hasRealEnv("PAYPAL_WEBHOOK_ID");
  const paypalMode = String(process.env.PAYPAL_MODE ?? "live").toLowerCase();
  const paypalApiBaseUrl = String(process.env.PAYPAL_API_BASE_URL ?? "");

  const flags = {
    BASE44_ENABLE_PAYPAL_WEBHOOK_WRITE: getEnvBool("BASE44_ENABLE_PAYPAL_WEBHOOK_WRITE", false),
    BASE44_ENABLE_REVENUE_FROM_PAYPAL: getEnvBool("BASE44_ENABLE_REVENUE_FROM_PAYPAL", false),
    BASE44_ENABLE_PAYPAL_PAYOUT_STATUS_WRITE: getEnvBool("BASE44_ENABLE_PAYPAL_PAYOUT_STATUS_WRITE", false),
    BASE44_ENABLE_PAYOUT_LEDGER_WRITE: getEnvBool("BASE44_ENABLE_PAYOUT_LEDGER_WRITE", false),
    BASE44_ENABLE_TRUTH_ONLY_UI: getEnvBool("BASE44_ENABLE_TRUTH_ONLY_UI", false),
    BASE44_ENABLE_PAYPAL_METRICS: getEnvBool("BASE44_ENABLE_PAYPAL_METRICS", false),
    PAYPAL_PPP2_APPROVED: getEnvBool("PAYPAL_PPP2_APPROVED", false) || getEnvBool("PPP2_APPROVED", false),
    PAYPAL_PPP2_ENABLE_SEND: getEnvBool("PAYPAL_PPP2_ENABLE_SEND", false) || getEnvBool("PPP2_ENABLE_SEND", false)
  };

  const warnings = [];
  const paypalSandbox = paypalMode === "sandbox" || paypalApiBaseUrl.toLowerCase().includes("sandbox.paypal.com");
  if (live && paypalSandbox) {
    warnings.push("SWARM_LIVE=true but PayPal is configured for sandbox");
  }

  const missing = [];
  if (!live) missing.push("SWARM_LIVE");
  if (!paypalConfigured) missing.push("PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET");
  if (!webhookConfigured) missing.push("PAYPAL_WEBHOOK_ID");
  if (!base44Configured) missing.push("BASE44_APP_ID/BASE44_SERVICE_TOKEN");
  if (!flags.BASE44_ENABLE_REVENUE_FROM_PAYPAL) missing.push("BASE44_ENABLE_REVENUE_FROM_PAYPAL");
  if (live && paypalSandbox) missing.push("PAYPAL_MODE/PAYPAL_API_BASE_URL (must be live)");

  if (live && (!flags.PAYPAL_PPP2_APPROVED || !flags.PAYPAL_PPP2_ENABLE_SEND)) {
    warnings.push("PayPal PPP2 flags not fully enabled (PAYPAL_PPP2_APPROVED and PAYPAL_PPP2_ENABLE_SEND)");
  }

  const nextSteps = [];
  if (!live) nextSteps.push('PowerShell: $env:SWARM_LIVE="true"');
  if (!paypalConfigured) nextSteps.push("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET");
  if (!webhookConfigured) nextSteps.push("Set PAYPAL_WEBHOOK_ID");
  if (!base44Configured) nextSteps.push("Set BASE44_APP_ID and BASE44_SERVICE_TOKEN (BASE44_APP_ID accepts a Base44 app URL)");
  if (!flags.BASE44_ENABLE_REVENUE_FROM_PAYPAL) nextSteps.push('PowerShell: $env:BASE44_ENABLE_REVENUE_FROM_PAYPAL="true"');
  if (warnings.length) nextSteps.push('PowerShell: $env:PAYPAL_MODE="live" (or unset PAYPAL_API_BASE_URL sandbox)');

  return {
    ok: missing.length === 0,
    live,
    base44Configured,
    base44Error: base44Build.ok ? null : base44Build.error,
    paypalConfigured,
    webhookConfigured,
    paypalMode,
    paypalApiBaseUrl: paypalApiBaseUrl ? "(set)" : "(default)",
    flags,
    warnings,
    nextSteps,
    missing
  };
}

function parseJsonEnv(name) {
  const raw = process.env[name];
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function coerceObject(value) {
  if (!value) return {};
  if (typeof value === "object") return Array.isArray(value) ? {} : value;
  if (typeof value === "string") {
    const parsed = (() => {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    })();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  }
  return {};
}

function getMissionHealthRequirements() {
  const override = parseJsonEnv("BASE44_MISSION_HEALTH_REQUIREMENTS_JSON");
  if (override) return override;
  return {
    financial_mission: {
      min_heartbeat_hours: 24,
      required_events: [
        "PAYMENT.CAPTURE.COMPLETED",
        // Without this subscription an approved-but-uncaptured order is never
        // captured automatically, so the buyer's payment is never taken.
        "CHECKOUT.ORDER.APPROVED",
        "PAYMENT.PAYOUTS-ITEM.SUCCEEDED"
      ],
      min_ledger_writes: 1
    },
    operational_mission: {
      min_heartbeat_hours: 72,
      required_events: [],
      min_ledger_writes: 0
    }
  };
}

function getMissionHealthConfig() {
  return {
    enableWrite: getEnvBool("BASE44_ENABLE_MISSION_HEALTH_WRITE", false),
    deployableThreshold: Number(process.env.BASE44_MISSION_HEALTH_DEPLOYABLE_THRESHOLD ?? "0.8") || 0.8,
    entities: {
      mission: process.env.BASE44_MISSION_ENTITY ?? "Mission",
      webhook: process.env.BASE44_MISSION_HEALTH_WEBHOOK_ENTITY ?? "PayPalWebhookEvent",
      revenue: process.env.BASE44_MISSION_HEALTH_REVENUE_ENTITY ?? "RevenueEvent",
      metric: process.env.BASE44_MISSION_HEALTH_METRIC_ENTITY ?? "PayPalMetric"
    },
    fields: {
      mission: {
        id: process.env.BASE44_MISSION_FIELD_ID ?? "id",
        type: process.env.BASE44_MISSION_FIELD_TYPE ?? "type",
        status: process.env.BASE44_MISSION_FIELD_STATUS ?? "status",
        deployed: process.env.BASE44_MISSION_FIELD_DEPLOYED ?? "deployed",
        metadata: process.env.BASE44_MISSION_FIELD_METADATA ?? "metadata",
        healthScore: process.env.BASE44_MISSION_FIELD_HEALTH_SCORE ?? "health_score",
        healthProofs: process.env.BASE44_MISSION_FIELD_HEALTH_PROOFS ?? "health_proofs",
        lastHealthCheck: process.env.BASE44_MISSION_FIELD_LAST_HEALTH_CHECK ?? "last_health_check"
      },
      webhook: {
        missionId: process.env.BASE44_WEBHOOK_FIELD_MISSION_ID ?? "mission_id",
        eventId: process.env.BASE44_WEBHOOK_FIELD_EVENT_ID ?? "event_id",
        eventType: process.env.BASE44_WEBHOOK_FIELD_EVENT_TYPE ?? "event_type",
        at: process.env.BASE44_WEBHOOK_FIELD_AT ?? "created_date"
      },
      revenue: {
        missionId: process.env.BASE44_REVENUE_FIELD_MISSION_ID ?? "mission_id",
        eventId: process.env.BASE44_REVENUE_FIELD_EVENT_ID ?? "event_id",
        amount: process.env.BASE44_REVENUE_FIELD_AMOUNT ?? "amount",
        at: process.env.BASE44_REVENUE_FIELD_AT ?? "occurred_at"
      },
      metric: {
        kind: process.env.BASE44_METRIC_FIELD_KIND ?? "kind",
        ok: process.env.BASE44_METRIC_FIELD_OK ?? "ok",
        at: process.env.BASE44_METRIC_FIELD_AT ?? "at"
      }
    },
    requirements: getMissionHealthRequirements()
  };
}

function pickFirst(record, keys) {
  for (const k of keys) {
    if (!k) continue;
    const v = record?.[k];
    if (v != null) return v;
  }
  return null;
}

function hoursSince(iso) {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return null;
  return (Date.now() - at.getTime()) / (1000 * 60 * 60);
}

function classifyMission(mission, cfg) {
  const type = pickFirst(mission, [cfg.fields.mission.type, "type"]);
  const t = String(type ?? "").toLowerCase();
  if (t.includes("financial") || t.includes("revenue") || t.includes("payout")) return "financial_mission";
  return "operational_mission";
}

function computeHealthScore(classKey, proofs) {
  const weights =
    classKey === "financial_mission"
      ? { webhook_heartbeat: 0.4, required_events: 0.2, ledger_activity: 0.3, paypal_sync: 0.1 }
      : { webhook_heartbeat: 0.2, required_events: 0.0, ledger_activity: 0.6, paypal_sync: 0.2 };

  const enabled = Object.entries(weights).filter(([, w]) => w > 0);
  const total = enabled.reduce((acc, [, w]) => acc + w, 0) || 1;

  const normalized = {};
  for (const [k, w] of enabled) normalized[k] = w / total;

  const healthy = new Set(["healthy", "active", "ok", "present"]);
  const byType = new Map(proofs.map((p) => [p.type, p]));

  let score = 0;
  for (const [type, w] of Object.entries(normalized)) {
    const p = byType.get(type);
    if (!p) continue;
    if (healthy.has(String(p.status))) score += w;
  }
  return Math.max(0, Math.min(1, score));
}

function computeDeployable({ classKey, requirements, proofs, score, threshold }) {
  if (score < threshold) return false;
  const byType = new Map(proofs.map((p) => [p.type, p]));

  if (classKey === "financial_mission") {
    const hb = byType.get("webhook_heartbeat");
    if (!hb || hb.status === "missing" || hb.status === "stale") return false;
    const ledger = byType.get("ledger_activity");
    if (Number(requirements?.min_ledger_writes ?? 0) > 0 && (!ledger || ledger.status !== "active")) return false;
  }
  return true;
}

function summarizeMissionHealthResults(results) {
  const list = Array.isArray(results) ? results : [];
  const summary = {
    ok: true,
    total: list.length,
    okCount: 0,
    errorCount: 0,
    deployableCount: 0,
    notDeployableCount: 0,
    minHealthScore: null,
    byClassKey: {},
    proofStatusCounts: {}
  };

  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    if (r.ok !== true) {
      summary.ok = false;
      summary.errorCount += 1;
      continue;
    }
    summary.okCount += 1;
    if (r.deployable === true) summary.deployableCount += 1;
    else summary.notDeployableCount += 1;
    if (r.deployable !== true) summary.ok = false;

    const score = Number(r.healthScore);
    if (Number.isFinite(score)) {
      summary.minHealthScore = summary.minHealthScore == null ? score : Math.min(summary.minHealthScore, score);
    }

    const classKey = String(r.classKey ?? "unknown");
    if (!summary.byClassKey[classKey]) {
      summary.byClassKey[classKey] = { total: 0, deployable: 0, notDeployable: 0 };
    }
    summary.byClassKey[classKey].total += 1;
    if (r.deployable === true) summary.byClassKey[classKey].deployable += 1;
    else summary.byClassKey[classKey].notDeployable += 1;

    const proofs = Array.isArray(r.proofs) ? r.proofs : [];
    for (const p of proofs) {
      if (!p || typeof p !== "object") continue;
      const key = `${String(p.type ?? "unknown")}:${String(p.status ?? "unknown")}`;
      summary.proofStatusCounts[key] = (summary.proofStatusCounts[key] ?? 0) + 1;
    }
  }

  return summary;
}

async function calculateMissionHealth(base44, cfg, mission) {
  const classKey = classifyMission(mission, cfg);
  const requirements = cfg.requirements?.[classKey] ?? {};
  const proofs = [];

  const missionId = pickFirst(mission, [cfg.fields.mission.id, "id"]);
  if (!missionId) {
    return { ok: false, error: "Mission missing id", missionId: null, healthScore: 0, proofs: [], deployable: false };
  }

  const webhookEntity = base44.asServiceRole.entities[cfg.entities.webhook];
  let lastWebhook = null;
  let webhookErr = null;
  try {
    const webhook = await webhookEntity.filter(
      { [cfg.fields.webhook.missionId]: String(missionId) },
      "-created_date",
      1,
      0,
      [cfg.fields.webhook.eventId, cfg.fields.webhook.eventType, cfg.fields.webhook.at, "created_date", "created_at", "at"]
    );
    lastWebhook = Array.isArray(webhook) && webhook.length ? webhook[0] : null;
  } catch (e) {
    webhookErr = e?.message ?? String(e);
  }
  if (webhookErr) {
    proofs.push({ type: "webhook_heartbeat", status: "unavailable", error: webhookErr });
  } else if (lastWebhook) {
    const at = pickFirst(lastWebhook, [cfg.fields.webhook.at, "created_date", "created_at", "at", "updated_date"]);
    const h = hoursSince(at);
    const maxH = Number(requirements?.min_heartbeat_hours ?? 24) || 24;
    if (h != null && h < maxH) {
      proofs.push({
        type: "webhook_heartbeat",
        status: "healthy",
        last_event: pickFirst(lastWebhook, [cfg.fields.webhook.eventId, "event_id", "id"]) ?? null,
        last_event_type: pickFirst(lastWebhook, [cfg.fields.webhook.eventType, "event_type", "type"]) ?? null,
        hours_ago: Math.floor(h)
      });
    } else {
      proofs.push({
        type: "webhook_heartbeat",
        status: "stale",
        last_event: pickFirst(lastWebhook, [cfg.fields.webhook.eventId, "event_id", "id"]) ?? null,
        last_event_type: pickFirst(lastWebhook, [cfg.fields.webhook.eventType, "event_type", "type"]) ?? null,
        hours_ago: h == null ? null : Math.floor(h)
      });
    }
  } else {
    proofs.push({ type: "webhook_heartbeat", status: "missing" });
  }

  const requiredEvents = Array.isArray(requirements?.required_events) ? requirements.required_events : [];
  if (requiredEvents.length > 0) {
    if (webhookErr) {
      proofs.push({ type: "required_events", status: "unavailable", required: requiredEvents, missing: requiredEvents });
    } else {
      const sample = await webhookEntity.filter(
        { [cfg.fields.webhook.missionId]: String(missionId) },
        "-created_date",
        250,
        0,
        [cfg.fields.webhook.eventType, "event_type", "type", cfg.fields.webhook.at, "created_date", "created_at", "at"]
      );
      const types = new Set(
        (Array.isArray(sample) ? sample : [])
          .map((r) => pickFirst(r, [cfg.fields.webhook.eventType, "event_type", "type"]))
          .filter((x) => x != null)
          .map((x) => String(x))
      );
      const missing = requiredEvents.filter((t) => !types.has(String(t)));
      proofs.push({
        type: "required_events",
        status: missing.length === 0 ? "present" : "missing",
        required: requiredEvents,
        missing
      });
    }
  }

  const revenueEntity = base44.asServiceRole.entities[cfg.entities.revenue];
  let lastRevenue = null;
  let revenueErr = null;
  try {
    const revenue = await revenueEntity.filter(
      { [cfg.fields.revenue.missionId]: String(missionId) },
      "-created_date",
      1,
      0,
      [cfg.fields.revenue.eventId, cfg.fields.revenue.amount, cfg.fields.revenue.at, "created_date", "occurred_at", "at"]
    );
    lastRevenue = Array.isArray(revenue) && revenue.length ? revenue[0] : null;
  } catch (e) {
    revenueErr = e?.message ?? String(e);
  }
  if (revenueErr) {
    proofs.push({ type: "ledger_activity", status: "unavailable", error: revenueErr });
  } else if (lastRevenue) {
    proofs.push({
      type: "ledger_activity",
      status: "active",
      last_event_id: pickFirst(lastRevenue, [cfg.fields.revenue.eventId, "event_id", "id"]) ?? null,
      amount: pickFirst(lastRevenue, [cfg.fields.revenue.amount, "amount"]) ?? null,
      at: pickFirst(lastRevenue, [cfg.fields.revenue.at, "occurred_at", "created_date", "at"]) ?? null
    });
  } else {
    proofs.push({ type: "ledger_activity", status: "missing" });
  }

  const metricEntity = base44.asServiceRole.entities[cfg.entities.metric];
  let lastMetric = null;
  let metricErr = null;
  try {
    const metric = await metricEntity.filter(
      { [cfg.fields.metric.kind]: "sync_payout_batch", [cfg.fields.metric.ok]: true },
      "-created_date",
      1,
      0,
      [cfg.fields.metric.at, "at", "created_date"]
    );
    lastMetric = Array.isArray(metric) && metric.length ? metric[0] : null;
  } catch (e) {
    metricErr = e?.message ?? String(e);
  }
  if (metricErr) {
    proofs.push({ type: "paypal_sync", status: "unavailable", error: metricErr });
  } else if (lastMetric) {
    const at = pickFirst(lastMetric, [cfg.fields.metric.at, "at", "created_date", "created_at"]) ?? null;
    const h = hoursSince(at);
    const maxH = Number(process.env.BASE44_MISSION_HEALTH_MAX_SYNC_STALENESS_HOURS ?? "24") || 24;
    proofs.push({
      type: "paypal_sync",
      status: h != null && h < maxH ? "ok" : "stale",
      hours_ago: h == null ? null : Math.floor(h),
      at
    });
  } else {
    proofs.push({ type: "paypal_sync", status: "missing" });
  }

  const healthScore = computeHealthScore(classKey, proofs);
  const deployable = computeDeployable({
    classKey,
    requirements,
    proofs,
    score: healthScore,
    threshold: cfg.deployableThreshold
  });

  const now = new Date().toISOString();
  const metadata = coerceObject(pickFirst(mission, [cfg.fields.mission.metadata, "metadata"]));
  const nextMetadata = {
    ...metadata,
    evidence_gated: true,
    health_calculated_at: now,
    health: { healthScore, deployable, proofs, classKey }
  };

  if (cfg.enableWrite) {
    const missionEntity = base44.asServiceRole.entities[cfg.entities.mission];
    const fullPatch = {
      [cfg.fields.mission.healthScore]: healthScore,
      [cfg.fields.mission.healthProofs]: proofs,
      [cfg.fields.mission.lastHealthCheck]: now,
      [cfg.fields.mission.deployed]: deployable,
      [cfg.fields.mission.metadata]: nextMetadata
    };
    try {
      await missionEntity.update(String(missionId), fullPatch);
    } catch {
      await missionEntity.update(String(missionId), { [cfg.fields.mission.metadata]: nextMetadata });
    }
  }

  return { ok: true, missionId: String(missionId), classKey, healthScore, proofs, deployable };
}

async function runMissionHealthOnce(base44, cfg, { missionId, limit }) {
  const missionEntity = base44.asServiceRole.entities[cfg.entities.mission];
  const fields = [cfg.fields.mission.id, cfg.fields.mission.type, cfg.fields.mission.status, cfg.fields.mission.metadata, cfg.fields.mission.deployed];
  let missions = [];
  if (missionId) {
    missions = await missionEntity.filter({ [cfg.fields.mission.id]: String(missionId) }, "-updated_date", 1, 0, fields);
  } else {
    const lim = Number(limit ?? process.env.BASE44_MISSION_HEALTH_LIMIT ?? "50") || 50;
    const target = Math.max(1, Math.floor(lim));
    const pageSize = Math.max(1, Math.min(100, target));
    let offset = 0;
    while (missions.length < target) {
      const page = await missionEntity.list("-updated_date", pageSize, offset, fields);
      if (!Array.isArray(page) || page.length === 0) break;
      missions.push(...page);
      if (page.length < pageSize) break;
      offset += pageSize;
      if (offset > 100000) break;
    }
    missions = missions.slice(0, target);
  }
  const results = [];
  for (const m of missions) {
    results.push(await calculateMissionHealth(base44, cfg, m));
  }
  return results;
}

async function main() {
  const args = parseArgs(process.argv);
  const once = args.once === true;
  const readiness = args.readiness === true || args["live-readiness"] === true;
  const ping = args.ping === true;
  const missionHealth = args["mission-health"] === true || args["mission-health-check"] === true;
  const missionHealthSummary = args.summary === true || args["mission-health-summary"] === true;

  const intervalMs = getIntervalMs();
  const enableWrite = (process.env.BASE44_ENABLE_HEALTH_WRITE ?? "false").toLowerCase() === "true";
  const enableAlerts = (process.env.BASE44_ENABLE_ALERTS ?? "false").toLowerCase() === "true";

  if (readiness) {
    const summary = buildReadinessSummary();
    if (!ping) {
      process.stdout.write(`${JSON.stringify({ ok: true, readiness: summary })}\n`, () => process.exit(0));
      return;
    }

    const at = nowIso();
    const paypal = await checkPayPal();
    let base44Client = null;
    let base44ClientErr = null;
    try {
      base44Client = buildBase44ServiceClient();
    } catch (e) {
      base44ClientErr = e?.message ?? String(e);
    }
    const base44Ping = base44Client ? await checkBase44(base44Client) : { ok: false, error: base44ClientErr ?? "Missing Base44 credentials" };
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        at,
        readiness: summary,
        ping: { paypalOk: paypal.ok, base44Ok: base44Ping.ok, details: { paypal: paypal.ok ? "ok" : paypal.error, base44: base44Ping.ok ? "ok" : base44Ping.error } }
      })}\n`,
      () => process.exit(0)
    );
    return;
  }

  if (missionHealth) {
    const base44 = buildBase44ServiceClient();
    const cfg = getMissionHealthConfig();
    const missionId = args["mission-id"] ? String(args["mission-id"]) : null;
    const limit = args["mission-limit"] ? String(args["mission-limit"]) : null;
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        missionHealth: { once, enableWrite: cfg.enableWrite, deployableThreshold: cfg.deployableThreshold, missionId, limit: limit ?? null }
      })}\n`
    );
    while (true) {
      const at = nowIso();
      const results = await runMissionHealthOnce(base44, cfg, { missionId, limit });
      if (missionHealthSummary) {
        const summary = summarizeMissionHealthResults(results);
        process.stdout.write(`${JSON.stringify({ ok: true, at, summary })}\n`);
      }
      process.stdout.write(`${JSON.stringify({ ok: true, at, results })}\n`);
      if (once) break;
      await sleep(intervalMs);
    }
    return;
  }

  const base44 = buildBase44ServiceClient();
  const cfg = getHealthEntityConfig();

  process.stdout.write(`${JSON.stringify({ ok: true, monitoring: true, intervalMs, once })}\n`);

  let lastAlertAt = 0;
  const alertCooldownMs = Number(process.env.ALERT_COOLDOWN_MS ?? "900000") || 900000;

  while (true) {
    const at = nowIso();
    const paypal = await checkPayPal();
    const base44Ping = await checkBase44(base44);

    const payload = {
      at,
      ok: paypal.ok && base44Ping.ok,
      paypalOk: paypal.ok,
      base44Ok: base44Ping.ok,
      details: {
        paypal: paypal.ok ? "ok" : paypal.error,
        base44: base44Ping.ok ? "ok" : base44Ping.error
      }
    };

    if (enableWrite) {
      await writeHealth(base44, cfg, payload);
    }

    process.stdout.write(`${JSON.stringify({ ok: true, health: payload })}\n`);

    if (enableAlerts && !payload.ok) {
      const now = Date.now();
      if (now - lastAlertAt >= alertCooldownMs) {
        lastAlertAt = now;
        await maybeSendAlert(base44, {
          subject: "Swarm Health Alert",
          body: JSON.stringify(payload, null, 2)
        });
      }
    }

    if (once) break;
    await sleep(intervalMs);
  }
}

main().catch((err) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: err?.message ?? String(err) })}\n`);
  process.exitCode = 1;
});
