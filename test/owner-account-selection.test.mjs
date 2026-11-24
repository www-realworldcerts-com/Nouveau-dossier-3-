import assert from 'node:assert/strict';
import test from 'node:test';

import {
    OWNER_ACCOUNTS,
    generateOwnerPayoutConfig,
    ownerAccountDestination,
    selectOptimalOwnerAccount
} from '../src/owner-directive.mjs';
import { ALLOWED_BENEFICIARIES } from '../src/policy/RecipientRegistry.mjs';

/**
 * Selection and the CSV payee used to be decided in different places, so the
 * rail could be chosen from one account while the instruction paid another.
 * These tests pin the rule that what is selected is what is paid.
 */
function withAccounts(changes, fn) {
    const saved = {};
    for (const [key, fields] of Object.entries(changes)) {
        saved[key] = { ...OWNER_ACCOUNTS[key] };
        Object.assign(OWNER_ACCOUNTS[key], fields);
    }
    try {
        return fn();
    } finally {
        for (const [key, snapshot] of Object.entries(saved)) {
            for (const field of Object.keys(OWNER_ACCOUNTS[key])) {
                if (!(field in snapshot)) delete OWNER_ACCOUNTS[key][field];
            }
            Object.assign(OWNER_ACCOUNTS[key], snapshot);
        }
    }
}

test('the payout config pays the account the selection returned', () => {
    const small = generateOwnerPayoutConfig(19, 'USD');
    assert.equal(selectOptimalOwnerAccount(19, 'USD').type, 'PAYONEER');
    assert.equal(small.recipient, OWNER_ACCOUNTS.payoneer.accountId);
    assert.equal(small.recipient_type, 'ACCOUNT_ID');

    const large = generateOwnerPayoutConfig(5000, 'USD');
    assert.equal(selectOptimalOwnerAccount(5000, 'USD').type, 'BANK_WIRE');
    assert.equal(large.recipient, OWNER_ACCOUNTS.bank.rib);
    assert.equal(large.recipient_type, 'BANK_ACCOUNT');
});

test('every destination a selection can produce is one the directive allows', () => {
    for (const account of [OWNER_ACCOUNTS.bank, OWNER_ACCOUNTS.payoneer]) {
        const payee = ownerAccountDestination(account);
        assert.ok(payee, `${account.label} must be payable`);
        assert.ok(
            ALLOWED_BENEFICIARIES.some(allowed => String(allowed).toLowerCase() === payee.destination.toLowerCase()),
            `${account.label} pays ${payee.destination}, which ALLOWED_BENEFICIARIES does not carry`
        );
    }
    // The payee the PAYONEER rail actually writes is the one the directive needs.
    assert.ok(ALLOWED_BENEFICIARIES.includes(OWNER_ACCOUNTS.payoneer.accountId));
});

test('an account its rail cannot pay is never selected', () => {
    withAccounts({ payoneer: { accountId: '' } }, () => {
        const account = selectOptimalOwnerAccount(19, 'USD');
        assert.equal(account, OWNER_ACCOUNTS.bank, 'the small band falls back to the payable account');
        assert.equal(generateOwnerPayoutConfig(19, 'USD').recipient, OWNER_ACCOUNTS.bank.rib);
    });
});

test('a disabled account is not selected', () => {
    withAccounts({ bank: { enabled: false } }, () => {
        assert.equal(selectOptimalOwnerAccount(5000, 'USD'), OWNER_ACCOUNTS.payoneer);
        assert.equal(generateOwnerPayoutConfig(5000, 'USD').recipient, OWNER_ACCOUNTS.payoneer.accountId);
    });
});

test('nothing is selected when no owner account can be paid', () => {
    withAccounts({ bank: { enabled: false }, payoneer: { accountId: '' } }, () => {
        assert.equal(selectOptimalOwnerAccount(19, 'USD'), null);
        assert.throws(() => generateOwnerPayoutConfig(19, 'USD'), /NO_PAYABLE_OWNER_ACCOUNT/);
    });
});

test('an account type with no rail is not a destination', () => {
    assert.equal(ownerAccountDestination(OWNER_ACCOUNTS.crypto), null);
    assert.equal(ownerAccountDestination({ type: 'BANK_WIRE', rib: '', identifier: '' }), null);
    assert.equal(ownerAccountDestination(null), null);
});
