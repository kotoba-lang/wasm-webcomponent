// Verifies createHttpPostBridge (src/actor-host.js) + its companion
// src/http-post-worker.js end-to-end: a real local HTTP server, and a real
// SharedArrayBuffer+Atomics.wait blocking round trip through TWO nested
// Node worker_threads workers (mirroring the browser topology this bridge
// targets -- a "guest worker" hosting the WASM instance calls
// createHttpPostBridge, which spawns a second worker to do the real async
// fetch; Node's worker_threads has no main-thread Atomics.wait restriction,
// but the topology under test, and http-post-worker.js itself, are
// otherwise unmodified -- see test/worker-self-shim.mjs). This does NOT
// exercise a real WASM guest calling http_post through actorHostImports
// (that needs a .kotoba fixture compiled with a guest hosted inside a
// Worker, a larger follow-up); it verifies the bridge primitive itself is
// correct. Run: `node test/verify-http-post-bridge.mjs`
import http from 'node:http';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

let failed = false;
function check(cond, message) {
  if (!cond) {
    failed = true;
    console.error(`FAIL: ${message}`);
  } else {
    console.log(`OK: ${message}`);
  }
}

function runInGuestWorker(url, body) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(here, 'worker-http-post-guest.mjs'));
    worker.once('message', (msg) => {
      worker.terminate();
      resolve(msg);
    });
    worker.once('error', reject);
    worker.postMessage({ kind: 'run', url, body });
  });
}

// ── real local echo server ──────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/fail') {
    req.destroy();
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const bodyText = Buffer.concat(chunks).toString('utf-8');
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`echo:${bodyText}`);
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

// ── success: real fetch, real Atomics.wait block/wake, real byte round trip
const ok = await runInGuestWorker(`${baseUrl}/`, 'hello-bridge');
check(ok.status === 200, `successful POST returns the real HTTP status (got ${ok.status})`);
check(
  ok.bodyText === 'echo:hello-bridge',
  `response body round-trips through the SharedArrayBuffer bridge unchanged (got ${JSON.stringify(ok.bodyText)})`
);

// ── network failure -> fail-closed -1, not a hang ───────────────────────
const failedReq = await runInGuestWorker(`${baseUrl}/fail`, 'x');
check(failedReq.status === -1, `a destroyed connection is fail-closed -1, not a hang or a throw (got ${failedReq.status})`);

server.close();

if (failed) {
  console.error('FAILED');
  process.exit(1);
} else {
  console.log('All checks passed.');
}
