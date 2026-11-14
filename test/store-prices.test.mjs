import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  loadCoursePrices,
  productsFromCoursePrices,
  storefrontPricePayload
} from '../src/sales/store-prices.mjs';

test('course prices are explicit, unique, and contain no hash-derived values', () => {
  const loaded = loadCoursePrices();
  const slugs = Object.keys(loaded.prices);
  assert.equal(slugs.length, 298);
  assert.equal(new Set(slugs).size, slugs.length);
  assert.equal(loaded.currency, 'USD');
  assert.equal(loaded.fulfillmentCostCents, 200);
  assert.deepEqual(loaded.prices['certified-blockchain-expert-cbe-preptest-2025'], {
    name: 'Certified Blockchain Expert (CBE) preptest 2025',
    price: 19
  });
});

test('the server products and public price file share the canonical prices', () => {
  const products = productsFromCoursePrices();
  assert.equal(products.length, 298);
  assert.deepEqual(products.find((row) => row.id === 'financial-risk-manager-test-bank'), {
    id: 'financial-risk-manager-test-bank',
    name: 'Financial Risk Manager Test Bank',
    price: 19,
    currency: 'USD',
    fulfillment_cost_cents: 200
  });
  assert.deepEqual(
    JSON.parse(fs.readFileSync('data/store-prices.json', 'utf8')),
    storefrontPricePayload()
  );
});
