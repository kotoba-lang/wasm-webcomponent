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
- `src-cljs/kotoba/kami_ecs.cljs` / `src/kami-ecs.js` — the browser/Node
  host for `kotoba-lang/kotoba`'s `kotoba.kami-host` (the deterministic
  game-engine ECS behind the `kami-*` host imports, kotoba-core-contracts
  `"kami/engine"` id 233, single `(module "kotoba")` ABI — NOT
  `kami-engine-host.js`'s 4-namespace `kami:engine/*` shape). **Authored
  in ClojureScript** (like `kami-engine-host.js`, unlike this repo's
  hand-JS modules — it replaced an earlier hand-JS port): the portable
  `.cljc` ECS itself is `src-cljs/vendor/kotoba/kami_host.cljc`, VENDORED
  file-for-file from `kotoba-lang/kotoba` (the `src/vendor` ed25519
  convention; provenance sha in its header) so ONE source serves kotoba's
  JVM compat suite, its nbb parity script, and this ESM — no drift.
  Host-owned entity table, fixed-step Euler integration (1/60s), tick
  counter, input axes, and a seeded 32-bit-pair xorshift64, bit-identical
  on every runtime — the same compiled game plays the same run here that
  kotoba's `kami_game_test.clj` pins on Chicory. Exports
  `createKamiEcs(seed)` and `kamiHostImports(ecs, memoryBox)`; regenerate
  with `npm run release:kami-ecs` (the compiled output is checked in).
- `examples/kami-survivors/` — `kami-survivors.wasm` (compiled by the real
  `kotoba wasm emit` from `kotoba-lang/kotoba`'s
  `src/kami_survivors.kotoba` — **the first game authored directly in a
  `.kotoba` file**) driven at a fixed step per `requestAnimationFrame`
  frame, rendered on a canvas, with arrow keys/WASD wired to the
  host-owned `MoveX`/`MoveY` axes. `test/verify-kami-survivors.mjs` is the
  parity proof: the same 300-tick run asserts the exact entity counts
  (`12` at tick 240, `8` after the tick-270 nova burst, `10` at 300,
  seed 7) kotoba's own JVM/Chicory test pins.
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
  for this) + `index.html`. `main` is called again every
  `requestAnimationFrame` tick (real animation, not a single static
  frame); each call reads a host-owned, wrapped simulated day count
  (`now-days`) and a host-owned heliocentric/galactic view toggle
  (`galactic-frame?`, wired to a page checkbox) instead of a fixed t.
  Galactic view ports `kami-solar-helix-scene`'s
  `galactic-frame-position-au` 1:1 (orbital-plane tilt + the Sun's own
  forward drift). Verified rendering correctly in both view modes three
  independent ways: interactive real-browser screenshots (page load and
  immediately after toggling), a headless real-GPU CI check
  (`test/render/verify-render-solar-helix.mjs`, exact landmark positions
  and colors for both a heliocentric and a galactic-frame frame), and a
  GPU-free numerical sweep of the guest's own math across the entire
  `now-days` range (`test/verify-solar-helix-guest.mjs`). Sustained
  multi-second *live* animation showed intermittent blank-canvas behavior
  in one sandboxed browser-automation session that root-caused to that
  session's own repeated WebGPU device/canvas creation, not the guest or
  host code — see the "Run an example" section below for the full
  account of that investigation.
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
  math, sphere-mesh generation) directly. The actual WebGPU draw path (pipeline
  creation, bind groups, `queue.submit` timing, the real rendered pixels) is
  no longer a human-only check — see `test/render/` and "Automated render
  verification" below.
  `verify-solar-helix-guest.mjs` separately sweeps `demo_solar_helix.wasm`'s
  own computed positions (no GPU, no browser) across the full `now-days`
  wrap range in both view modes (finite, bounded, correctly-signed) — the
  guest-math half of the animation-toggle investigation in "Run an
  example" below, made a permanent regression check.
- `test/render/verify-render-gpu-clear.mjs` / `test/render/verify-render-solar-helix.mjs`
  — real-pixel CI verification of `examples/gpu-clear`/`examples/solar-helix`'s
  actual WebGPU draw path via a real headless browser (not a human with
  claude-in-chrome). See "Automated render verification" below for what was
  investigated, what these assert, and what's still out of scope.
- `test/render/lib/webgpu-harness.mjs` / `test/render/lib/png-decode.mjs` —
  shared, dependency-free (beyond the `playwright` devDependency itself)
  helpers the two tests above use: a plain-Node static file server, a
  Playwright launch helper that resolves the full (non-headless-shell)
  Chromium binary, and a from-scratch PNG decoder (Node's built-in `zlib`
  only) to read back actual pixel bytes from a canvas screenshot.

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

### `examples/solar-helix/`'s sustained-animation verification gap

