import { readSwarmJson, readSwarmText } from './swarm-files';

/**
 * Derive the displayed runtime state from files the tick/audit actually wrote.
 * Missing or stale evidence is reported as unknown/degraded rather than
 * "online": the UI must never turn absence of data into a green status.
 */

interface Heartbeat {
  status?: string;
  at?: string;
  tick_at?: string;
  ok?: boolean;
  blocked_reason?: string;
  missing_env?: string[];
  revenue_enabled?: boolean;
  last_success_at?: string | null;
}

interface SilentState {
  updated_at?: string;
  findings?: Record<string, {
    first_seen?: string;
    last_seen?: string;
    occurrences?: number;
    severity?: string;
  }>;
}

interface ContentieuxReport {
  generated_at?: string;
  totals?: { cases?: number; amount_at_stake_mad?: number; high_severity?: number };
}

interface PayoutLedger {
  items?: Record<string, { status?: string }>;
}

export interface RuntimeStatus {
  status: 'operational' | 'degraded' | 'blocked' | 'unknown';
  reasons: string[];
  generated_at: string;
  heartbeat: {
    status: string;
    at: string | null;
    age_minutes: number | null;
    ok: boolean | null;
    blocked_reason: string | null;
    missing_env: string[];
    revenue_enabled: boolean | null;
    last_success_at: string | null;
  };
  findings: {
    open: number;
    highest: string | null;
    items: Array<{ code: string; severity: string; last_seen: string | null; occurrences: number }>;
    updated_at: string | null;
  };
  contentieux: {
    cases: number;
    amount_at_stake_mad: number;
    high: number;
    generated_at: string | null;
  };
  procurement: {
    total: number;
    open: number;
    by_status: Record<string, number>;
  };
  payouts: {
    total: number;
    submitted: number;
    credited: number;
    failed: number;
    returned: number;
  };
}

const STALE_MINUTES = 90;
const OPEN_PO_STATUSES = new Set(['placed', 'shipped', 'on_hold', 'delivered']);

function ageMinutes(value: string | undefined, now: Date): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.round((now.getTime() - parsed) / 60000));
}

function readProcurement(): RuntimeStatus['procurement'] {
  const text = readSwarmText('data/procurement/pos.ndjson');
  if (!text) return { total: 0, open: 0, by_status: {} };
  const latest = new Map<string, { status?: string }>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.po_ref) latest.set(row.po_ref, row);
    } catch {
      // Ignore malformed historical lines; the audit reports them separately.
    }
  }
  const byStatus: Record<string, number> = {};
  for (const po of latest.values()) {
    const status = String(po.status || 'unknown');
    byStatus[status] = (byStatus[status] || 0) + 1;
  }
  return {
    total: latest.size,
    open: [...latest.values()].filter(po => OPEN_PO_STATUSES.has(String(po.status || ''))).length,
    by_status: byStatus,
  };
}

function readPayouts(): RuntimeStatus['payouts'] {
  const ledger = readSwarmJson<PayoutLedger>('data/financial/payout_ledger.json');
  const items = Object.values(ledger?.items || {});
  const count = (status: string) => items.filter(item => item.status === status).length;
  return {
    total: items.length,
    submitted: count('submitted'),
    credited: count('credited'),
    failed: count('failed'),
    returned: count('returned'),
  };
}

export function buildRuntimeStatus({ now = new Date() }: { now?: Date } = {}): RuntimeStatus {
  const heartbeat = readSwarmJson<Heartbeat>('data/swarm-heartbeat.json');
  const silent = readSwarmJson<SilentState>('data/resilience/silent-state.json');
  const contentieux = readSwarmJson<ContentieuxReport>('data/resilience/contentieux.json');
  const findings = Object.entries(silent?.findings || {}).map(([code, value]) => ({
    code,
    severity: String(value.severity || 'medium'),
    last_seen: value.last_seen || null,
    occurrences: Number(value.occurrences || 0),
  }));
  const severityRank: Record<string, number> = { low: 1, warning: 2, medium: 2, high: 3, critical: 4 };
  const highest = findings.length
    ? [...findings].sort((a, b) => (severityRank[b.severity] || 0) - (severityRank[a.severity] || 0))[0].severity
    : null;
  const heartbeatAge = ageMinutes(heartbeat?.at || heartbeat?.tick_at, now);
  const reasons: string[] = [];

  let status: RuntimeStatus['status'] = 'unknown';
  if (!heartbeat) {
    reasons.push('No heartbeat has been written by the swarm.');
  } else if (heartbeat.status !== 'ok' || heartbeat.ok === false) {
    status = 'blocked';
    reasons.push(heartbeat.blocked_reason || `Heartbeat status is ${heartbeat.status || 'not ok'}.`);
    if (heartbeat.missing_env?.length) reasons.push(`Missing configuration: ${heartbeat.missing_env.join(', ')}.`);
  } else if (heartbeatAge !== null && heartbeatAge > STALE_MINUTES) {
    status = 'degraded';
    reasons.push(`Heartbeat is ${heartbeatAge} minutes old (budget ${STALE_MINUTES}).`);
  } else if (highest && severityRank[highest] >= severityRank.high) {
    status = 'degraded';
    reasons.push(`${findings.filter(item => severityRank[item.severity] >= severityRank.high).length} high/critical finding(s) are open.`);
  } else {
    status = 'operational';
  }

  return {
    status,
    reasons,
    generated_at: now.toISOString(),
    heartbeat: {
      status: heartbeat?.status || 'missing',
      at: heartbeat?.at || null,
      age_minutes: heartbeatAge,
      ok: heartbeat?.ok ?? null,
      blocked_reason: heartbeat?.blocked_reason || null,
      missing_env: heartbeat?.missing_env || [],
      revenue_enabled: heartbeat?.revenue_enabled ?? null,
      last_success_at: heartbeat?.last_success_at || null,
    },
    findings: {
      open: findings.length,
      highest,
      items: findings,
      updated_at: silent?.updated_at || null,
    },
    contentieux: {
      cases: contentieux?.totals?.cases || 0,
      amount_at_stake_mad: contentieux?.totals?.amount_at_stake_mad || 0,
      high: contentieux?.totals?.high_severity || 0,
      generated_at: contentieux?.generated_at || null,
    },
    procurement: readProcurement(),
    payouts: readPayouts(),
  };
}
