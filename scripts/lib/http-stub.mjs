/** Minimal local HTTP stub for provider tests; never talks to the internet. */
import http from "node:http";

export async function startStub(handler) {
  const hits = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const hit = { method: req.method, url: req.url, headers: req.headers, body };
    hits.push(hit);
    const reply = await handler(hit);
    if (!reply) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: "STUB_NO_ROUTE" }));
      return;
    }
    res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.body ?? {}));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
