// Dependency-free smoke test for src/actor-host.js's `actor:host` ABI port:
// (1) the hand-rolled synchronous SHA-256 against known digests, (2)
// validateImportSurface's grant/limit denials as pure data, (3) a real
// native-WebAssembly round trip through examples/actor-host/actor-host-demo.wasm
// (clock_monotonic/log_write/sha256_hex, module "kotoba" -- same fixture shape
// kotoba-lang/kototama's tender_test.clj compiles via wasm-tools, here
// compiled once and checked in). Run: `node test/verify-actor-host.mjs`
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  sha256Hex,
  hostCaps,
  validateImportSurface,
  actorHostImports,
  inMemoryStore,
} from '../src/actor-host.js';

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

// ── known SHA-256 digests (FIPS 180-4 / common test vectors) ───────────────
const emptyDigest = sha256Hex(new TextEncoder().encode(''));
check(
  emptyDigest === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  `sha256("") = e3b0c442...b855 (got ${emptyDigest})`
);
const helloDigest = sha256Hex(new TextEncoder().encode('hello'));
check(
  helloDigest === '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  `sha256("hello") = 2cf24dba...9824 (got ${helloDigest})`
);
const abcDigest = sha256Hex(new TextEncoder().encode('abc'));
check(
  abcDigest === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  `sha256("abc") = ba7816bf...5ad (got ${abcDigest})`
);
// a 64-byte-aligned-boundary message (exercises the multi-chunk padding path)
const longMsg = 'a'.repeat(64);
const longDigest = sha256Hex(new TextEncoder().encode(longMsg));
check(typeof longDigest === 'string' && longDigest.length === 64, `sha256(64 "a"s) produces a 64-char hex digest (got length ${longDigest.length})`);

// ── validateImportSurface: grant/limit denials as pure data ────────────────
const deniedByDefault = validateImportSurface(['http-post'], hostCaps());
check(deniedByDefault.ok === false, 'http-post is denied under default HostCaps (no grants)');
check(
  deniedByDefault.errors.some((e) => e.error === 'grants/missing'),
  `denial reason is grants/missing (got ${JSON.stringify(deniedByDefault.errors)})`
);

const secretDenied = validateImportSurface(['sign'], hostCaps({ grants: ['sign'] }));
check(
  secretDenied.ok === false && secretDenied.errors.some((e) => e.error === 'limit/secret-imports'),
  `sign is denied without allowSecretImports even when granted (got ${JSON.stringify(secretDenied.errors)})`
);

const granted = validateImportSurface(['clock-monotonic', 'sha256-hex'], hostCaps({ grants: ['clock-monotonic', 'sha256-hex'] }));
check(granted.ok === true, `clock-monotonic+sha256-hex granted and requested both pass validation (got ${JSON.stringify(granted.errors)})`);

const httpGetDenied = validateImportSurface(
  ['http-get'],
  hostCaps({ grants: ['http-get'], limits: { allowWriteImports: true } })
);
check(
  httpGetDenied.ok === false && httpGetDenied.errors.some((e) => e.error === 'limit/max-http-gets'),
  `http-get is default-denied by maxHttpGets=0 (got ${JSON.stringify(httpGetDenied.errors)})`
);

// ── validateImportSurface: the remaining four denial branches, previously
// untested (only grants/missing and limit/secret-imports had coverage
// above) ────────────────────────────────────────────────────────────────
const unknownImport = validateImportSurface(['bogus-import'], hostCaps());
check(
  unknownImport.ok === false && unknownImport.errors.some((e) => e.error === 'imports/unknown'),
  `an id outside IMPORT_SURFACE is imports/unknown, not silently ignored (got ${JSON.stringify(unknownImport.errors)})`
);

const overMaxImports = validateImportSurface(
  ['clock-monotonic', 'sha256-hex'],
  hostCaps({ grants: ['clock-monotonic', 'sha256-hex'], limits: { maxImports: 1 } })
);
check(
  overMaxImports.ok === false && overMaxImports.errors.some((e) => e.error === 'limit/max-imports'),
  `requesting 2 known imports against maxImports:1 is limit/max-imports (got ${JSON.stringify(overMaxImports.errors)})`
);