Same spirit as the gap above, recorded for the same reason (so the next
attempt doesn't repeat the investigation from scratch): a real-browser
GitHub Pages check confirmed `examples/solar-helix/` renders correctly —
9/9 bodies, correct colors/positions — both at page load (heliocentric)
and immediately after toggling the galactic-frame checkbox. But letting
the page's own `requestAnimationFrame` loop run for several sustained
seconds sometimes produced a solid-black canvas afterward, in both view
modes, with `main()` still returning `0` (success) and the frame counter
still advancing — i.e. the guest was still running successfully, but
nothing visible was being drawn.

Investigation before concluding this isn't a code defect:
- `test/verify-solar-helix-guest.mjs` sweeps the guest's own computed
  positions across the *entire* `now-days` wrap range in both view
  modes via Node's native `WebAssembly` (no GPU) — every value is
  finite, bounded, and correctly signed. The same sweep was independently
  re-run through `com.dylibso.chicory` (a real, different WASM engine)
  from `kotoba-lang/kotoba`'s own JVM test tooling with identical results.
  The guest math is not the problem.
- A dynamically created, DOM-attached `<canvas>` — set up and driven
  through the exact same `solar_render_host.cljs`-compiled host, in the
  same browser tab, after the page's own canvas had already gone
  black — rendered all 9 bodies correctly for hundreds of animated
  frames. The host/pipeline code is not the problem either, at least not
  in isolation.
- The failure was reproducible from a clean single-tab session with
  *no* other WebGPU activity beforehand, so it isn't purely an artifact
  of this investigation's own repeated `requestAdapter`/`requestDevice`
  calls in prior tabs (which was the first suspect, and did explain some
  — but not all — of the earlier flakiness observed while debugging).

Working conclusion, since strengthened to high confidence by the
automated-render-verification work below: this was browser/GPU-process-
level flakiness specific to the sandboxed browser-automation *tool* this
investigation used (repeated tab creation/navigation and manual
`requestAdapter`/`requestDevice` probing in the same Chrome instance),
not a bug in `demo_solar_helix.kotoba` or `solar_render_host.cljs`.
`test/render/verify-render-solar-helix.mjs` (see "Automated render
verification" below) drives the exact same compiled host/guest through a
freshly launched, real-GPU headless Chromium — no manual tab juggling,
no accumulated device churn — and passes cleanly for a full rendered
frame in *both* view modes, landmark-for-landmark, color-for-color. That
test is necessarily a single still frame per run (CI has no "watch it
animate for 30 seconds" primitive), so it doesn't directly re-run the
exact sustained-animation scenario above, but combined with the guest-math
sweep and the isolated-canvas recovery observed during the original
investigation, there are now three independent lines of evidence the
code itself is correct and zero evidence pointing at it specifically.
If a real, un-sandboxed browser left animating for an extended period
ever reproduces the blank-canvas symptom, the next place to look is
WebGPU device/resource lifecycle over a long `requestAnimationFrame` run
(e.g. whether `queue.submit`'s command buffers or bind groups need
explicit disposal this code doesn't do) — not the position math, which
is now regression-tested from two independent angles and ruled out.

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
node test/verify-kami-survivors.mjs
node test/verify-gpu-clear-host.mjs
node test/verify-solar-render-host.mjs
```

Real-pixel WebGPU render verification is a separate command (needs the
`playwright` devDependency + a downloaded browser, and — see below — a real
GPU to be meaningful):

```bash
npm install
npx playwright install chromium
npm run test:render   # runs every test/render/verify-*.mjs
```

## Automated render verification (real pixels, CI)

A prior maturity pass (ADR-2607078000 Addendum 7) gave `gpu-clear-host.cljs`/
`solar-render-host.cljs`'s pure math/mesh helpers unit coverage but explicitly
left one gap open: the actual WebGPU draw path (pipeline creation, bind
groups, `queue.submit` timing, the real rendered pixels — where both real
bugs Addendum 6 documents were actually found) had zero CI-runnable coverage
and needed a human with claude-in-chrome to eyeball a GitHub Pages screenshot
each time. `test/render/` closes that gap with real, automated, pixel-level
assertions.

**What was investigated: does headless WebGPU actually work?** Yes, but only
under specific conditions this repo's harness (`test/render/lib/webgpu-harness.mjs`)
now encodes:
- Playwright's *default* headless Chromium resolution is not always
  WebGPU-capable — on at least one platform tested here, the default
  `chromium.launch({ headless: true })` resolves to the stripped-down
  "headless shell" binary Playwright ships alongside the full Chromium
  build, which has no `navigator.gpu` at all. The fix is `chromium.executablePath()`
  (a public, version-independent Playwright API) passed explicitly as
  `executablePath` — this reliably resolves to the *full* Chromium/"Chrome
  for Testing" binary, which does have WebGPU, regardless of `headless`.
- `navigator.gpu` is only populated on a real `http(s)` origin, not on a
  fresh `about:blank` page — the harness always navigates before checking.
- **macOS: works reliably, no special launch flags needed.** Verified
  directly: `examples/gpu-clear` renders a pixel-perfect solid opaque-red
  canvas, and `examples/solar-helix` renders all 9 bodies at their expected
  positions with their expected colors (to within ~1-9 out of 255 per
  channel — see `verify-render-solar-helix.mjs`'s header comment for why
  that's expected to be this tight), matching this repo's own prior
  claude-in-chrome/GitHub-Pages screenshots.
- **Linux + SwiftShader software rendering: tested and found unreliable —
  not wired into CI.** A Docker container matching the `mcr.microsoft.com/playwright`
  image family, with `xvfb-run` + `--enable-unsafe-webgpu --enable-features=Vulkan
  --use-angle=swiftshader --ignore-gpu-blocklist` (the flag set another repo
  in this ecosystem's own investigation, `gftdcojp/network-isekai`'s
  `scripts/isekai/capture.clj`, uses), got as far as `navigator.gpu.requestAdapter()`/
  `requestDevice()` succeeding, but actual render-pass submission failed with
  `Instance dropped in popErrorScope` and produced a blank canvas. This
  matches this ecosystem's own prior, independent finding
  (`gftdcojp/network-isekai`'s ADR-0025: "headless WebGPU itself remains
  unavailable in this sandbox"). Given that, `render-verify`'s CI job targets
  `runs-on: macos-latest` (real Apple Silicon hardware, a working Metal-backed
  GPU process) instead of forcing an unreliable Linux/SwiftShader path.

**What the two tests actually assert** (not just "did it throw"):
- `verify-render-gpu-clear.mjs` — screenshots the canvas after the guest's
  `(gpu-clear -16776961)` call, decodes the PNG (`test/render/lib/png-decode.mjs`,
  a from-scratch decoder using only Node's built-in `zlib` — no image-decoding
  npm dependency), and asserts every sampled interior pixel is opaque red
  (`rgb(255,0,0)`, ±4 tolerance) — a real per-pixel color check.
- `verify-render-solar-helix.mjs` — samples 9 hand-verified landmark screen
  positions (one per body) and checks each against that body's *exact*
  expected peak-lit color. Those expected colors aren't fuzzy estimates:
  `solar_render_host.cljs`'s WGSL shader computes `lit = color.rgb * (0.35 +
  0.65*ndotl)`, so at a sphere's most directly-lit point (`ndotl == 1`),
  `lit == color` exactly — the raw `body-palette` value this repo's own
  source already defines. A real regression (wrong color, a missing body,
  or the buffer-aliasing bug reproducing) moves a landmark's measured color
  far past this test's tolerance, not by a couple of units. Landmark
  positions were picked over blob/connected-component detection specifically
  because Venus visually overlaps the Sun's disk at this render's fixed
  camera/t=45-day orbital phase — a real ambiguity for blind blob-counting,
  not a bug, that per-landmark sampling sidesteps entirely.

**Proof these actually discriminate pass/fail** (not just theoretically):
both of Addendum 6's real historical bugs were deliberately reintroduced
against a local worktree, rebuilt via `shadow-cljs release`, and confirmed to
fail the corresponding test before being reverted:
- Swapping the R/B channels in `gpu_clear_host.cljs`'s `clearValue` made
  `verify-render-gpu-clear.mjs` fail with every sampled pixel reading
  `rgb(0,0,255)` instead of `rgb(255,0,0)`.
- Reverting `solar_render_host.cljs`'s per-body uniform buffer/bind-group
  back to one shared buffer (the exact Addendum 6 bug) made
  `verify-render-solar-helix.mjs` fail on 8 of 9 bodies — only Neptune (drawn
  last) still rendered correctly, and the "distinct colors" check dropped
  from 9 to 2, exactly the failure signature Addendum 6 describes ("every
  draw referencing only the last write").

**What this still doesn't cover** (honest, not silently fixed): geometric/mesh
correctness beyond palette-color sampling (an entirely wrong mesh shape that
still happened to cover these same landmark pixels with the same color would
pass), camera-framing regressions too small to move a landmark color outside
its search window, and anything about `examples/kami-engine-host/`'s
`requestAnimationFrame`-driven tick loop (untouched by this pass — see its
own outstanding real-browser-confirmation gap above). `WEBGPU_RENDER_TEST_SKIP_IF_UNAVAILABLE=1`
lets these tests skip cleanly instead of failing red on a machine/CI runner
without a working WebGPU adapter (e.g. local Linux dev machines) — CI itself
does not set this, so a WebGPU regression on `macos-latest` fails loudly, not
silently.

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
