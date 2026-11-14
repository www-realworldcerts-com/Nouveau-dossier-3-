/**
 * Vercel Node.js entry point.
 *
 * The application server registers its request handler on import and does not
 * bind a port when VERCEL is set. This wrapper exposes that handler to Vercel's
 * Node runtime.
 */
let serverModule;

export default async function handler(req, res) {
  try {
    serverModule ??= import("../src/paypal-webhook-server.mjs");
    const { getRequestHandler } = await serverModule;
    return await getRequestHandler()(req, res);
  } catch (error) {
    console.error("api index failed", error);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "server_initialization_failed" }));
  }
}
