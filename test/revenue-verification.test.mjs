import assert from 'node:assert/strict';
import test from 'node:test';

import {
    classifyRevenueEvent,
    classifyRevenueProof,
    demoteUnverifiedStatus,
    isProviderTransactionId,
    summarizeRevenueEvents,
    verifyRevenueEvent
} from '../src/real/revenue-verification.mjs';

const PAYPAL_ID = '3C679366HH908993F';

test('a self-issued autonomous_execution proof is unverified', () => {
    const verdict = classifyRevenueProof({
        type: 'autonomous_execution',
        psp_id: 'PROOF_1767462283250',
        amount: 100,
        currency: 'USD'
    });
    assert.equal(verdict.verified, false);
    assert.equal(verdict.reason, 'self_issued_proof');
});

test('an id the system generated is not a provider transaction', () => {
    assert.equal(isProviderTransactionId('PROOF_1767462283250'), false);
    assert.equal(isProviderTransactionId('LIVE_1767462283000'), false);
    assert.equal(isProviderTransactionId('BATCH_1767521116713'), false);
    assert.equal(isProviderTransactionId(''), false);

    const verdict = classifyRevenueProof({ type: 'psp_transaction_id', psp_id: 'PROOF_1767462283250', amount: 1, currency: 'USD' });
    assert.equal(verdict.verified, false);
    assert.equal(verdict.reason, 'self_issued_proof');
});

test('a provider transaction id is verified with its provider', () => {
    assert.deepEqual(
        classifyRevenueProof({ type: 'psp_transaction_id', psp_id: PAYPAL_ID, amount: 19, currency: 'USD' }),
        { verified: true, reason: null, provider: 'paypal', psp_id: PAYPAL_ID }
    );
    assert.equal(classifyRevenueProof({ type: 'stripe', psp_id: 'pi_3MtwBwLkdIwHu7ix28a3tqPa', amount: 19, currency: 'USD' }).provider, 'stripe');
    assert.equal(classifyRevenueProof({ type: 'onchain_tx', tx_hash: `0x${'ab'.repeat(32)}`, amount: 19, currency: 'USDT' }).provider, 'crypto');
});

test('a local external id alone does not verify an event', () => {
    const verdict = verifyRevenueEvent({ metadata: { psp_transaction_id: 'LIVE_1767462283000' } });
    assert.equal(verdict.verified, false);
    assert.equal(verdict.reason, 'psp_id_not_provider_transaction');

    assert.equal(verifyRevenueEvent({ metadata: {} }).reason, 'no_provider_transaction_id');
    assert.equal(verifyRevenueEvent({}).reason, 'no_provider_transaction_id');
});

test('a provider id in metadata wins over a self-issued proof attached beside it', () => {
    const verdict = verifyRevenueEvent({
        metadata: { paypal_transaction_id: PAYPAL_ID, verification_proof: { type: 'autonomous_execution', psp_id: 'PROOF_1' } }
    });
    assert.equal(verdict.verified, true);
    assert.equal(verdict.provider, 'paypal');
    assert.equal(verdict.source, 'paypal_transaction_id');
});

test('an unverified event cannot keep a VERIFIED or settled status', () => {
    assert.deepEqual(demoteUnverifiedStatus('VERIFIED'), { status: 'UNVERIFIED', changed: true });
    assert.deepEqual(demoteUnverifiedStatus('settled'), { status: 'UNVERIFIED', changed: true });
    assert.deepEqual(demoteUnverifiedStatus('paid_out'), { status: 'UNVERIFIED', changed: true });
    assert.deepEqual(demoteUnverifiedStatus(null), { status: 'hallucination', changed: true });
    assert.deepEqual(demoteUnverifiedStatus('pending'), { status: 'pending', changed: false });
});

test('the audit summary separates provider-backed money from self-issued output', () => {
    const events = [
        { event_id: 'CAP-1', amount: 19, currency: 'USD', metadata: { psp_transaction_id: PAYPAL_ID } },
        {
            event_id: 'LIVE_1',
            amount: 100,
            currency: 'USD',
            status: 'VERIFIED',
            metadata: { verification_proof: { type: 'autonomous_execution', psp_id: 'PROOF_1', amount: 100, currency: 'USD' } }
        }
    ];
    const summary = summarizeRevenueEvents(events);

    assert.equal(summary.events, 2);
    assert.equal(summary.verified, 1);
    assert.equal(summary.unverified, 1);
    assert.deepEqual(summary.by_currency, [{ currency: 'USD', verified: 19, unverified: 100 }]);
    assert.deepEqual(summary.reasons, { self_issued_proof: 1 });
    assert.equal(classifyRevenueEvent(events[1]).verified, false);
});
