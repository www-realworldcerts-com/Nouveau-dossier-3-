import fs from 'node:fs';
import path from 'node:path';

import { storefrontPricePayload } from '../src/sales/store-prices.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) args[key] = true;
    else {
      args[key] = value;
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv);
const catalogPath = path.resolve(args.catalog || 'data/catalog.json');
const price = Number(args.price ?? 19);
const currency = String(args.currency || 'USD').toUpperCase();
const fulfillmentCostCents = Math.max(0, Math.round(Number(args['fulfillment-cost-cents'] ?? 200)));

if (!Number.isFinite(price) || price <= 0) {
  console.error('--price must be a positive amount');
  process.exit(1);
}
if (!Number.isFinite(fulfillmentCostCents)) {
  console.error('--fulfillment-cost-cents must be a non-negative integer');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const items = Array.isArray(raw) ? raw : Array.isArray(raw.items) ? raw.items : [];
const seen = new Set();
const duplicates = [];
const prices = {};

for (const item of items) {
  const slug = String(item?.slug || '').trim();
  if (!slug) continue;
  const name = String(item.title || slug);
  if (seen.has(slug)) {
    if (prices[slug].name !== name) throw new Error(`Conflicting catalog records for slug: ${slug}`);
    duplicates.push(slug);
    continue;
  }
  seen.add(slug);
  prices[slug] = { name, price: Number(price.toFixed(2)) };
}

if (!Object.keys(prices).length) {
  console.error(`No catalog items found in ${catalogPath}`);
  process.exit(1);
}

const canonicalPath = path.join(process.cwd(), 'config', 'course-prices.json');
const publicPath = path.join(process.cwd(), 'data', 'store-prices.json');
fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
fs.writeFileSync(canonicalPath, JSON.stringify({ currency, fulfillment_cost_cents: fulfillmentCostCents, prices }, null, 2) + '\n');
fs.mkdirSync(path.dirname(publicPath), { recursive: true });
fs.writeFileSync(publicPath, JSON.stringify(storefrontPricePayload(canonicalPath), null, 2) + '\n');

console.log(JSON.stringify({
  ok: true,
  courses: Object.keys(prices).length,
  catalog_items: items.length,
  duplicate_items_collapsed: duplicates.length,
  currency,
  price,
  fulfillment_cost_cents: fulfillmentCostCents,
  canonical: canonicalPath,
  public: publicPath
}, null, 2));
