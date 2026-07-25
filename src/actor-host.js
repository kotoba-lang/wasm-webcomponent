// Browser-side port of kotoba-lang/kototama's src/kototama/contract.cljc
// (the pure `actor:host` ABI authority: HostCaps/RuntimeLimits/
// validate-import-surface) plus a browser-native implementation of the
// subset of its host imports that a WebAssembly host-import function can
// actually perform SYNCHRONOUSLY (see "Scope" below).
//
// Like kgraph.js, this is a from-scratch, dependency-free port, not a
// compiled build of the CLJC source -- this repo stays zero-build-step,
// CDN-servable as raw ES modules (see README).
//
// ---------------------------------------------------------------------------
// Scope: pure synchronous imports are implemented directly. Network imports
// stay unlinked unless the caller supplies an explicit synchronous backend.
// `http-get` supports an injected worker/SAB bridge, but only with a finite
// request quota and structured HTTPS host/port/path allowlist. Node may inject
// the bounded worker/SAB raw transport broker; browsers still cannot. Database,
// SCRAM, and cancel imports remain unavailable here.
//
// A WebAssembly host-import function called from a running guest MUST
// return synchronously -- there is no `await` inside a Wasm call in a
// standard browser today (JS Promise Integration would allow this but isn't
// broadly shipped across engines yet). `gen-keypair`/`sign`/`verify`
// (Ed25519) don't actually need to go through the always-async Web Crypto
// `SubtleCrypto` API to be correct, though -- Ed25519 signing is pure
// arithmetic over bytes already in memory, not I/O, so a genuinely
// synchronous implementation is possible without SubtleCrypto at all. Unlike
// `sha256_hex` below, this isn't hand-rolled from scratch (a real,
// non-trivial correctness undertaking for elliptic-curve arithmetic
// specifically): `./vendor/curves/ed25519.js` vendors the actual,
// unmodified, audited `@noble/curves` (see `./vendor/README.md` for
// provenance and why vendored rather than CDN-imported).
//
// Bare `http-post` remains unavailable: `fetch` is
// real network I/O, not arithmetic, so there's no synchronous-without-async
// version of it to write or vendor -- it needs either JSPI (Chrome 137+
// only as of this writing, not yet Firefox/Safari) or a
// SharedArrayBuffer+Atomics.wait blocking bridge (needs COOP/COEP response
// headers, which this library's "zero-build-step, CDN-servable as raw
// static files" deployment model doesn't assume). NOT implemented here, on
// purpose, not silently skipped: `http_post` is simply absent from
// `actorHostImports`'s returned import object, so a guest declaring it
// fails to link with a clear Wasm "unknown import" error, not a confusing
// runtime crash.
//
// Implemented (all genuinely synchronous):
//   - `clock_monotonic` -- `Date.now()`
//   - `sha256_hex`    -- hand-rolled synchronous SHA-256, zero dependencies,
//                        verified against known digests in
//                        test/verify-actor-host.mjs
//   - `gen_keypair` / `sign` / `verify` -- vendored `@noble/curves` ed25519
//                        (see above), verified via a real Chicory-equivalent
//                        WASM round trip in test/verify-actor-host.mjs
//   - `log_read` / `log_write` -- an injectable synchronous byte store
//                        (same `store` parameter shape kgraph.js uses)
//   - conditional `http_get` -- explicit synchronous injection, finite quota,
//                        structured HTTPS scope; the browser E2E uses a
//                        COOP/COEP worker+SharedArrayBuffer bridge
//
// Field/id names (`clock-monotonic`/`log-write`, not `now`/`log-append!`)
// match `kotoba-lang/kototama`'s `kototama.contract` and
// `kotoba-core-contracts`' capability_contract.edn 1:1 -- a concurrent
// session independently registered `clock-monotonic`/`log-write` in that
// shared compiler table for aiueos's kernel-capability vocabulary with
// identical wire signatures, so kototama's side (and this browser port)
// were renamed to reuse those names instead of registering the same
// operation twice under different names.

import { ed25519 } from './vendor/curves/ed25519.js';

export const ACTOR_HOST_NAMESPACE = 'actor:host';
export const ACTOR_HOST_VERSION = 0;

// ---------------------------------------------------------------------------
// kototama.contract's import-surface, ported 1:1 (same ids, same effect
// tags -- kept complete even though only some have a browser implementation
// below, so `validateImportSurface` still recognizes and correctly denies
// the rest by name rather than treating them as unknown).

