// Runs INSIDE a dedicated Worker -- the guest-hosting counterpart to
// `kotoba-wasm-worker-element.js`. `http_post`'s SharedArrayBuffer+
// Atomics.wait bridge (`http-post-bridge.js`'s `createSabHttpPostBridge`)
// must be constructed off the main/DOM thread (browsers throw if
// `Atomics.wait` runs there), so the whole guest instantiation + call
// happens here, in the Worker, not in `KotobaWasmElement`'s main-thread
// `connectedCallback`.
//
// Message protocol with the main thread (`kotoba-wasm-worker-element.js`):
//   in:  {kind: 'run', src, exportName, grants, limits}
//   out: {ok: true, result: <string>} | {ok: false, error: <string>}
// `result` is stringified (not sent as a raw BigInt) for the widest
// structured-clone compatibility across engines -- every current export in
// this ABI returns `i64`, always representable as a decimal string.
import { actorHostImports, hostCaps } from './actor-host.js';
import { createSabHttpPostBridge } from './http-post-bridge.js';

self.onmessage = async (event) => {
  const msg = event.data;
  if (msg.kind !== 'run') return;
  const grants = msg.grants || ['http-post'];
  const limits = msg.limits || { maxHttpPosts: 8 };
  let bridge;
  try {
    bridge = createSabHttpPostBridge();
    // `createSabHttpPostBridge` spawns its own inner Worker and returns
    // before that Worker has actually started running (Worker
    // instantiation is inherently async) -- calling `postSync` before the
    // inner Worker's `onmessage`/`Atomics.wait` loop has registered is a
    // real, confirmed-live deadlock (the inner Worker's spawn+message
    // delivery never got a turn to complete because this thread blocks on
    // `Atomics.wait` first). A short yield here is a pragmatic margin,
    // empirically sufficient in this environment; the correct long-term
    // fix is an explicit ready handshake inside `createSabHttpPostBridge`
    // itself, out of scope for this change.
    await new Promise((r) => setTimeout(r, 200));
    const memoryBox = {};
    const caps = hostCaps({ grants, limits });
    const importObject = {
      kotoba: actorHostImports(grants, caps, memoryBox, { httpPostBridge: bridge }),
    };
    const response = await fetch(msg.src);
    const { instance } = await WebAssembly.instantiateStreaming(response, importObject);
    memoryBox.memory = instance.exports.memory;
    const fn = instance.exports[msg.exportName || 'main'];
    if (typeof fn !== 'function') {
      throw new Error(`module has no export "${msg.exportName || 'main'}"`);
    }
    const result = fn();
    self.postMessage({ ok: true, result: result.toString() });
  } catch (err) {
    self.postMessage({ ok: false, error: err.message });
  } finally {
    if (bridge) bridge.dispose();
  }
};
