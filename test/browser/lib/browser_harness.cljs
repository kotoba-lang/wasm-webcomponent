(ns lib.browser-harness
  "General-purpose (non-WebGPU) real-Chromium test harness for this repo's
  zero-build-step ES modules, run via nbb -- CLAUDE.md: new Node-side
  test/verification harnesses are written in nbb, not .mjs/.cjs. Ports the
  static-server + full-Chromium-launch technique
  test/render/lib/webgpu-harness.mjs established (ADR-2607078000 Addendum
  8, later ported to nbb in kotoba-lang/kami-app-amenominaka's
  test/render/lib/webgpu_harness.cljs) -- the *technique* is reused per
  that precedent, this is an independent (smaller) port, not a require of
  either existing file: actor-host.js exercises WASM host imports
  (crypto/clock/storage/network), not GPU, so there's no
  navigator.gpu/full-Chromium-build concern here, and no screenshot
  helper."
  (:require ["playwright" :refer [chromium]]
            ["node:http" :as http]
            ["node:path" :as path]
            ["node:fs/promises" :refer [readFile]]))

(def mime-types
  {".html" "text/html; charset=utf-8"
   ".js"   "text/javascript"
   ".mjs"  "text/javascript"
   ".wasm" "application/wasm"
   ".json" "application/json"})

(defn start-static-server
  "Serve `root-dir` over plain HTTP on an OS-assigned localhost port (no
  external dependency -- Node's own `http` module). Returns a Promise of
  `{:baseUrl :close}`."
  [root-dir]
  (js/Promise.
   (fn [resolve reject]
     (let [server
           (http/createServer
            (fn [req res]
              (-> (let [url-path (js/decodeURIComponent (first (.split (.-url req) "?")))
                        file-path (.join path root-dir url-path)]
                    (if-not (.startsWith file-path root-dir)
                      (do (.writeHead res 403) (.end res "forbidden") (js/Promise.resolve nil))
                      (-> (readFile file-path)
                          (.then (fn [data]
                                   (let [ext (.extname path file-path)]
                                     (.writeHead res 200 #js {"Content-Type" (get mime-types ext "application/octet-stream")})
                                     (.end res data)))))))
                  (.catch (fn [e]
                            (.writeHead res 404)
                            (.end res (str "not found: " (.-message e))))))))]
       (.on server "error" reject)
       (.listen server 0 "127.0.0.1"
                (fn []
                  (let [port (.-port (.address server))]
                    (resolve #js {:baseUrl (str "http://127.0.0.1:" port)
                                  :close (fn [] (js/Promise. (fn [r] (.close server r))))}))))))))

(defn with-headless-browser
  "Launch headless Chromium, run `(f browser)`, always close the browser
  afterward. Returns a Promise."
  [f]
  (-> (.launch chromium #js {:headless true})
      (.then (fn [browser]
               (-> (js/Promise.resolve (f browser))
                   (.finally (fn [] (.close browser))))))))

(defn wait-for-shadow-text
  "Wait until `selector`'s shadowRoot `<pre>` has non-empty textContent
  (KotobaWasmElement's connectedCallback creates an empty `<pre>`
  synchronously, then populates it once WebAssembly.instantiateStreaming +
  the guest call resolve -- polling current DOM state, not listening for a
  `kotoba-wasm:done` event, so this is race-free regardless of whether
  that already happened by the time this runs), then return it.

  `selector` is baked directly into the evaluated source (via
  `JSON.stringify`, so it's safely quoted) rather than passed as a
  separate Playwright `arg` -- Playwright only applies `arg` when
  `pageFunction` is a real Function value, not when it's a source string,
  so a string `pageFunction` given an `arg` silently ignores it. The
  `.evaluate` call is also an explicit IIFE (`(() => ...)()`), not a bare
  arrow-function string: passed as-is, `page.evaluate` treats a string as
  an *expression* to evaluate, and a bare `\"() => ...\"` expression
  evaluates to an (unserializable, silently-dropped-to-undefined) function
  VALUE rather than being called -- confirmed by a real crash this caused
  (`.includes` called on the resulting `undefined`)."
  ([page selector] (wait-for-shadow-text page selector 20000))
  ([page selector timeout]
   (let [sel (js/JSON.stringify selector)]
     (-> (.waitForFunction page
                            (str "() => { const el = document.querySelector(" sel ");"
                                 "const pre = el && el.shadowRoot && el.shadowRoot.querySelector('pre');"
                                 "return !!(pre && pre.textContent.length > 0); }")
                            nil #js {:timeout timeout})
         (.then (fn []
                  (.evaluate page
                             (str "(() => document.querySelector(" sel ").shadowRoot.querySelector('pre').textContent)()"))))))))
