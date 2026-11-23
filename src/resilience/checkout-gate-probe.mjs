/**
 * Deployed checkout-gate probe.
 *
 * A deployment whose replay protection is not durable answers 503 on every
 * checkout order creation before PayPal is called, so the store takes no money
 * while the loop, the heartbeat and the deployment all look alive. Only the
 * deployment knows its own gate, so `/health`'s `config.checkout_attempts` is
 * read directly instead of inferring the verdict from the runner's
 * environment.
 *
 * The same response carries `money_readiness`, the deployment's own verdict on
 * whether it can complete a paid order (quote key, PayPal order-create and
 * capture credentials, fulfillment and Resend). It is reported separately from
 * the gate so a deployment that answers checkouts but cannot finish them is not
 * mistaken for a sellable one.
 *
 * It is read-only: one GET, no credentials, no money movement.
 */

export function resolveCheckoutGateUrl({ flag = null, env = process.env } = {}) {
    const explicit = String(flag ?? '').trim();
    if (explicit) return explicit;
    const configured = String(env.CHECKOUT_HEALTH_URL ?? '').trim();
    if (configured) return configured;
    const origin = String(env.APP_ORIGIN ?? '').trim();
    if (origin) return `${origin.replace(/\/+$/, '')}/health`;
    return null;
}

/**
 * Read the deployed gate. `reported` is false when the response carries no
 * gate verdict, so a 404, an HTML page or a partial body can never be read as
 * an open gate.
 */
export async function probeCheckoutGate(url, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
    const unreadMoney = { reported: false, can_take_paid_order: false, missing: [] };
    const unread = (target, error) => ({
        url: target,
        status: null,
        reported: false,
        blocks: false,
        block_reason: null,
        replay_protection: null,
        money: unreadMoney,
        error
    });

    let target;
    try {
        target = new URL(url).toString();
    } catch {
        return unread(String(url), `invalid URL: ${url}`);
    }

    try {
        const response = await fetchImpl(target, { signal: AbortSignal.timeout(timeoutMs) });
        const body = await response.json().catch(() => null);
        const attempts = body?.config?.checkout_attempts ?? null;
        const money = body?.money_readiness ?? null;
        return {
            url: target,
            status: response.status,
            reported: typeof attempts?.blocks_checkout === 'boolean',
            blocks: attempts?.blocks_checkout === true,
            block_reason: attempts?.block_reason ?? null,
            replay_protection: attempts?.replay_protection ?? null,
            money: {
                reported: typeof money?.can_take_paid_order === 'boolean',
                can_take_paid_order: money?.can_take_paid_order === true,
                missing: Array.isArray(money?.missing) ? money.missing : []
            },
            error: null
        };
    } catch (error) {
        return unread(target, error?.message ?? String(error));
    }
}

export default probeCheckoutGate;
