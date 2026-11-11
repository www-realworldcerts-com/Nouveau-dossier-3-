import test from "node:test";
import assert from "node:assert/strict";

import { resolveRuntimeConfig } from "../src/autonomous-daemon.mjs";

test("resolveRuntimeConfig enables create payout batches from CLI flag", () => {
  const cfg = resolveRuntimeConfig({ "create-payout-batches": true }, {});
  assert.equal(cfg.tasks.createPayoutBatches, true);
});

test("resolveRuntimeConfig enables auto approve batches when auto approve payouts enabled", () => {
  const cfg = resolveRuntimeConfig({ "auto-approve-payouts": true }, {});
  assert.equal(cfg.payout.autoApprove.enabled, true);
  assert.equal(cfg.tasks.autoApprovePayoutBatches, true);
});

test("resolveRuntimeConfig enables auto submit PayPal from env", () => {
  const prev = process.env.AUTONOMOUS_AUTO_SUBMIT_PAYPAL_PAYOUT_BATCHES;
  try {
    process.env.AUTONOMOUS_AUTO_SUBMIT_PAYPAL_PAYOUT_BATCHES = "true";
    const cfg = resolveRuntimeConfig({}, {});
    assert.equal(cfg.tasks.autoSubmitPayPalPayoutBatches, true);
  } finally {
    if (prev == null) delete process.env.AUTONOMOUS_AUTO_SUBMIT_PAYPAL_PAYOUT_BATCHES;
    else process.env.AUTONOMOUS_AUTO_SUBMIT_PAYPAL_PAYOUT_BATCHES = prev;
  }
});

test("resolveRuntimeConfig enables auto export Payoneer from env", () => {
  const prev = process.env.AUTONOMOUS_AUTO_EXPORT_PAYONEER_PAYOUT_BATCHES;
  try {
    process.env.AUTONOMOUS_AUTO_EXPORT_PAYONEER_PAYOUT_BATCHES = "true";
    const cfg = resolveRuntimeConfig({}, {});
    assert.equal(cfg.tasks.autoExportPayoneerPayoutBatches, true);
  } finally {
    if (prev == null) delete process.env.AUTONOMOUS_AUTO_EXPORT_PAYONEER_PAYOUT_BATCHES;
    else process.env.AUTONOMOUS_AUTO_EXPORT_PAYONEER_PAYOUT_BATCHES = prev;
  }
});

test("resolveRuntimeConfig accepts legacy and current PayPal submit env names", () => {
  const prevPayments = process.env.AUTONOMOUS_AUTO_SUBMIT_PAYPAL_PAYOUTS;
  const prevBatches = process.env.AUTONOMOUS_AUTO_SUBMIT_PAYPAL_PAYOUT_BATCHES;
  try {
    delete process.env.AUTONOMOUS_AUTO_SUBMIT_PAYPAL_PAYOUTS;
    process.env.AUTONOMOUS_AUTO_SUBMIT_PAYPAL_PAYOUT_BATCHES = "false";
    assert.equal(resolveRuntimeConfig({}, {}).tasks.autoSubmitPayPalPayoutBatches, false);

    process.env.AUTONOMOUS_AUTO_SUBMIT_PAYPAL_PAYOUTS = "true";
    assert.equal(resolveRuntimeConfig({}, {}).tasks.autoSubmitPayPalPayoutBatches, true);
  } finally {
    if (prevPayments == null) delete process.env.AUTONOMOUS_AUTO_SUBMIT_PAYPAL_PAYOUTS;
    else process.env.AUTONOMOUS_AUTO_SUBMIT_PAYPAL_PAYOUTS = prevPayments;
    if (prevBatches == null) delete process.env.AUTONOMOUS_AUTO_SUBMIT_PAYPAL_PAYOUT_BATCHES;
    else process.env.AUTONOMOUS_AUTO_SUBMIT_PAYPAL_PAYOUT_BATCHES = prevBatches;
  }
});

test("resolveRuntimeConfig reads Payoneer out dir from env", () => {
  const prev = process.env.AUTONOMOUS_PAYONEER_OUT_DIR;
  try {
    process.env.AUTONOMOUS_PAYONEER_OUT_DIR = "custom/payoneer";
    const cfg = resolveRuntimeConfig({}, {});
    assert.equal(cfg.payout.export.payoneerOutDir, "custom/payoneer");
  } finally {
    if (prev == null) delete process.env.AUTONOMOUS_PAYONEER_OUT_DIR;
    else process.env.AUTONOMOUS_PAYONEER_OUT_DIR = prev;
  }
});
