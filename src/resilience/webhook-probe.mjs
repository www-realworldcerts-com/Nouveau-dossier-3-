/**
 * Payment-webhook reachability probe (P8).
 *
 * A webhook that cannot be reached is a silent revenue failure: the buyer pays,
 * fulfilment never happens, and PayPal eventually stops retrying. The only
 * reliable signal is an end-to-end request from the public internet, so the
 * probe sends a deliberately invalid body and classifies the status:
 *
 *   400 -> reachable and configured (invalid_json is the expected answer)
 *   404 -> the route is not deployed on that host (static-only deployment)
 *   401/403/302/307 -> a protection layer (SSO/deployment protection) blocks it
 *   503 -> route exists but webhook id/client credentials are missing
 *   5xx -> server failure; PayPal retries but nothing proves fulfilment
 *
 * It is read-only: one POST of `not-json`, no order data, no money movement.
 */

const PROTECTION_STATUSES = new Set([401, 403, 302, 307]);

export function classifyWebhookStatus(status, error = null) {
    if (error) return 'unreachable';
    if (status === 400) return 'reachable';
    if (status === 404) return 'route_not_deployed';
    if (PROTECTION_STATUSES.has(status)) return 'protection_blocking';
    if (status === 503) return 'webhook_not_configured';
    if (status >= 500) return 'server_error';
    return 'unexpected';
}

export async function probePaymentWebhook(url, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
    if (!url) throw new Error('a webhook URL is required');
    const startedAt = Date.now();
    let status = null;
    let error = null;
    try {
        const response = await fetchImpl(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'user-agent': 'swarm-silent-failure/1'
            },
            body: 'not-json',
            redirect: 'manual',
            signal: AbortSignal.timeout(timeoutMs)
        });
        status = response.status;
    } catch (cause) {
        error = cause.message;
    }
    const verdict = classifyWebhookStatus(status, error);
    return {
        url,
        status,
        verdict,
        ok: verdict === 'reachable',
        error,
        duration_ms: Date.now() - startedAt
    };
}

export function probeVerdictHint(verdict) {
    return {
        reachable: 'Webhook is reachable and configured (400 invalid_json).',
        route_not_deployed: 'Host serves no API route: the deployed build does not include the webhook.',
        protection_blocking: 'A deployment-protection layer answers before the app; PayPal cannot authenticate.',
        webhook_not_configured: 'Route exists but PAYPAL_WEBHOOK_ID or client credentials are missing.',
        server_error: 'The webhook route failed; PayPal retries but fulfilment is not proven.',
        unreachable: 'No HTTP response from the host.',
        unexpected: 'Unexpected status; inspect the deployment.'
    }[verdict] || 'Unknown verdict.';
}

export default probePaymentWebhook;
