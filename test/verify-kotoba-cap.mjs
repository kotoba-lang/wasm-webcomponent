// Amu wasm32-kotoba-v1 guests import kotoba:cap/call (i64,i64)->i64.
// This is a different plane from actor:host (module "kotoba"). Capability
// 7 is clock/now under the :clock-monotonic grant; any other id is
// fail-closed. Mirrors kototama.tender's always-linked cap-call-host-fn.
// Run: `node test/verify-kotoba-cap.mjs`
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  hostCaps,
  kotobaCapImports,
  amuCompileImports,
  KOTOBA_CAP_MODULE,
  CLOCK_NOW_CAPABILITY_ID,
} from '../src/actor-host.js';

let failed = false;
function check(cond, message) {
  if (!cond) {
    failed = true;
    console.error(`FAIL: ${message}`);
  } else {
    console.log(`OK: ${message}`);
  }
}

const wat = `(module
  (import "kotoba:cap" "call" (func $cap (param i64 i64) (result i64)))
  (func (export "main") (result i64)
    (call $cap (i64.const 7) (i64.const 0))))
`;

const dir = await mkdtemp(path.join(tmpdir(), 'kotoba-cap-'));
const watPath = path.join(dir, 'clock-now.wat');
const wasmPath = path.join(dir, 'clock-now.wasm');
await writeFile(watPath, wat);
const parsed = spawnSync('wasm-tools', ['parse', watPath, '-o', wasmPath], { encoding: 'utf8' });
if (parsed.status !== 0) {
  console.error(`wasm-tools parse failed: ${parsed.stderr || parsed.error}`);
  process.exit(1);
}

const bytes = await (await import('node:fs/promises')).readFile(wasmPath);

{
  const before = Date.now();
  const caps = hostCaps({ grants: ['clock-monotonic'] });
  const { instance } = await WebAssembly.instantiate(bytes, {
    [KOTOBA_CAP_MODULE]: kotobaCapImports(caps),
  });
  const n = instance.exports.main();
  const after = Date.now();
  const millis = typeof n === 'bigint' ? Number(n) : n;
  check(millis >= before && millis <= after, `granted clock/now returns host millis (got ${millis})`);
}

{
  const caps = hostCaps({ grants: [] });
  const { instance } = await WebAssembly.instantiate(bytes, {
    [KOTOBA_CAP_MODULE]: kotobaCapImports(caps),
  });
  let denied = false;
  try {
    instance.exports.main();
  } catch (e) {
    denied = /host import denied/.test(e.message);
  }
  check(denied, 'missing :clock-monotonic grant is fail-closed at the call');
}

{
  const unknownWat = `(module
  (import "kotoba:cap" "call" (func $cap (param i64 i64) (result i64)))
  (func (export "main") (result i64)
    (call $cap (i64.const 4) (i64.const 0))))
`;
  const uWat = path.join(dir, 'unknown.wat');
  const uWasm = path.join(dir, 'unknown.wasm');
  await writeFile(uWat, unknownWat);
  const uParsed = spawnSync('wasm-tools', ['parse', uWat, '-o', uWasm], { encoding: 'utf8' });
  if (uParsed.status !== 0) {
    console.error(`wasm-tools parse failed: ${uParsed.stderr || uParsed.error}`);
    process.exit(1);
  }
  const uBytes = await (await import('node:fs/promises')).readFile(uWasm);
  const caps = hostCaps({ grants: ['clock-monotonic'] });
  const { instance } = await WebAssembly.instantiate(uBytes, {
    [KOTOBA_CAP_MODULE]: kotobaCapImports(caps),
  });
  let denied = false;
  try {
    instance.exports.main();
  } catch (e) {
    denied = /host import denied/.test(e.message);
  }
  check(denied, 'unknown cap id 4 is fail-closed even when clock is granted');
}

{
  const caps = hostCaps({ grants: ['clock-monotonic'] });
  const imports = amuCompileImports(['clock-monotonic'], caps, {});
  check(typeof imports.kotoba.clock_monotonic === 'function', 'amuCompileImports still links actor:host clock');
  check(typeof imports[KOTOBA_CAP_MODULE].call === 'function', 'amuCompileImports always links kotoba:cap/call');
  check(CLOCK_NOW_CAPABILITY_ID === 7n, 'clock/now wire id is 7');
}

if (failed) process.exit(1);
console.log('OK: kotoba:cap/call hosts clock/now and fail-closes everything else');