const overMaxHttpPosts = validateImportSurface(['http-post'], hostCaps({ grants: ['http-post'], limits: { maxHttpPosts: 0 } }));
check(
  overMaxHttpPosts.ok === false && overMaxHttpPosts.errors.some((e) => e.error === 'limit/max-http-posts'),
  `http-post granted but over maxHttpPosts:0 is limit/max-http-posts, distinct from grants/missing (got ${JSON.stringify(overMaxHttpPosts.errors)})`
);

const writeDeniedByDefault = validateImportSurface(['log-write'], hostCaps({ grants: ['log-write'] }));
check(
  writeDeniedByDefault.ok === false && writeDeniedByDefault.errors.some((e) => e.error === 'limit/write-imports'),
  `log-write granted but allowWriteImports defaults to false is limit/write-imports (got ${JSON.stringify(writeDeniedByDefault.errors)})`
);

// ── actorHostImports: pre-flight rejection (no memory box even touched) ────
let preflightThrew = false;
try {
  actorHostImports(['log-write'], hostCaps({ grants: [] }), {});
} catch (e) {
  preflightThrew = true;
}
check(preflightThrew, 'actorHostImports throws pre-flight when the surface is rejected, before touching memoryBox');

// ── actorHostImports: RuntimeLimits exhaustion is an in-band -1, not a throw ─
{
  const store = inMemoryStore();
  const memoryBox = { memory: new WebAssembly.Memory({ initial: 1 }) };
  const fns = actorHostImports(
    ['log-write'],
    hostCaps({ grants: ['log-write'], limits: { allowWriteImports: true, maxLogWriteBytes: 4 } }),
    memoryBox,
    { store }
  );
  new Uint8Array(memoryBox.memory.buffer, 0, 4).set([1, 2, 3, 4]);
  const first = fns.log_write(0, 4);
  const second = fns.log_write(0, 4); // now 8 bytes total, over the 4-byte cap
  check(first === 0, `first 4-byte write succeeds (got ${first})`);
  check(second === -1, `second write exceeding maxLogWriteBytes=4 returns -1, not a throw (got ${second})`);
}

// ── actorHostImports: log_read's maxLogReadBytes exhaustion, the read-side
// mirror of maxLogWriteBytes above -- previously untested (only the write
// side had a test) ─────────────────────────────────────────────────────
{
  const store = inMemoryStore();
  store.append(new Uint8Array([1, 2, 3])); // 3 bytes, read again (not consumed) each call
  const memoryBox = { memory: new WebAssembly.Memory({ initial: 1 }) };
  const fns = actorHostImports(
    ['log-read'],
    hostCaps({ grants: ['log-read'], limits: { maxLogReadBytes: 4 } }),
    memoryBox,
    { store }
  );
  const first = fns.log_read(0, 100);
  const second = fns.log_read(0, 100); // now 6 accumulated bytes, over the 4-byte cap
  check(first === 3, `first read (3 bytes, under maxLogReadBytes=4) succeeds (got ${first})`);
  check(second === -1, `second read pushes accumulated logReadBytes to 6, over the cap -- returns -1, not a throw (got ${second})`);
}

