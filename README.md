# kotoba-lang/wasm-webcomponent

A small, dependency-free library for hosting a `kotoba wasm emit` binary
([kotoba-lang/kotoba](https://github.com/kotoba-lang/kotoba)) as a browser
WebComponent, running it via the browser's own native `WebAssembly` engine
— already-AOT-compiled machine code, no interpreter, no JVM, no
`com.dylibso.chicory`, no wasmtime.

Extracted from [kotoba-lang/kototama](https://github.com/kotoba-lang/kototama)'s
original `web/` PoC (see
[ADR-2607061630](https://github.com/com-junkawasaki/root/blob/main/90-docs/adr/2607061630-kototama-browser-wasm-aot-webcomponent.md)
and its follow-up) so any repo can adopt the same pattern instead of
hand-rolling it. kototama's own `web/` now imports from here rather than
duplicating the code.

## Usage

Zero-import module:

```js
import { KotobaWasmElement } from './src/kotoba-wasm-element.js';
KotobaWasmElement.define('my-wasm-run');
```

```html
<my-wasm-run src="./my-module.wasm"></my-wasm-run>
<script type="module" src="./register-my-wasm-run.js"></script>
```

Module with host imports (e.g. `kgraph.js`'s `kgraph-*` ABI port):

```js
import { KotobaWasmElement } from './src/kotoba-wasm-element.js';
import { kgraphHostImports } from './src/kgraph.js';

KotobaWasmElement.define('my-kgraph-demo', {
  createImports(memoryBox) {
    const store = [];
    return { kotoba: kgraphHostImports(store, memoryBox) };
  },
  render(pre, { result, memoryBox }) {
    pre.textContent = `result: ${result}`;
  },
});
```

See `src/kotoba-wasm-element.js`'s header comment for the full `define()`
option surface (`exportName`, `createImports`, `render`).

Module using a runtime `(has-capability? :some/cap)` check (`has_capability`,
a single import distinct from `kgraph-*`'s effectful host calls):

```js
import { KotobaWasmElement } from './src/kotoba-wasm-element.js';
import { hasCapabilityHostImport } from './src/has-capability.js';

KotobaWasmElement.define('my-cap-demo', {
  createImports() {
    return { kotoba: hasCapabilityHostImport(['notify/show']) };
  },
});
```

Module using the `actor:host` ABI (`src/actor-host.js`'s port of
`kototama.contract`'s HostCaps/RuntimeLimits, `kototama-lang/kototama`'s
JVM tender's browser-side counterpart):

```js
import { KotobaWasmElement } from './src/kotoba-wasm-element.js';
import { actorHostImports, hostCaps, inMemoryStore } from './src/actor-host.js';

KotobaWasmElement.define('my-actor-host-demo', {
  createImports(memoryBox) {
    const store = inMemoryStore();
    const caps = hostCaps({ grants: ['clock-monotonic', 'sha256-hex'] });
    return { kotoba: actorHostImports(['clock-monotonic', 'sha256-hex'], caps, memoryBox, { store }) };
  },
});
```

## Files

- `src/kotoba-wasm-element.js` — `KotobaWasmElement`, the reusable custom
  element base / factory. Fetches `src`, runs
  `WebAssembly.instantiateStreaming`, calls the named export (default
  `main`), renders the result into shadow DOM, and dispatches
  `kotoba-wasm:done`/`kotoba-wasm:error` events.
- `src/kgraph.js` — optional: a browser-side port of `kotoba-lang/kotoba`'s
  `src/kotoba/kgraph.clj` (pure in-memory EAVT datom store) plus a minimal
  EDN reader/writer for the `kgraph-*` host-import wire ABI's two shapes.
  Only pull this in if your module actually calls `kgraph-assert!`/
  `kgraph-query`/etc.
- `examples/hello/` — zero-import module (`kotoba wasm emit src/demo.kotoba`,
  73 bytes, `main()` returns 42).
- `examples/kgraph/` — a module using the `kgraph-*` host imports
  (`kotoba wasm emit src/demo_kgraph.kotoba --policy src/demo_kgraph_policy.edn`,
  219 bytes).
- `examples/gcd/` — a brand-new `.kotoba` program (`gcd.kotoba`, included)
  demonstrating real runtime recursion (the Euclidean algorithm), not a
  hardcoded constant or a compile-time-folded computation. Compiled with
  `kotoba wasm emit gcd.kotoba --package-lock <empty-deps-lock>` (96 bytes;
  see kotoba-lang/kotoba#284 for why an empty-deps lock is needed for a
  zero-dependency build).
- `src/has-capability.js` — optional: a browser-side port of
  `kotoba-lang/kotoba`'s `has_capability` host import
  (`kotoba.wasm-exec/has-capability-fn`), for modules with a runtime
  `(has-capability? :some/cap)` check (as opposed to the static
  compile-time gate `kotoba wasm emit --policy` already applies). The
  id-to-capability-name table is copied from the canonical
  `kotoba-lang/kotoba-core-contracts` `capability_contract.edn` (this
  library has no Clojure runtime to read that EDN file from directly).
- `examples/cap/` — `demo_cap.kotoba` (a runtime `has-capability?` check)
  instantiated twice with the same bytes: once granting `notify/show`
  (`main()` → 7) and once denying everything (`main()` → 0) — proves the
  check is real per-instantiation policy, not a stub that always answers
  one way.
- `src/actor-host.js` — a browser-side port of `kotoba-lang/kototama`'s
  `kototama.contract` (`actor:host` ABI: `HostCaps`/`RuntimeLimits`/
  `validateImportSurface`, same fail-closed pre-flight + per-call grant
  checks as `kototama.tender`, the JVM/Chicory counterpart). Implements
  7 of the 8 `actor:host` imports (`clock-monotonic`/`sha256-hex`/`gen-keypair`/`sign`/
  `verify`/`log-read`/`log-write`) — only `http-post` is missing (see its
  header comment for why: `fetch` is real network I/O, not arithmetic, so
  unlike Ed25519 there's no synchronous-without-async version of it to
  write or vendor). Includes a hand-rolled, zero-dependency,
  test-vector-verified synchronous SHA-256 (Web Crypto's
  `crypto.subtle.digest` is async, unusable inside a synchronous host
  import) and vendors the real `@noble/curves` ed25519 for `gen-keypair`/
  `sign`/`verify` (see `src/vendor/README.md` — Ed25519 signing is pure
  arithmetic, not I/O, so it doesn't need `SubtleCrypto`'s async API, but
  it's real elliptic-curve math not worth hand-rolling from scratch the
  way SHA-256 is).
- `src/vendor/` — the actual, unmodified `@noble/curves`/`@noble/hashes`
  source files `actor-host.js`'s ed25519 imports need, copied file-for-file
  (not hand-transcribed) with only bare-specifier import paths patched to
  relative — see `src/vendor/README.md` for the exact file list, versions,
  and why vendored rather than CDN-imported (Node's default ESM loader
  refuses `https:` specifiers, which would break `node test/verify-*.mjs`).
- `examples/actor-host/` — hand-assembled (`wasm-tools`) modules wired to
  `actor-host.js`: `actor-host-demo.wasm` (`clock_monotonic`/`log_write`/`sha256_hex`)
  and `crypto-demo.wasm` (`gen_keypair`/`sign`/`verify` — same fixture
  shape `kototama.tender`'s (JVM) `tender_test.clj` compiles via
  `wasm-tools`).
- `src-cljs/kotoba/kami_engine_host.cljs` / `src/kami-engine-host.js` — a
  port of `kotoba-lang/kami-script-runtime-rs` (the Rust/wasmtime WASM host
  for `kotoba-lang/engine`-compiled `.clj` game scripts), **authored in
  ClojureScript and compiled once via `shadow-cljs.edn`'s `:kami-engine-host`
  build (`:target :esm`) to `src/kami-engine-host.js`** — see
  ADR-2607078000 for why this module (unlike this repo's other, hand-JS
  modules below) takes a build step: one compiled ES module runs
  identically in a browser `<script type="module">` and in Node, instead
  of separate per-platform hand-ports. Run `npm install && npm run
  compile:kami-engine-host` to regenerate `src/kami-engine-host.js` from
  the `.cljs` source (the compiled output is checked in, so consumers don't
  need shadow-cljs unless they're changing the source). Wires all 14
  `kami:engine/*` host-imports (`bind_scene`/`bind_input`/`bind_random`/
  `bind_time`, across 4 WASM import modules: `kami:engine/scene@1.0.0`,
  `/input`, `/random`, `/time`) and drives the guest's `init`/`<name>-tick`
  lifecycle against a minimal in-memory ECS store — same semantics as the
  Rust `KamiHost`, ported 1:1 (entity spawn/despawn/position/velocity, tag
  queries, nearest/move-toward, xorshift64 random, fixed-step Euler
  integration, export-section `-tick`-suffix ordering). Exports
  `createKamiEngineHost(seed)` (a factory returning a plain JS object with
  `imports`/`setAxis`/`attach`/`callInit`/`tick`/`entityCount`/
  `taggedCount`/`debugDump` methods — not a JS `class`) and
  `orderedTickExports(wasmBytes)`. Unlike this library's other modules
  (single `(module "kotoba")` ABI), this one targets `kami-script-runtime-
  rs`'s existing 4-namespace import shape directly, since the goal is
  running the exact same compiled `game.wasm` a Rust host runs, not a new
  ABI.
- `examples/kami-engine-host/` — `isekai-network-01-netsurvivors.wasm`
  (the same fixture `kami-script-runtime-rs/tests/fixtures/` ships) driven
  for 300 ticks via `requestAnimationFrame` (real-browser confirmation
  outstanding — see ADR-2607078000's Consequences).
- `src-cljs/kotoba/gpu_clear_host.cljs` / `src/gpu-clear-host.js` — ADR-
  2607078000 Track B **Phase 0**: the browser host for the `gpu-clear`
  capability, the first proof that a compiled `.kotoba` guest can drive a
  real WebGPU canvas clear through a genuinely synchronous Wasm
  host-import (no JSPI / `Atomics.wait` bridge needed — `requestAdapter`/
  `requestDevice` are the only async WebGPU calls, and they run once,
  host-side, before the guest ever executes). Wire format:
  `gpu_clear(rgba8: i32) -> i32`, a packed `0xRRGGBBAA` color. Exports
  `setupGpuClearHost(canvas)` (async, one-time device/context setup) and
  `unpackRgba8` (the pure signed-i32→`[r,g,b,a]` bit-unpacking logic,
  public specifically so it's unit-testable without a GPU — see
  `test/verify-gpu-clear-host.mjs`). Regenerate via `npm run
  compile:gpu-clear-host` / `release:gpu-clear-host`.
- `examples/gpu-clear/` — `demo_gpu_clear.kotoba`/`.wasm` (a `.kotoba`
  guest that calls `gpu_clear` with a packed color) + `index.html`,
  browser-verified against `setupGpuClearHost` end to end.
- `src-cljs/kotoba/solar_render_host.cljs` / `src/solar-render-host.js` —
  ADR-2607078000 Track B **Phase 1**: the browser host for
  `gpu-set-position`/`gpu-draw-frame`, rendering `kami-solar-helix-scene`'s
  9 bodies (Sun + 8 planets) as spheres. The guest (compiled from
  `demo_solar_helix.kotoba`) computes each body's position every frame via
  real `cos`/`sin` host-imports and calls `gpu-set-position(body-id, x, y,
  z)` once per body, then `gpu-draw-frame()` once — all matrix/camera/
  pipeline/mesh mechanics stay host-side, since `.kotoba` has no vector/
  matrix type. One dedicated uniform buffer + bind group per body (9
  total, not one shared buffer) — `queue.writeBuffer` runs immediately but
  `pass.drawIndexed` only records until `queue.submit()`, so a single
  shared buffer written 9× before any draw executes would leave every draw
  referencing only the last write. Exports `setupSolarRenderHost(canvas)`
  plus its pure mat4/vec3/mesh helpers (`mat4Multiply`/`mat4Perspective`/
  `mat4LookAt`/`mat4TranslationScale`/`vec3Normalize`/`vec3Sub`/
  `vec3Cross`/`vec3Dot`/`buildSphereMesh`), public specifically so they're
  unit-testable without a GPU — see `test/verify-solar-render-host.mjs`.
  Regenerate via `npm run compile:solar-render-host` /
  `release:solar-render-host`.
- `examples/solar-helix/` — `demo_solar_helix.kotoba`/`.wasm` (the 9-body
  orbital-math guest, using `.kotoba`'s real `f32` support — `kotoba-lang/
  kotoba`'s compiler gained native f32 params/locals/results/comparisons
  for this) + `index.html`, browser-verified: all 9 bodies render in
  frame, matching `kami-solar-helix-scene`'s already-tested physics
  (pitch-to-circumference ratio ~7.4x/~16.8x).
- `test/verify-*.mjs` — dependency-free Node smoke tests (same
  `WebAssembly` engine — V8 — a Chromium browser uses) for each example.
  They check the AOT-execution / host-import claims only; they do not
  exercise `KotobaWasmElement`'s DOM/customElements path (no DOM in plain
  Node) — that needs a real browser, see `examples/*/index.html`.
  `verify-kami-engine-host.mjs` specifically is the parity proof for
  retiring `kami-script-runtime-rs`'s Rust runtime role: it drives the same
  fixture for the same 300 ticks and asserts the exact same entity counts
  (`entities=16 shiro-pico=1 ghost=14 beat-spark=1`) that crate's own README
  documents from a real `cargo run`/wasmtime execution.
  `verify-gpu-clear-host.mjs`/`verify-solar-render-host.mjs` exercise the
  pure, GPU-free logic behind Phase 0/Phase 1 (bit-unpacking, mat4/vec3
  math, sphere-mesh generation) directly — the actual WebGPU draw path in
  both modules still needs a real browser to verify (see `examples/gpu-
  clear/index.html`/`examples/solar-helix/index.html`).

## Run an example

```bash
cd examples/hello && python3 -m http.server 8123
# open http://localhost:8123/ in a browser
```

Every `test/verify-*.mjs` in this repo confirms the underlying `WebAssembly`
execution and host-import logic against Node's own engine (the same V8 a
Chromium browser uses) — but none of them drive an actual DOM/
`customElements` render in a real browser tab. That gap is a real,
outstanding limitation of this test suite, not just an unverified claim:
an agent working in a sandboxed automation environment tried to close it
and hit tooling dead ends worth recording so the next attempt doesn't
repeat them:
- A local `python3 -m http.server` in a sandboxed shell was unreachable
  from the browser-automation tool's actual Chrome process (separate
  network namespaces) — `file://` and `data:` URLs were also blocked
  outright by that tool.
- jsdelivr's GitHub proxy (`cdn.jsdelivr.net/gh/...`) serves `.js` files
  with the correct `application/javascript` type (fine for `import()`),
  but serves `.html` as `text/plain; charset=utf-8` with `nosniff` — a
  browser will not render it, only display it as text.
- `htmlpreview.github.io` does serve proxied GitHub HTML as real
  `text/html` and a page's own `<title>`/DOM genuinely renders through
  it — but its own `htmlpreview.js` reinjects `<script>` tags in a way
  that drops `type="module"`, so a page using `<script type="module">`
  (this library's own convention) fails there with `Cannot use import
  statement outside a module`. A page using dynamic `import()` from a
  classic `<script>` avoids that specific error, but produced an
  unexplained rendering artifact worth a fresh investigation rather than
  more workarounds layered on unrelated third-party proxies.
- None of the above says anything about a real, un-sandboxed browser
  (a developer's own Chrome hitting a real `python3 -m http.server`)  —
  only that this particular sandboxed session's tooling chain couldn't
  reach one. Do this from an environment where the browser and the
  static server actually share a network first.

## Run the tests

```bash
npm test   # runs every test/verify-*.mjs in sequence, stops on first failure

# or individually:
node test/verify-hello.mjs
node test/verify-kgraph.mjs
node test/verify-gcd.mjs
node test/verify-cap.mjs
node test/verify-actor-host.mjs
node test/verify-kami-engine-host.mjs
node test/verify-gpu-clear-host.mjs
node test/verify-solar-render-host.mjs
```

## Scope (honest R0)

- **`kgraph-*`, `has_capability`, and 7 of 8 `actor:host` imports have a
  browser host-import port.** `kse`/`auth`/`llm`/`evm`/`btc`/`egress`/
  `chain` (referenced in the wider kotoba/kototama design docs) have none,
  and neither does `actor:host`'s `http-post` (see `src/actor-host.js`'s
  header comment — `fetch` is real network I/O, so a synchronous Wasm host
  import can't perform it without either JS Promise Integration, which
  isn't broadly shipped across engines yet, or a SharedArrayBuffer+
  `Atomics.wait` bridge, which needs COOP/COEP response headers this
  library's plain-static-file deployment model doesn't assume). A module
  calling any other `(module "kotoba")` import will fail to instantiate
  against this library today.
- **`has-capability.js` re-states a policy at load time, it doesn't
  re-derive one.** The granted-capabilities list you pass to
  `hasCapabilityHostImport` is trusted input from the page author, not
  cryptographically verified against anything — it's the browser-side
  equivalent of the JVM's `:kotoba.policy/capabilities` map, not a
  replacement for `kotoba wasm emit --policy`'s compile-time gate.
- **`kgraph.js`'s EDN reader/writer is intentionally minimal** — only the
  shapes the `kgraph-*` ABI carries (vectors, keyword-keyed maps, keywords,
  strings, integers, `?var` symbols), not general-purpose EDN.
- **`kgraph.js` has no capability/policy re-enforcement at load time**
  (`kotoba wasm emit --policy`/`--package-lock` gates are build-time
  checks only). `actor-host.js` is the exception: it DOES re-verify
  `HostCaps`/`RuntimeLimits` at load time (pre-flight, before
  `WebAssembly.instantiateStreaming` runs) and per host-function call —
  but only for the 4 imports it implements. Don't treat a page built on
  this library as a sandboxed multi-tenant host in general.
- **Not every kotoba-lang repo has `.kotoba` source to point this at.**
  Most `kotoba-*`-named repos in the org (`lint-kotoba`, `kotoba-code`,
  `kotoba-procedure-clj`, ...) are regular `.cljc`/`.clj` Clojure libraries
  using language features (maps, `require`, third-party deps) well beyond
  `.kotoba`'s minimal subset (no maps, no interop, no third-party libs) —
  pointing this library at them requires rewriting their logic in that
  subset first, not just recompiling existing source. `examples/gcd/`
  demonstrates writing something new in the subset rather than pretending
  an existing repo "just becomes" a WASM WebComponent.

## License

MIT.
