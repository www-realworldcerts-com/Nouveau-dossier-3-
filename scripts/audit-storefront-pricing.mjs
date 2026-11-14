import fs from 'node:fs';
import path from 'node:path';

import { loadCoursePrices } from '../src/sales/store-prices.mjs';

function args(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) out[key] = true;
    else {
      out[key] = value;
      i += 1;
    }
  }
  return out;
}

const cli = args(process.argv);
const base = String(cli.base || 'https://www.realworldcerts.com').replace(/\/+$/, '');
const catalogPath = path.resolve(cli.catalog || 'data/catalog.json');
const limit = Math.max(1, Number(cli.limit || Number.MAX_SAFE_INTEGER));
const concurrency = Math.max(1, Number(cli.concurrency || 12));
const timeoutMs = Math.max(1000, Number(cli.timeout || 20000));

const catalogRaw = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const items = Array.isArray(catalogRaw) ? catalogRaw : Array.isArray(catalogRaw.items) ? catalogRaw.items : [];
const bySlug = new Map();
for (const item of items) {
  const slug = String(item?.slug || '').trim();
  if (slug && !bySlug.has(slug)) bySlug.set(slug, item);
}
const slugs = [...bySlug.keys()].slice(0, limit);

const prices = loadCoursePrices(cli.prices);
const priceSlugs = new Set(Object.keys(prices.prices));

async function fetchText(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': 'RealWorldCertsPricingAudit/1.0' }
  });
  return { status: response.status, text: await response.text() };
}

async function auditCourse(slug) {
  const url = `${base}/catalog/${encodeURIComponent(slug)}.html`;
  try {
    const { status, text } = await fetchText(url);
    const links = [...text.matchAll(/href="([^"]*\/checkout\/(?:paypal|payoneer|crypto|bank)[^"]*)"/gi)]
      .map((match) => match[1]);
    const amountLinks = links.filter((link) => /[?&]amount=/.test(link));
    const visiblePrice = /(?:id="amount"[^>]*>\s*\$?\s*\d|\$\s*\d+\.\d{2}|data-price=)/i.test(text);
    return {
      slug,
      status,
      checkout_links: links.length,
      checkout_links_with_amount: amountLinks.length,
      visible_price: visiblePrice,
      has_explicit_map_price: priceSlugs.has(slug)
    };
  } catch (error) {
    return { slug, error: error?.message ?? String(error) };
  }
}

async function auditCheckout(method, slug) {
  const url = `${base}/checkout/${method}?slug=${encodeURIComponent(slug)}`;
  try {
    const { status, text } = await fetchText(url);
    return {
      method,
      status,
      slug_derived_price: /\bfpn\b/.test(text) || /19\s*\+\s*(?:fpn|fp)\s*\/\s*10000/.test(text),
      accepts_amount_override: /q\.get\(["']amount["']\)/.test(text),
      has_manual_email_flow: /email .*payment details|email .*order reference|billing@realworldcerts\.com/i.test(text)
    };
  } catch (error) {
    return { method, status: 0, error: error?.message ?? String(error) };
  }
}

const results = [];
let next = 0;
async function worker() {
  while (next < slugs.length) {
    const index = next;
    next += 1;
    results[index] = await auditCourse(slugs[index]);
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, slugs.length) }, worker));

const sampleSlug = slugs[0] || 'certified-blockchain-expert-cbe-preptest-2025';
const checkout = [];
for (const method of ['paypal', 'payoneer', 'crypto', 'bank']) {
  checkout.push(await auditCheckout(method, sampleSlug));
}

const summary = {
  audited_at: new Date().toISOString(),
  base,
  catalog_items: items.length,
  unique_courses: bySlug.size,
  audited_courses: results.length,
  explicit_prices: priceSlugs.size,
  course_pages_missing_price: results.filter((row) => row.status === 200 && !row.visible_price).length,
  course_pages_without_checkout: results.filter((row) => row.status === 200 && row.checkout_links === 0).length,
  checkout_links_without_amount: results.reduce((sum, row) => sum + Math.max(0, (row.checkout_links || 0) - (row.checkout_links_with_amount || 0)), 0),
  errors: results.filter((row) => row.error || row.status !== 200).length,
  checkout,
  results
};

const out = cli.out ? path.resolve(cli.out) : null;
if (out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(summary, null, 2) + '\n');
}
console.log(JSON.stringify({
  ok: summary.errors === 0 && summary.checkout.every((row) => row.status === 200),
  base: summary.base,
  catalog_items: summary.catalog_items,
  unique_courses: summary.unique_courses,
  audited_courses: summary.audited_courses,
  explicit_prices: summary.explicit_prices,
  course_pages_missing_price: summary.course_pages_missing_price,
  course_pages_without_checkout: summary.course_pages_without_checkout,
  checkout_links_without_amount: summary.checkout_links_without_amount,
  errors: summary.errors,
  checkout: summary.checkout,
  out
}, null, 2));