// ── real native-WebAssembly round trip (module "kotoba", same convention
// kotoba.wasm-exec / kototama.tender use) ───────────────────────────────────
{
  const bytes = await readFile(path.join(here, '..', 'examples', 'actor-host', 'actor-host-demo.wasm'));
  const store = inMemoryStore();
  const memoryBox = {};
  const caps = hostCaps({
    grants: ['clock-monotonic', 'sha256-hex', 'log-write'],
    limits: { allowWriteImports: true },
  });
  const importObject = { kotoba: actorHostImports(['clock-monotonic', 'sha256-hex', 'log-write'], caps, memoryBox, { store }) };

  const { instance } = await WebAssembly.instantiate(bytes, importObject);
  memoryBox.memory = instance.exports.memory;

  const written = Number(instance.exports.main());
  check(written === 64, `main() wrote a 64-char sha256 hex digest (got ${written})`);

  const resultBytes = new Uint8Array(memoryBox.memory.buffer, 100, written);
  const resultText = new TextDecoder('utf-8').decode(resultBytes);
  check(
    resultText === '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    `guest-computed sha256("hello") matches the known digest (got ${resultText})`
  );

  const logged = new TextDecoder('utf-8').decode(store.read());
  check(logged === 'hello', `log_write recorded the guest's 5-byte payload (got ${JSON.stringify(logged)})`);
}

// ── gen_keypair/sign/verify: real native-WebAssembly round trip through the
// vendored ed25519, same fixture shape kototama.tender's (JVM) tender_test.clj
// compiles via wasm-tools (module "kotoba", gen_keypair/sign/verify) ────────
{
  const bytes = await readFile(path.join(here, '..', 'examples', 'actor-host', 'crypto-demo.wasm'));
  const memoryBox = {};
  const caps = hostCaps({
    grants: ['gen-keypair', 'sign', 'verify'],
    limits: { allowSecretImports: true },
  });
  const importObject = {
    kotoba: actorHostImports(['gen-keypair', 'sign', 'verify'], caps, memoryBox, {}),
  };

  const { instance } = await WebAssembly.instantiate(bytes, importObject);
  memoryBox.memory = instance.exports.memory;

  const ok = Number(instance.exports.main());
  check(ok === 1, `guest gen_keypair -> sign -> verify round-trips true through real Chicory-equivalent WASM (got ${ok})`);
}

// ── kagi-sign: only a decision-aware trusted adapter is linkable; the guest
// receives signature bytes, never key material or an unrestricted signer. ──
{
  const denied = validateImportSurface(['kagi-sign'], hostCaps({ grants: ['kagi-sign'] }));
  check(!denied.ok && denied.errors.some(e => e.error === 'limit/max-kagi-signs'),
    'kagi-sign is default-denied by its finite invocation quota');
  const memory = new WebAssembly.Memory({ initial: 1 }), memoryBox = { memory };
  const caps = hostCaps({ grants: ['kagi-sign'], limits: { maxKagiSigns: 1 } });
  const absent = actorHostImports(['kagi-sign'], caps, memoryBox, {});
  check(typeof absent.kagi_sign === 'undefined', 'kagi-sign stays unlinked without a decision-aware trusted adapter');
  const decisions = [{ ref: 'kagi://ops/key', purpose: 'release' }];
  const calls = [];
  const fns = actorHostImports(['kagi-sign'], caps, memoryBox, {
    runtime: 'node',
    kagiDecisions: decisions,
    kagiSigner: { authorizedSign(actualDecisions, ref, message) {
      calls.push({ actualDecisions, ref, message: [...message] }); return new Uint8Array(64).fill(7);
    } },
  });
  const ref = new TextEncoder().encode('kagi://ops/key'), message = new Uint8Array([1,2,3]);
  new Uint8Array(memory.buffer, 0, ref.length).set(ref); new Uint8Array(memory.buffer, 64, message.length).set(message);
  check(fns.kagi_sign(0, ref.length, 64, message.length, 128, 64) === 64,
    'kagi-sign returns only bounded signature bytes through the trusted adapter');
  check(calls.length === 1 && calls[0].actualDecisions === decisions && calls[0].ref === 'kagi://ops/key' && calls[0].message.join(',') === '1,2,3',
    'kagi-sign threads the exact decision set, opaque reference and message');
  check(fns.kagi_sign(0, ref.length, 64, message.length, 128, 64) === -1,
    'kagi-sign exhausts its finite per-session quota');
}