export const IMPORT_SURFACE = [
  { id: 'gen-keypair', category: 'identity', effects: new Set(['crypto', 'secret']) },
  { id: 'sign', category: 'identity', effects: new Set(['crypto', 'secret']) },
  { id: 'verify', category: 'identity', effects: new Set(['crypto']) },
  { id: 'kagi-sign', category: 'identity', effects: new Set(['crypto']) },
  { id: 'sha256-hex', category: 'content-addressing', effects: new Set(['crypto']) },
  { id: 'http-post', category: 'network', effects: new Set(['network']) },
  { id: 'transport-connect', category: 'transport', effects: new Set(['network']) },
  { id: 'tls-open', category: 'transport', effects: new Set(['network', 'crypto']) },
  { id: 'tls-server-end-point', category: 'transport', effects: new Set(['network', 'crypto']) },
  { id: 'transport-write', category: 'transport', effects: new Set(['network', 'write']) },
  { id: 'transport-read', category: 'transport', effects: new Set(['network']) },
  { id: 'transport-close', category: 'transport', effects: new Set(['network', 'write']) },
  { id: 'http-open', category: 'component-http', effects: new Set(['network']) },
  { id: 'http-write', category: 'component-http', effects: new Set(['network', 'write']) },
  { id: 'http-read', category: 'component-http', effects: new Set(['network']) },
  { id: 'http-close', category: 'component-http', effects: new Set(['network', 'write']) },
  { id: 'http-get', category: 'component-http', effects: new Set(['network', 'write']) },
  { id: 'db-open', category: 'component-database', effects: new Set(['network']) },
  { id: 'db-write', category: 'component-database', effects: new Set(['network', 'write']) },
  { id: 'db-read', category: 'component-database', effects: new Set(['network']) },
  { id: 'db-close', category: 'component-database', effects: new Set(['network', 'write']) },
  { id: 'db-exchange', category: 'component-database', effects: new Set(['network', 'write']) },
  { id: 'pg-simple-query', category: 'component-database', effects: new Set(['network', 'write']) },
  { id: 'pg-open', category: 'component-database', effects: new Set(['network', 'write']) },
  { id: 'pg-query', category: 'component-database', effects: new Set(['network', 'write']) },
  { id: 'pg-query-state', category: 'component-database', effects: new Set(['network', 'write']) },
  { id: 'pg-prepare', category: 'component-database', effects: new Set(['network', 'write']) },
  { id: 'pg-prepare-typed', category: 'component-database', effects: new Set(['network', 'write']) },
  { id: 'pg-execute-params2', category: 'component-database', effects: new Set(['network', 'write']) },
  { id: 'pg-execute-params', category: 'component-database', effects: new Set(['network', 'write']) },
  { id: 'pg-bind-portal', category: 'component-database', effects: new Set(['network', 'write']) },
  { id: 'pg-fetch-portal', category: 'component-database', effects: new Set(['network', 'write']) },
  { id: 'pg-close-portal', category: 'component-database', effects: new Set(['network', 'write']) },
  { id: 'pg-copy-out', category: 'component-database', effects: new Set(['network', 'write']) },
  { id: 'pg-copy-in', category: 'component-database', effects: new Set(['network', 'write']) },
  { id: 'pg-execute-batch', category: 'component-database', effects: new Set(['network', 'write']) },
  { id: 'pg-session-reset', category: 'component-database', effects: new Set(['network', 'write']) },
  { id: 'pg-pool-open', category: 'component-database', effects: new Set(['network', 'secret', 'write']) },
  { id: 'pg-pool-acquire', category: 'component-database', effects: new Set(['network', 'write']) },
  { id: 'pg-pool-query', category: 'component-database', effects: new Set(['network', 'write']) },
  { id: 'pg-pool-release', category: 'component-database', effects: new Set(['network', 'write']) },
  { id: 'pg-pool-stats', category: 'component-database', effects: new Set(['read']) },
  { id: 'pg-pool-health', category: 'component-database', effects: new Set(['network', 'write']) },
  { id: 'pg-pool-drain', category: 'component-database', effects: new Set(['network', 'write']) },
  { id: 'pg-pool-close', category: 'component-database', effects: new Set(['network', 'write']) },
  { id: 'pg-close-statement', category: 'component-database', effects: new Set(['network', 'write']) },
  { id: 'pg-open-scram', category: 'component-database', effects: new Set(['network', 'secret', 'write']) },
  { id: 'pg-open-scram-random', category: 'component-database', effects: new Set(['network', 'secret', 'write']) },
  { id: 'pg-open-scram-cancellable-random', category: 'component-database', effects: new Set(['network', 'secret', 'write']) },
  { id: 'pg-cancel-authority-use', category: 'component-database', effects: new Set(['network', 'secret', 'write']) },
  { id: 'pg-close-scram', category: 'component-database', effects: new Set(['network', 'write']) },
  { id: 'scram-sha256', category: 'credential-crypto', effects: new Set(['crypto', 'secret', 'write']) },
  { id: 'pg-cancel-register', category: 'credential-crypto', effects: new Set(['network', 'secret', 'write']) },
  { id: 'pg-cancel', category: 'credential-crypto', effects: new Set(['network', 'secret', 'write']) },
  { id: 'log-read', category: 'storage', effects: new Set(['storage']) },
  { id: 'log-write', category: 'storage', effects: new Set(['storage', 'write']) },
  { id: 'clock-monotonic', category: 'clock', effects: new Set(['clock']) },
  { id: 'random-bytes', category: 'randomness', effects: new Set(['crypto', 'write']) },
  // `llm-infer` (`llm/infer`, capability id 225 in kotoba-core-contracts'
  // capability_contract.edn; kototama.tender's Anthropic Messages API
  // call). Unlike `http-post`, this ISN'T fundamentally un-implementable
  // here -- it's only a real browser tab that can't do synchronous network
  // I/O. A Node host (this repo's own test/*.mjs scripts, not a browser)
  // has no such constraint and can inject a genuinely synchronous
  // implementation via `opts.llmInfer` (e.g. a blocking child_process
  // call) below, so this is listed unconditionally and wired whenever a
  // caller supplies one -- same "declared but only linked when a real
  // implementation exists" honesty `http-post`'s comment above documents,
  // just environment-dependent instead of universally absent.
  { id: 'llm-infer', category: 'llm', effects: new Set(['network']) },
];

