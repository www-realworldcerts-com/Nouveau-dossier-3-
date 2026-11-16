import { shopifySettingsFromEnv } from './shopify.mjs';

export function parseArgs(argv) {
    const flags = {};
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token.startsWith('--')) continue;
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) flags[key] = true;
        else {
            flags[key] = next;
            i += 1;
        }
    }
    return flags;
}

export function launchSettingsFromArgs(flags = {}, env = process.env) {
    return {
        ...shopifySettingsFromEnv(env),
        domain: flags['shop-domain'] || env.SHOPIFY_STORE_DOMAIN || '',
        expectedDomain: flags['expected-domain'] || env.SHOPIFY_PRIMARY_DOMAIN || '',
        canaryCourse: flags['canary-course'] || env.SHOPIFY_CANARY_COURSE || '',
        canaryCountryCode: flags['canary-country'] || env.SHOPIFY_CANARY_COUNTRY_CODE || 'US',
        payoutAttestationFile: flags['payout-attestation'] || env.SHOPIFY_PAYOUT_ATTESTATION_FILE || ''
    };
}
