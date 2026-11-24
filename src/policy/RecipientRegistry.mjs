/**
 * RECIPIENT REGISTRY - SINGLE SOURCE OF TRUTH
 * 
 * This module defines the canonical list of authorized recipients,
 * owner accounts, and legacy redirection maps.
 * 
 * IT MUST BE USED BY ALL SYSTEMS:
 * - Policy Enforcers
 * - Financial Managers
 * - Deployment Scripts
 * - Directives
 */

export const OWNER_IDENTITY = {
    name: 'Younes Tsouli',
    legal_entity: 'RealWorldCerts (Auto-Entrepreneur)',
    domain: 'realworldcerts.com',
    cin: 'A337773',
    verification_sources: ['biometrics', 'gov_id', 'law_enforcement_db', 'commercial_register'],
    status: 'VERIFIED_OWNER'
};

export const OWNER_ACCOUNTS = {
    bank: {
        type: 'BANK_WIRE',
        rib: '007810000448500030594182',
        label: 'Attijari',
        enabled: true,
        priority: 1
    },
    payoneer: {
        type: 'PAYONEER',
        email: 'younestsouli2019@gmail.com',
        accountId: '85538995', // Default ID
        label: 'Primary',
        enabled: true,
        priority: 2
    },
    payoneer_secondary: {
        type: 'PAYONEER',
        email: 'younesdgc@gmail.com',
        accountId: '101137054',
        label: 'Secondary',
        enabled: true,
        priority: 4
    },
    payoneer_uk_bank: {
        type: 'BANK_WIRE',
        identifier: 'Barclays:231486:15924956',
        label: 'Payoneer UK (Barclays)',
        enabled: true,
        priority: 2
    },
    payoneer_jp_bank: {
        type: 'BANK_WIRE',
        identifier: 'MUFG:0005:869:4671926',
        label: 'Payoneer JP (MUFG)',
        enabled: true,
        priority: 2
    },
    payoneer_eu_iban: {
        type: 'BANK_WIRE',
        identifier: 'LU774080000041265646',
        label: 'Payoneer EU (Banking Circle)',
        enabled: true,
        priority: 2
    },
    crypto: {
        type: 'CRYPTO',
        address: '0xA46225a984E2B2B5E5082E52AE8d8915A09fEfe7',
        label: 'Trust Wallet (ERC20/BEP20)',
        enabled: true,
        priority: 3
    },
    crypto_erc20: {
        type: 'CRYPTO',
        address: '0xA46225a984E2B2B5E5082E52AE8d8915A09fEfe7',
        label: 'Trust Wallet (ERC20)',
        enabled: true,
        priority: 3
    },
    crypto_bybit_erc20: {
        type: 'CRYPTO',
        address: '0xf6b9e2fcf43d41c778cba2bf46325cd201cc1a10',
        label: 'Bybit (ERC20)',
        enabled: true,
        priority: 3
    },
    crypto_bybit_ton: {
        type: 'CRYPTO',
        address: 'UQDIrlJp7NmV-5mief8eNB0b0sYGO0L62Vu7oGX49UXtqlDQ',
        label: 'Bybit (TON)',
        enabled: true,
        priority: 3
    },
    paypal: {
        type: 'BANK_WIRE', // Redirected to Bank
        rib: '007810000448500030594182',
        email: 'younestsouli2019@gmail.com', // Kept for reference
        label: 'PayPal (Redirected to Bank)',
        enabled: true,
        priority: 5,
        note: 'Mapped to Bank (Attijari) due to country restrictions'
    },
    stripe: {
        type: 'BANK_WIRE', // Redirected to Bank
        rib: '007810000448500030594182',
        label: 'Stripe (Redirected to Bank)',
        enabled: true,
        priority: 4
    }
};

export const ALLOWED_BENEFICIARIES = [
    "younestsouli2019@gmail.com",
    "younesdgc@gmail.com",
    "007810000448500030594182",
    "Barclays:231486:15924956",
    "MUFG:0005:869:4671926",
    "LU774080000041265646",
    "0xA46225a984E2B2B5E5082E52AE8d8915A09fEfe7",
    "0xf6b9e2fcf43d41c778cba2bf46325cd201cc1a10",
    "UQDIrlJp7NmV-5mief8eNB0b0sYGO0L62Vu7oGX49UXtqlDQ",
    "15924956", // Short ID
    "4671926",  // Short ID
    "231486",    // Short ID
    "101137054",
    "85538995" // Primary Payoneer account id: the payee the PAYONEER rail pays
];

export const LEGACY_REDIRECT_MAP = {
    // Example: 'legacy_agent_001': 'fused_finance_unit_alpha'
};
