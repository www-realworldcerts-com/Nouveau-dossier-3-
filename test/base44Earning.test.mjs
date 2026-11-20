import test from "node:test";
import assert from "node:assert/strict";

import { createBase44EarningIdempotent, getEarningConfigFromEnv } from "../src/base44-earning.mjs";

test("createBase44EarningIdempotent dedupes by earning_id", async () => {
  const cfg = getEarningConfigFromEnv();
  const base44 = {
    asServiceRole: {
      entities: {
        [cfg.entityName]: {
          filter: async () => [{ id: "existing" }],
          create: async () => ({ id: "new" })
        }
      }
    }
  };

  const prev = process.env.BASE44_ENABLE_EARNING_WRITES;
  process.env.BASE44_ENABLE_EARNING_WRITES = "true";
  try {
    const out = await createBase44EarningIdempotent(
      base44,
      cfg,
      {
        earningId: "EARN_1",
        amount: 10,
        currency: "USD",
        source: "agent_commission",
        beneficiary: "YOUNES",
        status: "settled_externally_pending",
        // Dedupe is tested against a provider-backed earning, because an
        // earning without provider evidence is now refused before lookup.
        metadata: { psp_transaction_id: "3C679366HH908993F" }
      },
      { dryRun: false }
    );
    assert.deepEqual(out, { id: "existing", deduped: true });
  } finally {
    process.env.BASE44_ENABLE_EARNING_WRITES = prev;
  }
});

