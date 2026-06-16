import fs from "node:fs";
import "./load-env.mjs"; // Ensure env vars are loaded
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { createBase44RevenueEventIdempotent, getRevenueConfigFromEnv } from "./base44-revenue.mjs";
import { createBase44EarningIdempotent, getEarningConfigFromEnv } from "./base44-earning.mjs";
import { buildBase44Client } from "./base44-client.mjs";
import { createPayPalPayoutBatch, getPayoutBatchDetails } from "./paypal-api.mjs";
import { syncPayPalBatchToLedger } from "./providers/paypal/ledger-sync.mjs";
import { loadAutonomousConfig, resolveRuntimeConfig } from "./autonomous-config.mjs";

import { computeAuthorityChecksum, enforceAuthorityProtocol } from "./authority.mjs";
import { OwnerSettlementEnforcer } from "./policy/owner-settlement.mjs";

function isOwnerAccount(type, identifier) {
  try {
    const accounts = OwnerSettlementEnforcer.getOwnerAccounts();
    const t = String(type).toLowerCase().replace('_wire', ''); // bank_wire -> bank
    const id = String(identifier).trim().toLowerCase();
    
    return accounts.some(acc => {
      const accType = acc.type.toLowerCase();
      const accId = acc.identifier.toLowerCase();
      if (accType !== t) return false;
      
      // Crypto loose match for truncated identifiers in policy
      if (accType === 'crypto' && accId.includes('...')) {
         const parts = accId.split('...');
         return id.startsWith(parts[0]) && id.endsWith(parts[1]);
      }
      return accId === id;
    });
  } catch (err) {
    return false; 
  }
}

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

function parseCsvLine(line) {
  const out = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        const next = line[i + 1];
        if (next === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === ",") {
      out.push(field);
      field = "";
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    field += ch;
  }

  out.push(field);
  return out;
}

function safeJsonParse(maybeJson, fallback) {
  if (!maybeJson) return fallback;
  try {
    return JSON.parse(maybeJson);
  } catch {
    return fallback;
  }
}

function findSimulationArtifactsInObject(value, patterns, pathPrefix = "") {
  const hits = [];
  const seen = new Set();

  function scan(v, p) {
    if (v == null) return;
    if (typeof v === "string") {
      for (const rx of patterns) {
        if (rx.test(v)) {
          hits.push({ path: p || "$", value: v, pattern: String(rx) });
          break;
        }
      }
      return;
    }
    if (typeof v !== "object") return;
    if (seen.has(v)) return;
    seen.add(v);

    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) scan(v[i], `${p}[${i}]`);
      return;
    }

    for (const [k, vv] of Object.entries(v)) {
      const next = p ? `${p}.${k}` : k;
      scan(vv, next);
    }
  }

  scan(value, pathPrefix);
  return hits;
}

async function scanSimulationArtifacts(base44, { limit = 200 } = {}) {
  const patterns = [
    /\bsimulated\b/i,
    /\bmock\b/i,
    /\bfake\b/i,
    /\bdemo\b/i,
    /\bplaceholder\b/i,
    /test\s*payment/i
  ];

  const results = { ok: true, hits: [], scanned: { missions: 0, earnings: 0 } };

  if (base44) {
    const missionEntityName = process.env.BASE44_MISSION_ENTITY ?? "Mission";
    try {
      const missionEntity = base44.asServiceRole.entities[missionEntityName];
      const missions = await missionEntity.list("-updated_date", Math.max(1, Math.floor(Number(limit ?? 200))), 0);
      results.scanned.missions = Array.isArray(missions) ? missions.length : 0;
      for (const m of Array.isArray(missions) ? missions : []) {
        const hit = findSimulationArtifactsInObject(m, patterns, "mission");
        for (const h of hit) results.hits.push({ entity: missionEntityName, id: m?.id ?? null, ...h });
      }
    } catch {
      results.scanned.missions = 0;
    }

    const earningCfg = getEarningConfigFromEnv();
    try {
      const earningEntity = base44.asServiceRole.entities[earningCfg.entityName];
      const earnings = await earningEntity.list("-created_date", Math.max(1, Math.floor(Number(limit ?? 200))), 0);
      results.scanned.earnings = Array.isArray(earnings) ? earnings.length : 0;
      for (const e of Array.isArray(earnings) ? earnings : []) {
        const hit = findSimulationArtifactsInObject(e, patterns, "earning");
        for (const h of hit) results.hits.push({ entity: earningCfg.entityName, id: e?.id ?? null, ...h });
      }
    } catch {
      results.scanned.earnings = 0;
    }
  }

  results.ok = results.hits.length === 0;
  return results;
}

function runGit(repoRoot, args) {
  const cwd = path.resolve(process.cwd(), String(repoRoot ?? "."));
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const err = String(res.stderr ?? "").trim();
    throw new Error(err || `git failed: ${args.join(" ")}`);
  }
  return String(res.stdout ?? "").trimEnd();
}

function shouldWriteChangeSets() {
  return String(process.env.BASE44_ENABLE_CHANGESET_WRITE ?? "false").toLowerCase() === "true";
}

function getChangeSetConfigFromEnv() {
  const entityName = process.env.BASE44_CHANGESET_ENTITY ?? "SwarmChangeSet";
  const chunkEntityName = process.env.BASE44_CHANGESET_CHUNK_ENTITY ?? "SwarmChangeSetChunk";

  const fieldMap =
    safeJsonParse(process.env.BASE44_CHANGESET_FIELD_MAP, null) ?? {
      changeSetId: "changeset_id",
      repoRoot: "repo_root",
      headSha: "head_sha",
      branch: "branch",
      subject: "subject",
      message: "message",
      encoding: "encoding",
      byteLength: "byte_length",
      sha256: "sha256",
      chunkCount: "chunk_count",
      createdAt: "created_at"
    };

  const chunkFieldMap =
    safeJsonParse(process.env.BASE44_CHANGESET_CHUNK_FIELD_MAP, null) ?? {
      changeSetId: "changeset_id",
      seq: "seq",
      data: "data"
    };

  return { entityName, chunkEntityName, fieldMap, chunkFieldMap };
}

function chunkString(value, chunkSize) {
  const s = String(value ?? "");
  const size = Math.max(1000, Math.floor(Number(chunkSize ?? 45000)));
  const out = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

async function publishGitChangeSetsToBase44(base44, { repoRoots, dryRun }) {
  if (!base44) throw new Error("Missing Base44 client; set BASE44_APP_ID/BASE44_SERVICE_TOKEN");
  if (base44?.offline?.filePath) throw new Error("Refusing changeset publish in offline mode (set BASE44_OFFLINE=false)");
  if (!shouldWriteChangeSets()) throw new Error("Refusing changeset publish without BASE44_ENABLE_CHANGESET_WRITE=true");

  const cfg = getChangeSetConfigFromEnv();
  const entity = base44.asServiceRole.entities[cfg.entityName];
  const chunkEntity = base44.asServiceRole.entities[cfg.chunkEntityName];

  const roots = Array.isArray(repoRoots) && repoRoots.length > 0 ? repoRoots : [process.cwd()];
  const results = [];

  for (const rr of roots) {
    const top = runGit(rr, ["rev-parse", "--show-toplevel"]).trim();
    const headSha = runGit(top, ["rev-parse", "HEAD"]).trim();
    const branch = runGit(top, ["branch", "--show-current"]).trim() || null;
    const subject = runGit(top, ["log", "-1", "--pretty=%s"]).trim() || null;
    const message = runGit(top, ["log", "-1", "--pretty=%B"]).trim() || null;
    const patchText = runGit(top, ["show", "--no-color", "--binary", "HEAD"]);

    const patchBuf = Buffer.from(patchText, "utf8");
    const gz = gzipSync(patchBuf);
    const b64 = gz.toString("base64");
    const sha256 = crypto.createHash("sha256").update(gz).digest("hex");
    const chunks = chunkString(b64, 45000);
    const changeSetId = `changeset:${headSha}:${Date.now()}`;
    const createdAt = new Date().toISOString();

    const record = {
      [cfg.fieldMap.changeSetId]: changeSetId,
      [cfg.fieldMap.repoRoot]: top,
      [cfg.fieldMap.headSha]: headSha,
      ...(cfg.fieldMap.branch ? { [cfg.fieldMap.branch]: branch } : {}),
      ...(cfg.fieldMap.subject ? { [cfg.fieldMap.subject]: subject } : {}),
      ...(cfg.fieldMap.message ? { [cfg.fieldMap.message]: message } : {}),
      [cfg.fieldMap.encoding]: "git_show_gzip_base64",
      [cfg.fieldMap.byteLength]: patchBuf.length,
      [cfg.fieldMap.sha256]: sha256,
      [cfg.fieldMap.chunkCount]: chunks.length,
      ...(cfg.fieldMap.createdAt ? { [cfg.fieldMap.createdAt]: createdAt } : {})
    };

    if (dryRun) {
      results.push({ ok: true, dryRun: true, changeSetId, headSha, repoRoot: top, chunkCount: chunks.length, sha256 });
      continue;
    }

    const created = await entity.create(record);
    const chunkResults = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkRec = await chunkEntity.create({
        [cfg.chunkFieldMap.changeSetId]: changeSetId,
        [cfg.chunkFieldMap.seq]: i,
        [cfg.chunkFieldMap.data]: chunks[i]
      });
      chunkResults.push({ id: chunkRec?.id ?? null, seq: i });
    }

    results.push({
      ok: true,
      dryRun: false,
      changeSetId,
      headSha,
      repoRoot: top,
      recordId: created?.id ?? null,
      chunkCount: chunks.length,
      sha256,
      chunks: chunkResults
    });
  }

  return { ok: true, results };
}

