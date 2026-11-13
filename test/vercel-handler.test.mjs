import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const probe = String.raw`
import handler from './api/index.mjs';

function call(url, method) {
  return new Promise(resolve => {
    const req = {
      method,
      url,
      headers: { host: 'localhost', 'user-agent': 'test', accept: '*/*' },
      socket: { remoteAddress: '127.0.0.1' }
    };
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(key, value) { this.headers[key] = value; },
      getHeader(key) { return this.headers[key]; },
      writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers || {}); return this; },
      end(body) { resolve({ status: this.statusCode, body: String(body) }); }
    };
    handler(req, res).catch(error => resolve({ status: 0, error: error.message }));
  });
}

const health = await call('/health', 'GET');
const webhook = await call('/api/webhooks/paypal', 'GET');
process.stdout.write(JSON.stringify({ health, webhook }) + '\n');
`;

test('the Vercel wrapper serves /health and the webhook alias without binding a port', () => {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 30000,
        env: { ...process.env, VERCEL: '1' }
    });
    assert.equal(run.status, 0, run.stderr);
    const lastLine = run.stdout.trim().split('\n').at(-1);
    const result = JSON.parse(lastLine);
    assert.equal(result.health.status, 200);
    assert.equal(result.webhook.status, 405);
    assert.match(run.stdout, /"embedded":true/);
    assert.doesNotMatch(run.stdout, /"listening":true/);
});
