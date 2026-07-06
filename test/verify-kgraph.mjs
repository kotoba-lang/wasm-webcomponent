// Dependency-free smoke test for src/kgraph.js's kgraph-* host-import ABI
// port: instantiate examples/kgraph/demo-kgraph.wasm backed by
// kgraphHostImports, and check the result matches kotoba-lang/kotoba's own
// JVM/Chicory test (wasm-binary-runs-kgraph-round-trip-through-real-host-functions,
// test/kotoba/wasm_exec_test.clj) byte-for-byte. Run: `node test/verify-kgraph.mjs`
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { kgraphHostImports, writeEdn } from '../src/kgraph.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const bytes = await readFile(path.join(here, '..', 'examples', 'kgraph', 'demo-kgraph.wasm'));

const store = [];
const memoryBox = {};
const importObject = { kotoba: kgraphHostImports(store, memoryBox) };

const { instance } = await WebAssembly.instantiate(bytes, importObject);
memoryBox.memory = instance.exports.memory;

const written = instance.exports.main();
const heapBase = 2048; // kotoba.runtime/wasm-binary's heap-base for this module
const resultBytes = new Uint8Array(memoryBox.memory.buffer, heapBase, written);
const resultText = new TextDecoder('utf-8').decode(resultBytes);

let failed = false;
function check(cond, message) {
  if (!cond) {
    failed = true;
    console.error(`FAIL: ${message}`);
  } else {
    console.log(`OK: ${message}`);
  }
}

check(written > 0, 'kgraph_query wrote a real result into the guest buffer');
check(resultText === '[["Aoi"]]', `query result is [["Aoi"]] (got ${resultText})`);
check(
  store.length === 1 && store[0][0] === 1 && store[0][1].kw === 'name' && store[0][2] === 'Aoi',
  `store received the asserted datom (got ${writeEdn(store)})`
);

if (failed) process.exit(1);
console.log('OK: kgraph.js round-trips through a real native-WebAssembly-hosted module');
