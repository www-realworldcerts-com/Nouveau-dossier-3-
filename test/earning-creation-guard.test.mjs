import assert from 'node:assert/strict';
import test from 'node:test';

import { createBase44EarningIdempotent, getEarningConfigFromEnv } from '../src/base44-earning.mjs';
import { RevenueManager } from '../src/finance/AdvancedFinancialManager.mjs';
import { RevenueNotProviderVerifiedError } from '../src/real/revenue-verification.mjs';

function fakeBase44() {
    const calls = { filter: 0, create: 0 };
    const base44 = {
        asServiceRole: {
            entities: {
                Earning: {
                    filter: async () => {
                        calls.filter += 1;
                        return [];
                    },
                    create: async data => {
                        calls.create += 1;
                        return { id: 'earning_1', ...data };
                    }
                }
            }
        }
    };
    return { base44, calls };
}

function earning(overrides = {}) {
    return {
        earningId: 'EARN_1768000000000',
        amount: 850,
        currency: 'USD',
        source: 'autonomous_ingestion',
        beneficiary: 'owner@example.com',
        status: 'verified',
        ...overrides
    };
}

test('an earning with no provider transaction id is never written', async () => {
    process.env.BASE44_ENABLE_EARNING_WRITES = 'true';
    const { base44, calls } = fakeBase44();

    await assert.rejects(
        () => createBase44EarningIdempotent(base44, getEarningConfigFromEnv(), earning()),
        error => {
            assert.ok(error instanceof RevenueNotProviderVerifiedError);
            assert.equal(error.code, 'REVENUE_NOT_PROVIDER_VERIFIED');
            assert.match(error.message, /Refusing to record earning EARN_1768000000000/);
            return true;
        }
    );
    assert.equal(calls.create, 0, 'no row may be written without provider evidence');
    assert.equal(calls.filter, 0, 'the refusal happens before any lookup');
});

test('a self-issued proof does not become an earning', async () => {
    process.env.BASE44_ENABLE_EARNING_WRITES = 'true';
    const { base44, calls } = fakeBase44();

    await assert.rejects(
        () => createBase44EarningIdempotent(base44, getEarningConfigFromEnv(), earning({
            psp_proof: { type: 'autonomous_execution', psp_id: 'PROOF_1767462283250' }
        })),
        error => {
            assert.equal(error.code, 'REVENUE_NOT_PROVIDER_VERIFIED');
            assert.match(error.message, /PSP_|psp_id_not_provider_transaction|no payment-provider/);
            return true;
        }
    );
    assert.equal(calls.create, 0);
});

test('an earning backed by a provider transaction id is written', async () => {
    process.env.BASE44_ENABLE_EARNING_WRITES = 'true';
    const { base44, calls } = fakeBase44();

    const out = await createBase44EarningIdempotent(base44, getEarningConfigFromEnv(), earning({
        metadata: { psp_transaction_id: '3C679366HH908993F' }
    }));

    assert.equal(out.id, 'earning_1');
    assert.equal(out.metadata.psp_transaction_id, '3C679366HH908993F');
    assert.equal(calls.create, 1);
});

test('a provider proof object is enough evidence for an earning', async () => {
    process.env.BASE44_ENABLE_EARNING_WRITES = 'true';
    const { base44 } = fakeBase44();

    const out = await createBase44EarningIdempotent(base44, getEarningConfigFromEnv(), earning({
        psp_proof: { provider: 'paypal', transaction_id: '3C679366HH908993F', amount: 850, currency: 'USD' }
    }));
    assert.equal(out.metadata.psp_transaction_id, '3C679366HH908993F');
});

test('a dry run previews an unverified earning without writing it', async () => {
    const { base44, calls } = fakeBase44();
    const out = await createBase44EarningIdempotent(base44, getEarningConfigFromEnv(), earning(), { dryRun: true });

    assert.equal(out.dryRun, true);
    assert.equal(calls.create, 0);
});

test('revenue ingest refuses a scheduled amount with no provider evidence', () => {
    const manager = new RevenueManager(null, null);
    assert.throws(
        () => manager.ingestRawRevenue({
            amount: 500,
            currency: 'USD',
            source: 'RecurringSchedule',
            metadata: { schedule_id: 'SCHED_1' }
        }, 'RecurringPayoutSystem'),
        error => {
            assert.equal(error.code, 'REVENUE_NOT_PROVIDER_VERIFIED');
            assert.match(error.message, /Refusing to record revenue ingest from RecurringPayoutSystem/);
            return true;
        }
    );
});
