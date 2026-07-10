// Node worker_threads bootstrap for src/http-post-worker.js: worker_threads
// gives a worker `parentPort`, not the browser Worker-global-scope's
// `self`/`onmessage` -- this shims just enough of that shape (an
// `onmessage` setter that forwards incoming `parentPort` messages) for the
// real, unmodified http-post-worker.js to run under Node purely for
// testing the SharedArrayBuffer+Atomics.wait bridge end-to-end.
import { parentPort } from 'node:worker_threads';

globalThis.self = globalThis;
Object.defineProperty(globalThis, 'onmessage', {
  set(handler) {
    parentPort.on('message', (data) => handler({ data }));
  },
});

await import('../src/http-post-worker.js');
