# Shared client runtime: recovered source candidate

Tracking: [JUN-14](https://linear.app/kotobalabs/issue/JUN-14).

This recovery is presented as a draft stacked on the legacy-CI retirement
[PR #25](https://github.com/kotoba-lang/wasm-webcomponent/pull/25). That
retirement's main merge is waiting for explicit human approval after an
automatic approval-review rejection. Keep both changes unmerged while that
approval is pending; the stacked recovery does not bypass the hold.

## Provenance

The canonical `src/kotoba-client-runtime.js` was absent from main at
`8ae8c5b412c9a37238b4a4330e5b57e0f27fa8c4`. Previous work on
`codex/client-first-runtime-host-20261016` and
`codex/client-runtime-v1-20261018` had left it uncommitted. The old worktree
registrations and branches were preserved.

The recovered file is the final source recorded by task
`01a14237-be01-73e0-b3cf-4febdf461bf1`: source snapshots followed by its final
two source patches, without executing any archived command. It is 29,517
bytes / 677 lines, SHA-256
`9b1c7984ca18b596b30e1c2b8f1ee3d0c3d82e1f0dd698483bc1ca934665e40a`.
That digest matches the task's final recorded source digest. Recovery retains
the implementation exactly, including its comments and API names. No old
test harness or generated app bundle was recovered into this change.

This module is browser host code, permitted by the shared end-user app
architecture contract. It does not provide a Node, Clojure, JVM or C execution
path for Amu selfhost, compiler builds or CDCI.

## Recovered surface

| Export | Purpose |
| --- | --- |
| `clientRuntimeProblems` | Validate the descriptor, local state, Workers, service operations and requested capabilities |
| `clientEndpointAllowsRequest` | Match concrete HTTPS method, path and query scope |
| `effectiveClientOperations` | Intersect declared operations, local host eligibility and host-supported selectors; empty by default |
| `createClientOperationBroker` | Snapshot requests, request confirmation for each invocation and dispatch a declared service adapter |
| `clientRuntimeConnectSrc` | Derive `connect-src` from declared service and redirect origins |
| `applyOfflineClientPolicy` | Add a restricting document policy for a local session |
| `CLIENT_INFERENCE_PROTOCOL` | Name `kotoba.inference.v1` |
| `clientInferenceRequestProblems`, `clientInferenceEventProblems` | Validate inference Worker messages |
| `createClientInferenceRequest`, `createClientInferenceEvent` | Construct schema-checked inference messages |

The recovered `approvedOperations` input is a host eligibility filter. It
cannot replace fresh consent for an invocation. A `load` inference message
carrying that field also grants no external request or inference authority.

## Open integration and qualification work

This file is a source candidate. Do not call a product integrated on the
strength of its existence or its recovery digest.

| Requirement | Current candidate and remaining work |
| --- | --- |
| Trusted user choice | The broker delegates to a caller-supplied `confirmOperation`. A trusted host must own the broker, eligibility, service adapters and consent UI, bind the user's direct choice to the shown request, and expose only bounded invocation to guests. An app/bot-supplied callback that returns `true` does not qualify. This module is not a sandbox for arbitrary same-realm JavaScript. |
| Browser-native side effects | The recovered schema and broker handle HTTPS requests. They do not declare or broker APIs such as `PushManager.subscribe()` / `unsubscribe()`. Add shared, host-supported browser-operation declarations and fresh consent before integrating these features. Browser permission and subsequent service requests each remain separate operations. Do not fill this gap with a product-local consent gate. |
| Exact request and redirects | Source checks method/path/query, snapshots before consent, omits ambient credentials, rejects undeclared redirects and verifies a Fetch response's final origin. Adapters must consume that exact snapshot without widening scope. Confirm actual permitted/denied browser traffic and redirect behavior before qualification. |
| Artifact admission | This module does not verify source signatures, immutable source revisions or artifact digests. The trusted artifact verifier must do so before execution. Missing expected digests keep the relevant artifact unverified. |
| Product builders | No Aozora, Itonami, Murakumo or other builder has been established here to import/copy this exact canonical module. Reconcile each builder and record its canonical source revision and bytes. |
| Static delivery and CSP | The helper renders `connect-src`, not a complete published CSP or a deployment. Inspect the complete static response headers and app-origin route inventory separately. |
| Runtime evidence | No test, project build, browser operation, inference, native compile or deployment was run for this recovery. No runtime qualification is claimed. |

Source recovery does not authorize a production route change or stopping an
existing service. Complete the integration and release evidence first, then
obtain the separately required cutover approval.
