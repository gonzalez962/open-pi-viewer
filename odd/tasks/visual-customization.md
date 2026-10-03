# Visual Customization

## Objective
Adapt PR #28 visual functionality onto updated main without obsolete IPC/project changes.

## Scope and constraints
Presets, accent/text/label colors, five area backgrounds, wallpapers, work animation and preview/confirm/cancel. Preserve backend/project/session logic and Vite configuration. Single writer; no publishing. RDD explicitly disabled clone-local (global remains on). Base570c66521c180cc0548566ffc7afa987c0069c03; source theme34301aae832e77d2ea4e6a6d11667d532d8bba8c; branch feat/visual-customization.

## Tasks
- [x] T1 Prepare isolated baseline. Fresh main/clean branch; theme-only source surfaces inspected. Commit e19646e.
- [x] T2 Validate preferences and presets. Atomic persist-first appearance API, legacy migration and durable null accent marker;71 focused tests,8 architecture/build passing independently. Commit35406ad.
- [x] T3 Isolate preview lifecycle. Pure constructor, effect-owned restartable start/stop, stable ownership and system listener;60 focused tests independently passing. Actual browser StrictMode confirmed T7. Commit1d721ff.
- [x] T4 Integrate modular visual customizer. Scoped area CSS, explicit clear actions, system palette, EN/ES and sandbox;100 focused tests independently passing. Browser preview/save/cancel/reload/reset/system/area assertions PASS T7. Commitf2e2bab.
- [x] T5 Implement bounded wallpapers. Typed localized errors and synchronous intent/lifecycle generation cancellation;125 focused tests independently passing. Real browser FileReader/canvas, save/reload,invalid file,builtin/repeat/disable/clear PASS T7. Delayed upload races covered in deterministic tests, not browser stress. Commit3e61395.
- [ ] T6 Verify integration and document usage. Full1056/1056 tests(no skipped),architecture8/8,buildPASS; backend/IPC/Vite/project logic untouched. Docs/hygiene independently38tests/link/alignment/diffPASS;commit70bce7b. In progress: record browser evidence and synchronize final tracking. Native desktop acceptance pending T8; do not claim all checks complete.
- [x] T7 Record resolved browser blocker and verification evidence. Commitdc9a8d5; doc/readback and working/base whitespace checks PASS. Evidence: verifier mus5wyc7-o-t37w executed11 scenarios PASS headlessChrome153 actualStrictMode with cachedplaywright-core,isolated profile/Vite localhost5188;mocked backend,no installs/livePi. Own server/browser stopped,temp files removed. Evidence recorded in docs/appearance-customization.md; no browser or desktop claim beyond observed scenarios. No appearance console errors;20 MCP errors caused by null mock results. Deliberately delayed upload race/native busy-agent flow not executed in browser.
- [ ] T8 Verify Tauri desktop acceptance. Blocked runtime: verifier mus6x9x7-q-qc7y observed cargo check --manifest-path src-tauri/Cargo.toml PASS(exit0,18.57s),Rust/Cargo1.98.1;gitstatus unchanged only parenttracking. CSP statically allows inline styles/self/data/http/httpsimages. Native launch withheld: auto-discovery/connect may touch real Pi/sessions, no isolated native mock flag or WebViewdriver. Manual checklist recorded in docs. Native window/CSP/filepicker/composition NOT tested; T8 remains pending.

## Acceptance and verification
Preview never persists; confirm atomic; cancel/unmount restores saved appearance. Existing preferences survive. Wallpaper limits5MiBinput,16,777,216 pixels AFTERdecode BEFOREcanvas,1280pxoutput,1,048,576encodedcharacters;quota failures handled independently. Root/shared listener survives child unmount. No source behavior changed after full suite except EOF-only test whitespace.

## Evidence and corrections
Independent reviewers found and workers fixed legacy accent resurrection, StrictMode/render-purity faults, null clear fallback, global area CSS coupling, system palette mismatch, stale upload overwrites/stuck loading and untranslated processing errors, with regression tests. Initial browser CLI unavailable resolved using existing cached Playwright and installedChrome, without installs. Verifier diagnostic2>nul accidentally created literal nul underMSYS; parent inspected and removed only diagnostic artifact. Working and base-to-HEAD whitespace checks clean after70bce7b.

## Review workload
Feature delta exceeds9k lines including tests/docs; commits are logical units but large. No source compression to game review budget. Delivery splitting requires a separate decision before publishing; no push/PR/merge performed.

## Next step
Human/native-safe runtime acceptance required before closing T8 and T6: run documented manual checklist only with intentional local Pi discovery/connect, or separately authorize isolated native test infrastructure. Browser delayed-upload stress and live busy indicator remain explicit supplementary checks. No source expansion or user acceptance inferred; no publishing.