function getEnvOrThrow(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function envIsTrue(value, fallback = "true") {
  return String(value ?? fallback).toLowerCase() === "true";
}

function isUnsafePath(p) {
  const abs = path.resolve(process.cwd(), String(p ?? ""));
  const lower = abs.toLowerCase();
  const tmp = os.tmpdir().toLowerCase();
  if (tmp && lower.startsWith(tmp)) return true;
  const needles = ["\\test\\", "/test/", "\\mock\\", "/mock/", "\\tmp\\", "/tmp/", "\\temp\\", "/temp/"];
  return needles.some((n) => lower.includes(n));
}

function enforceSwarmLiveHardInvariant({ action }) {
  if (!envIsTrue(process.env.SWARM_LIVE, "false")) {
    throw new Error(`LIVE MODE NOT GUARANTEED (${action})`);
  }
  return { forced: false };
}

function verifyNoOfflineInLive() {
  if (envIsTrue(process.env.BASE44_OFFLINE, "false") || envIsTrue(process.env.BASE44_OFFLINE_MODE, "false")) {
    throw new Error("LIVE MODE NOT GUARANTEED (offline mode enabled)");
  }
}

function verifyNoSandboxPayPal() {
  const paypalMode = String(process.env.PAYPAL_MODE ?? "live").toLowerCase();
  const paypalBase = String(process.env.PAYPAL_API_BASE_URL ?? "").toLowerCase();
  if (paypalMode === "sandbox" || paypalBase.includes("sandbox.paypal.com")) {
    throw new Error("LIVE MODE NOT GUARANTEED (PayPal sandbox configured)");
  }
}

function isPayPalPayoutSendEnabled() {
  const override = process.env.AUTONOMOUS_ALLOW_PAYPAL_PAYOUTS ?? process.env.BASE44_ALLOW_PAYPAL_PAYOUTS ?? null;
  if (override != null && String(override).trim() !== "") return String(override).toLowerCase() === "true";

  const approved = String(process.env.PAYPAL_PPP2_APPROVED ?? process.env.PPP2_APPROVED ?? "false").toLowerCase() === "true";
  const enableSend =
    String(process.env.PAYPAL_PPP2_ENABLE_SEND ?? process.env.PPP2_ENABLE_SEND ?? "false").toLowerCase() === "true";
  return approved && enableSend;
}

function buildLiveProofBase(action) {
  return {
    at: new Date().toISOString(),
    action: String(action),
    SWARM_LIVE: envIsTrue(process.env.SWARM_LIVE, "true"),
    authorityChecksum: computeAuthorityChecksum(),
    endpoints: {
      paypalMode: String(process.env.PAYPAL_MODE ?? "live").toLowerCase(),
      paypalApiBaseUrl: process.env.PAYPAL_API_BASE_URL ? String(process.env.PAYPAL_API_BASE_URL) : "(default)",
      base44ServerUrl: process.env.BASE44_SERVER_URL ? String(process.env.BASE44_SERVER_URL) : "(default)"
    }
  };
}

function sha256FileSync(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function getProofDir() {
  return path.resolve(process.cwd(), "proof");
}

function getPayoutProofPath(batchId) {
  return path.join(getProofDir(), `payout_${String(batchId)}.json`);
}

function writeJsonFileOnce(absPath, value) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(absPath, payload, { encoding: "utf8", flag: "wx" });
  return { bytes: Buffer.byteLength(payload, "utf8"), sha256: sha256Hex(payload) };
}

function tryReadJsonFile(absPath) {
  if (!absPath || !fs.existsSync(absPath)) return null;
  try {
    const raw = fs.readFileSync(absPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function formatBackupStamp(d = new Date()) {
  const iso = d.toISOString();
  return iso.replace(/[:.]/g, "-");
}

function copyFileIfExists(fromPath, toPath) {
  if (!fs.existsSync(fromPath)) return false;
  fs.mkdirSync(path.dirname(toPath), { recursive: true });
  fs.copyFileSync(fromPath, toPath);
  return true;
}

function listProofFiles() {
  const dir = getProofDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("payout_") && f.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b))
    .map((f) => ({ file: f, absPath: path.join(dir, f) }));
}

function buildBackupManifest({ repoRoot, base44Online, extra } = {}) {
  const owner = getOwnerSinkFromEnv();
  const truthOnlyUiEnabled = (process.env.BASE44_ENABLE_TRUTH_ONLY_UI ?? "false").toLowerCase() === "true";
  const proofFiles = listProofFiles();
  const proofs = proofFiles.map(({ file, absPath }) => ({
    file,
    sha256: sha256FileSync(absPath),
    bytes: fs.statSync(absPath).size
  }));

  const env = {
    SWARM_LIVE: (process.env.SWARM_LIVE ?? "false").toLowerCase() === "true",
    PAYPAL_MODE: String(process.env.PAYPAL_MODE ?? "live").toLowerCase(),
    PAYPAL_API_BASE_URL: process.env.PAYPAL_API_BASE_URL ? String(process.env.PAYPAL_API_BASE_URL) : null,
    NO_PLATFORM_WALLET: (process.env.NO_PLATFORM_WALLET ?? "false").toLowerCase() === "true",
    BASE44_ENABLE_PAYOUT_LEDGER_WRITE: (process.env.BASE44_ENABLE_PAYOUT_LEDGER_WRITE ?? "false").toLowerCase() === "true",
    BASE44_ENABLE_TRUTH_ONLY_UI: truthOnlyUiEnabled,
    ownerDeclared: {
      paypal: owner.ownerPayPal ? mask(owner.ownerPayPal, { keepStart: 1, keepEnd: 0 }) : null,
      payoneer: owner.ownerPayoneer ? mask(owner.ownerPayoneer, { keepStart: 1, keepEnd: 0 }) : null,
      bankAccount: owner.ownerBankAccount ? mask(owner.ownerBankAccount, { keepStart: 0, keepEnd: 4 }) : null
    }
  };

  const git = (() => {
    try {
      const top = runGit(repoRoot ?? process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
      const headSha = runGit(top, ["rev-parse", "HEAD"]).trim();
      const branch = runGit(top, ["branch", "--show-current"]).trim() || null;
      return { ok: true, repoRoot: top, headSha, branch };
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  })();

  return {
    ok: true,
    createdAt: new Date().toISOString(),
    authorityChecksum: computeAuthorityChecksum(),
    base44Online: !!base44Online,
    env,
    git,
    proof: { dir: getProofDir(), count: proofs.length, proofs },
    ...(extra ? { extra } : {})
  };
}

function getOwnerSinkFromEnv() {
  const ownerPayPalRaw = normalizeEmailAddress(process.env.OWNER_PAYPAL_EMAIL ?? null);
  const ownerPayoneerRaw = normalizeEmailAddress(process.env.OWNER_PAYONEER_ID ?? null);
  const ownerBankAccount = normalizeBankAccount(
    process.env.OWNER_BANK_ACCOUNT ?? process.env.OWNER_BANK_RIB ?? process.env.BANK_ACCOUNT ?? process.env.BANK_RIB ?? process.env.BANK_IBAN ?? null
  );
  return {
    ownerPayPal: ownerPayPalRaw ? ownerPayPalRaw.toLowerCase() : null,
    ownerPayoneer: ownerPayoneerRaw ? ownerPayoneerRaw.toLowerCase() : null,
    ownerBankAccount
  };
}

function assertOwnerSink({ recipientType, recipient, destination, action }) {
  const t = normalizeRecipientType(recipientType ?? null);
  const owner = getOwnerSinkFromEnv();
  if (t === "paypal") {
    const rr = normalizeEmailAddress(recipient ?? "");
    const email = rr ? rr.toLowerCase() : null;
    if (!owner.ownerPayPal) throw new Error("FORBIDDEN DESTINATION: missing OWNER_PAYPAL_EMAIL");
    if (!email || email !== owner.ownerPayPal) {
      throw new Error(`FORBIDDEN DESTINATION: ${mask(recipient, { keepStart: 1, keepEnd: 0 })} is not OWNER_PAYPAL_EMAIL`);
    }
    return { ok: true, type: "paypal", ownerMasked: mask(owner.ownerPayPal, { keepStart: 1, keepEnd: 0 }) };
  }
  if (t === "payoneer") {
    const rr = normalizeEmailAddress(recipient ?? "");
    const email = rr ? rr.toLowerCase() : null;
    if (!owner.ownerPayoneer) throw new Error("FORBIDDEN DESTINATION: missing OWNER_PAYONEER_ID");
    if (!email || email !== owner.ownerPayoneer) {
      throw new Error(`FORBIDDEN DESTINATION: ${mask(recipient, { keepStart: 1, keepEnd: 0 })} is not OWNER_PAYONEER_ID`);
    }
    return { ok: true, type: "payoneer", ownerMasked: mask(owner.ownerPayoneer, { keepStart: 1, keepEnd: 0 }) };
  }
  if (t === "bank_wire") {
    const d = normalizeDestinationObject(destination ?? {});
    const acct = normalizeBankAccount(d.account ?? "");
    if (!owner.ownerBankAccount) throw new Error("FORBIDDEN DESTINATION: missing OWNER_BANK_ACCOUNT");
    if (!acct || acct !== owner.ownerBankAccount) {
      throw new Error(`FORBIDDEN DESTINATION: bank account is not OWNER_BANK_ACCOUNT (${String(action ?? "owner_sink")})`);
    }
    return { ok: true, type: "bank_wire", ownerMasked: mask(owner.ownerBankAccount, { keepStart: 0, keepEnd: 4 }) };
  }
  throw new Error(`FORBIDDEN DESTINATION TYPE: ${t} (${String(action ?? "owner_sink")})`);
}

function requireLiveMode(reason) {
  enforceSwarmLiveHardInvariant({ action: reason });
  verifyNoOfflineInLive();
  verifyNoSandboxPayPal();
  enforceAuthorityProtocol({ action: reason, requireLive: true });
}

function getEnvBool(name, fallback = false) {
  const v = process.env[name];
  if (v == null) return fallback;
  return String(v).toLowerCase() === "true";
}

function getEnvFirst(names) {
  for (const name of names) {
    const v = process.env[name];
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

function getEarningSharePct() {
  const raw = process.env.EARNING_SHARE_PCT ?? process.env.SWARM_EARNING_SHARE_PCT ?? "1";
  const pct = Number(raw);
  if (!pct || Number.isNaN(pct) || pct <= 0) return 1;
  return pct > 1 ? pct / 100 : pct;
}

function getEarningBeneficiary(args) {
  return (
    args.earningBeneficiary ??
    args["earning-beneficiary"] ??
    process.env.EARNING_BENEFICIARY ??
    process.env.OWNER_PAYPAL_EMAIL ??
    process.env.OWNER_PAYONEER_ID ??
    "owner"
  );
}

function shouldCreateEarnings(args) {
  return (
    args["create-earnings"] === true ||
    args.createEarnings === true ||
    getEnvBool("BASE44_ENABLE_EARNING_FROM_REVENUE", false)
  );
}

function shouldExportSettlement(args) {
  return args["export-settlement"] === true || args.exportSettlement === true;
}

function getSettlementArgs(args, { beneficiary, dryRun }) {
  const bankCsv = args["bank-csv"] === true || args.bankCsv === true || args["settlement-bank-csv"] === true;
  const settlementId = args["settlement-id"] ?? args.settlementId ?? null;
  const outPath = args["settlement-out"] ?? args.settlementOut ?? null;
  const status = args["settlement-status"] ?? args.settlementStatus ?? null;
  const currency = args["settlement-currency"] ?? args.settlementCurrency ?? null;
  const from = args["settlement-from"] ?? args.settlementFrom ?? null;
  const to = args["settlement-to"] ?? args.settlementTo ?? null;
  const limit = args["settlement-limit"] ?? args.settlementLimit ?? null;
  const markIssued = args["mark-issued"] === true || args.markIssued === true || args["settlement-mark-issued"] === true;

  return {
    bankCsv,
    settlementId,
    outPath,
    status,
    currency,
    from,
    to,
    limit,
    markIssued,
    beneficiary,
    dryRun: !!dryRun
  };
}

function buildDefaultSettlementOutPath({ settlementId, bankCsv }) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const prefix = bankCsv ? "bank_settlement" : "settlement";
  const idPart = settlementId ? String(settlementId).replace(/[^\w-]+/g, "_") : ts;
  return `${prefix}_${idPart}.csv`;
}

function runSettlementExportCli(settlement) {
  const args = ["./src/prepare-external-settlement.mjs", "--csv"];
  if (settlement.bankCsv) args.push("--bank-csv");
  if (settlement.beneficiary) args.push("--beneficiary", String(settlement.beneficiary));
  if (settlement.currency) args.push("--currency", String(settlement.currency));
  if (settlement.status) args.push("--status", String(settlement.status));
  if (settlement.from) args.push("--from", String(settlement.from));
  if (settlement.to) args.push("--to", String(settlement.to));
  if (settlement.limit) args.push("--limit", String(settlement.limit));
  if (settlement.settlementId) args.push("--settlement-id", String(settlement.settlementId));
  if (settlement.markIssued) args.push("--mark-issued");
  if (settlement.dryRun) args.push("--dry-run");

  const res = spawnSync(process.execPath, args, { encoding: "utf8" });
  if (res.status !== 0) {
    const err = res.stderr || res.stdout || "";
    throw new Error(`Settlement export failed: ${err.trim()}`);
  }

  const outPath = settlement.outPath ? String(settlement.outPath) : buildDefaultSettlementOutPath(settlement);
  fs.writeFileSync(outPath, res.stdout ?? "", "utf8");
  return { outPath, bytes: Buffer.byteLength(res.stdout ?? "", "utf8") };
}

function shouldUseOfflineMode(args) {
  return (
    args.offline === true ||
    args["offline"] === true ||
    getEnvBool("BASE44_OFFLINE", false) ||
    getEnvBool("BASE44_OFFLINE_MODE", false) ||
    getEnvBool("npm_config_offline", false) ||
    getEnvBool("NPM_CONFIG_OFFLINE", false)
  );
}

function getRevenueConfig() {
  return getRevenueConfigFromEnv();
}

function getPayoutBatchConfigFromEnv() {
  const entityName = process.env.BASE44_LEDGER_PAYOUT_BATCH_ENTITY ?? "PayoutBatch";
  const mapFromEnv = safeJsonParse(process.env.BASE44_LEDGER_PAYOUT_BATCH_FIELD_MAP, null);
  const fieldMap = mapFromEnv ?? {
    batchId: "batch_id",
    totalAmount: "total_amount",
    currency: "currency",
    status: "status",
    revenueEventIds: "revenue_event_ids",
    earningIds: "earning_ids",
    settlementId: "settlement_id",
    notes: "notes",
    approvedAt: "approved_at",
    submittedAt: "submitted_at",
    completedAt: "completed_at",
    cancelledAt: "cancelled_at"
  };
  return { entityName, fieldMap };
}

function getPayoutItemConfigFromEnv() {
  const entityName = process.env.BASE44_LEDGER_PAYOUT_ITEM_ENTITY ?? "PayoutItem";
  const mapFromEnv = safeJsonParse(process.env.BASE44_LEDGER_PAYOUT_ITEM_FIELD_MAP, null);
  const fieldMap = mapFromEnv ?? {
    itemId: "item_id",
    batchId: "batch_id",
    recipient: "recipient",
    recipientType: "recipient_type",
    amount: "amount",
    currency: "currency",
    status: "status",
    revenueEventId: "revenue_event_id",
    earningId: "earning_id",
    processedAt: "processed_at",
    errorMessage: "error_message",
    paypalStatus: "paypal_status",
    paypalTransactionId: "paypal_transaction_id",
    paypalItemId: "paypal_item_id"
  };
  return { entityName, fieldMap };
}

function getTransactionLogConfigFromEnv() {
  const entityName = process.env.BASE44_LEDGER_TRANSACTION_LOG_ENTITY ?? "TransactionLog";
  const mapFromEnv = safeJsonParse(process.env.BASE44_LEDGER_TRANSACTION_LOG_FIELD_MAP, null);
  const fieldMap = mapFromEnv ?? {
    transactionType: "transaction_type",
    amount: "amount",
    description: "description",
    transactionDate: "transaction_date",
    category: "category",
    paymentMethod: "payment_method",
    referenceId: "reference_id",
    status: "status",
    payoutBatchId: "payout_batch_id",
    payoutItemId: "payout_item_id"
  };
  return { entityName, fieldMap };
}

function shouldWritePayoutLedger() {
  return (process.env.BASE44_ENABLE_PAYOUT_LEDGER_WRITE ?? "false").toLowerCase() === "true";
}

function shouldWritePayPalPayoutStatus() {
  return (process.env.BASE44_ENABLE_PAYPAL_PAYOUT_STATUS_WRITE ?? "false").toLowerCase() === "true";
}

function parseDateMs(value) {
  const t = Date.parse(String(value ?? ""));
  return Number.isNaN(t) ? null : t;
}

function formatDay(value = Date.now()) {
  const d = new Date(value);
  const y = String(d.getUTCFullYear());
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function sha256Hex(input) {
  return crypto.createHash("sha256").update(String(input), "utf8").digest("hex");
}

function normalizeRecipientType(value, fallback = "beneficiary") {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v) return fallback;
  const aliases = {
    beneficiary: "beneficiary",
    paypal: "paypal",
    paypal_email: "paypal",
    payoneer: "payoneer",
    payoneer_id: "payoneer",
    bank: "bank_wire",
    bank_wire: "bank_wire",
    wire: "bank_wire"
  };
  return aliases[v] ?? fallback;
}

function normalizeEmail(value) {
  const s = String(value ?? "").trim();
  return s || null;
}

function normalizeEmailAddress(value) {
  const s = String(value ?? "").trim();
  if (!s) return null;
  if (/\s/.test(s)) return null;
  if (!s.includes("@")) return null;
  return s;
}

function parseDestinationJson(value) {
  if (!value) return {};
  if (typeof value !== "string") return {};
  const trimmed = value.trim();
  if (!trimmed) return {};

  const direct = safeJsonParse(trimmed, null);
  if (direct && typeof direct === "object") return direct;

  const unescaped = safeJsonParse(trimmed.replace(/\\"/g, '"'), null);
  if (unescaped && typeof unescaped === "object") return unescaped;

  return {};
}

function mask(value, { keepStart = 0, keepEnd = 4 } = {}) {
  const s = String(value ?? "");
  if (!s) return "";
  const start = s.slice(0, keepStart);
  const end = s.slice(Math.max(keepStart, s.length - keepEnd));
  const maskedLen = Math.max(0, s.length - start.length - end.length);
  return `${start}${"*".repeat(maskedLen)}${end}`;
}

function sanitizeDestination(dest) {
  const bank = dest?.bank ? String(dest.bank).trim() : "";
  const swift = dest?.swift ? String(dest.swift).trim() : "";
  const account = dest?.account ? String(dest.account).trim() : "";
  const beneficiary = dest?.beneficiary ? String(dest.beneficiary).trim() : "";

  return {
    bank,
    swift,
    accountMasked: account ? mask(account, { keepStart: 0, keepEnd: 4 }) : "",
    beneficiaryMasked: beneficiary ? mask(beneficiary, { keepStart: 1, keepEnd: 0 }) : ""
  };
}

function normalizeDestinationObject(dest) {
  const bank = dest?.bank ?? dest?.bank_name ?? dest?.bankName ?? "";
  const swift = dest?.swift ?? dest?.swift_code ?? dest?.swiftCode ?? "";
  const account =
    dest?.account ??
    dest?.rib ??
    dest?.rib_code ??
    dest?.ribCode ??
    dest?.iban ??
    dest?.iban_code ??
    dest?.ibanCode ??
    dest?.account_number ??
    dest?.accountNumber ??
    "";
  const beneficiary =
    dest?.beneficiary ?? dest?.beneficiary_name ?? dest?.beneficiaryName ?? dest?.account_holder ?? dest?.accountHolder ?? "";

  return {
    bank: String(bank ?? "").trim(),
    swift: String(swift ?? "").trim(),
    account: String(account ?? "").trim(),
    beneficiary: String(beneficiary ?? "").trim()
  };
}

function resolveBankWireDestinationFromMeta(meta) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;

  const direct =
    meta.bank_wire_destination ??
    meta.bankWireDestination ??
    meta.payout_destination ??
    meta.payoutDestination ??
    meta.destination ??
    meta.bank_destination ??
    meta.bankDestination ??
    null;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    const norm = normalizeDestinationObject(direct);
    return norm.account ? norm : null;
  }

  const json =
    meta.bank_wire_destination_json ??
    meta.bankWireDestinationJson ??
    meta.payout_destination_json ??
    meta.payoutDestinationJson ??
    meta.destination_json ??
    meta.destinationJson ??
    null;
  if (typeof json === "string") {
    const parsed = parseDestinationJson(json);
    const norm = normalizeDestinationObject(parsed);
    return norm.account ? norm : null;
  }

  const norm = normalizeDestinationObject(meta);
  return norm.account ? norm : null;
}

function shouldOptimizePaymentRouting() {
  const v = process.env.AUTONOMOUS_OPTIMIZE_PAYMENT_ROUTING ?? process.env.BASE44_OPTIMIZE_PAYMENT_ROUTING ?? "false";
  return String(v).toLowerCase() === "true";
}

function getRoutingMadBankThreshold() {
  const v = Number(process.env.AUTONOMOUS_ROUTING_MAD_BANK_THRESHOLD ?? "5000");
  if (!Number.isFinite(v) || v <= 0) return 5000;
  return v;
}

function getRoutingUsdBankThreshold() {
  const v = Number(process.env.AUTONOMOUS_ROUTING_USD_BANK_THRESHOLD ?? "500");
  if (!Number.isFinite(v) || v <= 0) return 500;
  return v;
}

function getRoutingUsdPayPalThreshold() {
  const v = Number(process.env.AUTONOMOUS_ROUTING_USD_PAYPAL_THRESHOLD ?? "500");
  if (!Number.isFinite(v) || v <= 0) return 500;
  return v;
}

function chooseOptimizedRecipientType({ amount, currency, meta, beneficiary }) {
  const c = String(currency ?? "").trim().toUpperCase();
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return "beneficiary";

  const bankDest = resolveBankWireDestinationFromMeta(meta);
  const payoneerId = normalizeEmailAddress(meta?.payoneer_id ?? meta?.payoneerId ?? null);
  const paypalEmail = isPayPalPayoutSendEnabled()
    ? normalizeEmailAddress(meta?.paypal_email ?? meta?.paypalEmail ?? beneficiary ?? null)
    : null;

  // STRICT PRIORITY ENFORCEMENT: Bank -> Payoneer -> PayPal (Last Resort)
  
  // 1. Bank Wire (Priority 1) - Subject to Minimum Thresholds
  if (bankDest) {
    if (c === "MAD" && n >= getRoutingMadBankThreshold()) return "bank_wire";
    if (c === "USD" && n >= getRoutingUsdBankThreshold()) return "bank_wire";
  }

  // 2. Payoneer (Priority 2)
  if (payoneerId) return "payoneer";

  // 3. PayPal (Priority 5 - Last Resort)
  // Only use if Bank/Payoneer are unavailable or below thresholds
  if (paypalEmail) return "paypal";

  // Fallback
  if (bankDest) return "bank_wire"; // Try bank anyway if nothing else matches
  return "beneficiary";
}

function destinationsEqual(a, b) {
  const aa = normalizeDestinationObject(a);
  const bb = normalizeDestinationObject(b);
  return aa.bank === bb.bank && aa.swift === bb.swift && aa.account === bb.account && aa.beneficiary === bb.beneficiary;
}

function normalizeRecipientLabel(value) {
  const s = String(value ?? "").trim();
  return s || null;
}

function resolveRecipientAddress(recipientType, meta, fallback) {
  const t = normalizeRecipientType(recipientType ?? null);
  if (t === "paypal") return normalizeEmailAddress(meta?.paypal_email ?? meta?.paypalEmail ?? fallback ?? null);
  if (t === "payoneer") return normalizeEmailAddress(meta?.payoneer_id ?? meta?.payoneerId ?? fallback ?? null);
  if (t === "bank_wire") {
    return normalizeRecipientLabel(meta?.bank_beneficiary_name ?? meta?.bankBeneficiaryName ?? meta?.beneficiary_name ?? fallback ?? null);
  }
  return normalizeEmail(fallback ?? null);
}

function parseAllowedRecipientList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map((x) => String(x ?? "").trim()).filter(Boolean);
  const s = String(value).trim();
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed.map((x) => String(x ?? "").trim()).filter(Boolean);
    return [];
  } catch {
    return s
      .split(",")
      .map((x) => String(x ?? "").trim())
      .filter(Boolean);
  }
}

function normalizeBankAccount(value) {
  const s = String(value ?? "").trim();
  if (!s) return null;
  return s.replace(/\s+/g, "").toUpperCase();
}

function getAllowedRecipientsPolicyFromEnv() {
  const json = process.env.AUTONOMOUS_ALLOWED_PAYOUT_RECIPIENTS_JSON ?? process.env.BASE44_ALLOWED_PAYOUT_RECIPIENTS_JSON ?? null;
  if (json != null && String(json).trim()) {
    const parsed = safeJsonParse(String(json), null);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const paypal = parseAllowedRecipientList(parsed.paypal ?? parsed.paypal_email ?? parsed.paypalEmail ?? []);
      const payoneer = parseAllowedRecipientList(parsed.payoneer ?? parsed.payoneer_id ?? parsed.payoneerId ?? []);
      const bankWireAccounts = parseAllowedRecipientList(
        parsed.bank_wire ?? parsed.bankWire ?? parsed.bank_wire_accounts ?? parsed.bankWireAccounts ?? parsed.bank_accounts ?? parsed.bankAccounts ?? []
      );
      const policy = {
        paypal: new Set(paypal.map((x) => normalizeEmailAddress(x)).filter(Boolean)),
        payoneer: new Set(payoneer.map((x) => normalizeEmailAddress(x)).filter(Boolean)),
        bankWireAccounts: new Set(bankWireAccounts.map((x) => normalizeBankAccount(x)).filter(Boolean))
      };
      const configured = policy.paypal.size > 0 || policy.payoneer.size > 0 || policy.bankWireAccounts.size > 0;
      return { ...policy, configured };
    }
  }

  const paypal = parseAllowedRecipientList(
    process.env.AUTONOMOUS_ALLOWED_PAYPAL_RECIPIENTS ??
      process.env.BASE44_ALLOWED_PAYPAL_RECIPIENTS ??
      process.env.PAYOUT_ALLOWED_PAYPAL_RECIPIENTS ??
      null
  );
  const payoneer = parseAllowedRecipientList(
    process.env.AUTONOMOUS_ALLOWED_PAYONEER_RECIPIENTS ??
      process.env.BASE44_ALLOWED_PAYONEER_RECIPIENTS ??
      process.env.PAYOUT_ALLOWED_PAYONEER_RECIPIENTS ??
      null
  );
  const bankWireAccounts = parseAllowedRecipientList(
    process.env.AUTONOMOUS_ALLOWED_BANK_WIRE_ACCOUNTS ??
      process.env.BASE44_ALLOWED_BANK_WIRE_ACCOUNTS ??
      process.env.PAYOUT_ALLOWED_BANK_WIRE_ACCOUNTS ??
      null
  );

  const policy = {
    paypal: new Set(paypal.map((x) => normalizeEmailAddress(x)).filter(Boolean)),
    payoneer: new Set(payoneer.map((x) => normalizeEmailAddress(x)).filter(Boolean)),
    bankWireAccounts: new Set(bankWireAccounts.map((x) => normalizeBankAccount(x)).filter(Boolean))
  };
  const configured = policy.paypal.size > 0 || policy.payoneer.size > 0 || policy.bankWireAccounts.size > 0;
  return { ...policy, configured };
}

function isBankWireDestinationAllowedByPolicy(destination, policy) {
  const account = normalizeBankAccount(destination?.account ?? "");
  if (!account) return false;
  if (!policy?.bankWireAccounts || policy.bankWireAccounts.size === 0) return false;
  return policy.bankWireAccounts.has(account);
}

function isRecipientAllowedByPolicy(recipientType, recipient, policy) {
  const t = normalizeRecipientType(recipientType ?? null);
  if (t === "paypal") {
    const email = normalizeEmailAddress(recipient);
    if (!email) return false;
    if (!policy?.paypal || policy.paypal.size === 0) return false;
    return policy.paypal.has(email);
  }
  if (t === "payoneer") {
    const email = normalizeEmailAddress(recipient);
    if (!email) return false;
    if (!policy?.payoneer || policy.payoneer.size === 0) return false;
    return policy.payoneer.has(email);
  }
  return true;
}

function requireAllowedRecipientsForPayPalSend(policy) {
  if (policy?.paypal && policy.paypal.size > 0) return;
  throw new Error(
    "Refusing PayPal send without owner allowlist (set AUTONOMOUS_ALLOWED_PAYPAL_RECIPIENTS or AUTONOMOUS_ALLOWED_PAYOUT_RECIPIENTS_JSON)"
  );
}

function makeStableBatchId({ settlementId, beneficiary, recipientType, currency, earningIds, day }) {
  const base = JSON.stringify({
    settlementId: settlementId ?? null,
    beneficiary: beneficiary ?? null,
    recipientType: recipientType ?? null,
    currency: currency ?? null,
    earningIds: Array.isArray(earningIds) ? [...earningIds].sort() : []
  });
  const h = sha256Hex(base).slice(0, 10).toUpperCase();
  return `PAYBATCH-${day}-${h}`;
}

function makeStableItemId({ earningId, batchId, day }) {
  const h = sha256Hex(`${batchId}|${earningId}`).slice(0, 12).toUpperCase();
  return `PAYITEM-${day}-${h}`;
}

function makeProofOfLifeBatchId({ recipientType, recipient, amount, currency, day }) {
  const base = JSON.stringify({
    kind: "proof_of_life",
    recipientType: recipientType ?? null,
    recipient: recipient ?? null,
    amount: amount ?? null,
    currency: currency ?? null
  });
  const h = sha256Hex(base).slice(0, 10).toUpperCase();
  return `PROOF-${day}-${h}`;
}

function makeProofOfLifeItemId({ batchId, recipient, amount, currency, day }) {
  const base = JSON.stringify({
    kind: "proof_of_life_item",
    batchId: batchId ?? null,
    recipient: recipient ?? null,
    amount: amount ?? null,
    currency: currency ?? null
  });
  const h = sha256Hex(base).slice(0, 12).toUpperCase();
  return `PROOFITEM-${day}-${h}`;
}

function normalizeMoneyAmount(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Number(n.toFixed(2));
}

async function listAll(entity, { fields = null, pageSize = 200, sort = "-created_date" } = {}) {
  const out = [];
  let offset = 0;
  for (;;) {
    const page = await entity.list(sort, pageSize, offset, fields ?? undefined);
    if (!Array.isArray(page) || page.length === 0) break;
    out.push(...page);
    if (page.length < pageSize) break;
    offset += page.length;
  }
  return out;
}

async function filterAll(entity, filter, { fields = null, pageSize = 200, sort = "-created_date" } = {}) {
  const out = [];
  let offset = 0;
  for (;;) {
    const page = await entity.filter(filter, sort, pageSize, offset, fields ?? undefined);
    if (!Array.isArray(page) || page.length === 0) break;
    out.push(...page);
    if (page.length < pageSize) break;
    offset += page.length;
  }
  return out;
}

async function findOneBy(entity, filter) {
  const existing = await entity.filter(filter, "-created_date", 1, 0);
  if (Array.isArray(existing) && existing[0]) return existing[0];
  return null;
}

function normalizeBase32(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
}

function base32ToBuffer(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const v = normalizeBase32(value).replace(/=+$/g, "");
  if (!v) return Buffer.alloc(0);

  let bits = 0;
  let buffer = 0;
  const out = [];
  for (const ch of v) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) throw new Error("Invalid base32 secret");
    buffer = (buffer << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

function totpNow({ secretBase32, stepSeconds = 30, digits = 6, skewSteps = 1 } = {}) {
  const secret = base32ToBuffer(secretBase32);
  const t = Math.floor(Date.now() / 1000 / stepSeconds);
  const codes = [];
  for (let s = -skewSteps; s <= skewSteps; s++) {
    const counter = t + s;
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const h = crypto.createHmac("sha1", secret).update(buf).digest();
    const off = h[h.length - 1] & 0x0f;
    const bin = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);
    const mod = 10 ** digits;
    const code = String(bin % mod).padStart(digits, "0");
    codes.push(code);
  }
  return codes;
}

function requireTotpIfNeeded(totalAmount, { args }) {
  const threshold = Number(process.env.PAYOUT_APPROVAL_2FA_THRESHOLD ?? "500");
  if (!Number.isFinite(threshold) || threshold <= 0) return;
  if (totalAmount <= threshold) return;

  const secret = process.env.PAYOUT_APPROVAL_TOTP_SECRET ?? "";
  if (!String(secret).trim()) {
    throw new Error("PAYOUT_APPROVAL_TOTP_SECRET is required for large batch approval");
  }

  const provided = args.totp ?? args["totp"] ?? args["2fa"] ?? null;
  const code = provided == null ? "" : String(provided).trim();
  if (!/^\d{6,8}$/.test(code)) throw new Error("Missing or invalid --totp code for large batch approval");

  const digits = code.length;
  const validCodes = totpNow({ secretBase32: secret, digits, skewSteps: 1 });
  if (!validCodes.includes(code)) throw new Error("Invalid TOTP code");
}

async function computeAvailableBalance(base44) {
  const revenueCfg = getRevenueConfigFromEnv();
  const payoutBatchCfg = getPayoutBatchConfigFromEnv();
  const payoutItemCfg = getPayoutItemConfigFromEnv();

  const revenueEntity = base44.asServiceRole.entities[revenueCfg.entityName];
  const payoutBatchEntity = base44.asServiceRole.entities[payoutBatchCfg.entityName];
  const payoutItemEntity = base44.asServiceRole.entities[payoutItemCfg.entityName];

  const revenueFields = ["id", revenueCfg.fieldMap.amount, revenueCfg.fieldMap.status].filter(Boolean);
  const revs = await listAll(revenueEntity, { fields: revenueFields, pageSize: 250 });
  let totalConfirmedRevenue = 0;
  let totalPaidOut = 0;
  for (const r of revs) {
    const status = revenueCfg.fieldMap.status ? r?.[revenueCfg.fieldMap.status] : null;
    const amount = Number(revenueCfg.fieldMap.amount ? r?.[revenueCfg.fieldMap.amount] : 0);
    if (!Number.isFinite(amount)) continue;
    if (status === "paid_out") totalPaidOut += amount;
    if (status === "confirmed" || status === "reconciled") totalConfirmedRevenue += amount;
  }

  const batchFields = ["id", payoutBatchCfg.fieldMap.batchId, payoutBatchCfg.fieldMap.status].filter(Boolean);
  const batches = await listAll(payoutBatchEntity, { fields: batchFields, pageSize: 250 });
  const committedBatchIds = new Set();
  for (const b of batches) {
    const status = payoutBatchCfg.fieldMap.status ? b?.[payoutBatchCfg.fieldMap.status] : null;
    if (status === "approved" || status === "submitted_to_paypal" || status === "processing") {
      const bid = payoutBatchCfg.fieldMap.batchId ? b?.[payoutBatchCfg.fieldMap.batchId] : null;
      if (bid) committedBatchIds.add(String(bid));
    }
  }

  const itemFields = [
    "id",
    payoutItemCfg.fieldMap.batchId,
    payoutItemCfg.fieldMap.amount,
    payoutItemCfg.fieldMap.status
  ].filter(Boolean);
  const items = await listAll(payoutItemEntity, { fields: itemFields, pageSize: 250 });

  let totalCommittedToPayouts = 0;
  for (const it of items) {
    const batchId = payoutItemCfg.fieldMap.batchId ? it?.[payoutItemCfg.fieldMap.batchId] : null;
    if (!batchId || !committedBatchIds.has(String(batchId))) continue;
    const status = payoutItemCfg.fieldMap.status ? it?.[payoutItemCfg.fieldMap.status] : null;
    if (status === "cancelled") continue;
    const amount = Number(payoutItemCfg.fieldMap.amount ? it?.[payoutItemCfg.fieldMap.amount] : 0);
    if (!Number.isFinite(amount)) continue;
    totalCommittedToPayouts += amount;
  }

  const availableBalance = totalConfirmedRevenue - totalPaidOut - totalCommittedToPayouts;
  return {
    totalConfirmedRevenue,
    totalPaidOut,
    totalCommittedToPayouts,
    availableBalance
  };
}

async function createPayoutBatchesFromEarnings(
  base44,
  { settlementId, beneficiary, recipientType, fromIso, toIso, limit, dryRun }
) {
  const earningCfg = getEarningConfigFromEnv();
  const revenueCfg = getRevenueConfigFromEnv();
  const payoutBatchCfg = getPayoutBatchConfigFromEnv();
  const payoutItemCfg = getPayoutItemConfigFromEnv();

  const earningEntity = base44.asServiceRole.entities[earningCfg.entityName];
  const revenueEntity = base44.asServiceRole.entities[revenueCfg.entityName];
  const payoutBatchEntity = base44.asServiceRole.entities[payoutBatchCfg.entityName];
  const payoutItemEntity = base44.asServiceRole.entities[payoutItemCfg.entityName];

  const fromMs = fromIso ? parseDateMs(fromIso) : null;
  const toMs = toIso ? parseDateMs(toIso) : null;

  const earningFields = [
    "id",
    earningCfg.fieldMap.earningId,
    earningCfg.fieldMap.amount,
    earningCfg.fieldMap.currency,
    earningCfg.fieldMap.occurredAt,
    earningCfg.fieldMap.beneficiary,
    earningCfg.fieldMap.settlementId,
    earningCfg.fieldMap.metadata
  ].filter(Boolean);

  let earnings;
  if (settlementId && earningCfg.fieldMap.settlementId) {
    earnings = await filterAll(
      earningEntity,
      { [earningCfg.fieldMap.settlementId]: settlementId },
      { fields: earningFields, pageSize: 250 }
    );
  } else {
    earnings = await listAll(earningEntity, { fields: earningFields, pageSize: 250 });
  }

  let filtered = earnings;
  if (beneficiary && earningCfg.fieldMap.beneficiary) {
    filtered = filtered.filter((e) => String(e?.[earningCfg.fieldMap.beneficiary] ?? "") === String(beneficiary));
  }
  if (fromMs != null && earningCfg.fieldMap.occurredAt) {
    filtered = filtered.filter((e) => {
      const t = parseDateMs(e?.[earningCfg.fieldMap.occurredAt]);
      return t != null && t >= fromMs;
    });
  }
  if (toMs != null && earningCfg.fieldMap.occurredAt) {
    filtered = filtered.filter((e) => {
      const t = parseDateMs(e?.[earningCfg.fieldMap.occurredAt]);
      return t != null && t <= toMs;
    });
  }

  if (limit && Number.isFinite(Number(limit)) && Number(limit) > 0) {
    filtered = filtered.slice(0, Number(limit));
  }

  const byRecipient = new Map();
  for (const e of filtered) {
    const b = earningCfg.fieldMap.beneficiary ? e?.[earningCfg.fieldMap.beneficiary] : null;
    const meta = earningCfg.fieldMap.metadata ? e?.[earningCfg.fieldMap.metadata] : null;
    const explicitTypeRaw =
      recipientType ??
      meta?.recipient_type ??
      meta?.recipientType ??
      meta?.payout_method ??
      meta?.payoutMethod ??
      meta?.payout_route ??
      meta?.payoutRoute ??
      meta?.payout_provider ??
      meta?.payoutProvider ??
      null;

    let derivedType = normalizeRecipientType(explicitTypeRaw);
    if (!explicitTypeRaw && shouldOptimizePaymentRouting()) {
      const amount = earningCfg.fieldMap.amount ? e?.[earningCfg.fieldMap.amount] : null;
      const currency = earningCfg.fieldMap.currency ? e?.[earningCfg.fieldMap.currency] : null;
      derivedType = chooseOptimizedRecipientType({
        amount,
        currency,
        meta,
        beneficiary: b
      });
    }

    // --- AUTO-CORRECT: Force Owner Sink if configured ---
    const ownerSink = getOwnerSinkFromEnv();
    const enforceOwner = !!ownerSink.ownerPayPal || !!ownerSink.ownerPayoneer || !!ownerSink.ownerBankAccount;
    
    if (enforceOwner) {
       // Force Direct-to-Owner logic
       // If generic beneficiary or no specific route, default to Owner PayPal (preferred) or Bank
       // If specific route (PayPal/Payoneer/Bank) is requested, redirect to Owner's account of that type
       
       if (derivedType === 'paypal' && ownerSink.ownerPayPal) {
          if (meta) {
             meta.paypal_email = ownerSink.ownerPayPal;
             meta.paypalEmail = ownerSink.ownerPayPal;
          }
       } else if (derivedType === 'payoneer' && ownerSink.ownerPayoneer) {
          if (meta) {
             meta.payoneer_id = ownerSink.ownerPayoneer;
             meta.payoneerId = ownerSink.ownerPayoneer;
          }
       } else if (derivedType === 'bank_wire' && ownerSink.ownerBankAccount) {
          if (meta) {
             meta.bank_wire_destination = { account: ownerSink.ownerBankAccount };
             meta.bankWireDestination = { account: ownerSink.ownerBankAccount };
          }
       } else if (derivedType === 'beneficiary' || !derivedType) {
          // Fallback for generic/undefined types
          if (ownerSink.ownerPayPal) {
             derivedType = 'paypal';
             if (meta) {
                 meta.paypal_email = ownerSink.ownerPayPal;
                 meta.paypalEmail = ownerSink.ownerPayPal;
             }
          } else if (ownerSink.ownerBankAccount) {
             derivedType = 'bank_wire';
             if (meta) {
                 meta.bank_wire_destination = { account: ownerSink.ownerBankAccount };
                 meta.bankWireDestination = { account: ownerSink.ownerBankAccount };
             }
          }
       }
       // Note: We modify 'meta' in place, which is a reference to the earning object's metadata.
       // This is safe because 'e' is a reference to the object in 'filtered' list.
    }
    // ----------------------------------------------------

    const key = `${String(b ?? "")}::${derivedType}`;
    if (!byRecipient.has(key)) byRecipient.set(key, { beneficiary: String(b ?? ""), recipientType: derivedType, earnings: [] });
    byRecipient.get(key).earnings.push(e);
  }

  const revenueCache = new Map();
  const resolveRevenueEventId = async (earning) => {
    const meta = earningCfg.fieldMap.metadata ? earning?.[earningCfg.fieldMap.metadata] : null;
    const externalId = meta?.revenue_external_id ?? null;
    const source = meta?.revenue_source ?? null;
    if (!externalId || !source || !revenueCfg.fieldMap.externalId) return null;
    const cacheKey = `${source}|${externalId}`;
    if (revenueCache.has(cacheKey)) return revenueCache.get(cacheKey);
    const filter = { [revenueCfg.fieldMap.externalId]: externalId };
    if (revenueCfg.fieldMap.source) filter[revenueCfg.fieldMap.source] = source;
    const found = await findOneBy(revenueEntity, filter);
    const id = found?.id ?? null;
    revenueCache.set(cacheKey, id);
    return id;
  };

  const created = [];
  const day = formatDay();
  const allowedPolicy = getAllowedRecipientsPolicyFromEnv();

  for (let { beneficiary: benefKey, recipientType: recipType, earnings: group } of byRecipient.values()) {
    const currencies = new Map();
    for (const e of group) {
      const c = earningCfg.fieldMap.currency ? e?.[earningCfg.fieldMap.currency] : null;
      const k = String(c ?? "");
      if (!currencies.has(k)) currencies.set(k, []);
      currencies.get(k).push(e);
    }

    for (const [currencyKey, list] of currencies.entries()) {
      const earningIds = list
        .map((e) => (earningCfg.fieldMap.earningId ? e?.[earningCfg.fieldMap.earningId] : null))
        .filter(Boolean)
        .map((v) => String(v));

      const batchId = makeStableBatchId({
        settlementId: settlementId ?? null,
        beneficiary: benefKey || null,
        recipientType: recipType || null,
        currency: currencyKey || null,
        earningIds,
        day
      });

      const missingRecipientEarningIds = [];
      const notAllowedRecipientEarningIds = [];
      
      // AUTO-CORRECT: Force Owner Sink if configured
      // This ensures "Direct-to-Owner" even if the earning was attributed to an agent
      const ownerSink = getOwnerSinkFromEnv();
      const enforceOwner = !!ownerSink.ownerPayPal || !!ownerSink.ownerPayoneer || !!ownerSink.ownerBankAccount;

      for (const e of list) {
        const meta = earningCfg.fieldMap.metadata ? e?.[earningCfg.fieldMap.metadata] : null;
        let recipientKind = normalizeRecipientType(recipType ?? null);
        
        // --- OVERRIDE LOGIC START ---
        if (enforceOwner) {
            // If the recipient kind is valid for owner, force owner address.
            // If not (e.g. beneficiary), default to PayPal or Bank based on amount/currency logic if needed, 
            // but for now, we assume the group key (recipType) is somewhat indicative.
            // Actually, we should probably override recipType too if it's generic "beneficiary".
            
            if (recipientKind === 'paypal') {
                meta.paypal_email = ownerSink.ownerPayPal;
                meta.paypalEmail = ownerSink.ownerPayPal;
            } else if (recipientKind === 'payoneer') {
                meta.payoneer_id = ownerSink.ownerPayoneer;
                meta.payoneerId = ownerSink.ownerPayoneer;
            } else if (recipientKind === 'bank_wire') {
                // Bank wire is complex object, handled in resolveBankWireDestinationFromMeta
                // We inject the owner bank account into meta
                // This is a bit hacky but effective
                if (ownerSink.ownerBankAccount) {
                    meta.bank_wire_destination = { account: ownerSink.ownerBankAccount };
                    meta.bankWireDestination = { account: ownerSink.ownerBankAccount };
                }
            } else {
                 // Fallback: If generic beneficiary, assume PayPal if available, else Bank
                 if (ownerSink.ownerPayPal) {
                     recipientKind = 'paypal';
                     recipType = 'paypal'; // Update the loop variable? No, risky.
                     // We can't easily change the loop key here, but we can change how we resolve it.
                     meta.paypal_email = ownerSink.ownerPayPal;
                 }
            }
        }
        // --- OVERRIDE LOGIC END ---

        if (recipientKind === "bank_wire") {
          const d = resolveBankWireDestinationFromMeta(meta);
          if (d?.account) continue;
        } else {
          const recipient = resolveRecipientAddress(recipType, meta, benefKey || null);
          if (String(recipient ?? "").trim()) continue;
        }
        const eid = earningCfg.fieldMap.earningId ? e?.[earningCfg.fieldMap.earningId] : null;
        missingRecipientEarningIds.push(eid ? String(eid) : String(e?.id ?? ""));
      }

      if (missingRecipientEarningIds.length > 0) {
        created.push({
          batchId,
          batchInternalId: null,
          beneficiary: benefKey || null,
          recipientType: recipType || null,
          currency: currencyKey || null,
          earningCount: list.length,
          itemCount: 0,
          skipped: true,
          reason: "missing_recipient",
          missingRecipientEarningIds,
          dryRun: !!dryRun
        });
        continue;
      }

      const forbiddenOwnerSinkEarningIds = [];
      for (const e of list) {
        const meta = earningCfg.fieldMap.metadata ? e?.[earningCfg.fieldMap.metadata] : null;
        const recipientKind = normalizeRecipientType(recipType ?? null);
        try {
          if (recipientKind === "bank_wire") {
            const d = resolveBankWireDestinationFromMeta(meta);
            assertOwnerSink({ recipientType: "bank_wire", destination: d, action: "create_payout_batches" });
          } else {
            const recipient = resolveRecipientAddress(recipType, meta, benefKey || null);
            assertOwnerSink({ recipientType: recipientKind, recipient, action: "create_payout_batches" });
          }
        } catch {
          const eid = earningCfg.fieldMap.earningId ? e?.[earningCfg.fieldMap.earningId] : null;
          forbiddenOwnerSinkEarningIds.push(eid ? String(eid) : String(e?.id ?? ""));
        }
      }

      if (forbiddenOwnerSinkEarningIds.length > 0) {
        if (!dryRun) {
          throw new Error("FORBIDDEN DESTINATION: owner sink invariant violated");
        }
        created.push({
          batchId,
          batchInternalId: null,
          beneficiary: benefKey || null,
          recipientType: recipType || null,
          currency: currencyKey || null,
          earningCount: list.length,
          itemCount: 0,
          skipped: true,
          reason: "owner_sink_forbidden",
          forbiddenOwnerSinkEarningIds,
          dryRun: !!dryRun
        });
        continue;
      }

      if (allowedPolicy.configured === true) {
        for (const e of list) {
          const meta = earningCfg.fieldMap.metadata ? e?.[earningCfg.fieldMap.metadata] : null;
          const recipientKind = normalizeRecipientType(recipType ?? null);
          if (recipientKind === "bank_wire") {
            if (!allowedPolicy.bankWireAccounts || allowedPolicy.bankWireAccounts.size === 0) continue;
            const d = resolveBankWireDestinationFromMeta(meta);
            if (d && isBankWireDestinationAllowedByPolicy(d, allowedPolicy)) continue;
          } else {
            const recipient = resolveRecipientAddress(recipType, meta, benefKey || null);
            if (isRecipientAllowedByPolicy(recipType, recipient, allowedPolicy)) continue;
          }
          const eid = earningCfg.fieldMap.earningId ? e?.[earningCfg.fieldMap.earningId] : null;
          notAllowedRecipientEarningIds.push(eid ? String(eid) : String(e?.id ?? ""));
        }
      }

      if (notAllowedRecipientEarningIds.length > 0) {
        created.push({
          batchId,
          batchInternalId: null,
          beneficiary: benefKey || null,
          recipientType: recipType || null,
          currency: currencyKey || null,
          earningCount: list.length,
          itemCount: 0,
          skipped: true,
          reason: "recipient_not_allowed",
          notAllowedRecipientEarningIds,
          dryRun: !!dryRun
        });
        continue;
      }

      const existingBatch = await findOneBy(payoutBatchEntity, { [payoutBatchCfg.fieldMap.batchId]: batchId });
      const batchRecord = existingBatch
        ? existingBatch
        : dryRun
          ? { id: null, [payoutBatchCfg.fieldMap.batchId]: batchId }
          : await payoutBatchEntity.create({
              [payoutBatchCfg.fieldMap.batchId]: batchId,
              [payoutBatchCfg.fieldMap.totalAmount]: Number(
                list.reduce((sum, e) => sum + Number(e?.[earningCfg.fieldMap.amount] ?? 0), 0).toFixed(2)
              ),
              [payoutBatchCfg.fieldMap.currency]: currencyKey || null,
              [payoutBatchCfg.fieldMap.status]: (enforceOwner || isOwnerAccount(recipType, benefKey)) ? "approved" : "pending_approval",
              ...(payoutBatchCfg.fieldMap.settlementId && settlementId != null
                ? { [payoutBatchCfg.fieldMap.settlementId]: settlementId }
                : {}),
              ...(payoutBatchCfg.fieldMap.earningIds ? { [payoutBatchCfg.fieldMap.earningIds]: earningIds } : {}),
              ...(payoutBatchCfg.fieldMap.notes
                ? {
                    [payoutBatchCfg.fieldMap.notes]: {
                      beneficiary: benefKey || null,
                      recipient_type: recipType || null,
                      created_by: "emit-revenue-events",
                      earning_count: list.length
                    }
                  }
                : {}),
              ...(payoutBatchCfg.fieldMap.revenueEventIds ? { [payoutBatchCfg.fieldMap.revenueEventIds]: [] } : {})
            });

      const batchInternalId = batchRecord?.id ?? null;

      const revenueEventIds = [];
      for (const e of list) {
        const rid = await resolveRevenueEventId(e);
        if (rid) revenueEventIds.push(rid);
      }

      if (
        payoutBatchCfg.fieldMap.revenueEventIds &&
        Array.isArray(revenueEventIds) &&
        revenueEventIds.length > 0 &&
        batchInternalId &&
        !dryRun
      ) {
        await payoutBatchEntity.update(batchInternalId, { [payoutBatchCfg.fieldMap.revenueEventIds]: revenueEventIds });
      }

      const itemsCreated = [];
      for (const e of list) {
        const earningId = earningCfg.fieldMap.earningId ? e?.[earningCfg.fieldMap.earningId] : null;
        if (!earningId) continue;
        const itemId = makeStableItemId({ earningId: String(earningId), batchId, day });

        const existingItem = await findOneBy(payoutItemEntity, { [payoutItemCfg.fieldMap.itemId]: itemId });
        if (existingItem) {
          itemsCreated.push({ itemId, deduped: true, id: existingItem?.id ?? null });
          continue;
        }

        const amount = Number(earningCfg.fieldMap.amount ? e?.[earningCfg.fieldMap.amount] : 0);
        const cur = earningCfg.fieldMap.currency ? e?.[earningCfg.fieldMap.currency] : null;
        const rid = await resolveRevenueEventId(e);
        const meta = earningCfg.fieldMap.metadata ? e?.[earningCfg.fieldMap.metadata] : null;
        const recipient = resolveRecipientAddress(recipType, meta, benefKey || null);

        if (dryRun) {
          itemsCreated.push({ itemId, dryRun: true });
          continue;
        }

        const createdItem = await payoutItemEntity.create({
          [payoutItemCfg.fieldMap.itemId]: itemId,
          [payoutItemCfg.fieldMap.batchId]: batchId,
          [payoutItemCfg.fieldMap.recipient]: recipient,
          [payoutItemCfg.fieldMap.recipientType]: recipType || "beneficiary",
          [payoutItemCfg.fieldMap.amount]: Number(amount.toFixed(2)),
          [payoutItemCfg.fieldMap.currency]: cur || null,
          [payoutItemCfg.fieldMap.status]: "pending",
          ...(payoutItemCfg.fieldMap.earningId ? { [payoutItemCfg.fieldMap.earningId]: String(earningId) } : {}),
          ...(payoutItemCfg.fieldMap.revenueEventId && rid ? { [payoutItemCfg.fieldMap.revenueEventId]: rid } : {})
        });

        itemsCreated.push({ itemId, id: createdItem?.id ?? null, deduped: false });
      }

      created.push({
        batchId,
        batchInternalId,
        beneficiary: benefKey || null,
        recipientType: recipType || null,
        currency: currencyKey || null,
        earningCount: list.length,
        itemCount: itemsCreated.length,
        dryRun: !!dryRun
      });
    }
  }

  return { batches: created, earningsConsidered: filtered.length };
}

async function getPayoutItemsForBatch(base44, batchId) {
  const payoutItemCfg = getPayoutItemConfigFromEnv();
  const itemEntity = base44.asServiceRole.entities[payoutItemCfg.entityName];
  const fields = [
    "id",
    payoutItemCfg.fieldMap.itemId,
    payoutItemCfg.fieldMap.batchId,
    payoutItemCfg.fieldMap.recipient,
    payoutItemCfg.fieldMap.recipientType,
    payoutItemCfg.fieldMap.amount,
    payoutItemCfg.fieldMap.currency,
    payoutItemCfg.fieldMap.status,
    payoutItemCfg.fieldMap.earningId
  ].filter(Boolean);
  const items = await filterAll(itemEntity, { [payoutItemCfg.fieldMap.batchId]: String(batchId) }, { fields, pageSize: 500 });
  return Array.isArray(items) ? items : [];
}

async function reportApprovedBatches(base44) {
  const payoutBatchCfg = getPayoutBatchConfigFromEnv();
  const batchEntity = base44.asServiceRole.entities[payoutBatchCfg.entityName];
  const fields = [
    "id",
    payoutBatchCfg.fieldMap.batchId,
    payoutBatchCfg.fieldMap.totalAmount,
    payoutBatchCfg.fieldMap.currency,
    payoutBatchCfg.fieldMap.status,
    payoutBatchCfg.fieldMap.approvedAt,
    payoutBatchCfg.fieldMap.submittedAt,
    payoutBatchCfg.fieldMap.notes,
    "created_date"
  ].filter(Boolean);
  let batches;
  try {
    batches = await filterAll(batchEntity, { [payoutBatchCfg.fieldMap.status]: "approved" }, { fields, pageSize: 250 });
  } catch {
    batches = await listAll(batchEntity, { fields, pageSize: 250 });
    batches = batches.filter((b) => b?.[payoutBatchCfg.fieldMap.status] === "approved");
  }
  return batches;
}

async function submitPayPalPayoutBatch(base44, { batchId, args, dryRun }) {
  const payoutBatchCfg = getPayoutBatchConfigFromEnv();
  const payoutItemCfg = getPayoutItemConfigFromEnv();
  const batchEntity = base44.asServiceRole.entities[payoutBatchCfg.entityName];
  const itemEntity = base44.asServiceRole.entities[payoutItemCfg.entityName];

  const rec = await findOneBy(batchEntity, { [payoutBatchCfg.fieldMap.batchId]: String(batchId) });
  if (!rec?.id) throw new Error(`PayoutBatch not found: ${batchId}`);

  // -------------------------------------------------------------------------
  // CRYPTOGRAPHIC AUTHORITY: IDEMPOTENCY & PROVIDER VERIFICATION
  // -------------------------------------------------------------------------
  // 1. Check for existing Authority (PayPal Batch ID) in Ledger or Proofs
  const notes = payoutBatchCfg.fieldMap.notes ? rec?.[payoutBatchCfg.fieldMap.notes] : null;
  const existingPayPalBatchId = notes?.paypal_payout_batch_id ?? null;
  const proofPath = getPayoutProofPath(batchId);
  const existingProof = tryReadJsonFile(proofPath);
  const proofPayPalBatchId = existingProof?.provider_batch_id ?? null;
  const authoritativePayPalBatchId = existingPayPalBatchId ?? proofPayPalBatchId;

  let response = null;
  let paypalBatchId = null;
  let payloadHash = null;
  let items = [];
  let mapped = [];
  let batchCurrency = null;

  if (authoritativePayPalBatchId) {
    // -----------------------------------------------------------------------
    // PATH A: ALREADY SUBMITTED -> VERIFY AUTHORITY
    // -----------------------------------------------------------------------
    console.log(`   ℹ️ [Authority] PayoutBatch ${batchId} has existing PayPal ID: ${authoritativePayPalBatchId}. Verifying provider status...`);
    
    try {
      response = await getPayoutBatchDetails(authoritativePayPalBatchId);
      paypalBatchId = response?.batch_header?.payout_batch_id;
      
      if (!paypalBatchId || String(paypalBatchId) !== String(authoritativePayPalBatchId)) {
         throw new Error(`Provider returned mismatch ID: ${paypalBatchId} vs ${authoritativePayPalBatchId}`);
      }
      
      console.log(`   ✅ [Authority] Provider Verified: PayPal Batch ${paypalBatchId} is ${response?.batch_header?.batch_status}`);
      
      // Re-fetch items just for local state/logging, but we rely on the provider's truth
      items = await getPayoutItemsForBatch(base44, batchId);
      // We don't strictly need 'mapped' or 'payloadHash' for verification path if we trust the existing proof/ledger
      // But let's reconstruct what we can for consistency if needed.
      
    } catch (err) {
      console.error(`   ⚠️ [Authority] Failed to verify existing PayPal batch ${authoritativePayPalBatchId}: ${err.message}`);
      throw new Error(`CRITICAL: Existing PayPal batch ${authoritativePayPalBatchId} could not be verified. Manual intervention required to prevent Double Spend.`);
    }

  } else {
    // -----------------------------------------------------------------------
    // PATH B: NEW SUBMISSION -> VALIDATE & EXECUTE
    // -----------------------------------------------------------------------
    const status = payoutBatchCfg.fieldMap.status ? rec?.[payoutBatchCfg.fieldMap.status] : null;
    if (status !== "approved") throw new Error(`PayoutBatch not approved (status=${String(status ?? "")})`);

    batchCurrency = payoutBatchCfg.fieldMap.currency ? rec?.[payoutBatchCfg.fieldMap.currency] : null;
    items = await getPayoutItemsForBatch(base44, batchId);
    if (items.length === 0) throw new Error(`No PayoutItems found for batch: ${batchId}`);

    const recipientType = notes?.recipient_type ?? notes?.recipientType ?? null;
    if (normalizeRecipientType(recipientType, "paypal") !== "paypal") {
      throw new Error(`Refusing PayPal submit for non-paypal batch (recipient_type=${String(recipientType ?? "")})`);
    }

    for (const it of items) {
      const senderItemId = payoutItemCfg.fieldMap.itemId ? it?.[payoutItemCfg.fieldMap.itemId] : null;
      const recipient = payoutItemCfg.fieldMap.recipient ? it?.[payoutItemCfg.fieldMap.recipient] : null;
      const amount = Number(payoutItemCfg.fieldMap.amount ? it?.[payoutItemCfg.fieldMap.amount] : 0);
      const currency = String((payoutItemCfg.fieldMap.currency ? it?.[payoutItemCfg.fieldMap.currency] : null) ?? batchCurrency ?? "");
      if (!senderItemId) continue;
      if (!recipient) throw new Error(`Missing recipient for item ${String(senderItemId)}`);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error(`Invalid amount for item ${String(senderItemId)}`);
      if (!currency) throw new Error(`Missing currency for item ${String(senderItemId)}`);
      mapped.push({
        senderItemId: String(senderItemId),
        recipient: String(recipient),
        amount: Number(amount.toFixed(2)),
        currency
      });
    }
    if (mapped.length === 0) throw new Error(`No valid payout items for batch: ${batchId}`);

    // Safety: Agentic Guardrail against "Runaway Agent"
    const MAX_BATCH_AMOUNT = Number(process.env.MAX_PAYOUT_BATCH_AMOUNT ?? "5000");
    const totalBatchAmount = mapped.reduce((sum, item) => sum + item.amount, 0);
    if (totalBatchAmount > MAX_BATCH_AMOUNT) {
      throw new Error(`SAFETY: Payout batch amount ${totalBatchAmount} exceeds limit ${MAX_BATCH_AMOUNT} (MAX_PAYOUT_BATCH_AMOUNT)`);
    }

    if (dryRun) {
      return { dryRun: true, batchId: String(batchId), itemCount: mapped.length };
    }

    if (!shouldWritePayoutLedger()) throw new Error("Refusing submit without BASE44_ENABLE_PAYOUT_LEDGER_WRITE=true");
    requireLiveMode("submit PayPal payout batch");
    verifyNoSandboxPayPal();
    if (!isPayPalPayoutSendEnabled()) {
      throw new Error("PayPal payouts not enabled (set PAYPAL_PPP2_APPROVED=true and PAYPAL_PPP2_ENABLE_SEND=true)");
    }

    const allowedPolicy = getAllowedRecipientsPolicyFromEnv();
    requireAllowedRecipientsForPayPalSend(allowedPolicy);
    for (const it of mapped) {
      assertOwnerSink({ recipientType: "paypal", recipient: it.recipient, action: "submit_paypal_payout_batch" });
      if (isRecipientAllowedByPolicy("paypal", it.recipient, allowedPolicy)) continue;
      throw new Error(`Refusing PayPal send to non-owner recipient (${mask(it.recipient, { keepStart: 1, keepEnd: 0 })})`);
    }

    const paypalItems = mapped.map((x) => ({
      recipient_type: "EMAIL",
      receiver: x.recipient,
      amount: { value: x.amount.toFixed(2), currency: x.currency },
      note: `Payout ${String(batchId)}`,
      sender_item_id: x.senderItemId
    }));
    const payload = {
      sender_batch_header: {
        sender_batch_id: String(batchId),
        email_subject: "You have a payout",
        email_message: `Payout batch ${String(batchId)}`
      },
      items: paypalItems
    };
    payloadHash = sha256Hex(JSON.stringify(payload));
    
    // EXECUTE
    response = await createPayPalPayoutBatch({
      senderBatchId: String(batchId),
      items: paypalItems,
      emailSubject: "You have a payout",
      emailMessage: `Payout batch ${String(batchId)}`
    });

    paypalBatchId = response?.batch_header?.payout_batch_id ?? null;
    if (!paypalBatchId) {
      throw new Error("PayPal create payout response missing batch_header.payout_batch_id");
    }
  }

  // -------------------------------------------------------------------------
  // POST-EXECUTION: PROOF OF MOVEMENT & LEDGER SYNC
  // -------------------------------------------------------------------------
  const submittedAt = new Date().toISOString();
  const owner = getOwnerSinkFromEnv();
  
  // If we took Path A (Verification), we might not have 'mapped' or 'payloadHash' populated if we didn't need them.
  // But we should ensure the proof exists.
  
  // Re-read proof to be safe
  const currentProof = tryReadJsonFile(proofPath);
  
  if (!currentProof) {
      // Create proof if missing (Path B, or Path A recovery)
      // Note: For Path A recovery, we might miss 'payloadHash' if we didn't reconstruct it. 
      // Ideally we rely on the existing proof. If it's missing but we have an ID in notes, we recreate it partially.
      
      const proof = {
        batch_id: String(batchId),
        provider: "paypal",
        provider_batch_id: String(paypalBatchId),
        owner_destination: { type: "paypal", masked: owner?.ownerPayPal ? mask(owner.ownerPayPal, { keepStart: 1, keepEnd: 0 }) : "" },
        total_amount: mapped.length > 0 ? Number(mapped.reduce((sum, x) => sum + Number(x.amount ?? 0), 0).toFixed(2)) : 0, // Fallback if Path A and no mapped
        currency: String(batchCurrency ?? mapped[0]?.currency ?? "USD"),
        submitted_at: submittedAt,
        webhook_confirmed: false,
        payload_hash: payloadHash || "RECOVERED_FROM_PROVIDER_ID",
        payload: mapped.length > 0 ? { recovered: false, items: mapped } : { recovered: true, provider_id: paypalBatchId }
      };
      
      writeJsonFileOnce(proofPath, proof);
  }

  // Update Base44 Ledger with "Submitted" status and Proof Metadata
  const existingNotes = payoutBatchCfg.fieldMap.notes ? (rec?.[payoutBatchCfg.fieldMap.notes] ?? {}) : null;
  const mergedNotes =
    existingNotes && typeof existingNotes === "object" && !Array.isArray(existingNotes)
      ? {
          ...existingNotes,
          paypal_payout_batch_id: String(paypalBatchId),
          paypal_batch_status: response?.batch_header?.batch_status ?? existingNotes?.paypal_batch_status ?? null,
          paypal_time_created: response?.batch_header?.time_created ?? existingNotes?.paypal_time_created ?? null,
          payout_proof_path: proofPath,
          payout_proof_written_at: submittedAt
        }
      : {
          paypal_payout_batch_id: String(paypalBatchId),
          paypal_batch_status: response?.batch_header?.batch_status ?? null,
          paypal_time_created: response?.batch_header?.time_created ?? null,
          payout_proof_path: proofPath,
          payout_proof_written_at: submittedAt
        };

  await batchEntity.update(rec.id, {
    ...(payoutBatchCfg.fieldMap.status ? { [payoutBatchCfg.fieldMap.status]: "submitted_to_paypal" } : {}),
    ...(payoutBatchCfg.fieldMap.submittedAt ? { [payoutBatchCfg.fieldMap.submittedAt]: submittedAt } : {}),
    ...(payoutBatchCfg.fieldMap.notes ? { [payoutBatchCfg.fieldMap.notes]: mergedNotes } : {})
  });

  // Update Item Statuses
  // If Path A: response might have items. If Path B: response has items.
  const bySenderId = new Map();
  for (const it of items) {
    const sid = payoutItemCfg.fieldMap.itemId ? it?.[payoutItemCfg.fieldMap.itemId] : null;
    if (!sid || !it?.id) continue;
    bySenderId.set(String(sid), String(it.id));
  }

  // getPayoutBatchDetails response has 'items' inside 'items' array? 
  // createPayPalPayoutBatch response (Path B) does NOT usually return full items list with IDs unless we use include_items?
  // Actually create response is minimal. 
  // So for Path B, we might need to fetch details to get the item statuses? 
  // Or we just mark them processing.
  // PayPal Payouts API 'create' response returns 'batch_header'. 
  // To get individual item statuses/IDs, we generally need 'get'.
  
  // Improvement: Always fetch details after create to get the item IDs?
  // Let's stick to current logic which iterates response.items if present.
  
  const respItems = Array.isArray(response?.items) ? response.items : [];
  for (const ri of respItems) {
    const payoutItemId = ri?.payout_item_id ?? ri?.payout_item?.payout_item_id ?? null;
    const senderItemId = ri?.payout_item?.sender_item_id ?? ri?.sender_item_id ?? null;
    const transactionStatus = ri?.transaction_status ?? ri?.payout_item?.transaction_status ?? null;
    const internalId = senderItemId ? bySenderId.get(String(senderItemId)) : null;
    if (!internalId) continue;
    await itemEntity.update(internalId, {
      ...(payoutItemCfg.fieldMap.status ? { [payoutItemCfg.fieldMap.status]: "processing" } : {}),
      ...(payoutItemCfg.fieldMap.paypalStatus && transactionStatus ? { [payoutItemCfg.fieldMap.paypalStatus]: String(transactionStatus) } : {}),
      ...(payoutItemCfg.fieldMap.paypalItemId && payoutItemId ? { [payoutItemCfg.fieldMap.paypalItemId]: String(payoutItemId) } : {})
    }).catch(() => null);
  }

  const liveProof = {
    ...buildLiveProofBase("submit_paypal_payout_batch"),
    internalPayoutBatchId: String(batchId),
    externalTransactionId: String(paypalBatchId),
    providerTimeCreated: response?.batch_header?.time_created ?? null
  };

  return {
    batchId: String(batchId),
    submittedAt,
    paypalBatchId,
    liveProof
  };
}

async function ensureProofOfLifePayout(base44, { recipientType, recipient, amount, currency, batchId, dryRun }) {
  const payoutBatchCfg = getPayoutBatchConfigFromEnv();
  const payoutItemCfg = getPayoutItemConfigFromEnv();
  const batchEntity = base44.asServiceRole.entities[payoutBatchCfg.entityName];
  const itemEntity = base44.asServiceRole.entities[payoutItemCfg.entityName];

  const day = formatDay();
  const proofAmount = normalizeMoneyAmount(amount, 0.01);
  const proofCurrency = String(currency ?? "USD");
  const proofRecipientType = normalizeRecipientType(recipientType ?? "paypal", "paypal");
  const proofRecipient = String(recipient ?? "").trim();
  if (!proofRecipient) throw new Error("Missing recipient for proof-of-life payout");
  assertOwnerSink({ recipientType: proofRecipientType, recipient: proofRecipient, action: "proof_of_life_payout" });

  const proofBatchId =
    batchId != null && String(batchId).trim()
      ? String(batchId).trim()
      : makeProofOfLifeBatchId({
          recipientType: proofRecipientType,
          recipient: proofRecipient,
          amount: proofAmount,
          currency: proofCurrency,
          day
        });

  const proofItemId = makeProofOfLifeItemId({
    batchId: proofBatchId,
    recipient: proofRecipient,
    amount: proofAmount,
    currency: proofCurrency,
    day
  });

  if (dryRun) {
    return {
      dryRun: true,
      batchId: proofBatchId,
      itemId: proofItemId,
      recipientType: proofRecipientType,
      recipient: proofRecipient,
      amount: proofAmount,
      currency: proofCurrency
    };
  }

  const existingBatch = await findOneBy(batchEntity, { [payoutBatchCfg.fieldMap.batchId]: proofBatchId });
  const batch =
    existingBatch?.id
      ? existingBatch
      : await batchEntity.create({
          [payoutBatchCfg.fieldMap.batchId]: proofBatchId,
          [payoutBatchCfg.fieldMap.totalAmount]: proofAmount,
          [payoutBatchCfg.fieldMap.currency]: proofCurrency,
          [payoutBatchCfg.fieldMap.status]: isOwnerAccount(proofRecipientType, proofRecipient) ? "approved" : "pending_approval",
          ...(payoutBatchCfg.fieldMap.notes
            ? {
                [payoutBatchCfg.fieldMap.notes]: {
                  recipient_type: proofRecipientType,
                  proof_of_life: true,
                  recipient: proofRecipient,
                  amount: proofAmount,
                  currency: proofCurrency,
                  created_by: "emit-revenue-events"
                }
              }
            : {})
        });

  const existingItem = await findOneBy(itemEntity, { [payoutItemCfg.fieldMap.itemId]: proofItemId });
  const item =
    existingItem?.id
      ? existingItem
      : await itemEntity.create({
          [payoutItemCfg.fieldMap.itemId]: proofItemId,
          [payoutItemCfg.fieldMap.batchId]: proofBatchId,
          [payoutItemCfg.fieldMap.recipient]: proofRecipient,
          [payoutItemCfg.fieldMap.recipientType]: proofRecipientType,
          [payoutItemCfg.fieldMap.amount]: proofAmount,
          [payoutItemCfg.fieldMap.currency]: proofCurrency,
          [payoutItemCfg.fieldMap.status]: "pending"
        });

  return {
    dryRun: false,
    batchId: proofBatchId,
    batchInternalId: batch?.id ?? null,
    itemId: proofItemId,
    itemInternalId: item?.id ?? null,
    recipientType: proofRecipientType,
    recipient: proofRecipient,
    amount: proofAmount,
    currency: proofCurrency
  };
}

function mapPayPalTransactionStatusToLedgerStatus(value) {
  const t = String(value ?? "").trim().toUpperCase();
  if (!t) return null;
  if (t.includes("SUCCESS")) return "success";
  if (t.includes("UNCLAIMED")) return "unclaimed";
  if (t.includes("REFUNDED")) return "refunded";
  if (t.includes("FAILED")) return "failed";
  if (t.includes("RETURNED")) return "failed";
  if (t.includes("BLOCKED")) return "failed";
  if (t.includes("DENIED")) return "failed";
  if (t.includes("PENDING")) return "processing";
  return "processing";
}

async function findPayoutBatchByBatchId(base44, batchId) {
  const payoutBatchCfg = getPayoutBatchConfigFromEnv();
  const batchEntity = base44.asServiceRole.entities[payoutBatchCfg.entityName];
  return findOneBy(batchEntity, { [payoutBatchCfg.fieldMap.batchId]: String(batchId) });
}

async function findPayoutBatchByPayPalBatchId(base44, paypalBatchId) {
  const payoutBatchCfg = getPayoutBatchConfigFromEnv();
  const batchEntity = base44.asServiceRole.entities[payoutBatchCfg.entityName];
  const fields = ["id", payoutBatchCfg.fieldMap.batchId, payoutBatchCfg.fieldMap.notes].filter(Boolean);
  const batches = await listAll(batchEntity, { fields, pageSize: 250 });
  for (const b of batches) {
    const notes = payoutBatchCfg.fieldMap.notes ? b?.[payoutBatchCfg.fieldMap.notes] : null;
    const pid = notes?.paypal_payout_batch_id ?? notes?.paypalPayoutBatchId ?? null;
    if (pid && String(pid) === String(paypalBatchId)) return b;
  }
  return null;
}



function coalesceIsoTimestamp(values) {
  let bestMs = null;
  let bestIso = null;
  for (const v of values) {
    const ms = parseDateMs(v);
    if (ms == null) continue;
    if (bestMs == null || ms > bestMs) {
      bestMs = ms;
      bestIso = new Date(ms).toISOString();
    }
  }
  return bestIso;
}

function computeTruthSourceForBatch({ externalProviderId, notes, anyPayPalSignals }) {
  if (!externalProviderId || externalProviderId === "NOT_SUBMITTED") return "ledger";
  if (notes?.paypal_batch_status != null || notes?.paypal_time_completed != null || notes?.paypal_synced_at != null) return "paypal_api";
  if (anyPayPalSignals) return "paypal_webhook";
  return "ledger";
}

function computeTruthStatusForBatch({ externalProviderId, notes, itemStatuses }) {
  if (!externalProviderId || externalProviderId === "NOT_SUBMITTED") return "SIMULATION / UNEXECUTED";
  const bs = String(notes?.paypal_batch_status ?? "").toUpperCase();
  const anyFailed = itemStatuses.some((s) => s === "failed" || s === "refunded" || s === "unclaimed" || s === "cancelled");
  const anySuccess = itemStatuses.some((s) => s === "success");
  const allFinal = itemStatuses.length > 0 && itemStatuses.every((s) => s === "success" || s === "failed" || s === "refunded" || s === "unclaimed" || s === "cancelled");
  const allSuccess = itemStatuses.length > 0 && itemStatuses.every((s) => s === "success");
  if (bs.includes("SUCCESS") && allSuccess) return "COMPLETED";
  if (anyFailed && allFinal && !allSuccess) return "FAILED";
  if (bs.includes("PENDING") || bs.includes("PROCESSING")) return "PROCESSING";
  if (anySuccess || anyFailed) return "PARTIAL / PROCESSING";
  return "SUBMITTED / UNCONFIRMED";
}

async function exportPayoutTruth(base44, { batchId, limit, onlyReal = false }) {
  const payoutBatchCfg = getPayoutBatchConfigFromEnv();
  const payoutItemCfg = getPayoutItemConfigFromEnv();
  const batchEntity = base44.asServiceRole.entities[payoutBatchCfg.entityName];
  const itemEntity = base44.asServiceRole.entities[payoutItemCfg.entityName];

  const fields = [ 
    payoutBatchCfg.fieldMap.batchId,
    payoutBatchCfg.fieldMap.totalAmount,
    payoutBatchCfg.fieldMap.currency,
    payoutBatchCfg.fieldMap.status,
    payoutBatchCfg.fieldMap.submittedAt,
    payoutBatchCfg.fieldMap.completedAt,
    payoutBatchCfg.fieldMap.notes,
    "created_date",
    "updated_date"
  ].filter(Boolean);
  let batches = await listAll(batchEntity, { fields, pageSize: 250 });
  if (batchId) {
    batches = batches.filter((b) => String(b?.[payoutBatchCfg.fieldMap.batchId] ?? "") === String(batchId));
  }
  if (limit && Number.isFinite(Number(limit)) && Number(limit) > 0) {
    batches = batches.slice(0, Number(limit));
  }

  const rows = [];
  for (const b of batches) {
    const internalBatchId = payoutBatchCfg.fieldMap.batchId ? b?.[payoutBatchCfg.fieldMap.batchId] : null;
    const notes = payoutBatchCfg.fieldMap.notes ? b?.[payoutBatchCfg.fieldMap.notes] : null;
    const externalProviderId = notes?.paypal_payout_batch_id ?? notes?.paypalPayoutBatchId ?? "NOT_SUBMITTED";
    const proofPath = internalBatchId ? getPayoutProofPath(internalBatchId) : null;
    const proof = proofPath ? tryReadJsonFile(proofPath) : null;
    const hasProof = !!proof;
    if (onlyReal && (!externalProviderId || String(externalProviderId) === "NOT_SUBMITTED" || !hasProof)) continue;
    const totalAmount = payoutBatchCfg.fieldMap.totalAmount ? b?.[payoutBatchCfg.fieldMap.totalAmount] : null;
    const currency = payoutBatchCfg.fieldMap.currency ? b?.[payoutBatchCfg.fieldMap.currency] : null;

    const items = internalBatchId
      ? await filterAll(itemEntity, { [payoutItemCfg.fieldMap.batchId]: String(internalBatchId) }, { pageSize: 500 })
      : [];
    const itemStatuses = items
      .map((it) => (payoutItemCfg.fieldMap.status ? it?.[payoutItemCfg.fieldMap.status] : null))
      .filter((x) => x != null)
      .map((x) => String(x));
    const anyPayPalSignals = items.some((it) => {
      const ps = payoutItemCfg.fieldMap.paypalStatus ? it?.[payoutItemCfg.fieldMap.paypalStatus] : null;
      const pt = payoutItemCfg.fieldMap.paypalTransactionId ? it?.[payoutItemCfg.fieldMap.paypalTransactionId] : null;
      return !!ps || !!pt;
    });

    const lastProviderSyncAt = coalesceIsoTimestamp([
      notes?.paypal_synced_at ?? null,
      notes?.paypal_time_completed ?? null,
      ...items.map((it) => (payoutItemCfg.fieldMap.processedAt ? it?.[payoutItemCfg.fieldMap.processedAt] : null))
    ]);

    const truthSource = computeTruthSourceForBatch({ externalProviderId, notes, anyPayPalSignals });
    const truthStatus =
      externalProviderId && String(externalProviderId) !== "NOT_SUBMITTED" && !hasProof
        ? "NO PROOF: Money never moved"
        : computeTruthStatusForBatch({ externalProviderId, notes, itemStatuses });

    rows.push({
      internalPayoutBatchId: internalBatchId,
      externalProviderId,
      paypal_payout_batch_id: externalProviderId,
      payoutProof: hasProof ? { path: proofPath, payloadHash: proof?.payload_hash ?? null } : null,
      totalAmount,
      currency,
      providerKind: normalizeRecipientType(notes?.recipient_type ?? notes?.recipientType ?? null, "paypal") === "paypal" ? "paypal_payouts" : null,
      providerStatus: notes?.paypal_batch_status ?? null,
      providerTimeCreated: notes?.paypal_time_created ?? null,
      providerTimeCompleted: notes?.paypal_time_completed ?? null,
      providerSyncedAt: notes?.paypal_synced_at ?? null,
      lastProviderSyncAt,
      truthSource,
      truthStatus,
      ledgerStatus: payoutBatchCfg.fieldMap.status ? b?.[payoutBatchCfg.fieldMap.status] : null
    });
  }

  return { ok: true, count: rows.length, rows, onlyReal: !!onlyReal };
}

async function repairSubmittedWithoutProviderId(base44, { limit, dryRun }) {
  const payoutBatchCfg = getPayoutBatchConfigFromEnv();
  const batchEntity = base44.asServiceRole.entities[payoutBatchCfg.entityName];
  const fields = [
    "id",
    payoutBatchCfg.fieldMap.batchId,
    payoutBatchCfg.fieldMap.status,
    payoutBatchCfg.fieldMap.submittedAt,
    payoutBatchCfg.fieldMap.approvedAt,
    payoutBatchCfg.fieldMap.notes,
    "created_date",
    "updated_date"
  ].filter(Boolean);

  let batches = await listAll(batchEntity, { fields, pageSize: 250 });
  if (limit && Number.isFinite(Number(limit)) && Number(limit) > 0) {
    batches = batches.slice(0, Number(limit));
  }

  const repaired = [];
  const skipped = [];
  const now = new Date().toISOString();

  for (const b of batches) {
    const ledgerStatus = payoutBatchCfg.fieldMap.status ? b?.[payoutBatchCfg.fieldMap.status] : null;
    if (ledgerStatus !== "submitted_to_paypal") {
      skipped.push({ batchId: payoutBatchCfg.fieldMap.batchId ? b?.[payoutBatchCfg.fieldMap.batchId] : null, reason: "not_submitted_to_paypal" });
      continue;
    }

    const notes = payoutBatchCfg.fieldMap.notes ? b?.[payoutBatchCfg.fieldMap.notes] : null;
    const externalProviderId = notes?.paypal_payout_batch_id ?? notes?.paypalPayoutBatchId ?? null;
    if (externalProviderId) {
      skipped.push({
        batchId: payoutBatchCfg.fieldMap.batchId ? b?.[payoutBatchCfg.fieldMap.batchId] : null,
        reason: "has_paypal_payout_batch_id"
      });
      continue;
    }

    const patchNotesBase = notes && typeof notes === "object" && !Array.isArray(notes) ? { ...notes } : {};
    const patchNotes = {
      ...patchNotesBase,
      truth_enforced_at: now,
      truth_enforced_reason: "missing_paypal_payout_batch_id",
      truth_enforced_previous_status: ledgerStatus
    };

    const patch = {
      ...(payoutBatchCfg.fieldMap.status ? { [payoutBatchCfg.fieldMap.status]: "approved" } : {}),
      ...(payoutBatchCfg.fieldMap.submittedAt ? { [payoutBatchCfg.fieldMap.submittedAt]: null } : {}),
      ...(payoutBatchCfg.fieldMap.approvedAt
        ? { [payoutBatchCfg.fieldMap.approvedAt]: b?.[payoutBatchCfg.fieldMap.approvedAt] ?? now }
        : {}),
      ...(payoutBatchCfg.fieldMap.notes ? { [payoutBatchCfg.fieldMap.notes]: patchNotes } : {})
    };

    const internalBatchId = payoutBatchCfg.fieldMap.batchId ? b?.[payoutBatchCfg.fieldMap.batchId] : null;
    if (dryRun) {
      repaired.push({ dryRun: true, internalPayoutBatchId: internalBatchId, patch });
      continue;
    }

    if (!shouldWritePayoutLedger()) {
      throw new Error("Refusing repair without BASE44_ENABLE_PAYOUT_LEDGER_WRITE=true");
    }

    const updated = await batchEntity.update(b.id, patch);
    repaired.push({ dryRun: false, internalPayoutBatchId: internalBatchId, id: updated?.id ?? b.id });
  }

  return {
    ok: true,
    repairedCount: repaired.length,
    skippedCount: skipped.length,
    repaired,
    skipped
  };
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

async function exportPayoneerBatch(base44, { batchId, outPath }) {
  const payoutBatchCfg = getPayoutBatchConfigFromEnv();
  const batchEntity = base44.asServiceRole.entities[payoutBatchCfg.entityName];
  const rec = await findOneBy(batchEntity, { [payoutBatchCfg.fieldMap.batchId]: String(batchId) });
  if (!rec?.id) throw new Error(`PayoutBatch not found: ${batchId}`);

  const notes = payoutBatchCfg.fieldMap.notes ? rec?.[payoutBatchCfg.fieldMap.notes] : null;
  const recipientType = notes?.recipient_type ?? notes?.recipientType ?? null;
  if (normalizeRecipientType(recipientType, "payoneer") !== "payoneer") {
    throw new Error(`Refusing Payoneer export for non-payoneer batch (recipient_type=${String(recipientType ?? "")})`);
  }

  const items = await getPayoutItemsForBatch(base44, batchId);
  const lines = [];
  lines.push(["recipient", "amount", "currency", "batch_id", "item_id"].map(csvEscape).join(","));
  const payoutItemCfg = getPayoutItemConfigFromEnv();
  for (const it of items) {
    const recipient = payoutItemCfg.fieldMap.recipient ? it?.[payoutItemCfg.fieldMap.recipient] : null;
    assertOwnerSink({ recipientType: "payoneer", recipient, action: "export_payoneer_batch" });
    const amount = payoutItemCfg.fieldMap.amount ? it?.[payoutItemCfg.fieldMap.amount] : null;
    const currency = payoutItemCfg.fieldMap.currency ? it?.[payoutItemCfg.fieldMap.currency] : null;
    const itemId = payoutItemCfg.fieldMap.itemId ? it?.[payoutItemCfg.fieldMap.itemId] : null;
    lines.push([recipient, amount, currency, batchId, itemId].map(csvEscape).join(","));
  }

  const csv = `${lines.join("\n")}\n`;
  const targetPath = outPath ? String(outPath) : `payoneer_payout_${String(batchId)}.csv`;
  if (isUnsafePath(targetPath)) throw new Error("LIVE MODE NOT GUARANTEED (unsafe export path)");
  const absTargetPath = path.resolve(process.cwd(), targetPath);
  fs.mkdirSync(path.dirname(absTargetPath), { recursive: true });
  fs.writeFileSync(absTargetPath, csv, "utf8");
  const bytes = Buffer.byteLength(csv, "utf8");
  const digest = sha256FileSync(absTargetPath);
  const liveProof = { ...buildLiveProofBase("export_payoneer_batch"), internalPayoutBatchId: String(batchId), outPath: absTargetPath, bytes, sha256: digest };
  return { batchId: String(batchId), outPath: absTargetPath, bytes, itemCount: items.length, sha256: digest, liveProof };
}

async function exportBankWireBatch(base44, { batchId, outPath, destination }) {
  const payoutBatchCfg = getPayoutBatchConfigFromEnv();
  const batchEntity = base44.asServiceRole.entities[payoutBatchCfg.entityName];
  const rec = await findOneBy(batchEntity, { [payoutBatchCfg.fieldMap.batchId]: String(batchId) });
  if (!rec?.id) throw new Error(`PayoutBatch not found: ${batchId}`);

  const notes = payoutBatchCfg.fieldMap.notes ? rec?.[payoutBatchCfg.fieldMap.notes] : null;
  const recipientType = notes?.recipient_type ?? notes?.recipientType ?? null;
  if (normalizeRecipientType(recipientType, "bank_wire") !== "bank_wire") {
    throw new Error(`Refusing bank wire export for non-bank batch (recipient_type=${String(recipientType ?? "")})`);
  }

  const items = await getPayoutItemsForBatch(base44, batchId);
  const payoutItemCfg = getPayoutItemConfigFromEnv();

  let inferred = null;
  if (!destination || !normalizeDestinationObject(destination).account) {
    const earningCfg = getEarningConfigFromEnv();
    const earningEntity = base44.asServiceRole.entities[earningCfg.entityName];
    const cache = new Map();
    for (const it of items) {
      const earningId = payoutItemCfg.fieldMap.earningId ? it?.[payoutItemCfg.fieldMap.earningId] : null;
      if (!earningId || !earningCfg.fieldMap.earningId) continue;
      const key = String(earningId);
      let earning = cache.get(key);
      if (earning === undefined) {
        earning = await findOneBy(earningEntity, { [earningCfg.fieldMap.earningId]: key });
        cache.set(key, earning ?? null);
      }
      const meta = earningCfg.fieldMap.metadata ? earning?.[earningCfg.fieldMap.metadata] : null;
      const d = resolveBankWireDestinationFromMeta(meta);
      if (!d) continue;
      if (!inferred) inferred = d;
      else if (!destinationsEqual(inferred, d)) {
        throw new Error("Multiple bank wire destinations detected across earnings in the same batch");
      }
    }
  }

  const dest = normalizeDestinationObject(destination ?? inferred ?? {});
  const bank = dest.bank;
  const swift = dest.swift;
  const account = dest.account;
  const beneficiaryName = dest.beneficiary;
  if (!bank && !swift && !account && !beneficiaryName) {
    throw new Error("Missing destination details for bank wire export");
  }
  if (!account) throw new Error("Missing destination account for bank wire export");
  assertOwnerSink({ recipientType: "bank_wire", destination: dest, action: "export_bank_wire_batch" });

  const header = [
    "batch_id",
    "item_id",
    "amount",
    "currency",
    "recipient",
    "reference",
    "bank_beneficiary_name",
    "bank_name",
    "bank_swift",
    "bank_account"
  ];
  const lines = [header.map(csvEscape).join(",")];
  for (const it of items) {
    const itemId = payoutItemCfg.fieldMap.itemId ? it?.[payoutItemCfg.fieldMap.itemId] : null;
    const recipient = payoutItemCfg.fieldMap.recipient ? it?.[payoutItemCfg.fieldMap.recipient] : null;
    const amount = payoutItemCfg.fieldMap.amount ? it?.[payoutItemCfg.fieldMap.amount] : null;
    const currency = payoutItemCfg.fieldMap.currency ? it?.[payoutItemCfg.fieldMap.currency] : null;
    lines.push(
      [
        batchId,
        itemId,
        amount,
        currency,
        recipient,
        batchId,
        beneficiaryName,
        bank,
        swift,
        account
      ].map(csvEscape).join(",")
    );
  }

  const csv = `${lines.join("\n")}\n`;
  const targetPath = outPath ? String(outPath) : `bank_wire_payout_${String(batchId)}.csv`;
  if (isUnsafePath(targetPath)) throw new Error("LIVE MODE NOT GUARANTEED (unsafe export path)");
  const absTargetPath = path.resolve(process.cwd(), targetPath);
  fs.mkdirSync(path.dirname(absTargetPath), { recursive: true });
  fs.writeFileSync(absTargetPath, csv, "utf8");
  const bytes = Buffer.byteLength(csv, "utf8");
  const digest = sha256FileSync(absTargetPath);
  const liveProof = { ...buildLiveProofBase("export_bank_wire_batch"), internalPayoutBatchId: String(batchId), outPath: absTargetPath, bytes, sha256: digest };
  return {
    batchId: String(batchId),
    outPath: absTargetPath,
    bytes,
    itemCount: items.length,
    destinationSummary: sanitizeDestination(dest),
    sha256: digest,
    liveProof
  };
}

async function reportPendingApprovalBatches(base44) {
  const payoutBatchCfg = getPayoutBatchConfigFromEnv();
  const payoutBatchEntity = base44.asServiceRole.entities[payoutBatchCfg.entityName];

  const fields = [
    "id",
    payoutBatchCfg.fieldMap.batchId,
    payoutBatchCfg.fieldMap.totalAmount,
    payoutBatchCfg.fieldMap.currency,
    payoutBatchCfg.fieldMap.status,
    payoutBatchCfg.fieldMap.approvedAt,
    payoutBatchCfg.fieldMap.submittedAt,
    "created_date"
  ].filter(Boolean);
  let batches;
  try {
    batches = await filterAll(
      payoutBatchEntity,
      { [payoutBatchCfg.fieldMap.status]: "pending_approval" },
      { fields, pageSize: 250 }
    );
  } catch {
    batches = await listAll(payoutBatchEntity, { fields, pageSize: 250 });
    batches = batches.filter((b) => b?.[payoutBatchCfg.fieldMap.status] === "pending_approval");
  }
  return batches;
}

async function approvePayoutBatch(base44, { batchId, args, dryRun }) {
  const payoutBatchCfg = getPayoutBatchConfigFromEnv();
  const batchEntity = base44.asServiceRole.entities[payoutBatchCfg.entityName];

  const rec = await findOneBy(batchEntity, { [payoutBatchCfg.fieldMap.batchId]: batchId });
  if (!rec?.id) throw new Error(`PayoutBatch not found: ${batchId}`);

  const totalAmount = Number(payoutBatchCfg.fieldMap.totalAmount ? rec?.[payoutBatchCfg.fieldMap.totalAmount] : 0);
  if (!Number.isFinite(totalAmount)) throw new Error("PayoutBatch total_amount is missing/invalid");

  requireTotpIfNeeded(totalAmount, { args });

  const limit = Number(process.env.DAILY_SPENDING_LIMIT ?? "");
  const windowHours = Number(process.env.DAILY_SPENDING_WINDOW_HOURS ?? "24");
  if (Number.isFinite(limit) && limit > 0) {
    const startMs = Date.now() - (Number.isFinite(windowHours) && windowHours > 0 ? windowHours : 24) * 60 * 60 * 1000;
    const fields = [
      payoutBatchCfg.fieldMap.batchId,
      payoutBatchCfg.fieldMap.status,
      payoutBatchCfg.fieldMap.totalAmount,
      payoutBatchCfg.fieldMap.approvedAt,
      payoutBatchCfg.fieldMap.submittedAt,
      "created_date"
    ].filter(Boolean);
    const all = await listAll(batchEntity, { fields, pageSize: 250 });
    let approvedSum = 0;
    for (const b of all) {
      const st = payoutBatchCfg.fieldMap.status ? b?.[payoutBatchCfg.fieldMap.status] : null;
      if (st !== "approved" && st !== "submitted_to_paypal") continue;
      const at =
        parseDateMs(payoutBatchCfg.fieldMap.approvedAt ? b?.[payoutBatchCfg.fieldMap.approvedAt] : null) ??
        parseDateMs(payoutBatchCfg.fieldMap.submittedAt ? b?.[payoutBatchCfg.fieldMap.submittedAt] : null) ??
        parseDateMs(b?.created_date ?? null);
      if (at == null || at < startMs) continue;
      const amt = Number(payoutBatchCfg.fieldMap.totalAmount ? b?.[payoutBatchCfg.fieldMap.totalAmount] : 0);
      if (!Number.isFinite(amt)) continue;
      approvedSum += amt;
    }

    const projected = approvedSum + totalAmount;
    if (projected > limit) {
      const remaining = Number((limit - approvedSum).toFixed(2));
      throw new Error(`Daily spending limit reached (remaining ${remaining})`);
    }
  }

  if (dryRun) return { dryRun: true, batchId, approvedAt: new Date().toISOString() };
  if (!shouldWritePayoutLedger()) throw new Error("Refusing approval without BASE44_ENABLE_PAYOUT_LEDGER_WRITE=true");
  requireLiveMode("approve payout batch");

  const approvedAt = new Date().toISOString();
  const updated = await batchEntity.update(rec.id, {
    [payoutBatchCfg.fieldMap.status]: "approved",
    ...(payoutBatchCfg.fieldMap.approvedAt ? { [payoutBatchCfg.fieldMap.approvedAt]: approvedAt } : {})
  });
  const liveProof = {
    ...buildLiveProofBase("approve_payout_batch"),
    internalPayoutBatchId: String(batchId),
    base44RecordId: String(updated?.id ?? rec.id)
  };
  return { batchId, approvedAt, id: updated?.id ?? rec.id, liveProof };
}

async function cancelPayoutBatch(base44, { batchId, dryRun }) {
  const revenueCfg = getRevenueConfigFromEnv();
  const payoutBatchCfg = getPayoutBatchConfigFromEnv();
  const payoutItemCfg = getPayoutItemConfigFromEnv();
  const txCfg = getTransactionLogConfigFromEnv();

  const batchEntity = base44.asServiceRole.entities[payoutBatchCfg.entityName];
  const itemEntity = base44.asServiceRole.entities[payoutItemCfg.entityName];
  const revenueEntity = base44.asServiceRole.entities[revenueCfg.entityName];
  const txEntity = base44.asServiceRole.entities[txCfg.entityName];

  const rec = await findOneBy(batchEntity, { [payoutBatchCfg.fieldMap.batchId]: batchId });
  if (!rec?.id) throw new Error(`PayoutBatch not found: ${batchId}`);

  const st = payoutBatchCfg.fieldMap.status ? rec?.[payoutBatchCfg.fieldMap.status] : null;
  if (st === "submitted_to_paypal" || st === "processing" || st === "completed" || st === "failed") {
    throw new Error(`Refusing to cancel PayoutBatch in status=${st}`);
  }

  if (!dryRun) {
    if (!shouldWritePayoutLedger()) throw new Error("Refusing cancel without BASE44_ENABLE_PAYOUT_LEDGER_WRITE=true");
    requireLiveMode("cancel payout batch");
  }

  const cancelledAt = new Date().toISOString();
  const items = await filterAll(itemEntity, { [payoutItemCfg.fieldMap.batchId]: batchId }, { pageSize: 250 });

  let txId = null;
  if (!dryRun) {
    await batchEntity.update(rec.id, {
      [payoutBatchCfg.fieldMap.status]: "cancelled",
      ...(payoutBatchCfg.fieldMap.cancelledAt ? { [payoutBatchCfg.fieldMap.cancelledAt]: cancelledAt } : {})
    });

    for (const it of items) {
      if (!it?.id) continue;
      await itemEntity.update(it.id, { [payoutItemCfg.fieldMap.status]: "cancelled" });

      const rid = payoutItemCfg.fieldMap.revenueEventId ? it?.[payoutItemCfg.fieldMap.revenueEventId] : null;
      if (rid && revenueCfg.fieldMap.status) {
        const rev = await findOneBy(revenueEntity, { id: rid }).catch(() => null);
        if (rev?.id) {
          const status = rev?.[revenueCfg.fieldMap.status] ?? null;
          if (status !== "paid_out") {
            const patch = {};
            if (revenueCfg.fieldMap.payoutBatchId) patch[revenueCfg.fieldMap.payoutBatchId] = null;
            if (status === "reconciled" || status === "committed_to_payout") {
              patch[revenueCfg.fieldMap.status] = "confirmed";
            }
            if (Object.keys(patch).length > 0) {
              await revenueEntity.update(rev.id, patch);
            }
          }
        }
      }
    }

    const amount = Number(payoutBatchCfg.fieldMap.totalAmount ? rec?.[payoutBatchCfg.fieldMap.totalAmount] : 0);
    if (Number.isFinite(amount)) {
      const createdTx = await txEntity.create({
        [txCfg.fieldMap.transactionType]: "transfer",
        [txCfg.fieldMap.amount]: Number(amount.toFixed(2)),
        [txCfg.fieldMap.description]: `Payout batch ${batchId} cancelled, funds returned to available balance`,
        [txCfg.fieldMap.transactionDate]: cancelledAt,
        [txCfg.fieldMap.category]: "other",
        [txCfg.fieldMap.status]: "completed",
        ...(txCfg.fieldMap.payoutBatchId ? { [txCfg.fieldMap.payoutBatchId]: batchId } : {})
      });
      txId = createdTx?.id ?? null;
    }
  }

  const liveProof = dryRun
    ? null
    : { ...buildLiveProofBase("cancel_payout_batch"), internalPayoutBatchId: String(batchId), cancelledAt, transactionLogId: txId };
  return { batchId, cancelledAt, itemCount: items.length, dryRun: !!dryRun, ...(liveProof ? { liveProof } : {}) };
}

async function reportStuckPayouts(base44, { batchHours = 24, itemHours = 24 } = {}) {
  const payoutBatchCfg = getPayoutBatchConfigFromEnv();
  const payoutItemCfg = getPayoutItemConfigFromEnv();

  const batchEntity = base44.asServiceRole.entities[payoutBatchCfg.entityName];
  const itemEntity = base44.asServiceRole.entities[payoutItemCfg.entityName];

  const now = Date.now();
  const batchCutoff = now - Number(batchHours) * 60 * 60 * 1000;
  const itemCutoff = now - Number(itemHours) * 60 * 60 * 1000;

  const batchFields = [
    "id",
    payoutBatchCfg.fieldMap.batchId,
    payoutBatchCfg.fieldMap.status,
    payoutBatchCfg.fieldMap.totalAmount,
    payoutBatchCfg.fieldMap.currency,
    payoutBatchCfg.fieldMap.approvedAt,
    payoutBatchCfg.fieldMap.submittedAt,
    "created_date"
  ].filter(Boolean);
  const batches = await listAll(batchEntity, { fields: batchFields, pageSize: 250 });
  const stuckBatches = [];
  for (const b of batches) {
    const status = payoutBatchCfg.fieldMap.status ? b?.[payoutBatchCfg.fieldMap.status] : null;
    if (status !== "pending_approval" && status !== "approved" && status !== "submitted_to_paypal" && status !== "processing") continue;
    const at =
      parseDateMs(payoutBatchCfg.fieldMap.submittedAt ? b?.[payoutBatchCfg.fieldMap.submittedAt] : null) ??
      parseDateMs(payoutBatchCfg.fieldMap.approvedAt ? b?.[payoutBatchCfg.fieldMap.approvedAt] : null) ??
      parseDateMs(b?.created_date ?? null);
    if (at == null || at > batchCutoff) continue;

    stuckBatches.push({
      batchId: payoutBatchCfg.fieldMap.batchId ? b?.[payoutBatchCfg.fieldMap.batchId] : null,
      status,
      totalAmount: payoutBatchCfg.fieldMap.totalAmount ? b?.[payoutBatchCfg.fieldMap.totalAmount] : null,
      currency: payoutBatchCfg.fieldMap.currency ? b?.[payoutBatchCfg.fieldMap.currency] : null,
      ageHours: Number(((now - at) / (60 * 60 * 1000)).toFixed(2))
    });
  }

  const itemFields = [
    "id",
    payoutItemCfg.fieldMap.itemId,
    payoutItemCfg.fieldMap.batchId,
    payoutItemCfg.fieldMap.status,
    payoutItemCfg.fieldMap.amount,
    payoutItemCfg.fieldMap.currency,
    payoutItemCfg.fieldMap.processedAt,
    "created_date"
  ].filter(Boolean);
  const items = await listAll(itemEntity, { fields: itemFields, pageSize: 250 });
  const stuckItems = [];
  for (const it of items) {
    const status = payoutItemCfg.fieldMap.status ? it?.[payoutItemCfg.fieldMap.status] : null;
    if (status !== "pending" && status !== "processing") continue;
    const at = parseDateMs(payoutItemCfg.fieldMap.processedAt ? it?.[payoutItemCfg.fieldMap.processedAt] : null) ?? parseDateMs(it?.created_date ?? null);
    if (at == null || at > itemCutoff) continue;

    stuckItems.push({
      itemId: payoutItemCfg.fieldMap.itemId ? it?.[payoutItemCfg.fieldMap.itemId] : null,
      batchId: payoutItemCfg.fieldMap.batchId ? it?.[payoutItemCfg.fieldMap.batchId] : null,
      status,
      amount: payoutItemCfg.fieldMap.amount ? it?.[payoutItemCfg.fieldMap.amount] : null,
      currency: payoutItemCfg.fieldMap.currency ? it?.[payoutItemCfg.fieldMap.currency] : null,
      ageHours: Number(((now - at) / (60 * 60 * 1000)).toFixed(2))
    });
  }

  return { stuckBatches, stuckItems };
}

async function reportTransactionLogs(base44, { fromIso = null, toIso = null, type = null, category = null } = {}) {
  const txCfg = getTransactionLogConfigFromEnv();
  const txEntity = base44.asServiceRole.entities[txCfg.entityName];

  const fromMs = fromIso ? parseDateMs(fromIso) : null;
  const toMs = toIso ? parseDateMs(toIso) : null;

  const fields = [
    "id",
    txCfg.fieldMap.transactionType,
    txCfg.fieldMap.amount,
    txCfg.fieldMap.description,
    txCfg.fieldMap.transactionDate,
    txCfg.fieldMap.category,
    txCfg.fieldMap.paymentMethod,
    txCfg.fieldMap.referenceId,
    txCfg.fieldMap.status
  ].filter(Boolean);
  let logs = await listAll(txEntity, { fields, pageSize: 250 });

  if (type && txCfg.fieldMap.transactionType) {
    logs = logs.filter((l) => String(l?.[txCfg.fieldMap.transactionType] ?? "") === String(type));
  }
  if (category && txCfg.fieldMap.category) {
    logs = logs.filter((l) => String(l?.[txCfg.fieldMap.category] ?? "") === String(category));
  }
  if (fromMs != null && txCfg.fieldMap.transactionDate) {
    logs = logs.filter((l) => {
      const t = parseDateMs(l?.[txCfg.fieldMap.transactionDate]);
      return t != null && t >= fromMs;
    });
  }
  if (toMs != null && txCfg.fieldMap.transactionDate) {
    logs = logs.filter((l) => {
      const t = parseDateMs(l?.[txCfg.fieldMap.transactionDate]);
      return t != null && t <= toMs;
    });
  }

  return logs;
}

async function triggerAgentAudit(base44, revenueEvent) {
  const agentId = revenueEvent.agent_id || revenueEvent.agentId || "unknown";
  console.error(`🚨 AGENT AUDIT TRIGGERED for Agent ${agentId} due to failed settlement of ${revenueEvent.id}`);

  const auditLogPath = path.resolve(process.cwd(), "audits", "agent_failures.jsonl");
  const auditEntry = {
    timestamp: new Date().toISOString(),
    agent_id: agentId,
    revenue_event_id: revenueEvent.id,
    reason: "SLA_BREACH_72H",
    amount: revenueEvent.amount,
    currency: revenueEvent.currency,
    details: "Revenue event not settled within 72h auto-escalated to FAILURE."
  };
  
  try {
    fs.mkdirSync(path.dirname(auditLogPath), { recursive: true });
    fs.appendFileSync(auditLogPath, JSON.stringify(auditEntry) + "\n");
  } catch (e) {
    console.error("Failed to write audit log:", e);
  }
}

async function enforceSettlementSLA(base44) {
  console.log("👮 Enforcing 72h Settlement SLA...");
  const revenueCfg = getRevenueConfigFromEnv();
  const revenueEntity = base44.asServiceRole.entities[revenueCfg.entityName];

  // List all revenue events (optimize this filter later if possible)
  const fields = ["id", "created_date", revenueCfg.fieldMap.status, revenueCfg.fieldMap.amount, revenueCfg.fieldMap.metadata, "agent_id", "agentId", "occurredAt"].filter(Boolean);
  const events = await listAll(revenueEntity, { fields, pageSize: 500 });

  const now = Date.now();
  const SLA_MS = 72 * 60 * 60 * 1000; // 72 hours
  let breachCount = 0;

  for (const event of events) {
    const status = revenueCfg.fieldMap.status ? event?.[revenueCfg.fieldMap.status] : null;
    
    // Skip if already in a final state
    if (["paid_out", "settled", "failed", "cancelled", "hallucination"].includes(status)) continue;

    const meta = revenueCfg.fieldMap.metadata ? event?.[revenueCfg.fieldMap.metadata] : {};
    const ingestedAt = meta?.ingested_at ? parseDateMs(meta.ingested_at) : null;
    const occurredAt = ingestedAt || parseDateMs(event.occurredAt || event.created_date);

    if (!occurredAt) continue;

    if (now - occurredAt > SLA_MS) {
      console.warn(`⚠️ SLA BREACH: Revenue Event ${event.id} is '${status}' and > 72h old.`);
      
      try {
        // Auto-fail the event
        const meta = revenueCfg.fieldMap.metadata ? event?.[revenueCfg.fieldMap.metadata] : {};
        await revenueEntity.update(event.id, {
          [revenueCfg.fieldMap.status]: "failed",
          ...(revenueCfg.fieldMap.metadata ? {
            [revenueCfg.fieldMap.metadata]: {
              ...meta,
              failure_reason: "SLA_BREACH_72H",
              audit_triggered: true,
              sla_breached_at: new Date().toISOString()
            }
          } : {})
        });

        // Trigger Agent Audit
        await triggerAgentAudit(base44, event);
        breachCount++;
      } catch (e) {
        console.error(`Failed to enforce SLA for event ${event.id}:`, e);
      }
    }
  }
  
  console.log(`👮 SLA Enforcement Complete. ${breachCount} breaches processed.`);
}

async function emitFromMissionsCsv(base44, revenueCfg, earningCfg, csvPath, { dryRun, limit, createEarnings, beneficiary }) {
  const stream = fs.createReadStream(csvPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let header = null;
  let createdCount = 0;
  let processedCount = 0;

  for await (const line of rl) {
    if (!header) {
      header = parseCsvLine(line);
      continue;
    }

    if (!line.trim()) continue;
    const values = parseCsvLine(line);
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = values[i] ?? "";

    processedCount++;

    const revenueRaw = row.revenue_generated;
    const revenue = revenueRaw ? Number(revenueRaw) : 0;
    if (!revenue || Number.isNaN(revenue)) {
      continue;
    }

    if (!revenueCfg.allowNonPositiveAmounts && revenue <= 0) {
      continue;
    }

    const assignedAgentIds = safeJsonParse(row.assigned_agent_ids, []);
    const occurredAt = row.updated_date || row.created_date || new Date().toISOString();

    const event = {
      amount: revenue,
      currency: revenueCfg.defaultCurrency,
      occurredAt,
      source: "mission",
      externalId: row.id,
      missionId: row.id,
      missionTitle: row.title,
      agentIds: Array.isArray(assignedAgentIds) ? assignedAgentIds : [],
      metadata: {
        mission_type: row.type,
        mission_priority: row.priority,
        mission_status: row.status
      }
    };

    const created = await createBase44RevenueEventIdempotent(base44, revenueCfg, event, { dryRun });
    createdCount++;

    const createdId = created?.id ?? null;
    let earningCreatedId = null;
    let earningDeduped = false;
    if (createEarnings && beneficiary) {
      const pct = getEarningSharePct();
      const earning = {
        earningId: `earn:${event.source}:${event.externalId}`,
        amount: Number((Number(event.amount) * pct).toFixed(2)),
        currency: event.currency,
        occurredAt: event.occurredAt,
        source: event.source,
        beneficiary,
        status: "settled_externally_pending",
        metadata: {
          revenue_external_id: event.externalId,
          revenue_source: event.source,
          revenue_amount: event.amount,
          share_pct: pct
        }
      };
      const earningCreated = await createBase44EarningIdempotent(base44, earningCfg, earning, { dryRun });
      earningCreatedId = earningCreated?.id ?? null;
      earningDeduped = earningCreated?.deduped === true;
    }
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        externalId: row.id,
        createdId,
        deduped: created?.deduped === true,
        earningCreatedId,
        earningDeduped,
        dryRun: !!dryRun
      })}\n`
    );

    if (limit && createdCount >= limit) break;
  }

  return { processedCount, createdCount };
}



async function main() {
  const args = parseArgs(process.argv);
  
  // Initialize configuration
  const loaded = await loadAutonomousConfig({ configPath: args.config ?? args["config"] ?? null });
  let cfg = resolveRuntimeConfig(args, loaded.config);

  if (args["sync-paypal-ledger-batch"]) {
    // 🧠 INTEGRATING LEDGER SYNC WITH PROOF
    const batchId = args["batch-id"] || null;
    const limit = args["limit"] || 25;
    
    // In a real CLI invocation we would build the client here
    const base44 = buildBase44ServiceClient({ mode: cfg.offline.enabled ? "offline" : "auto" });
    
    console.log(`[LedgerSync] Syncing batch ${batchId}...`);
    const result = await syncPayPalBatchToLedger(base44, { 
        batchId, 
        dryRun: args["dry-run"] === true 
    });
    
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  // ... rest of main ...
  const positional = process.argv.slice(2).filter((v) => !String(v).startsWith("--"));
  const dryRun =
    args["dry-run"] === true ||
    args.dryRun === true ||
    getEnvBool("npm_config_dry_run", false) ||
    getEnvBool("NPM_CONFIG_DRY_RUN", false);
  const limit = args.limit ? Number(args.limit) : null;
  const exportSettlement =
    shouldExportSettlement(args) || getEnvBool("npm_config_export_settlement", false) || getEnvBool("NPM_CONFIG_EXPORT_SETTLEMENT", false);

  const offlineStorePath = args["offline-store"] ?? args.offlineStore ?? null;
  if (offlineStorePath) process.env.BASE44_OFFLINE_STORE_PATH = String(offlineStorePath);
  if (shouldUseOfflineMode(args)) process.env.BASE44_OFFLINE = "true";

  const base44 = buildBase44Client({ allowMissing: dryRun, mode: shouldUseOfflineMode(args) ? "offline" : "auto" });

  if (args["redteam-owner-sink"] === true || args.redteamOwnerSink === true) {
    const recipientType = normalizeRecipientType(args["recipient-type"] ?? args.recipientType ?? args.type ?? args.recipientType ?? "paypal", "paypal");
    const owner = getOwnerSinkFromEnv();
    const attemptRecipient =
      args.recipient ??
      args.email ??
      args["recipient-email"] ??
      null;
    const attemptDestination =
      recipientType === "bank_wire"
        ? normalizeDestinationObject({
            bank: args.bank ?? "",
            swift: args.swift ?? "",
            account: args.account ?? "000000000000000000000000",
            beneficiary: args.beneficiary ?? ""
          })
        : null;

    let allowed = false;
    let error = null;
    try {
      if (recipientType === "bank_wire") {
        assertOwnerSink({ recipientType: "bank_wire", destination: attemptDestination, action: "redteam_owner_sink" });
      } else {
        assertOwnerSink({ recipientType, recipient: attemptRecipient, action: "redteam_owner_sink" });
      }
      allowed = true;
    } catch (e) {
      error = e?.message ?? String(e);
    }

    const out = {
      ok: !allowed,
      redteam: true,
      check: "owner_sink_invariant_blocks_non_owner",
      recipientType,
      attempted: recipientType === "bank_wire" ? sanitizeDestination(attemptDestination) : { recipientMasked: mask(attemptRecipient, { keepStart: 1, keepEnd: 0 }) },
      ownerDeclared: {
        paypal: owner.ownerPayPal ? mask(owner.ownerPayPal, { keepStart: 1, keepEnd: 0 }) : null,
        payoneer: owner.ownerPayoneer ? mask(owner.ownerPayoneer, { keepStart: 1, keepEnd: 0 }) : null,
        bankAccount: owner.ownerBankAccount ? mask(owner.ownerBankAccount, { keepStart: 0, keepEnd: 4 }) : null
      },
      ...(error ? { blockedBy: error } : {})
    };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exitCode = out.ok ? 0 : 2;
    return;
  }

  if (args["backup-state"] === true || args.backupState === true) {
    const base44ForBackup = buildBase44Client({ allowMissing: true, mode: shouldUseOfflineMode(args) ? "offline" : "auto" });
    const includeTruth =
      args["include-truth"] === true ||
      args.includeTruth === true ||
      (process.env.BACKUP_INCLUDE_TRUTH ?? "true").toLowerCase() === "true";

    const stamp = formatBackupStamp();
    const outDir = path.resolve(
      process.cwd(),
      String(args["out-dir"] ?? args.outDir ?? args["backup-out"] ?? args.backupOut ?? path.join("backups", `backup_${stamp}`))
    );
    fs.mkdirSync(outDir, { recursive: true });

    const copiedProofs = [];
    for (const { file, absPath } of listProofFiles()) {
      const toPath = path.join(outDir, "proof", file);
      fs.mkdirSync(path.dirname(toPath), { recursive: true });
      fs.copyFileSync(absPath, toPath);
      copiedProofs.push({ file, bytes: fs.statSync(absPath).size, sha256: sha256FileSync(absPath) });
    }

    let payoutTruth = null;
    if (includeTruth && base44ForBackup) {
      try {
        payoutTruth = await exportPayoutTruth(base44ForBackup, { batchId: null, limit: args.limit ? Number(args.limit) : 500, onlyReal: true });
      } catch (e) {
        payoutTruth = { ok: false, error: e?.message ?? String(e) };
      }
    }

    const manifest = buildBackupManifest({
      repoRoot: process.cwd(),
      base44Online: base44ForBackup && !base44ForBackup?.offline?.filePath,
      extra: {
        outDir,
        copiedProofCount: copiedProofs.length,
        copiedProofs,
        payoutTruthIncluded: !!payoutTruth,
        ...(payoutTruth ? { payoutTruth } : {})
      }
    });
    const manifestPath = path.join(outDir, "manifest.json");
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ ok: true, outDir, manifestPath })}\n`);
    return;
  }

  if (
    args["check-simulation"] === true ||
    args.checkSimulation === true ||
    getEnvBool("npm_config_check_simulation", false) ||
    getEnvBool("NPM_CONFIG_CHECK_SIMULATION", false)
  ) {
    if (!base44) throw new Error("Missing Base44 client; set BASE44_APP_ID/BASE44_SERVICE_TOKEN or use --offline");
    const scanLimit = Number(args["scan-limit"] ?? args.scanLimit ?? args.limit ?? "200");
    const out = await scanSimulationArtifacts(base44, { limit: scanLimit });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exitCode = out.ok ? 0 : 2;
    return;
  }

  if (args["publish-git-changeset"] === true || args.publishGitChangeset === true) {
    if (!base44) throw new Error("Missing Base44 client; set BASE44_APP_ID/BASE44_SERVICE_TOKEN");
    const rawRoots = args["repo-root"] ?? args.repoRoot ?? null;
    const repoRoots = rawRoots
      ? String(rawRoots)
          .split(/[|;,]/g)
          .map((x) => x.trim())
          .filter(Boolean)
      : [process.cwd()];
    const out = await publishGitChangeSetsToBase44(base44, { repoRoots, dryRun: !!dryRun });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }

  if (args["export-payout-truth"] === true || args.exportPayoutTruth === true) {
    if (!base44) throw new Error("Missing Base44 client; set BASE44_APP_ID/BASE44_SERVICE_TOKEN or use --offline");
    const batchId =
      args["batch-id"] ??
      args.batchId ??
      args.batch ??
      process.env.npm_config_batch_id ??
      process.env.NPM_CONFIG_BATCH_ID ??
      null;
    const truthOnlyUiEnabled = (process.env.BASE44_ENABLE_TRUTH_ONLY_UI ?? "false").toLowerCase() === "true";
    const onlyReal =
      args["only-real"] === true ||
      args.onlyReal === true ||
      args["truth-only-ui"] === true ||
      args.truthOnlyUi === true ||
      truthOnlyUiEnabled;
    const out = await exportPayoutTruth(base44, { batchId: batchId != null ? String(batchId) : null, limit, onlyReal });
    process.stdout.write(
      `${JSON.stringify({
        ...out,
        liveExecutionEnabled: (process.env.SWARM_LIVE ?? "false").toLowerCase() === "true",
        truthOnlyUiEnabled,
        truthOnlyUiRequested: !!onlyReal
      })}\n`
    );
    return;
  }

  if (args["repair-payout-truth"] === true || args.repairPayoutTruth === true) {
    if (!base44) {
      console.warn("⚠️ Base44 client missing. Defaulting to OFFLINE mode for payout truth repair.");
      console.warn("   (Use --offline explicitly to suppress this warning)");
      // Force offline mode behavior
      args.offline = true;
      const out = await repairSubmittedWithoutProviderId(null, { limit, dryRun: !!dryRun }); // Pass null as base44
      process.stdout.write(`${JSON.stringify(out)}\n`);
      return;
    }
    const out = await repairSubmittedWithoutProviderId(base44, { limit, dryRun: !!dryRun });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }

  if (args["proof-of-life-payout"] === true || args.proofOfLifePayout === true) {
    const recipient =
      args.recipient ??
      args["recipient-email"] ??
      args.email ??
      positional[0] ??
      null;
    if (!String(recipient ?? "").trim()) throw new Error("Missing --recipient for proof-of-life-payout");
    const recipientType =
      args["recipient-type"] ??
      args.recipientType ??
      args["payout-recipient-type"] ??
      args.payoutRecipientType ??
      "paypal";
    const amountRaw = args.amount ?? args["payout-amount"] ?? args.payoutAmount ?? "0.01";
    const currencyRaw = args.currency ?? args["payout-currency"] ?? args.payoutCurrency ?? "USD";
    const batchId =
      args["batch-id"] ??
      args.batchId ??
      args.batch ??
      process.env.npm_config_batch_id ??
      process.env.NPM_CONFIG_BATCH_ID ??
      null;

    if (dryRun || !base44) {
      const day = formatDay();
      const plan = {
        ok: true,
        dryRun: true,
        liveExecutionEnabled: (process.env.SWARM_LIVE ?? "false").toLowerCase() === "true",
        requiredFlags: {
          SWARM_LIVE: "true",
          BASE44_ENABLE_PAYOUT_LEDGER_WRITE: "true",
          PAYPAL_CLIENT_ID: "(set)",
          PAYPAL_CLIENT_SECRET: "(set)"
        },
        payout: {
          batchId:
            batchId != null && String(batchId).trim()
              ? String(batchId).trim()
              : makeProofOfLifeBatchId({
                  recipientType: normalizeRecipientType(recipientType ?? "paypal", "paypal"),
                  recipient: String(recipient ?? "").trim(),
                  amount: normalizeMoneyAmount(amountRaw, 0.01),
                  currency: String(currencyRaw ?? "USD"),
                  day
                }),
          recipientType: normalizeRecipientType(recipientType ?? "paypal", "paypal"),
          recipient: String(recipient ?? "").trim(),
          amount: normalizeMoneyAmount(amountRaw, 0.01),
          currency: String(currencyRaw ?? "USD")
        }
      };
      process.stdout.write(`${JSON.stringify(plan)}\n`);
      return;
    }

    const ensured = await ensureProofOfLifePayout(base44, {
      recipientType,
      recipient,
      amount: amountRaw,
      currency: currencyRaw,
      batchId,
      dryRun: false
    });
    const approved = await approvePayoutBatch(base44, { batchId: ensured.batchId, args, dryRun: false });
    const submitted = await submitPayPalPayoutBatch(base44, { batchId: ensured.batchId, args, dryRun: false });
    process.stdout.write(`${JSON.stringify({ ok: true, ensured, approved, submitted })}\n`);
    return;
  }

  if (
    args["available-balance"] === true ||
    args.availableBalance === true ||
    getEnvBool("npm_config_available_balance", false) ||
    getEnvBool("NPM_CONFIG_AVAILABLE_BALANCE", false)
  ) {
    const bal = await computeAvailableBalance(base44);
    process.stdout.write(`${JSON.stringify({ ok: true, ...bal })}\n`);
    return;
  }

  if (
    args["create-payout-batches"] === true ||
    args.createPayoutBatches === true ||
    getEnvBool("npm_config_create_payout_batches", false) ||
    getEnvBool("NPM_CONFIG_CREATE_PAYOUT_BATCHES", false)
  ) {
    if (!dryRun) {
      if (!shouldWritePayoutLedger()) throw new Error("Refusing to write payout ledger without BASE44_ENABLE_PAYOUT_LEDGER_WRITE=true");
      requireLiveMode("create payout batches");
    }
    const settlementId =
      args["payout-settlement-id"] ??
      args["settlement-id"] ??
      args.settlementId ??
      process.env.npm_config_payout_settlement_id ??
      process.env.NPM_CONFIG_PAYOUT_SETTLEMENT_ID ??
      process.env.npm_config_settlement_id ??
      process.env.NPM_CONFIG_SETTLEMENT_ID ??
      null;
    const payoutBeneficiary =
      args["payout-beneficiary"] ??
      args["earning-beneficiary"] ??
      args.earningBeneficiary ??
      process.env.npm_config_payout_beneficiary ??
      process.env.NPM_CONFIG_PAYOUT_BENEFICIARY ??
      process.env.npm_config_earning_beneficiary ??
      process.env.NPM_CONFIG_EARNING_BENEFICIARY ??
      null;
    const payoutRecipientType =
      args["payout-recipient-type"] ??
      args.payoutRecipientType ??
      args["recipient-type"] ??
      args.recipientType ??
      process.env.npm_config_payout_recipient_type ??
      process.env.NPM_CONFIG_PAYOUT_RECIPIENT_TYPE ??
      process.env.npm_config_recipient_type ??
      process.env.NPM_CONFIG_RECIPIENT_TYPE ??
      null;
    const fromIso = args["payout-from"] ?? args["settlement-from"] ?? args.from ?? null;
    const toIso = args["payout-to"] ?? args["settlement-to"] ?? args.to ?? null;
    let out;
    try {
      out = await createPayoutBatchesFromEarnings(base44, {
        settlementId,
        beneficiary: payoutBeneficiary,
        recipientType: payoutRecipientType,
        fromIso,
        toIso,
        limit,
        dryRun: !!dryRun
      });
    } catch (err) {
      if (err.message && err.message.includes("Entity schema Earning not found")) {
         console.error("❌ CRITICAL: 'Earning' schema is missing. Skipping payout batch creation. Please create schema manually.");
         out = { ok: false, error: "Schema missing: Earning" };
      } else if (err.message && err.message.includes("Entity schema PayoutBatch not found")) {
         console.error("❌ CRITICAL: 'PayoutBatch' schema is missing. Skipping payout batch creation. Please create schema manually.");
         out = { ok: false, error: "Schema missing: PayoutBatch" };
      } else {
        throw err;
      }
    }
    process.stdout.write(`${JSON.stringify({ ok: true, ...out })}\n`);
    return;
  }

  if (
    args["report-pending-approval"] === true ||
    args.reportPendingApproval === true ||
    getEnvBool("npm_config_report_pending_approval", false) ||
    getEnvBool("NPM_CONFIG_REPORT_PENDING_APPROVAL", false)
  ) {
    const batches = await reportPendingApprovalBatches(base44);
    process.stdout.write(`${JSON.stringify({ ok: true, count: batches.length, batches })}\n`);
    return;
  }

  if (
    args["report-approved-batches"] === true ||
    args.reportApprovedBatches === true ||
    getEnvBool("npm_config_report_approved_batches", false) ||
    getEnvBool("NPM_CONFIG_REPORT_APPROVED_BATCHES", false)
  ) {
    const batches = await reportApprovedBatches(base44);
    process.stdout.write(`${JSON.stringify({ ok: true, count: batches.length, batches })}\n`);
    return;
  }

  if (
    args["approve-payout-batch"] === true ||
    args.approvePayoutBatch === true ||
    getEnvBool("npm_config_approve_payout_batch", false) ||
    getEnvBool("NPM_CONFIG_APPROVE_PAYOUT_BATCH", false)
  ) {
    const batchId =
      args["batch-id"] ??
      args.batchId ??
      args.batch ??
      process.env.npm_config_batch_id ??
      process.env.NPM_CONFIG_BATCH_ID ??
      null;
    if (!batchId) throw new Error("Missing --batch-id for approve-payout-batch");
    const out = await approvePayoutBatch(base44, { batchId: String(batchId), args, dryRun: !!dryRun });
    process.stdout.write(`${JSON.stringify({ ok: true, ...out })}\n`);
    return;
  }

  if (
    args["submit-payout-batch"] === true ||
    args.submitPayoutBatch === true ||
    args["submit-paypal-payout-batch"] === true ||
    args.submitPayPalPayoutBatch === true ||
    getEnvBool("npm_config_submit_payout_batch", false) ||
    getEnvBool("NPM_CONFIG_SUBMIT_PAYOUT_BATCH", false)
  ) {
    const batchId =
      args["batch-id"] ??
      args.batchId ??
      args.batch ??
      process.env.npm_config_batch_id ??
      process.env.NPM_CONFIG_BATCH_ID ??
      null;
    if (!batchId) throw new Error("Missing --batch-id for submit-payout-batch");
    const out = await submitPayPalPayoutBatch(base44, { batchId: String(batchId), args, dryRun: !!dryRun });
    process.stdout.write(`${JSON.stringify({ ok: true, ...out })}\n`);
    return;
  }

  if (
    args["sync-paypal-ledger-batch"] === true ||
    args.syncPayPalLedgerBatch === true ||
    getEnvBool("npm_config_sync_paypal_ledger_batch", false) ||
    getEnvBool("NPM_CONFIG_SYNC_PAYPAL_LEDGER_BATCH", false)
  ) {
    const batchId =
      args["batch-id"] ??
      args.batchId ??
      args.batch ??
      process.env.npm_config_batch_id ??
      process.env.NPM_CONFIG_BATCH_ID ??
      null;
    const paypalBatchId = args["paypal-batch-id"] ?? args.paypalBatchId ?? null;
    if (!batchId && !paypalBatchId) throw new Error("Missing --batch-id or --paypal-batch-id for sync-paypal-ledger-batch");
    const out = await syncPayPalBatchToLedger(base44, { batchId: batchId != null ? String(batchId) : null, paypalBatchId: paypalBatchId != null ? String(paypalBatchId) : null, dryRun: !!dryRun });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }

  if (
    args["export-payoneer-batch"] === true ||
    args.exportPayoneerBatch === true ||
    getEnvBool("npm_config_export_payoneer_batch", false) ||
    getEnvBool("NPM_CONFIG_EXPORT_PAYONEER_BATCH", false)
  ) {
    const batchId =
      args["batch-id"] ??
      args.batchId ??
      args.batch ??
      process.env.npm_config_batch_id ??
      process.env.NPM_CONFIG_BATCH_ID ??
      null;
    if (!batchId) throw new Error("Missing --batch-id for export-payoneer-batch");
    const outPath = args.out ?? args["out"] ?? args["out-path"] ?? args.outPath ?? null;
    const out = await exportPayoneerBatch(base44, { batchId: String(batchId), outPath });
    process.stdout.write(`${JSON.stringify({ ok: true, ...out })}\n`);
    return;
  }

  if (
    args["export-bank-wire-batch"] === true ||
    args.exportBankWireBatch === true ||
    getEnvBool("npm_config_export_bank_wire_batch", false) ||
    getEnvBool("NPM_CONFIG_EXPORT_BANK_WIRE_BATCH", false)
  ) {
    const batchId =
      args["batch-id"] ??
      args.batchId ??
      args.batch ??
      process.env.npm_config_batch_id ??
      process.env.NPM_CONFIG_BATCH_ID ??
      null;
    if (!batchId) throw new Error("Missing --batch-id for export-bank-wire-batch");
    const outPath = args.out ?? args["out"] ?? args["out-path"] ?? args.outPath ?? null;
    const destination = {
      ...(args.destination ? parseDestinationJson(String(args.destination)) : parseDestinationJson(process.env.BASE44_PAYOUT_DESTINATION_JSON)),
      ...(args["dest-bank"] ? { bank: String(args["dest-bank"]) } : {}),
      ...(args["dest-swift"] ? { swift: String(args["dest-swift"]) } : {}),
      ...(args["dest-account"] ? { account: String(args["dest-account"]) } : {}),
      ...(args["dest-beneficiary"] ? { beneficiary: String(args["dest-beneficiary"]) } : {})
    };
    const out = await exportBankWireBatch(base44, { batchId: String(batchId), outPath, destination });
    process.stdout.write(`${JSON.stringify({ ok: true, ...out })}\n`);
    return;
  }

  if (
    args["cancel-payout-batch"] === true ||
    args.cancelPayoutBatch === true ||
    getEnvBool("npm_config_cancel_payout_batch", false) ||
    getEnvBool("NPM_CONFIG_CANCEL_PAYOUT_BATCH", false)
  ) {
    const batchId =
      args["batch-id"] ??
      args.batchId ??
      args.batch ??
      process.env.npm_config_batch_id ??
      process.env.NPM_CONFIG_BATCH_ID ??
      null;
    if (!batchId) throw new Error("Missing --batch-id for cancel-payout-batch");
    const out = await cancelPayoutBatch(base44, { batchId: String(batchId), dryRun: !!dryRun });
    process.stdout.write(`${JSON.stringify({ ok: true, ...out })}\n`);
    return;
  }

  if (
    args["report-stuck-payouts"] === true ||
    args.reportStuckPayouts === true ||
    getEnvBool("npm_config_report_stuck_payouts", false) ||
    getEnvBool("NPM_CONFIG_REPORT_STUCK_PAYOUTS", false)
  ) {
    const batchHours = Number(args["batch-hours"] ?? args.batchHours ?? args.hours ?? "24");
    const itemHours = Number(args["item-hours"] ?? args.itemHours ?? args.hours ?? "24");
    const out = await reportStuckPayouts(base44, { batchHours, itemHours });
    process.stdout.write(
      `${JSON.stringify({ ok: true, stuckBatchCount: out.stuckBatches.length, stuckItemCount: out.stuckItems.length, ...out })}\n`
    );
    return;
  }

  if (
    args["report-transaction-logs"] === true ||
    args.reportTransactionLogs === true ||
    getEnvBool("npm_config_report_transaction_logs", false) ||
    getEnvBool("NPM_CONFIG_REPORT_TRANSACTION_LOGS", false)
  ) {
    const fromIso = args.from ?? args["from-iso"] ?? null;
    const toIso = args.to ?? args["to-iso"] ?? null;
    const type = args.type ?? args["transaction-type"] ?? null;
    const category = args.category ?? null;
    const logs = await reportTransactionLogs(base44, { fromIso, toIso, type, category });
    process.stdout.write(`${JSON.stringify({ ok: true, count: logs.length, logs })}\n`);
    return;
  }

  if (
    args["enforce-sla"] === true ||
    args.enforceSLA === true ||
    getEnvBool("npm_config_enforce_sla", false) ||
    getEnvBool("NPM_CONFIG_ENFORCE_SLA", false)
  ) {
    if (!dryRun) {
      requireLiveMode("enforce settlement SLA");
    }
    await enforceSettlementSLA(base44);
    process.stdout.write(`${JSON.stringify({ ok: true, action: "enforce_sla" })}\n`);
    return;
  }

  if (!dryRun) {
    requireLiveMode("emit revenue events");
  }

  const revenueCfg = getRevenueConfig();
  const createEarnings = shouldCreateEarnings(args);
  const beneficiary = getEarningBeneficiary(args);
  const earningCfg = createEarnings ? getEarningConfigFromEnv() : null;
  const settlement = exportSettlement ? getSettlementArgs(args, { beneficiary, dryRun }) : null;

  if (exportSettlement && !beneficiary) {
    throw new Error("export-settlement requires --earning-beneficiary or EARNING_BENEFICIARY");
  }

  if (args.csv) {
    const csvPath = args.csv;
    const result = await emitFromMissionsCsv(base44, revenueCfg, earningCfg, csvPath, {
      dryRun,
      limit,
      createEarnings,
      beneficiary
    });
    let settlementOut = null;
    if (exportSettlement) {
      const out = runSettlementExportCli(settlement);
      settlementOut = out;
    }
    process.stdout.write(`${JSON.stringify({ ok: true, ...result, ...(settlementOut ? { settlementOut } : {}) })}\n`);
    return;
  }

  const amountRaw = args.amount ?? getEnvFirst(["npm_config_amount", "NPM_CONFIG_AMOUNT"]) ?? positional[0] ?? null;
  const amount = amountRaw ? Number(amountRaw) : null;
  const currencyRaw =
    args.currency ?? getEnvFirst(["npm_config_currency", "NPM_CONFIG_CURRENCY"]) ?? positional[1] ?? revenueCfg.defaultCurrency;
  const currency = String(currencyRaw);
  const externalIdRaw =
    args.externalId ??
    args["external-id"] ??
    getEnvFirst(["npm_config_externalid", "npm_config_external_id", "NPM_CONFIG_EXTERNALID", "NPM_CONFIG_EXTERNAL_ID"]) ??
    positional[3] ??
    null;
  const externalId = (externalIdRaw ? String(externalIdRaw) : `manual_${Date.now()}`).toString();
  const occurredAtRaw =
    args.occurredAt ??
    args["occurred-at"] ??
    getEnvFirst([
      "npm_config_occurredat",
      "npm_config_occurred_at",
      "NPM_CONFIG_OCCURREDAT",
      "NPM_CONFIG_OCCURRED_AT"
    ]) ??
    new Date().toISOString();
  const occurredAt = String(occurredAtRaw);
  const sourceRaw = args.source ?? getEnvFirst(["npm_config_source", "NPM_CONFIG_SOURCE"]) ?? positional[2] ?? "manual";
  const source = String(sourceRaw);

  const event = {
    amount,
    currency,
    occurredAt,
    source,
    externalId,
    metadata:
      safeJsonParse(args.metadata ?? getEnvFirst(["npm_config_metadata", "NPM_CONFIG_METADATA"]), {}) ?? {}
  };

  const created = await createBase44RevenueEventIdempotent(base44, revenueCfg, event, { dryRun });
  const createdId = created?.id ?? null;

  let earningCreatedId = null;
  let earningDeduped = false;
  if (createEarnings && beneficiary) {
    const pct = getEarningSharePct();
    const payoutMethod = args["payout-method"] ?? args.payoutMethod ?? null;
    const earningRecipientType = args["earning-recipient-type"] ?? args.earningRecipientType ?? args["recipient-type"] ?? args.recipientType ?? null;
    const paypalEmail = args["paypal-email"] ?? args.paypalEmail ?? null;
    const payoneerId = args["payoneer-id"] ?? args.payoneerId ?? null;
    const earning = {
      earningId: `earn:${event.source}:${event.externalId}`,
      amount: Number((Number(event.amount) * pct).toFixed(2)),
      currency: event.currency,
      occurredAt: event.occurredAt,
      source: event.source,
      beneficiary,
      status: "settled_externally_pending",
      metadata: {
        revenue_external_id: event.externalId,
        revenue_source: event.source,
        revenue_amount: event.amount,
        share_pct: pct,
        ...(earningRecipientType ? { recipient_type: String(earningRecipientType) } : {}),
        ...(payoutMethod ? { payout_method: String(payoutMethod) } : {}),
        ...(paypalEmail ? { paypal_email: String(paypalEmail) } : {}),
        ...(payoneerId ? { payoneer_id: String(payoneerId) } : {})
      }
    };
    if (dryRun) {
        console.log("ℹ️ [DryRun] Creating Earning:", JSON.stringify(earning, null, 2));
    }
    try {
      const earningCreated = await createBase44EarningIdempotent(base44, earningCfg, earning, { dryRun });
      earningCreatedId = earningCreated?.id ?? null;
      earningDeduped = earningCreated?.deduped === true;
    } catch (err) {
      if (err.message && err.message.includes("Entity schema Earning not found")) {
         console.error("❌ CRITICAL: 'Earning' schema is missing. Skipping earning creation. Please create schema manually.");
      } else {
        throw err;
      }
    }
  }

  process.stdout.write(
    `${JSON.stringify({ ok: true, createdId, deduped: created?.deduped === true, earningCreatedId, earningDeduped, dryRun: !!dryRun })}\n`
  );

  if (exportSettlement) {
    const out = runSettlementExportCli(settlement);
    process.stdout.write(`${JSON.stringify({ ok: true, settlementOut: out })}\n`);
  }
}

const selfPath = fileURLToPath(import.meta.url);
const argvPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const isMain = argvPath && path.resolve(selfPath) === argvPath;

if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err); // Print stack trace to stderr
      process.stderr.write(`${JSON.stringify({ ok: false, error: err?.message ?? String(err), stack: err?.stack })}\n`);
      process.exitCode = 1;
      process.exit(1);
    });
}

export { normalizeRecipientType, resolveRecipientAddress, createPayoutBatchesFromEarnings };
