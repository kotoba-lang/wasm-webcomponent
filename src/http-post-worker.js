// Companion Worker for `createHttpPostBridge` in actor-host.js.
//
// A Wasm host-import call (running on whatever thread instantiated the
// guest) must return synchronously; `fetch` is unavoidably async. This
// script runs on a SEPARATE thread (a dedicated Worker) and does the real,
// async `fetch`, then hands the result back to the blocked caller through a
// SharedArrayBuffer: writes the response bytes + status into the shared
// buffers, then `Atomics.notify`s the control cell the caller is blocked on
// via `Atomics.wait`. Never throws out of `onmessage` uncaught -- every path
// (success, non-2xx, network failure, oversized response) ends by writing
// `control[0] = 1` and calling `Atomics.notify`, because a caller blocked in
// `Atomics.wait` with nothing to wake it is a permanent hang, strictly worse
// than any in-band error code.
//
// control (Int32Array, 3 cells over a 12-byte SharedArrayBuffer):
//   [0] done flag   -- 0 = pending, 1 = done (this is the Atomics.wait index)
//   [1] http status -- the real HTTP status on success, -1 on any failure
//       (network error, non-OK fetch rejection) -- same fail-closed "-1"
//       convention kototama.tender's http-post-host-fn and llm-infer-host-fn
//       both use.
//   [2] response length -- bytes actually written into `response` (may be
//       less than the real response body length if it exceeds the shared
//       buffer's fixed capacity; truncated, not an error, same convention
//       `writeBytes`'s out-cap truncation uses elsewhere in actor-host.js).

self.onmessage = async (event) => {
  const msg = event.data;
  if (msg.kind === 'init') {
    self.__control = new Int32Array(msg.control);
    self.__response = new Uint8Array(msg.response);
    return;
  }
  if (msg.kind !== 'post') return;

  const control = self.__control;
  const response = self.__response;
  try {
    const res = await fetch(msg.url, { method: 'POST', body: msg.body });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const length = Math.min(bytes.length, response.length);
    response.set(bytes.subarray(0, length));
    Atomics.store(control, 2, length);
    Atomics.store(control, 1, res.status);
  } catch {
    // Network error, DNS failure, aborted request, etc. -- fail-closed -1,
    // no response body.
    Atomics.store(control, 2, 0);
    Atomics.store(control, 1, -1);
  } finally {
    Atomics.store(control, 0, 1);
    Atomics.notify(control, 0);
  }
};