// ── gen_keypair/sign/verify without allowSecretImports: denied pre-flight,
// same limit/secret-imports gate kototama.contract's default-runtime-limits
// enforces (RuntimeLimits' :allow-secret-imports? false by default) ────────
{
  const denied = validateImportSurface(['gen-keypair'], hostCaps({ grants: ['gen-keypair'] }));
  check(
    denied.ok === false && denied.errors.some((e) => e.error === 'limit/secret-imports'),
    `gen-keypair is denied without allowSecretImports even when granted (got ${JSON.stringify(denied.errors)})`
  );
}

// ── llm-infer: denied by default (maxLlmInfers 0, same convention
// max-http-posts uses), same limit/max-llm-infers shape kototama.tender's
// (JVM) :limit/max-llm-infers denial uses ──────────────────────────────────
{
  const denied = validateImportSurface(['llm-infer'], hostCaps({ grants: ['llm-infer'] }));
  check(
    denied.ok === false && denied.errors.some((e) => e.error === 'limit/max-llm-infers'),
    `llm-infer is denied without raising maxLlmInfers even when granted (got ${JSON.stringify(denied.errors)})`
  );
  const granted = validateImportSurface(['llm-infer'], hostCaps({ grants: ['llm-infer'], limits: { maxLlmInfers: 1 } }));
  check(granted.ok === true, `llm-infer granted + maxLlmInfers raised passes validation (got ${JSON.stringify(granted.errors)})`);
}

// ── llm-infer: without opts.llmInfer, fns.llm_infer is never wired even
// when granted -- same "declared but not linked" honesty http-post's
// permanent absence uses, just conditional on the Node caller's choice
// instead of universal ──────────────────────────────────────────────────
{
  const memoryBox = { memory: new WebAssembly.Memory({ initial: 1 }) };
  const fns = actorHostImports(
    ['llm-infer'],
    hostCaps({ grants: ['llm-infer'], limits: { maxLlmInfers: 1 } }),
    memoryBox
    // no opts.llmInfer
  );
  check(fns.llm_infer === undefined, 'fns.llm_infer is absent when no opts.llmInfer backend is supplied');
}

// ── high-level http-get: injected sync bridge only; exact endpoint/path,
// manual redirects, output cap, and fail-closed absence/invalid reply. ─────
{
  const memoryBox = { memory: new WebAssembly.Memory({ initial: 1 }) };
  const encoder = new TextEncoder();
  const host = encoder.encode('example.test');
  const requestPath = encoder.encode('/bounded');
  new Uint8Array(memoryBox.memory.buffer, 0, host.length).set(host);
  new Uint8Array(memoryBox.memory.buffer, 32, requestPath.length).set(requestPath);
  let seen = null;
  const caps = hostCaps({
    grants: ['http-get'],
    limits: {
      maxHttpGets: 1,
      allowWriteImports: true,
      httpUrlAllowlist: ['https://example.test:443/bounded'],
    },
  });
  const absent = actorHostImports(['http-get'], caps, memoryBox);
  check(absent.http_get === undefined, 'http_get stays unlinked without an explicit synchronous bridge');
  const fns = actorHostImports(['http-get'], caps, memoryBox, {
    httpGet: (request) => {
      seen = request;
      return encoder.encode('HTTP/1.1 200 OK\r\n\r\nok');
    },
  });
  const n = fns.http_get(0, host.length, 443, 32, requestPath.length, 128, 64);
  check(
    JSON.stringify(seen) === JSON.stringify({
      host: 'example.test', port: 443, path: '/bounded', maxBytes: 64, redirect: 'manual',
    }),
    `http_get bridge receives exact scoped request (got ${JSON.stringify(seen)})`
  );
  const response = new TextDecoder().decode(new Uint8Array(memoryBox.memory.buffer, 128, n));
  check(response === 'HTTP/1.1 200 OK\r\n\r\nok', `http_get writes bounded response bytes (got ${JSON.stringify(response)})`);
  check(fns.http_get(0, host.length, 443, 32, requestPath.length, 128, 64) === -1,
    'http_get enforces its per-session request quota');

  const wrongScope = actorHostImports(['http-get'], hostCaps({
    grants: ['http-get'],
    limits: {
      maxHttpGets: 1,
      allowWriteImports: true,
      httpUrlAllowlist: ['https://example.test:443/bounded'],
    },
  }), memoryBox, { httpGet: () => encoder.encode('unexpected') });
  check(wrongScope.http_get(0, host.length, 443, 32, requestPath.length - 1, 128, 64) === -1,
    'http_get rejects a path outside the structured HTTPS allowlist before injection');
}

