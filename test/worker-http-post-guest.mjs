// The "guest worker" side of test/verify-http-post-bridge.mjs: runs inside
// its own Worker thread (mirroring where a real WASM guest needing
// http-post must live -- see actor-host.js's scope note on why
// Atomics.wait can't run on a browser main thread), constructs a real
// createHttpPostBridge (spawning ITS OWN nested worker, via
// worker-self-shim.mjs, to run the real http-post-worker.js), and drives
// one `.post()` call per `{kind: 'run'}` message from the test file.
import { parentPort, Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHttpPostBridge } from '../src/actor-host.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const shimPath = path.join(here, 'worker-self-shim.mjs');

parentPort.on('message', (msg) => {
  if (msg.kind !== 'run') return;
  const bridge = createHttpPostBridge({ makeWorker: () => new Worker(shimPath) });
  const body = new TextEncoder().encode(msg.body);
  const result = bridge.post(msg.url, body);
  bridge.terminate();
  parentPort.postMessage({
    status: result.status,
    bodyText: new TextDecoder().decode(result.body),
  });
});
