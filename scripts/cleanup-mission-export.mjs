import fs from 'node:fs';
import path from 'node:path';

import { containsSecrets, writeSanitizedText } from '../src/security/export-sanitizer.mjs';

function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        const next = text[i + 1];
        if (next === '"') {
          cell += '"';
          i += 2;
          continue;
        } else {
          inQuotes = false;
          i += 1;
          continue;
        }
      } else {
        cell += ch;
        i += 1;
        continue;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i += 1;
        continue;
      }
      if (ch === ',') {
        row.push(cell);
        cell = '';
        i += 1;
        continue;
      }
      if (ch === '\r') {
        // skip, handle at \n
        i += 1;
        continue;
      }
      if (ch === '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
    }
  }
  // flush last cell/row
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function toCSV(rows) {
  const escapeCell = (v) => {
    const s = v == null ? '' : String(v);
    const needsQuotes = s.includes(',') || s.includes('\n') || s.includes('"');
    if (!needsQuotes) return s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return rows.map((r) => r.map(escapeCell).join(',')).join('\n');
}

function tryJsonParse(s, fallback) {
  try {
    if (!s || !String(s).trim()) return fallback;
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function minifyJsonString(obj) {
  try {
    return JSON.stringify(obj ?? {});
  } catch {
    return '{}';
  }
}

function normalizeBoolean(v) {
  const s = String(v ?? '').toLowerCase().trim();
  if (['true', '1', 'yes'].includes(s)) return 'true';
  if (['false', '0', 'no'].includes(s)) return 'false';
  return 'false';
}

function envJson(name, fallback) {
  try {
    const raw = process.env[name];
    if (!raw || !String(raw).trim()) return fallback;
    const parsed = JSON.parse(raw);
    return parsed;
  } catch {
    return fallback;
  }
}

const ALLOW_TITLES = envJson('MISSION_ALLOWLIST', []);
const DENY_TITLES = envJson('MISSION_DENYLIST', []);
const REVIVED_WINDOW_DAYS = Number(process.env.MISSION_REVIVED_WINDOW_DAYS ?? '30');
const NOW_MS = Date.now();
const REVIVED_THRESHOLD_MS = NOW_MS - REVIVED_WINDOW_DAYS * 24 * 60 * 60 * 1000;

function titleMatches(title, list) {
  const t = String(title || '').trim().toLowerCase();
  return Array.isArray(list) && list.some((x) => String(x || '').trim().toLowerCase() === t);
}

function hasRevenueIndicators(rec, mpObj, pdObj) {
  const revVal = Number(rec.revenue_generated ?? 0);
  if (revVal > 0) return true;
  const mp = mpObj || {};
  const pd = pdObj || {};
  const hasTargetRevenue = Object.prototype.hasOwnProperty.call(mp, 'target_revenue');
  const hasPaymentConfig = Object.prototype.hasOwnProperty.call(mp, 'payment_configuration');
  const hasPaymentPlatform = String(mp?.payment_configuration?.payment_platform || '').trim() !== '';
  const completionPct = Number(pd?.completion_percentage ?? 0);
  if (hasTargetRevenue || hasPaymentConfig || hasPaymentPlatform) return true;
  if (completionPct > 0 && String(rec.status || '').toLowerCase() !== 'completed') return true;
  return false;
}

function cleanupRecord(rec) {
  // Normalize mission_parameters and progress_data
  const mp = tryJsonParse(rec.mission_parameters, {});
  const pd = tryJsonParse(rec.progress_data, {});
  rec.mission_parameters = minifyJsonString(mp);
  rec.progress_data = minifyJsonString(pd);

  // Normalize assigned_agent_ids
  const agents = tryJsonParse(rec.assigned_agent_ids, []);
  if (!Array.isArray(agents)) rec.assigned_agent_ids = '[]';
  else rec.assigned_agent_ids = minifyJsonString(agents);

  // Standardize is_sample
  rec.is_sample = normalizeBoolean(rec.is_sample);

  // Remove embedded CSV artifacts or dangerous payloads in title
  const t = String(rec.title || '').toLowerCase();
  if (
    t.includes('add paypal api settings') ||
    t.includes('execute transfer') && t.includes('paypal') ||
    t.includes('authorize and execute transfer') ||
    t.includes('monthly paypal transfer') ||
    t.includes('one-time paypal transfer')
  ) {
    rec.__drop = true;
  }

  // Targeted removal of deployment rows already taken care of
  const exact = String(rec.title || '').trim();
  if (exact === '🚀 DEPLOY: Push Code to GitHub Remote' || exact === '🎯 FINAL DEPLOYMENT CHECKLIST') {
    rec.__drop = true;
  }

  // Env-driven allow/deny lists
  if (titleMatches(rec.title, DENY_TITLES)) rec.__drop = true;
  if (titleMatches(rec.title, ALLOW_TITLES)) rec.__keep = true;

  // Preserve revived missions and those with revenue indicators
  const updated = Date.parse(rec.updated_date || '');
  const isRevived = !isNaN(updated) && updated >= REVIVED_THRESHOLD_MS;
  const hasRev = hasRevenueIndicators(rec, mp, pd);
  const statusStr = String(rec.status || '').toLowerCase();
  const isActive = statusStr === 'in_progress' || statusStr === 'pending';
  if ((isRevived && isActive) || hasRev) rec.__keep = true;

  // Drop obviously duplicated placeholders
  if (t === 'tri-001') {
    rec.__dupKey = 'tri-001';
  }
  return rec;
}

function main() {
  const target = process.argv[2] || path.resolve(process.cwd(), 'Mission_export (73).csv');
  const raw = fs.readFileSync(target, 'utf8');
  const rows = parseCSV(raw);
  if (rows.length < 2) {
    console.log(JSON.stringify({ ok: false, error: 'no_rows' }, null, 2));
    process.exit(1);
  }
  const header = rows[0];
  const idx = (name) => header.indexOf(name);
  const toObj = (r) => ({
    title: r[idx('title')],
    type: r[idx('type')],
    priority: r[idx('priority')],
    status: r[idx('status')],
    assigned_agent_ids: r[idx('assigned_agent_ids')],
    mission_parameters: r[idx('mission_parameters')],
    progress_data: r[idx('progress_data')],
    estimated_duration_hours: r[idx('estimated_duration_hours')],
    actual_duration_hours: r[idx('actual_duration_hours')],
    deadline: r[idx('deadline')],
    completion_notes: r[idx('completion_notes')],
    revenue_generated: r[idx('revenue_generated')],
    id: r[idx('id')],
    created_date: r[idx('created_date')],
    updated_date: r[idx('updated_date')],
    created_by_id: r[idx('created_by_id')],
    created_by: r[idx('created_by')],
    is_sample: r[idx('is_sample')]
  });
  const toRow = (o) => [
    o.title ?? '',
    o.type ?? '',
    o.priority ?? '',
    o.status ?? '',
    o.assigned_agent_ids ?? '[]',
    o.mission_parameters ?? '{}',
    o.progress_data ?? '{}',
    o.estimated_duration_hours ?? '',
    o.actual_duration_hours ?? '',
    o.deadline ?? '',
    o.completion_notes ?? '',
    o.revenue_generated ?? '',
    o.id ?? '',
    o.created_date ?? '',
    o.updated_date ?? '',
    o.created_by_id ?? '',
    o.created_by ?? '',
    o.is_sample ?? 'false'
  ];

  // Map, clean, and dedupe
  const cleaned = [];
  const seenTitles = new Map();
  const seenDupKeys = new Set();
  for (let i = 1; i < rows.length; i++) {
    const obj = cleanupRecord(toObj(rows[i]));
    if (obj.__drop && !obj.__keep) continue;
    const tkey = String(obj.title || '').trim().toLowerCase();
    const existing = seenTitles.get(tkey);
    if (existing) {
      // keep earliest created_date
      const a = Date.parse(existing.created_date || '1970-01-01');
      const b = Date.parse(obj.created_date || '1970-01-01');
      if (!isNaN(b) && !isNaN(a) && b >= a) continue;
    }
    if (obj.__dupKey) {
      if (seenDupKeys.has(obj.__dupKey)) continue;
      seenDupKeys.add(obj.__dupKey);
    }
    seenTitles.set(tkey, obj);
    cleaned.push(obj);
  }

  // Sort by priority then status then created_date
  const prioRank = { critical: 0, high: 1, medium: 2, low: 3 };
  const statusRank = { in_progress: 0, pending: 1, completed: 2, paused: 3 };
  cleaned.sort((a, b) => {
    const pa = prioRank[String(a.priority || '').toLowerCase()] ?? 99;
    const pb = prioRank[String(b.priority || '').toLowerCase()] ?? 99;
    if (pa !== pb) return pa - pb;
    const sa = statusRank[String(a.status || '').toLowerCase()] ?? 99;
    const sb = statusRank[String(b.status || '').toLowerCase()] ?? 99;
    if (sa !== sb) return sa - sb;
    const da = Date.parse(a.created_date || '1970-01-01');
    const db = Date.parse(b.created_date || '1970-01-01');
    return (isNaN(da) ? 0 : da) - (isNaN(db) ? 0 : db);
  });

  const outRows = [header, ...cleaned.map(toRow)];
  const outCsv = toCSV(outRows);

  // Backup and write
  const backup = `${target}.bak`;
  try {
    if (!fs.existsSync(backup)) {
      writeSanitizedText(backup, raw);
    } else if (containsSecrets(fs.readFileSync(backup, 'utf8'))) {
      writeSanitizedText(backup, fs.readFileSync(backup, 'utf8'));
    }
  } catch {}
  writeSanitizedText(target, outCsv);

  console.log(JSON.stringify({ ok: true, input_rows: rows.length - 1, output_rows: cleaned.length }, null, 2));
}

main();
