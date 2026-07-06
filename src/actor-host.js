// Browser-side port of kotoba-lang/kototama's src/kototama/contract.cljc
// (the pure `actor:host` ABI authority: HostCaps/RuntimeLimits/
// validate-import-surface) plus a browser-native implementation of the
// subset of its 8 host imports that a WebAssembly host-import function can
// actually perform SYNCHRONOUSLY (see "Scope" below).
//
// Like kgraph.js, this is a from-scratch, dependency-free port, not a
// compiled build of the CLJC source -- this repo stays zero-build-step,
// CDN-servable as raw ES modules (see README).
//
// ---------------------------------------------------------------------------
// Scope (honest R0): only 4 of the 8 `actor:host` imports are implemented.
//
// A WebAssembly host-import function called from a running guest MUST
// return synchronously -- there is no `await` inside a Wasm call in a
// standard browser today (JS Promise Integration, which would allow this,
// is not yet universally shipped). `gen-keypair`/`sign`/`verify` (Ed25519)
// and `http-post` all fundamentally need either the Web Crypto API
// (`SubtleCrypto`, EVERY method async) or `fetch` (also async) -- neither
// can be implemented as a synchronous host import without either (a) a
// hand-rolled synchronous crypto implementation (a real, non-trivial
// correctness undertaking for Ed25519 specifically -- not attempted here,
// rather than risking a subtly wrong hand-rolled signature scheme), or
// (b) JSPI once it's broadly available. NOT implemented here, on purpose,
// not silently skipped: `gen_keypair`/`sign`/`verify`/`http_post` are
// simply absent from `actorHostImports`'s returned import object, so a
// guest declaring them fails to link with a clear Wasm "unknown import"
// error, not a confusing runtime crash.
//
// Implemented (all genuinely synchronous, zero dependencies):
//   - `now`           -- `Date.now()`
//   - `sha256_hex`    -- hand-rolled synchronous SHA-256 (below), verified
//                        against known digests in test/verify-actor-host.mjs
//   - `log_read` / `log_append` -- an injectable synchronous byte store
//                        (same `store` parameter shape kgraph.js uses)

export const ACTOR_HOST_NAMESPACE = 'actor:host';
export const ACTOR_HOST_VERSION = 0;

// ---------------------------------------------------------------------------
// kototama.contract's import-surface, ported 1:1 (same 8 ids, same effect
// tags -- kept complete even though only 4 have a browser implementation
// below, so `validateImportSurface` still recognizes and correctly denies
// the other 4 by name rather than treating them as unknown).

export const IMPORT_SURFACE = [
  { id: 'gen-keypair', category: 'identity', effects: new Set(['crypto', 'secret']) },
  { id: 'sign', category: 'identity', effects: new Set(['crypto', 'secret']) },
  { id: 'verify', category: 'identity', effects: new Set(['crypto']) },
  { id: 'sha256-hex', category: 'content-addressing', effects: new Set(['crypto']) },
  { id: 'http-post', category: 'network', effects: new Set(['network']) },
  { id: 'log-read', category: 'storage', effects: new Set(['storage']) },
  { id: 'log-append!', category: 'storage', effects: new Set(['storage', 'write']) },
  { id: 'now', category: 'clock', effects: new Set(['clock']) },
];

const IMPORT_BY_ID = new Map(IMPORT_SURFACE.map((i) => [i.id, i]));

export const DEFAULT_RUNTIME_LIMITS = {
  maxImports: IMPORT_SURFACE.length,
  maxHttpPosts: 0,
  maxLogReadBytes: 1048576,
  maxLogAppendBytes: 65536,
  allowSecretImports: false,
  allowWriteImports: false,
};

export const DEFAULT_HOST_CAPS = {
  namespace: ACTOR_HOST_NAMESPACE,
  version: ACTOR_HOST_VERSION,
  grants: new Set(),
  limits: DEFAULT_RUNTIME_LIMITS,
};

// hostCaps/validateImportSurface mirror kototama.contract/host-caps and
// kototama.contract/validate-import-surface field-for-field (grants
// normalized to known ids, limits merged over defaults, same error shapes:
// `imports/unknown`, `grants/missing`, `limit/max-imports`,
// `limit/max-http-posts`, `limit/secret-imports`, `limit/write-imports`).

export function hostCaps(m = {}) {
  const limits = { ...DEFAULT_RUNTIME_LIMITS, ...(m.limits || {}) };
  const grants = new Set([...(m.grants || [])].filter((id) => IMPORT_BY_ID.has(id)));
  return { ...DEFAULT_HOST_CAPS, ...m, grants, limits };
}

export function validateImportSurface(requestedIds, caps) {
  const c = hostCaps(caps);
  const unknown = requestedIds.filter((id) => !IMPORT_BY_ID.has(id));
  const known = requestedIds.filter((id) => IMPORT_BY_ID.has(id));
  const missing = known.filter((id) => !c.grants.has(id));
  const errors = [];
  if (unknown.length) errors.push({ error: 'imports/unknown', imports: unknown });
  if (missing.length) errors.push({ error: 'grants/missing', imports: missing });
  if (known.length > c.limits.maxImports) {
    errors.push({ error: 'limit/max-imports', limit: c.limits.maxImports, actual: known.length });
  }
  const httpPosts = known.filter((id) => id === 'http-post').length;
  if (httpPosts > c.limits.maxHttpPosts) {
    errors.push({ error: 'limit/max-http-posts', limit: c.limits.maxHttpPosts, actual: httpPosts });
  }
  const secretImports = known.filter((id) => IMPORT_BY_ID.get(id).effects.has('secret'));
  if (!c.limits.allowSecretImports && secretImports.length) {
    errors.push({ error: 'limit/secret-imports', imports: secretImports });
  }
  const writeImports = known.filter((id) => IMPORT_BY_ID.get(id).effects.has('write'));
  if (!c.limits.allowWriteImports && writeImports.length) {
    errors.push({ error: 'limit/write-imports', imports: writeImports });
  }
  return { ok: errors.length === 0, requested: known, granted: c.grants, limits: c.limits, errors };
}

