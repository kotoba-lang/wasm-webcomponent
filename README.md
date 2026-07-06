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
- `test/verify-*.mjs` — dependency-free Node smoke tests (same
  `WebAssembly` engine — V8 — a Chromium browser uses) for each example.
  They check the AOT-execution / host-import claims only; they do not
  exercise `KotobaWasmElement`'s DOM/customElements path (no DOM in plain
  Node) — that needs a real browser, see `examples/*/index.html`.

## Run an example

```bash
cd examples/hello && python3 -m http.server 8123
# open http://localhost:8123/ in a browser
```

## Run the tests

```bash
node test/verify-hello.mjs
node test/verify-kgraph.mjs
node test/verify-gcd.mjs
```

## Scope (honest R0)

- **Only `kgraph-*` has a browser host-import port.** `kse`/`auth`/`llm`/
  `evm`/`btc`/`egress`/`chain` (referenced in the wider kotoba/kototama
  design docs) have none. A module calling any other `(module "kotoba")`
  import will fail to instantiate against this library today.
- **`kgraph.js`'s EDN reader/writer is intentionally minimal** — only the
  shapes the `kgraph-*` ABI carries (vectors, keyword-keyed maps, keywords,
  strings, integers, `?var` symbols), not general-purpose EDN.
- **No capability/policy re-enforcement at load time.** `kotoba wasm emit
  --policy`/`--package-lock` gates are build-time checks; nothing in this
  library re-verifies them when a module loads. Don't treat a page built
  on this library as a sandboxed multi-tenant host.
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