// ── http-post: injected sync bridge, structured HTTPS scope and quota. ───
{
  const memoryBox = { memory: new WebAssembly.Memory({ initial: 1 }) };
  const encoder = new TextEncoder();
  const url = encoder.encode('https://api.example.test/v1/messages');
  const body = encoder.encode('{"prompt":"hi"}');
  new Uint8Array(memoryBox.memory.buffer, 0, url.length).set(url);
  new Uint8Array(memoryBox.memory.buffer, 64, body.length).set(body);
  let seen = null;
  const caps = hostCaps({
    grants: ['http-post'],
    limits: {
      maxHttpPosts: 1,
      httpUrlAllowlist: ['https://api.example.test/v1'],
    },
  });
  const absent = actorHostImports(['http-post'], caps, memoryBox);
  check(absent.http_post === undefined, 'http_post stays unlinked without an explicit synchronous bridge');
  const fns = actorHostImports(['http-post'], caps, memoryBox, {
    httpPost: (request) => {
      seen = request;
      return encoder.encode('accepted');
    },
  });
  const n = fns.http_post(0, url.length, 64, body.length, 128, 32);
  check(seen?.url === 'https://api.example.test/v1/messages' &&
        new TextDecoder().decode(seen.body) === '{"prompt":"hi"}' &&
        seen.redirect === 'manual',
    `http_post bridge receives scoped URL/body (got ${JSON.stringify(seen)})`);
  check(new TextDecoder().decode(new Uint8Array(memoryBox.memory.buffer, 128, n)) === 'accepted',
    'http_post writes the bounded response');
  check(fns.http_post(0, url.length, 64, body.length, 128, 32) === -1,
    'http_post enforces its per-session request quota');
}

// ── llm-infer: with a fake synchronous opts.llmInfer, a real prompt/reply
// round-trips through guest memory, and a null reply (no key configured /
// call failed) fails closed as -1, matching kototama.tender's
// llm-infer-host-fn never distinguishing the two in-band ──────────────────
{
  const memoryBox = { memory: new WebAssembly.Memory({ initial: 1 }) };
  let lastPrompt = null;
  const fns = actorHostImports(
    ['llm-infer'],
    hostCaps({ grants: ['llm-infer'], limits: { maxLlmInfers: 2 } }),
    memoryBox,
    { llmInfer: (prompt) => { lastPrompt = prompt; return prompt === 'fail' ? null : `echo:${prompt}`; } }
  );
  const promptBytes = new TextEncoder().encode('hi');
  new Uint8Array(memoryBox.memory.buffer, 0, promptBytes.length).set(promptBytes);
  const written = fns.llm_infer(0, promptBytes.length, 100, 64);
  const reply = new TextDecoder('utf-8').decode(new Uint8Array(memoryBox.memory.buffer, 100, written));
  check(lastPrompt === 'hi', `opts.llmInfer receives the guest's decoded prompt (got ${JSON.stringify(lastPrompt)})`);
  check(reply === 'echo:hi', `opts.llmInfer's reply is written back into guest memory (got ${JSON.stringify(reply)})`);

  const failBytes = new TextEncoder().encode('fail');
  new Uint8Array(memoryBox.memory.buffer, 0, failBytes.length).set(failBytes);
  const failResult = fns.llm_infer(0, failBytes.length, 100, 64);
  check(failResult === -1, `a null opts.llmInfer reply fails closed as -1 (got ${failResult})`);
}

if (failed) process.exit(1);
console.log('OK: actor-host.js round-trips through a real native-WebAssembly-hosted module');