const IMPORT_BY_ID = new Map(IMPORT_SURFACE.map((i) => [i.id, i]));

export const DEFAULT_RUNTIME_LIMITS = {
  maxImports: IMPORT_SURFACE.length,
  maxHttpPosts: 0,
  maxHttpGets: 0,
  maxTransportConnections: 0,
  maxTransportConnectMs: 5000,
  maxTransportReadMs: 5000,
  maxTransportReadBytes: 1048576,
  maxTransportWriteBytes: 1048576,
  transportEndpointAllowlist: [],
  transportResolvedAddressAllowlist: [],
  maxLlmInfers: 0,
  maxKagiSigns: 0,
  maxScramProofs: 0,
  maxPgCancelHandles: 0,
  maxPgCancelRequests: 0,
  scramCredentialAllowlist: [],
  maxRandomBytes: 0,
  httpUrlAllowlist: [],
  maxLogReadBytes: 1048576,
  maxLogWriteBytes: 65536,
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
  const httpGets = known.filter((id) => id === 'http-get').length;
  if (httpGets > c.limits.maxHttpGets) {
    errors.push({ error: 'limit/max-http-gets', limit: c.limits.maxHttpGets, actual: httpGets });
  }
  const transportConnects = known.filter((id) => id === 'transport-connect').length;
  if (transportConnects > c.limits.maxTransportConnections) {
    errors.push({ error: 'limit/max-transport-connections',
      limit: c.limits.maxTransportConnections, actual: transportConnects });
  }
  const llmInfers = known.filter((id) => id === 'llm-infer').length;
  if (llmInfers > c.limits.maxLlmInfers) {
    errors.push({ error: 'limit/max-llm-infers', limit: c.limits.maxLlmInfers, actual: llmInfers });
  }
  const kagiSigns = known.filter((id) => id === 'kagi-sign').length;
  if (kagiSigns > c.limits.maxKagiSigns) {
    errors.push({ error: 'limit/max-kagi-signs', limit: c.limits.maxKagiSigns, actual: kagiSigns });
  }
  const scramProofs = known.filter((id) => id === 'scram-sha256').length;
  if (scramProofs > c.limits.maxScramProofs) {
    errors.push({ error: 'limit/max-scram-proofs', limit: c.limits.maxScramProofs, actual: scramProofs });
  }
  const cancelRegisters = known.filter((id) => id === 'pg-cancel-register').length;
  if (cancelRegisters > c.limits.maxPgCancelHandles) {
    errors.push({ error: 'limit/max-pg-cancel-handles', limit: c.limits.maxPgCancelHandles, actual: cancelRegisters });
  }
  const cancels = known.filter((id) => id === 'pg-cancel').length;
  if (cancels > c.limits.maxPgCancelRequests) {
    errors.push({ error: 'limit/max-pg-cancel-requests', limit: c.limits.maxPgCancelRequests, actual: cancels });
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

function httpUrlAllowed(allowlist, requestUrl) {
  if (!Array.isArray(allowlist) || allowlist.length === 0) return false;
  let requested;
  try {
    requested = new URL(requestUrl);
    if (requested.protocol !== 'https:' || requested.username || requested.password || requested.hash) return false;
  } catch (_) {
    return false;
  }
  return allowlist.some((entry) => {
    try {
      const scope = new URL(entry);
      if (scope.protocol !== 'https:' || scope.username || scope.password || scope.search || scope.hash) return false;
      const scopePort = Number(scope.port || 443);
      const scopePath = scope.pathname || '/';
      const pathAllowed = requested.pathname === scopePath ||
        (scopePath.endsWith('/') ? requested.pathname.startsWith(scopePath) : requested.pathname.startsWith(`${scopePath}/`));
      return scope.hostname === requested.hostname &&
        scopePort === Number(requested.port || 443) && pathAllowed;
    } catch (_) {
      return false;
    }
  });
}

function httpGetAllowed(allowlist, host, port, requestPath) {
  if (typeof host !== 'string' || !/^[A-Za-z0-9.-]+$/.test(host) ||
      !Number.isInteger(port) || port < 1 || port > 65535 ||
      typeof requestPath !== 'string' || !requestPath.startsWith('/')) return false;
  return httpUrlAllowed(allowlist, `https://${host}:${port}${requestPath}`);
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
// RuntimeLimits exhaustion (`maxLogReadBytes`/`maxLogWriteBytes`) is an
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
  const state = {
    logReadBytes: 0, logWriteBytes: 0, randomBytes: 0, httpGets: 0, httpPosts: 0, kagiSigns: 0,
  };
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

  if (available.has('clock-monotonic')) {
    fns.clock_monotonic = () => BigInt(Date.now());
  }

  if (available.has('random-bytes')) {
    fns.random_bytes = (outPtr, outCap) => {
      ensureGranted('random-bytes');
      if (outCap <= 0 || outCap > 4096 || state.randomBytes + outCap > c.limits.maxRandomBytes) return -1;
      const bytes = new Uint8Array(outCap);
      if (typeof opts.randomBytes === 'function') {
        const supplied = opts.randomBytes(outCap);
        if (!(supplied instanceof Uint8Array) || supplied.length !== outCap) return -1;
        bytes.set(supplied);
      } else globalThis.crypto.getRandomValues(bytes);
      state.randomBytes += outCap;
      return writeBytes(outPtr, outCap, bytes);
    };
  }

  if (available.has('sha256-hex')) {
    fns.sha256_hex = (ptr, len, outPtr, outCap) => {
      ensureGranted('sha256-hex');
      const hex = sha256Hex(readBytes(ptr, len));
      return writeBytes(outPtr, outCap, new TextEncoder().encode(hex));
    };
  }

  if (available.has('kagi-sign') && opts.runtime === 'node' && typeof opts.kagiSigner?.authorizedSign === 'function' &&
      Array.isArray(opts.kagiDecisions) && opts.kagiDecisions.length > 0) {
    fns.kagi_sign = (refPtr, refLen, msgPtr, msgLen, outPtr, outCap) => {
      ensureGranted('kagi-sign');
      if (state.kagiSigns >= c.limits.maxKagiSigns || refLen <= 0 || refLen > 255 || msgLen < 0 || msgLen > 65536) return -1;
      try {
        const ref = new TextDecoder('utf-8', { fatal: true }).decode(readBytes(refPtr, refLen));
        const signature = opts.kagiSigner.authorizedSign(opts.kagiDecisions, ref, readBytes(msgPtr, msgLen));
        if (!(signature instanceof Uint8Array)) return -1;
        const written = writeBytes(outPtr, outCap, signature);
        if (written >= 0) state.kagiSigns += 1;
        return written;
      } catch (_) { return -1; }
    };
  }

  if (available.has('http-post') && typeof opts.httpPost === 'function') {
    fns.http_post = (urlPtr, urlLen, bodyPtr, bodyLen, outPtr, outCap) => {
      ensureGranted('http-post');
      if (state.httpPosts >= c.limits.maxHttpPosts) return -1;
      const url = new TextDecoder('utf-8', { fatal: true }).decode(readBytes(urlPtr, urlLen));
      if (!httpUrlAllowed(c.limits.httpUrlAllowlist, url)) return -1;
      const reply = opts.httpPost({
        url,
        body: readBytes(bodyPtr, bodyLen),
        maxBytes: outCap,
        redirect: 'manual',
      });
      if (!(reply instanceof Uint8Array)) return -1;
      state.httpPosts += 1;
      return writeBytes(outPtr, outCap, reply);
    };
  }

  // High-level component HTTP capability. Browser tabs and Node cannot expose
  // raw synchronous sockets safely, but a caller may inject a synchronous
  // fetch/SAB/worker bridge. The callback receives an exact endpoint and a
  // manual-redirect requirement; absence leaves the Wasm import unlinked.
  if (available.has('http-get') && typeof opts.httpGet === 'function') {
    fns.http_get = (hostPtr, hostLen, port, pathPtr, pathLen, outPtr, outCap) => {
      ensureGranted('http-get');
      const host = new TextDecoder('utf-8', { fatal: true }).decode(readBytes(hostPtr, hostLen));
      const requestPath = new TextDecoder('utf-8', { fatal: true }).decode(readBytes(pathPtr, pathLen));
      if (state.httpGets >= c.limits.maxHttpGets ||
          !httpGetAllowed(c.limits.httpUrlAllowlist, host, port, requestPath)) return -1;
      const reply = opts.httpGet({
        host,
        port,
        path: requestPath,
        maxBytes: outCap,
        redirect: 'manual',
      });
      if (!(reply instanceof Uint8Array)) return -1;
      state.httpGets += 1;
      return writeBytes(outPtr, outCap, reply);
    };
  }

  // Node may inject a worker/SAB broker implementing the bounded raw
  // transport ABI. Browser callers leave this absent. Opaque handles and all
  // socket/TLS state remain owned by the broker worker.
  if (opts.transport) {
    const transport = opts.transport;
    if (available.has('transport-connect') && typeof transport.connect === 'function') {
      fns.transport_connect = (hostPtr, hostLen, port) => {
        ensureGranted('transport-connect');
        try { return transport.connect(new TextDecoder('utf-8', { fatal: true }).decode(readBytes(hostPtr, hostLen)), port); }
        catch (_) { return 0n; }
      };
    }
    if (available.has('tls-open') && typeof transport.tlsOpen === 'function') {
      fns.tls_open = (handle, namePtr, nameLen) => {
        ensureGranted('tls-open');
        try { return transport.tlsOpen(handle, new TextDecoder('utf-8', { fatal: true }).decode(readBytes(namePtr, nameLen))); }
        catch (_) { return 0n; }
      };
    }
    if (available.has('tls-server-end-point') && typeof transport.tlsServerEndPoint === 'function') {
      fns.tls_server_end_point = (handle, outPtr, outCap) => {
        ensureGranted('tls-server-end-point');
        const bytes = transport.tlsServerEndPoint(handle, outCap);
        return bytes instanceof Uint8Array ? writeBytes(outPtr, outCap, bytes) : -1;
      };
    }
    if (available.has('transport-write') && typeof transport.write === 'function') {
      fns.transport_write = (handle, ptr, len) => {
        ensureGranted('transport-write');
        return transport.write(handle, readBytes(ptr, len));
      };
    }
    if (available.has('transport-read') && typeof transport.read === 'function') {
      fns.transport_read = (handle, outPtr, outCap) => {
        ensureGranted('transport-read');
        const bytes = transport.read(handle, outCap);
        return bytes instanceof Uint8Array ? writeBytes(outPtr, outCap, bytes) : -1;
      };
    }
    if (available.has('transport-close') && typeof transport.close === 'function') {
      fns.transport_close = (handle) => { ensureGranted('transport-close'); return transport.close(handle); };
    }
    if (available.has('pg-cancel-register') && typeof transport.registerCancel === 'function') {
      fns.pg_cancel_register = (handle, pid, secret) => {
        ensureGranted('pg-cancel-register'); return transport.registerCancel(handle, pid, secret);
      };
    }
    if (available.has('pg-cancel') && typeof transport.cancel === 'function') {
      fns.pg_cancel = (handle) => { ensureGranted('pg-cancel'); return transport.cancel(handle); };
    }
  }

  if (available.has('scram-sha256') && typeof opts.credentials?.scramSha256 === 'function') {
    fns.scram_sha256 = (refPtr, refLen, saltPtr, saltLen, iterations,
      authPtr, authLen, outPtr, outCap) => {
      ensureGranted('scram-sha256');
      if (outCap < 64) return -1;
      try {
        const credentialRef = new TextDecoder('utf-8', { fatal: true }).decode(readBytes(refPtr, refLen));
        if (!c.limits.scramCredentialAllowlist.includes(credentialRef)) return -1;
        const result = opts.credentials.scramSha256({ credentialRef,
          salt: readBytes(saltPtr, saltLen), iterations,
          authMessage: readBytes(authPtr, authLen) });
        return result instanceof Uint8Array && result.length === 64 ? writeBytes(outPtr, outCap, result) : -1;
      } catch (_) { return -1; }
    };
  }

  // `(out-ptr out-cap) -> bytes-written|-1`. Writes a fresh 32-byte Ed25519
  // seed followed by its 32-byte derived public key (64 bytes total) --
  // same wire shape kototama.tender's (JVM) `gen-keypair-host-fn` uses.
  if (available.has('gen-keypair')) {
    fns.gen_keypair = (outPtr, outCap) => {
      ensureGranted('gen-keypair');
      const seed = ed25519.utils.randomPrivateKey();
      const pub = ed25519.getPublicKey(seed);
      const out = new Uint8Array(64);
      out.set(seed, 0);
      out.set(pub, 32);
      return writeBytes(outPtr, outCap, out);
    };
  }

  // `(seed-ptr msg-ptr msg-len out-ptr out-cap) -> bytes-written|-1`. Signs
  // MSG with the raw 32-byte seed at SEED-PTR, writes the 64-byte signature.
  if (available.has('sign')) {
    fns.sign = (seedPtr, msgPtr, msgLen, outPtr, outCap) => {
      ensureGranted('sign');
      const seed = readBytes(seedPtr, 32);
      const msg = readBytes(msgPtr, msgLen);
      const sig = ed25519.sign(msg, seed);
      return writeBytes(outPtr, outCap, sig);
    };
  }

  // `(pub-ptr pub-len msg-ptr msg-len sig-ptr sig-len) -> 1|0`.
  if (available.has('verify')) {
    fns.verify = (pubPtr, pubLen, msgPtr, msgLen, sigPtr, sigLen) => {
      ensureGranted('verify');
      const pub = readBytes(pubPtr, pubLen);
      const msg = readBytes(msgPtr, msgLen);
      const sig = readBytes(sigPtr, sigLen);
      return ed25519.verify(sig, msg, pub) ? 1 : 0;
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

  if (available.has('log-write')) {
    fns.log_write = (ptr, len) => {
      ensureGranted('log-write');
      const bytes = readBytes(ptr, len);
      if (state.logWriteBytes + bytes.length > c.limits.maxLogWriteBytes) return -1;
      state.logWriteBytes += bytes.length;
      store.append(bytes);
      return 0;
    };
  }

  // `(prompt-ptr prompt-len out-ptr out-cap) -> bytes-written|-1`. Only
  // wired when a caller supplies `opts.llmInfer` (a synchronous
  // `(promptString) => string|null` function) -- e.g. this repo's own
  // Node-hosted verify scripts backing it with a blocking child_process
  // call to `curl`. Never call `opts.llmInfer` from actual browser code: a
  // synchronous XHR-style blocking call is deprecated/discouraged
  // platform-wide there, unlike a Node `child_process` call, which has no
  // such constraint. `text === null` (no API key configured on the host,
  // the call failed, or an empty/malformed reply) fails closed as -1, same
  // as `kototama.tender`'s `llm-infer-host-fn` never distinguishing "no
  // credential" from "call failed" in-band.
  if (available.has('llm-infer') && typeof opts.llmInfer === 'function') {
    fns.llm_infer = (promptPtr, promptLen, outPtr, outCap) => {
      ensureGranted('llm-infer');
      const prompt = new TextDecoder().decode(readBytes(promptPtr, promptLen));
      const text = opts.llmInfer(prompt);
      if (text == null) return -1;
      return writeBytes(outPtr, outCap, new TextEncoder().encode(text));
    };
  }

  return fns;
}
