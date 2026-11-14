import fs from 'node:fs';
import path from 'node:path';

/**
 * Server-owned course prices.
 *
 * `config/course-prices.json` is the only source of truth. The public payload
 * is derived from it for the static checkout pages; there is no hash or
 * client-supplied amount fallback.
 */

export const DEFAULT_COURSE_PRICES_FILE = path.join(process.cwd(), 'config', 'course-prices.json');

export function loadCoursePrices(file = process.env.COURSE_PRICES_FILE || DEFAULT_COURSE_PRICES_FILE) {
  const raw = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const currency = String(raw?.currency || '').toUpperCase();
  if (!currency) throw new Error('Course price file is missing a currency');

  const fulfillmentCostCents = Math.max(0, Math.round(Number(raw?.fulfillment_cost_cents ?? 0)));
  const prices = {};

  for (const [slug, record] of Object.entries(raw?.prices || {})) {
    const key = String(slug || '').trim();
    const price = Number(record?.price);
    if (!key || !Number.isFinite(price) || price <= 0) {
      throw new Error(`Invalid explicit price for ${key || '(empty slug)'}`);
    }
    prices[key] = {
      name: String(record.name || key),
      price: Number(price.toFixed(2))
    };
  }

  if (!Object.keys(prices).length) throw new Error('Course price file has no prices');
  return { currency, fulfillmentCostCents, prices };
}

export function productsFromCoursePrices(file) {
  const { currency, fulfillmentCostCents, prices } = loadCoursePrices(file);
  return Object.entries(prices).map(([slug, record]) => ({
    id: slug,
    name: record.name,
    price: record.price,
    currency,
    fulfillment_cost_cents: fulfillmentCostCents
  }));
}

/** Compact payload served to the static checkout pages. */
export function storefrontPricePayload(file) {
  const { currency, prices } = loadCoursePrices(file);
  return {
    currency,
    prices: Object.fromEntries(Object.entries(prices).map(([slug, record]) => [slug, record.price]))
  };
}
