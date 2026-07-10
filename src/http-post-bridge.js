// SharedArrayBuffer + Atomics.wait bridge for sync `http_post` host imports.
//
// Browser requirements:
//   - crossOriginIsolated === true
//     (COOP: same-origin + COEP: require-corp on the document)
//   - SharedArrayBuffer + Atomics.wait
//
// Control Int32Array (SharedArrayBuffer):
//   [0] status: 0 idle | 1 pending | 2 ok | 3 err
//   [1] response length (or -1)
//   [2] url length
//   [3] body length
// Payload SAB: [url bytes][body bytes] then overwritten with [response bytes].
//
// Prefer opts.httpPost inject on Node/tests. Use this bridge only when a
// real browser tab is cross-origin-isolated.

const STATUS_IDLE = 0;
const STATUS_PENDING = 1;
const STATUS_OK = 2;
const STATUS_ERR = 3;

const DEFAULT_PAYLOAD_BYTES = 256 * 1024;

/**
 * @param {object} [opts]
 * @param {number} [opts.payloadBytes]
 * @param {number} [opts.timeoutMs]
 */
export function createSabHttpPostBridge(opts = {}) {
  if (typeof SharedArrayBuffer === 'undefined' || typeof Atomics === 'undefined') {
    throw new Error('http-post-bridge: SharedArrayBuffer/Atomics unavailable');
  }
  if (typeof window !== 'undefined' && globalThis.crossOriginIsolated !== true) {
    throw new Error(
      'http-post-bridge: not crossOriginIsolated — set COOP/COEP headers ' +
        '(see COOP_COEP_HEADERS export)',
    );
  }
  if (typeof Worker === 'undefined') {
    throw new Error('http-post-bridge: Worker unavailable; use opts.httpPost inject');
  }

  const payloadBytes = opts.payloadBytes || DEFAULT_PAYLOAD_BYTES;
  const timeoutMs = opts.timeoutMs || 30000;
  const ctrlSab = new SharedArrayBuffer(16);
  const payloadSab = new SharedArrayBuffer(payloadBytes);
  const ctrl = new Int32Array(ctrlSab);
  const payload = new Uint8Array(payloadSab);

  const workerSource = `
    const P=1, OK=2, ERR=3;
    self.onmessage = (ev) => {
      const ctrl = new Int32Array(ev.data.ctrlSab);
      const payload = new Uint8Array(ev.data.payloadSab);
      (async function loop() {
        for (;;) {
          let s = Atomics.load(ctrl, 0);
          while (s !== P) {
            Atomics.wait(ctrl, 0, s);
            s = Atomics.load(ctrl, 0);
          }
          try {
            const urlLen = Atomics.load(ctrl, 2);
            const bodyLen = Atomics.load(ctrl, 3);
            const url = new TextDecoder().decode(payload.subarray(0, urlLen));
            const body = payload.slice(urlLen, urlLen + bodyLen);
            const resp = await fetch(url, {
              method: 'POST',
              body,
              headers: { 'content-type': 'application/octet-stream' },
            });
            const buf = new Uint8Array(await resp.arrayBuffer());
            const n = Math.min(buf.length, payload.length);
            payload.set(buf.subarray(0, n), 0);
            Atomics.store(ctrl, 1, n);
            Atomics.store(ctrl, 0, OK);
            Atomics.notify(ctrl, 0);
          } catch (e) {
            Atomics.store(ctrl, 1, -1);
            Atomics.store(ctrl, 0, ERR);
            Atomics.notify(ctrl, 0);
          }
        }
      })();
    };
  `;

  const blob = new Blob([workerSource], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);
  worker.postMessage({ ctrlSab, payloadSab });

  function postSync(urlStr, body) {
    const urlBytes = new TextEncoder().encode(String(urlStr));
    const bodyBytes =
      body instanceof Uint8Array ? body : new TextEncoder().encode(String(body || ''));
    if (urlBytes.length + bodyBytes.length > payload.length) return null;

    // Wait for idle
    let s = Atomics.load(ctrl, 0);
    while (s === STATUS_PENDING) {
      Atomics.wait(ctrl, 0, STATUS_PENDING, 50);
      s = Atomics.load(ctrl, 0);
    }

    payload.fill(0);
    payload.set(urlBytes, 0);
    payload.set(bodyBytes, urlBytes.length);
    Atomics.store(ctrl, 2, urlBytes.length);
    Atomics.store(ctrl, 3, bodyBytes.length);
    Atomics.store(ctrl, 1, 0);
    Atomics.store(ctrl, 0, STATUS_PENDING);
    Atomics.notify(ctrl, 0);

    const wr = Atomics.wait(ctrl, 0, STATUS_PENDING, timeoutMs);
    if (wr === 'timed-out') {
      Atomics.store(ctrl, 0, STATUS_IDLE);
      return null;
    }
    const status = Atomics.load(ctrl, 0);
    const n = Atomics.load(ctrl, 1);
    Atomics.store(ctrl, 0, STATUS_IDLE);
    if (status !== STATUS_OK || n < 0) return null;
    return payload.slice(0, n);
  }

  return {
    postSync,
    dispose() {
      try {
        worker.terminate();
        URL.revokeObjectURL(url);
      } catch (_) {}
    },
    capabilities: { mode: 'sab-coop', payloadBytes, timeoutMs },
  };
}

/** Headers a static file server must emit for crossOriginIsolated. */
export const COOP_COEP_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};
