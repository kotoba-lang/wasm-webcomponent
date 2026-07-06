// Dependency-free smoke test for src/actor-host.js's `actor:host` ABI port:
// (1) the hand-rolled synchronous SHA-256 against known digests, (2)
// validateImportSurface's grant/limit denials as pure data, (3) a real
// native-WebAssembly round trip through examples/actor-host/actor-host-demo.wasm
// (now/log_append/sha256_hex, module "kotoba" -- same fixture shape
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

const granted = validateImportSurface(['now', 'sha256-hex'], hostCaps({ grants: ['now', 'sha256-hex'] }));
check(granted.ok === true, `now+sha256-hex granted and requested both pass validation (got ${JSON.stringify(granted.errors)})`);

// ── actorHostImports: pre-flight rejection (no memory box even touched) ────
let preflightThrew = false;
try {
  actorHostImports(['log-append!'], hostCaps({ grants: [] }), {});
} catch (e) {
  preflightThrew = true;
}
check(preflightThrew, 'actorHostImports throws pre-flight when the surface is rejected, before touching memoryBox');

// ── actorHostImports: RuntimeLimits exhaustion is an in-band -1, not a throw ─
{
  const store = inMemoryStore();
  const memoryBox = { memory: new WebAssembly.Memory({ initial: 1 }) };
  const fns = actorHostImports(
    ['log-append!'],
    hostCaps({ grants: ['log-append!'], limits: { allowWriteImports: true, maxLogAppendBytes: 4 } }),
    memoryBox,
    { store }
  );
  new Uint8Array(memoryBox.memory.buffer, 0, 4).set([1, 2, 3, 4]);
  const first = fns.log_append(0, 4);
  const second = fns.log_append(0, 4); // now 8 bytes total, over the 4-byte cap
  check(first === 0, `first 4-byte append succeeds (got ${first})`);
  check(second === -1, `second append exceeding maxLogAppendBytes=4 returns -1, not a throw (got ${second})`);
}

// ── real native-WebAssembly round trip (module "kotoba", same convention
// kotoba.wasm-exec / kototama.tender use) ───────────────────────────────────
{
  const bytes = await readFile(path.join(here, '..', 'examples', 'actor-host', 'actor-host-demo.wasm'));
  const store = inMemoryStore();
  const memoryBox = {};
  const caps = hostCaps({
    grants: ['now', 'sha256-hex', 'log-append!'],
    limits: { allowWriteImports: true },
  });
  const importObject = { kotoba: actorHostImports(['now', 'sha256-hex', 'log-append!'], caps, memoryBox, { store }) };

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
  check(logged === 'hello', `log_append! recorded the guest's 5-byte payload (got ${JSON.stringify(logged)})`);
}

if (failed) process.exit(1);
console.log('OK: actor-host.js round-trips through a real native-WebAssembly-hosted module');
