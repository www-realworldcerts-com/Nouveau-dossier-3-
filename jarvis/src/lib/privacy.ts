import crypto from 'node:crypto';

/**
 * Per-request privacy masking, inspired by magpie's gateway masking.
 *
 * High-confidence secrets and personal identifiers are replaced with stable
 * placeholders before a request leaves the server. The same value always gets
 * the same placeholder, so a conversation and prompt cache stay coherent. The
 * map lives only in memory for this request; values are never logged or stored.
 *
 * Masking is intentionally conservative: normal prose, URLs, SKUs and item IDs
 * are left alone.
 */

export type PrivacyKind =
  | 'PRIVATE_KEY'
  | 'API_KEY'
  | 'TOKEN'
  | 'EMAIL'
  | 'IBAN'
  | 'CARD'
  | 'BANK_ACCOUNT'
  | 'PHONE';

export interface PrivacySummary {
  masked_values: number;
  by_kind: Record<string, number>;
}

export interface PrivacyMasker {
  mask: (text: string) => string;
  unmask: (text: string) => string;
  summary: () => PrivacySummary;
}

interface Rule {
  kind: PrivacyKind;
  pattern: RegExp;
  validate?: (value: string) => boolean;
}

function luhn(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = Number(digits[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

const RULES: Rule[] = [
  {
    kind: 'PRIVATE_KEY',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    kind: 'API_KEY',
    pattern: /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|shpat_[a-f0-9]{32})\b/g,
  },
  {
    kind: 'TOKEN',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    kind: 'TOKEN',
    pattern: /(\bBearer\s+)[A-Za-z0-9._~+/=-]{20,}/g,
  },
  {
    kind: 'EMAIL',
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    validate: value => !/@(?:example\.(?:com|org|net)|.*\.(?:test|invalid))$/i.test(value),
  },
  {
    kind: 'IBAN',
    pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
  },
  {
    kind: 'CARD',
    pattern: /\b(?:\d[ -]?){13,19}\b/g,
    validate: luhn,
  },
  {
    kind: 'BANK_ACCOUNT',
    pattern: /\b\d{20,34}\b/g,
  },
  {
    kind: 'PHONE',
    pattern: /(?<!\d)(?:\+212|0)[5-7]\d{8}(?!\d)/g,
  },
];

function placeholder(kind: PrivacyKind, value: string): string {
  const digest = crypto.createHash('sha256').update(value).digest('hex').slice(0, 10);
  return `{{${kind}_${digest}}}`;
}

export function createPrivacyMasker(): PrivacyMasker {
  const forward = new Map<string, string>();
  const reverse = new Map<string, string>();
  const counts: Record<string, number> = {};

  const mask = (text: string): string => {
    if (!text) return text;
    let result = String(text);
    for (const rule of RULES) {
      result = result.replace(rule.pattern, (...args) => {
        const match = String(args[0]);
        // Keep labels such as "Bearer " outside the placeholder.
        const prefix = rule.kind === 'TOKEN' && match.toLowerCase().startsWith('bearer ')
          ? match.slice(0, 7)
          : '';
        const value = prefix ? match.slice(7) : match;
        if (rule.validate && !rule.validate(value)) return match;
        const token = placeholder(rule.kind, value);
        if (!forward.has(value)) {
          forward.set(value, token);
          reverse.set(token, value);
          counts[rule.kind] = (counts[rule.kind] || 0) + 1;
        }
        return `${prefix}${token}`;
      });
    }
    return result;
  };

  const unmask = (text: string): string => {
    if (!text) return text;
    let result = String(text);
    for (const [token, value] of reverse) {
      result = result.split(token).join(value);
    }
    return result;
  };

  const summary = (): PrivacySummary => ({
    masked_values: forward.size,
    by_kind: { ...counts },
  });

  return { mask, unmask, summary };
}
