/**
 * Vercel Node.js entry point.
 *
 * The application server (src/paypal-webhook-server.mjs) registers its request
 * handler on import and does not bind a port when VERCEL is set. This wrapper
 * exposes that handler to Vercel's Node runtime.
 *
 * Routing lives in vercel.json: only the server-owned paths are rewritten here.
 * The marketing site is still static, because the server has no static file
 * serving and a catch-all rewrite would make `/` a 404.
 */
import { getRequestHandler } from "../src/paypal-webhook-server.mjs";

export default async function handler(req, res) {
    return getRequestHandler()(req, res);
}
