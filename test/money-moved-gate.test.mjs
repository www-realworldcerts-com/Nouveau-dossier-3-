import assert from 'node:assert/strict';
import test from 'node:test';

import { EvidenceIntegrityChain } from '../src/real/evidence-integrity.mjs';
import { MoneyMovedGate } from '../src/real/money-moved-gate.mjs';
import { ProofValidator } from '../src/real/proof-validator.mjs';
import { RedressEngine } from '../src/resilience/redress.mjs';

// A capture id in the shape PayPal actually issues.
const PAYPAL_CAPTURE = '5O190127TN364715T';

function revenueEvent(overrides = {}) {
    return {
        id: 'rev-1',
        amount: 19,
        currency: 'USD',
        status: 'VERIFIED',
        settled: false,
        verification_proof: {
            type: 'paypal_capture',
            psp_id: PAYPAL_CAPTURE,
            amount: 19,
            currency: 'USD',
            timestamp: new Date().toISOString()
        },
        ...overrides
    };
}

/**
 * These tests exercise the gate's own guards, so the proof validator and the
 * evidence chain are stubbed: each is tested where it lives. `failProof` proves
 * the gate refuses before it ever asks a downstream check.
 */
function stubDownstream(t, { failProof = null } = {}) {
    const saved = {
        proof: ProofValidator.assertValid,
        chain: EvidenceIntegrityChain.assertEventBound,
        allowed: RedressEngine.prototype.isSettlementAllowed
    };
    ProofValidator.assertValid = async () => {
        if (failProof) throw new Error(failProof);
    };
    EvidenceIntegrityChain.assertEventBound = async () => true;
    RedressEngine.prototype.isSettlementAllowed = () => true;
    t.after(() => {
        ProofValidator.assertValid = saved.proof;
        EvidenceIntegrityChain.assertEventBound = saved.chain;
        RedressEngine.prototype.isSettlementAllowed = saved.allowed;
    });
}

test('a self-generated proof object is refused by the gate itself', async t => {
    stubDownstream(t, { failProof: 'the proof validator must not be reached' });
    await assert.rejects(
        MoneyMovedGate.assertMoneyMoved(revenueEvent({
            amount: 100,
            verification_proof: {
                type: 'autonomous_execution',
                psp_id: 'PROOF_1767462283250',
                amount: 100,
                currency: 'USD'
            }
        })),
        /MONEY_GATE_FAIL: proof_not_provider_backed \(self_issued_proof: PROOF_1767462283250\)/
    );
});

test('a system id cannot pass as a provider transaction id', async t => {
    stubDownstream(t, { failProof: 'the proof validator must not be reached' });
    await assert.rejects(
        MoneyMovedGate.assertMoneyMoved(revenueEvent({
            verification_proof: {
                type: 'psp_transaction_id',
                psp_id: 'PROOF_1767462283250',
                amount: 19,
                currency: 'USD'
            }
        })),
        /proof_not_provider_backed \(self_issued_proof/
    );
});

test('an id that is not a provider receipt shape is refused', async t => {
    stubDownstream(t, { failProof: 'the proof validator must not be reached' });
    await assert.rejects(
        MoneyMovedGate.assertMoneyMoved(revenueEvent({
            verification_proof: {
                type: 'psp_transaction_id',
                psp_id: 'LOCAL-0001',
                amount: 19,
                currency: 'USD'
            }
        })),
        /proof_not_provider_backed \(psp_id_not_provider_transaction: LOCAL-0001\)/
    );
});

test('a self-generated proof carried in metadata is refused too', async t => {
    stubDownstream(t, { failProof: 'the proof validator must not be reached' });
    await assert.rejects(
        MoneyMovedGate.assertMoneyMoved(revenueEvent({
            verification_proof: undefined,
            metadata: {
                verification_proof: {
                    type: 'autonomous_execution',
                    psp_id: 'PROOF_1767462283250',
                    amount: 19,
                    currency: 'USD'
                }
            }
        })),
        /proof_not_provider_backed \(self_issued_proof/
    );
});

test('an already-settled event cannot be settled again', async t => {
    stubDownstream(t);
    await assert.rejects(
        MoneyMovedGate.assertMoneyMoved(revenueEvent({ settled: true })),
        /MONEY_GATE_FAIL: already_settled/
    );
});

test('a status that does not claim money moved is refused', async t => {
    stubDownstream(t);
    await assert.rejects(
        MoneyMovedGate.assertMoneyMoved(revenueEvent({ status: 'pending_verification' })),
        /MONEY_GATE_FAIL: invalid_status \(pending_verification\)/
    );
});

test('a provider-backed event with a moved status passes', async t => {
    stubDownstream(t);
    assert.equal(await MoneyMovedGate.assertMoneyMoved(revenueEvent()), true);
    assert.equal(await MoneyMovedGate.assertMoneyMoved(revenueEvent({ status: 'settled' })), true);
    assert.equal(await MoneyMovedGate.assertMoneyMoved(revenueEvent({ status: 'paid_out' })), true);
});
