import test from "node:test";
import assert from "node:assert/strict";

import { createBase44RevenueEvent, createBase44RevenueEventIdempotent } from "../src/base44-revenue.mjs";

function makeCfg() {
  return {
    entityName: "RevenueEvent",
    defaultCurrency: "USD",
    allowNonPositiveAmounts: false,
    fieldMap: {
      amount: "amount",
      currency: "currency",
      occurredAt: "occurred_at",
      source: "source",
      externalId: "external_id",
      missionId: "mission_id",
      missionTitle: "mission_title",
      agentIds: "agent_ids",
      metadata: "metadata"
    }
  };
}

function makeEvent(overrides = {}) {
  return {
    amount: 10,
    currency: "USD",
    occurredAt: "2025-01-01T00:00:00.000Z",
    source: "paypal",
    externalId: "evt_1",
    // Creation requires provider evidence; idempotency is tested against a
    // genuinely provider-backed event so no step has to pretend one is real.
    metadata: { psp_transaction_id: "3C679366HH908993F" },
    ...overrides
  };
}

function cfgWithStatus() {
  const cfg = makeCfg();
  cfg.fieldMap.status = "status";
  return cfg;
}

const SELF_ISSUED = {
  type: "autonomous_execution",
  psp_id: "PROOF_1767462283250",
  amount: 100,
  currency: "USD",
  timestamp: "2026-01-03T16:01:00.000Z"
};

test("a self-issued proof is written as UNVERIFIED even when the event claims VERIFIED", async () => {
  const out = await createBase44RevenueEvent(null, cfgWithStatus(), makeEvent({
    externalId: "LIVE_1767462283000",
    amount: 100,
    status: "VERIFIED",
    metadata: { created_by: "autonomous-daemon", verification_proof: SELF_ISSUED }
  }), { dryRun: true });

  assert.equal(out.data.status, "UNVERIFIED");
  assert.equal(out.data.metadata.verification.verified, false);
  assert.equal(out.data.metadata.verification.reason, "self_issued_proof");
  assert.equal(out.data.metadata.verification.psp_id, null);
});

test("a local event id with no provider transaction is not VERIFIED", async () => {
  const out = await createBase44RevenueEvent(null, cfgWithStatus(), makeEvent({
    externalId: "LIVE_1767462283000",
    status: "VERIFIED",
    metadata: {}
  }), { dryRun: true });

  assert.equal(out.data.status, "UNVERIFIED");
  assert.equal(out.data.metadata.verification.reason, "no_provider_transaction_id");
});

test("a PayPal transaction id keeps the verified status", async () => {
  const out = await createBase44RevenueEvent(null, cfgWithStatus(), makeEvent({
    externalId: "CAP-1",
    status: "VERIFIED",
    metadata: { psp_transaction_id: "3C679366HH908993F" }
  }), { dryRun: true });

  assert.equal(out.data.status, "VERIFIED");
  assert.equal(out.data.metadata.verification.verified, true);
  assert.equal(out.data.metadata.verification.provider, "paypal");
  assert.equal(out.data.metadata.verification.psp_id, "3C679366HH908993F");
});

test("an unverified event with no status is still recorded as a hallucination", async () => {
  const out = await createBase44RevenueEvent(null, cfgWithStatus(), makeEvent({ externalId: "LIVE_x", metadata: {} }), { dryRun: true });
  assert.equal(out.data.status, "hallucination");
});

test("an unverified event is refused at creation, not demoted after the fact", async () => {
  let created = false;
  const base44 = {
    asServiceRole: {
      entities: {
        RevenueEvent: {
          filter: async () => [],
          create: async () => {
            created = true;
            return { id: "new" };
          }
        }
      }
    }
  };

  await assert.rejects(
    () => createBase44RevenueEventIdempotent(base44, makeCfg(), makeEvent({ externalId: "LIVE_1767462283000", metadata: {} }), { dryRun: false }),
    (error) => {
      assert.equal(error.code, "REVENUE_NOT_PROVIDER_VERIFIED");
      assert.equal(error.reason, "no_provider_transaction_id");
      assert.match(error.message, /Refusing to record revenue event from paypal/);
      return true;
    }
  );
  assert.equal(created, false, "no row may be written for an unverified event");
});

test("createBase44RevenueEventIdempotent returns existing id when found", async () => {
  let created = false;
  const base44 = {
    asServiceRole: {
      entities: {
        RevenueEvent: {
          filter: async () => [{ id: "existing" }],
          create: async () => {
            created = true;
            return { id: "new" };
          }
        }
      }
    }
  };

  const out = await createBase44RevenueEventIdempotent(base44, makeCfg(), makeEvent(), { dryRun: false });
  assert.deepEqual(out, { id: "existing", deduped: true });
  assert.equal(created, false);
});

test("createBase44RevenueEventIdempotent creates when no existing record", async () => {
  let filterCalls = 0;
  let createCalls = 0;
  const base44 = {
    asServiceRole: {
      entities: {
        RevenueEvent: {
          filter: async () => {
            filterCalls++;
            return [];
          },
          create: async () => {
            createCalls++;
            return { id: "created" };
          }
        }
      }
    }
  };

  const out = await createBase44RevenueEventIdempotent(base44, makeCfg(), makeEvent(), { dryRun: false });
  assert.equal(out?.id, "created");
  assert.equal(out?.deduped, undefined);
  assert.equal(filterCalls, 1);
  assert.equal(createCalls, 1);
});

test("createBase44RevenueEventIdempotent re-checks on create error and dedupes", async () => {
  let filterCalls = 0;
  const base44 = {
    asServiceRole: {
      entities: {
        RevenueEvent: {
          filter: async () => {
            filterCalls++;
            return filterCalls === 1 ? [] : [{ id: "existing_after_race" }];
          },
          create: async () => {
            throw new Error("duplicate");
          }
        }
      }
    }
  };

  const out = await createBase44RevenueEventIdempotent(base44, makeCfg(), makeEvent(), { dryRun: false });
  assert.deepEqual(out, { id: "existing_after_race", deduped: true });
  assert.equal(filterCalls, 2);
});