// ---------------------------------------------------------------------------
// Hand-rolled synchronous SHA-256 (FIPS 180-4), zero dependencies -- Web
// Crypto's `crypto.subtle.digest` is async, unusable inside a synchronous
// Wasm host import (see the scope note above).

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x, n) {
  return (x >>> n) | (x << (32 - n));
}

/** Bytes (Uint8Array) -> 32-byte SHA-256 digest (Uint8Array). */
export function sha256(bytes) {
  const bitLen = bytes.length * 8;
  const padLen = (((bytes.length + 9 + 63) >> 6) << 6);
  const padded = new Uint8Array(padLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padLen - 4, bitLen >>> 0, false);
  view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let chunk = 0; chunk < padLen; chunk += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(chunk + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((v, i) => outView.setUint32(i * 4, v, false));
  return out;
}

export function sha256Hex(bytes) {
  return Array.from(sha256(bytes)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// An injectable, synchronous byte log store -- same role kgraph.js's `store`
// parameter plays, kept outside this module rather than owning a backend
// (kototama's own README stance: don't become the semantic authority).

export function inMemoryStore() {
  let buf = new Uint8Array(0);
  return {
    read: () => buf,
    append: (bytes) => {
      const next = new Uint8Array(buf.length + bytes.length);
      next.set(buf);
      next.set(bytes, buf.length);
      buf = next;
    },
  };
}

// ---------------------------------------------------------------------------
// The (module "kotoba") host imports, wired exactly like kgraph.js's
// kgraphHostImports: `memoryBox` is a mutable `{memory}` holder populated
// with `instance.exports.memory` AFTER `WebAssembly.instantiate` resolves.
//
// Fail-closed, two layers, matching kototama.tender's (JVM) design:
//   1. PRE-FLIGHT: validateImportSurface runs here, before any host
//      function is even constructed -- throws if not `ok`, so
//      `KotobaWasmElement.createImports` (which calls this) throws before
//      `WebAssembly.instantiateStreaming` ever runs, and its own
//      try/catch renders the error -- no separate wiring needed.
//   2. PER-CALL: each host function re-checks its own grant (defense in
//      depth) via `ensureGranted`.
// RuntimeLimits exhaustion (`maxLogReadBytes`/`maxLogAppendBytes`) is an
// in-band `-1`, same convention `writeBytes`'s overflow case uses -- NOT a
// thrown error -- so a well-behaved guest can see it and back off, exactly
// like `kototama.tender`'s distinction between a hard-thrown grant
// violation and a soft quota signal.
export function actorHostImports(requestedIds, caps, memoryBox, opts = {}) {
  const c = hostCaps(caps);
  const validation = validateImportSurface(requestedIds, c);
  if (!validation.ok) {
    throw new Error(`kototama actor-host: import surface rejected: ${JSON.stringify(validation.errors)}`);
  }

  const store = opts.store || inMemoryStore();
  const state = { logReadBytes: 0, logAppendBytes: 0 };
  const available = new Set(validation.requested);

  const readBytes = (ptr, len) => new Uint8Array(memoryBox.memory.buffer, ptr, len).slice();
  const writeBytes = (ptr, cap, bytes) => {
    if (bytes.length > cap) return -1;
    new Uint8Array(memoryBox.memory.buffer, ptr, bytes.length).set(bytes);
    return bytes.length;
  };
  const ensureGranted = (id) => {
    if (!c.grants.has(id)) {
      throw new Error(`kototama actor-host: ${id} denied (grant/missing)`);
    }
  };

  const fns = {};

  if (available.has('now')) {
    fns.now = () => BigInt(Date.now());
  }

  if (available.has('sha256-hex')) {
    fns.sha256_hex = (ptr, len, outPtr, outCap) => {
      ensureGranted('sha256-hex');
      const hex = sha256Hex(readBytes(ptr, len));
      return writeBytes(outPtr, outCap, new TextEncoder().encode(hex));
    };
  }

  if (available.has('log-read')) {
    fns.log_read = (outPtr, outCap) => {
      ensureGranted('log-read');
      const bytes = store.read();
      if (state.logReadBytes + bytes.length > c.limits.maxLogReadBytes) return -1;
      state.logReadBytes += bytes.length;
      return writeBytes(outPtr, outCap, bytes);
    };
  }

  if (available.has('log-append!')) {
    fns.log_append = (ptr, len) => {
      ensureGranted('log-append!');
      const bytes = readBytes(ptr, len);
      if (state.logAppendBytes + bytes.length > c.limits.maxLogAppendBytes) return -1;
      state.logAppendBytes += bytes.length;
      store.append(bytes);
      return 0;
    };
  }

  return fns;
}
