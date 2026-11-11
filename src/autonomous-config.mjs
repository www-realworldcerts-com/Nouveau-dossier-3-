import fs from "node:fs/promises";
import path from "node:path";

export function getEnvBool(name, fallback = false) {
  const v = process.env[name];
  if (v == null) return fallback;
  return String(v).toLowerCase() === "true";
}

export function deepMerge(a, b) {
  if (!b || typeof b !== "object") return a;
  const out = Array.isArray(a) ? [...a] : { ...(a ?? {}) };
  for (const [k, v] of Object.entries(b)) {
    const av = out[k];
    if (v && typeof v === "object" && !Array.isArray(v) && av && typeof av === "object" && !Array.isArray(av)) {
      out[k] = deepMerge(av, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function normalizeIntervalMs(value, fallback) {
  const ms = Number(value);
  if (!ms || Number.isNaN(ms) || ms < 1000) return fallback;
  return Math.floor(ms);
}

export function normalizeNumber(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

export function normalizeHourUtc(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const h = Math.floor(n);
  if (h < 0 || h > 23) return fallback;
  return h;
}

export function defaultConfig() {
  return {
    intervalMs: 60000,
    offline: {
      enabled: false,
      auto: true,
      storePath: ".base44-offline-store.json"
    },
    health: {
      requirePayPal: false
    },
    real: {
      executionLoop: true
    },
    payout: {
      settlementId: null,
      beneficiary: null,
      recipientType: null,
      dryRun: true,
      minAvailableBalance: 0,
      windowUtc: {
        startHourUtc: 0,
        endHourUtc: 0
      },
      syncPayPalLimit: 25,
      syncPayPalMinAgeMinutes: 10,
      export: {
        payoneerOutDir: "out/payoneer"
      },
      autoApprove: {
        enabled: false,
        pendingAgeMinutes: 120,
        maxBatchAmount: 0,
        totp: null
      }
    },
    deadman: {
      intervalMs: 300000,
      thresholds: {
        webhookSilenceHours: 4,
        metricFailureCount: 3,
        metricWindowMinutes: 30
      }
    },
    tasks: {
      health: true,
      missionHealth: false,
      availableBalance: true,
      reportPendingApproval: true,
      reportStuckPayouts: true,
      deadman: true,
      createPayoutBatches: false,
      autoApprovePayoutBatches: false,
      autoSubmitPayPalPayoutBatches: false,
      syncPayPalLedgerBatches: false,
      autoExportPayoneerPayoutBatches: false,
      revenueSwarm: false,
      philanthropyAudit: true
    },
    alerts: {
      enabled: false,
      cooldownMs: 900000
    },
    missionHealth: {
      missionId: null,
      limit: 50
    },
    state: {
      path: ".autonomous-state.json"
    },
    backoff: {
      maxMs: 300000
    }
  };
}

export async function loadAutonomousConfig({ configPath }) {
  const resolved = configPath ? path.resolve(process.cwd(), String(configPath)) : path.resolve(process.cwd(), "autonomous.txt");
  const raw = await fs.readFile(resolved, "utf8").catch(() => "");
  const trimmed = String(raw).trim();
  if (!trimmed) return { configPath: resolved, config: {} };
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object") return { configPath: resolved, config: {} };
  return { configPath: resolved, config: parsed };
}

export function resolveRuntimeConfig(args, fileCfg) {
  const cfg = deepMerge(defaultConfig(), fileCfg ?? {});

  const intervalMs = normalizeIntervalMs(args["interval-ms"] ?? args.intervalMs ?? process.env.AUTONOMOUS_INTERVAL_MS, cfg.intervalMs);

  const offlineEnabled =
    args.offline === true ||
    getEnvBool("BASE44_OFFLINE", false) ||
    getEnvBool("BASE44_OFFLINE_MODE", false) ||
    getEnvBool("npm_config_offline", false) ||
    getEnvBool("NPM_CONFIG_OFFLINE", false) ||
    cfg.offline?.enabled === true;

  const offlineStorePath =
    args["offline-store"] ??
    args.offlineStore ??
    process.env.BASE44_OFFLINE_STORE_PATH ??
    cfg.offline?.storePath ??
    ".base44-offline-store.json";

  const offlineAuto = cfg.offline?.auto !== false;

  const payoutSettlementId = args["payout-settlement-id"] ?? process.env.PAYOUT_SETTLEMENT_ID ?? cfg.payout?.settlementId ?? null;
  const payoutBeneficiary = args["payout-beneficiary"] ?? process.env.PAYOUT_BENEFICIARY ?? cfg.payout?.beneficiary ?? null;
  const payoutRecipientType = args["payout-recipient-type"] ?? process.env.PAYOUT_RECIPIENT_TYPE ?? cfg.payout?.recipientType ?? null;

  const payoneerOutDir =
    args["payoneer-out-dir"] ??
    args.payoneerOutDir ??
    process.env.AUTONOMOUS_PAYONEER_OUT_DIR ??
    cfg.payout?.export?.payoneerOutDir ??
    "out/payoneer";

  const bankWireOutDir =
    args["bank-wire-out-dir"] ??
    args.bankWireOutDir ??
    process.env.AUTONOMOUS_BANK_WIRE_OUT_DIR ??
    cfg.payout?.export?.bankWireOutDir ??
    "out/bank-wire";

  const payoutDryRun =
    args["payout-live"] === true
      ? false
      : cfg.payout?.dryRun !== false && getEnvBool("AUTONOMOUS_PAYOUT_LIVE", false) !== true;

  const minAvailableBalance = normalizeNumber(
    args["min-available-balance"] ?? process.env.AUTONOMOUS_MIN_AVAILABLE_BALANCE ?? cfg.payout?.minAvailableBalance ?? 0,
    0
  );

  const startHourUtc = normalizeHourUtc(
    args["payout-window-start-utc"] ?? process.env.AUTONOMOUS_PAYOUT_WINDOW_START_UTC ?? cfg.payout?.windowUtc?.startHourUtc ?? 0,
    0
  );
  const endHourUtc = normalizeHourUtc(
    args["payout-window-end-utc"] ?? process.env.AUTONOMOUS_PAYOUT_WINDOW_END_UTC ?? cfg.payout?.windowUtc?.endHourUtc ?? 0,
    0
  );

  const syncPayPalLedgerEnabled =
    args["sync-paypal-ledger"] === true ||
    getEnvBool("AUTONOMOUS_SYNC_PAYPAL_LEDGER", false) ||
    cfg.tasks?.syncPayPalLedgerBatches === true;
  const syncPayPalLimit = normalizeNumber(
    args["sync-paypal-limit"] ?? process.env.AUTONOMOUS_SYNC_PAYPAL_LIMIT ?? cfg.payout?.syncPayPalLimit ?? 25,
    25
  );
  const syncPayPalMinAgeMinutes = normalizeNumber(
    args["sync-paypal-min-age-minutes"] ?? process.env.AUTONOMOUS_SYNC_PAYPAL_MIN_AGE_MINUTES ?? cfg.payout?.syncPayPalMinAgeMinutes ?? 10,
    10
  );

  const createPayoutBatchesEnabled =
    args["create-payout-batches"] === true ||
    args.createPayoutBatches === true ||
    getEnvBool("AUTONOMOUS_CREATE_PAYOUT_BATCHES", false) ||
    cfg.tasks?.createPayoutBatches === true;

  const autoApproveEnabled =
    args["auto-approve-payouts"] === true ||
    args.autoApprovePayouts === true ||
    getEnvBool("AUTONOMOUS_AUTO_APPROVE_PAYOUTS", false) ||
    cfg.payout?.autoApprove?.enabled === true;
  const pendingAgeMinutes = normalizeNumber(
    args["auto-approve-pending-age-minutes"] ??
      process.env.AUTONOMOUS_AUTO_APPROVE_PENDING_AGE_MINUTES ??
      cfg.payout?.autoApprove?.pendingAgeMinutes ??
      120,
    120
  );
  const maxBatchAmount = normalizeNumber(
    args["auto-approve-max-batch-amount"] ??
      process.env.AUTONOMOUS_AUTO_APPROVE_MAX_BATCH_AMOUNT ??
      cfg.payout?.autoApprove?.maxBatchAmount ??
      0,
    0
  );
  const totp =
    args["auto-approve-totp"] ?? process.env.AUTONOMOUS_AUTO_APPROVE_TOTP ?? cfg.payout?.autoApprove?.totp ?? null;

  // The env names drifted: deploy-live.ps1 and the tests use the _PAYOUT_BATCHES
  // form, older setups use _PAYOUTS, and the deploy script also exports
  // AUTONOMOUS_AUTO_SUBMIT_PAYPAL. Accept every alias so enabling the task does
  // not silently depend on which spelling was documented last.
  const autoSubmitPayPalPayoutBatchesEnabled =
    args["auto-submit-paypal-payouts"] === true ||
    getEnvBool("AUTONOMOUS_AUTO_SUBMIT_PAYPAL_PAYOUTS", false) ||
    getEnvBool("AUTONOMOUS_AUTO_SUBMIT_PAYPAL_PAYOUT_BATCHES", false) ||
    getEnvBool("AUTONOMOUS_AUTO_SUBMIT_PAYPAL", false) ||
    cfg.tasks?.autoSubmitPayPalPayoutBatches === true;

  const autoExportPayoneerPayoutBatchesEnabled =
    args["auto-export-payoneer-payouts"] === true ||
    getEnvBool("AUTONOMOUS_AUTO_EXPORT_PAYONEER_PAYOUTS", false) ||
    getEnvBool("AUTONOMOUS_AUTO_EXPORT_PAYONEER_PAYOUT_BATCHES", false) ||
    cfg.tasks?.autoExportPayoneerPayoutBatches === true;

  const autoExportBankWirePayoutBatchesEnabled =
    args["auto-export-bank-wire-payouts"] === true ||
    getEnvBool("AUTONOMOUS_AUTO_EXPORT_BANK_WIRE_PAYOUTS", false) ||
    cfg.tasks?.autoExportBankWirePayoutBatches === true;

  const healthEnabled =
    args.health !== false &&
    process.env.AUTONOMOUS_HEALTH_CHECK !== "false" &&
    cfg.tasks?.health !== false;

  const missionHealthEnabled =
    args["mission-health"] === true ||
    getEnvBool("AUTONOMOUS_MISSION_HEALTH", false) ||
    cfg.tasks?.missionHealth === true;
  const missionHealthMissionId =
    args["mission-health-id"] ?? process.env.AUTONOMOUS_MISSION_HEALTH_ID ?? cfg.missionHealth?.missionId ?? null;
  const missionHealthLimit =
    args["mission-health-limit"] ?? process.env.AUTONOMOUS_MISSION_HEALTH_LIMIT ?? cfg.missionHealth?.limit ?? 50;

  const deadmanEnabled =
    args.deadman !== false &&
    process.env.AUTONOMOUS_DEADMAN_CHECK !== "false" &&
    cfg.tasks?.deadman !== false;
  const deadmanIntervalMs = normalizeIntervalMs(
    args["deadman-interval-ms"] ?? process.env.AUTONOMOUS_DEADMAN_INTERVAL_MS ?? cfg.deadman?.intervalMs,
    300000
  );
  const webhookSilenceHours = normalizeNumber(
    args["deadman-webhook-silence-hours"] ??
      process.env.AUTONOMOUS_DEADMAN_WEBHOOK_SILENCE_HOURS ??
      cfg.deadman?.thresholds?.webhookSilenceHours ??
      4,
    4
  );
  const metricFailureCount = normalizeNumber(
    args["deadman-metric-failure-count"] ??
      process.env.AUTONOMOUS_DEADMAN_METRIC_FAILURE_COUNT ??
      cfg.deadman?.thresholds?.metricFailureCount ??
      3,
    3
  );
  const metricWindowMinutes = normalizeNumber(
    args["deadman-metric-window-minutes"] ??
      process.env.AUTONOMOUS_DEADMAN_METRIC_WINDOW_MINUTES ??
      cfg.deadman?.thresholds?.metricWindowMinutes ??
      30,
    30
  );

  const statePath =
    args["state-path"] ??
    process.env.AUTONOMOUS_STATE_PATH ??
    cfg.state?.path ??
    ".autonomous-state.json";

  const alertsEnabled =
    args.alerts === true ||
    getEnvBool("AUTONOMOUS_ALERTS_ENABLED", false) ||
    cfg.alerts?.enabled === true;
  const alertCooldownMs = normalizeNumber(
    args["alert-cooldown-ms"] ?? process.env.AUTONOMOUS_ALERT_COOLDOWN_MS ?? cfg.alerts?.cooldownMs ?? 900000,
    900000
  );

  const backoffMaxMs = normalizeNumber(
    args["backoff-max-ms"] ?? process.env.AUTONOMOUS_BACKOFF_MAX_MS ?? cfg.backoff?.maxMs ?? 300000,
    300000
  );

  const revenueSwarmEnabled =
    args["revenue-swarm"] === true ||
    args.revenueSwarm === true ||
    getEnvBool("AUTONOMOUS_REVENUE_SWARM", false) ||
    cfg.tasks?.revenueSwarm === true;
  
  const philanthropyAuditEnabled =
    args["philanthropy-audit"] === true ||
    getEnvBool("AUTONOMOUS_PHILANTHROPY_AUDIT", false) ||
    cfg.tasks?.philanthropyAudit === true;

  return {
    intervalMs,
    offline: { enabled: offlineEnabled, auto: offlineAuto, storePath: String(offlineStorePath) },
    health: { requirePayPal: false }, // Simplification for shared config
    payout: {
      settlementId: payoutSettlementId ? String(payoutSettlementId) : null,
      beneficiary: payoutBeneficiary ? String(payoutBeneficiary) : null,
      recipientType: payoutRecipientType ? String(payoutRecipientType) : null,
      dryRun: payoutDryRun,
      minAvailableBalance: Number(minAvailableBalance ?? 0),
      windowUtc: { startHourUtc, endHourUtc },
      syncPayPalLimit: Number(syncPayPalLimit ?? 25),
      syncPayPalMinAgeMinutes: Number(syncPayPalMinAgeMinutes ?? 10),
      export: { 
        payoneerOutDir: String(payoneerOutDir),
        bankWireOutDir: String(bankWireOutDir)
      },
      autoApprove: {
        enabled: autoApproveEnabled === true,
        pendingAgeMinutes: Number(pendingAgeMinutes ?? 120),
        maxBatchAmount: maxBatchAmount == null ? null : Number(maxBatchAmount),
        totp: totp == null ? null : String(totp)
      }
    },
    deadman: {
      intervalMs: deadmanIntervalMs,
      thresholds: { webhookSilenceHours, metricFailureCount, metricWindowMinutes }
    },
    tasks: {
      health: healthEnabled,
      missionHealth: missionHealthEnabled === true,
      availableBalance: cfg.tasks?.availableBalance !== false,
      reportPendingApproval: cfg.tasks?.reportPendingApproval !== false,
      reportStuckPayouts: cfg.tasks?.reportStuckPayouts !== false,
      deadman: deadmanEnabled === true,
      createPayoutBatches: createPayoutBatchesEnabled === true,
      autoApprovePayoutBatches: autoApproveEnabled === true,
      autoSubmitPayPalPayoutBatches: autoSubmitPayPalPayoutBatchesEnabled === true,
      syncPayPalLedgerBatches: syncPayPalLedgerEnabled === true,
      autoExportPayoneerPayoutBatches: autoExportPayoneerPayoutBatchesEnabled === true,
      autoExportBankWirePayoutBatches: autoExportBankWirePayoutBatchesEnabled === true,
      revenueSwarm: revenueSwarmEnabled === true,
      philanthropyAudit: philanthropyAuditEnabled === true
    },
    alerts: { enabled: alertsEnabled, cooldownMs: alertCooldownMs },
    missionHealth: {
      missionId: missionHealthMissionId ? String(missionHealthMissionId) : null,
      limit: Number(missionHealthLimit ?? 50)
    },
    state: { path: String(statePath) },
    backoff: { maxMs: backoffMaxMs }
  };
}
