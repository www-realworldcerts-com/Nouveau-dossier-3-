function normalized(value) {
    return String(value || '').trim().toLowerCase();
}

function hasCredentials(env) {
    return Boolean(
        String(env.PAYPAL_CLIENT_ID || '').trim()
        && String(env.PAYPAL_CLIENT_SECRET || '').trim()
    );
}

function safeError(error) {
    return String(error?.message || error || 'unknown').slice(0, 200);
}

async function requestAccessToken({ env, fetchImpl, base, timeoutMs }) {
    const clientId = String(env.PAYPAL_CLIENT_ID || '').trim();
    const clientSecret = String(env.PAYPAL_CLIENT_SECRET || '').trim();
    const basic = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
    let response;
    try {
        response = await fetchImpl(`${base}/v1/oauth2/token`, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${basic}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'grant_type=client_credentials',
            signal: AbortSignal.timeout(timeoutMs)
        });
    } catch (error) {
        return { ok: false, error: safeError(error) };
    }
    if (!response.ok) return { ok: false, status: response.status };
    let data;
    try {
        data = await response.json();
    } catch (error) {
        return { ok: false, error: safeError(error) };
    }
    if (!data?.access_token) return { ok: false, error: 'access_token missing' };
    return { ok: true, token: data.access_token };
}

/**
 * Verify a PayPal payout destination against the account behind the API
 * credentials. The check is optional when no credentials are configured; when
 * credentials are configured, failures and mismatches fail closed.
 */
export async function verifyPayPalPayoutAccount({
    destination,
    fetchImpl = globalThis.fetch,
    env = process.env,
    accessToken = null,
    apiBaseUrl = null,
    timeoutMs = 15000
} = {}) {
    const target = normalized(destination);
    if (!target) {
        return { checked: false, skipped: true, reason: 'paypal_destination_missing' };
    }
    if (!accessToken && !hasCredentials(env)) {
        return { checked: false, skipped: true, reason: 'paypal_credentials_missing' };
    }

    const base = String(apiBaseUrl || env.PAYPAL_API_BASE_URL || 'https://api-m.paypal.com')
        .replace(/\/+$/, '');
    let token = accessToken;
    if (!token) {
        const tokenResult = await requestAccessToken({ env, fetchImpl, base, timeoutMs });
        if (!tokenResult.ok) {
            return {
                checked: true,
                ok: false,
                reason: 'paypal_account_unverified',
                ...(tokenResult.status ? { status: tokenResult.status } : {}),
                ...(tokenResult.error ? { error: tokenResult.error } : {})
            };
        }
        token = tokenResult.token;
    }
    if (!token) {
        return { checked: true, ok: false, reason: 'paypal_account_unverified' };
    }
    let response;
    try {
        response = await fetchImpl(
            `${base}/v1/identity/oauth2/userinfo?schema=paypalv1.1`,
            {
                method: 'GET',
                headers: { Authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(timeoutMs)
            }
        );
    } catch (error) {
        return {
            checked: true,
            ok: false,
            reason: 'paypal_account_unverified',
            error: safeError(error)
        };
    }

    if (!response.ok) {
        return {
            checked: true,
            ok: false,
            reason: 'paypal_account_unverified',
            status: response.status
        };
    }

    let account;
    try {
        account = await response.json();
    } catch (error) {
        return {
            checked: true,
            ok: false,
            reason: 'paypal_account_unverified',
            error: safeError(error)
        };
    }

    const emails = Array.isArray(account?.emails)
        ? account.emails.map(row => row?.value)
        : [];
    const candidates = [
        account?.email,
        account?.payer_id,
        account?.user_id,
        ...emails
    ].map(normalized).filter(Boolean);
    if (!candidates.length) {
        return { checked: true, ok: false, reason: 'paypal_account_unverified' };
    }

    const verified = candidates.includes(target);
    return {
        checked: true,
        ok: verified,
        reason: verified ? null : 'paypal_account_mismatch'
    };
}
