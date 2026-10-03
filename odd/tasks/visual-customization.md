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
- [ ] T7 Record resolved browser blocker and verification evidence. In progress: verifier mus5wyc7-o-t37w executed11 scenarios PASS headlessChrome153 actualStrictMode with cachedplaywright-core,isolated profile/Vite localhost5188;mocked backend,no installs/livePi. Own server/browser stopped,temp files removed. Evidence documentation update pending verification/commit. No appearance console errors;20 MCP errors caused by null mock results. Deliberately delayed upload race/native busy-agent flow not executed in browser.
- [ ] T8 Verify Tauri desktop acceptance. Pending: WebView/CSP/windowcomposition/nativefilepicker; browser evidence is not native desktop evidence. No desktop runner check performed yet.

## Acceptance and verification
Preview never persists; confirm atomic; cancel/unmount restores saved appearance. Existing preferences survive. Wallpaper limits5MiBinput,16,777,216 pixels AFTERdecode BEFOREcanvas,1280pxoutput,1,048,576encodedcharacters;quota failures handled independently. Root/shared listener survives child unmount. No source behavior changed after full suite except EOF-only test whitespace.

## Evidence and corrections
Independent reviewers found and workers fixed legacy accent resurrection, StrictMode/render-purity faults, null clear fallback, global area CSS coupling, system palette mismatch, stale upload overwrites/stuck loading and untranslated processing errors, with regression tests. Initial browser CLI unavailable resolved using existing cached Playwright and installedChrome, without installs. Verifier diagnostic2>nul accidentally created literal nul underMSYS; parent inspected and removed only diagnostic artifact. Working and base-to-HEAD whitespace checks clean after70bce7b.

## Review workload
Feature delta exceeds9k lines including tests/docs; commits are logical units but large. No source compression to game review budget. Delivery splitting requires a separate decision before publishing; no push/PR/merge performed.

## Next step
Verify and commit runtime evidence/docs plus reconciled task tracking; close T7 only after evidence commit. T6 remains open while T8 desktop acceptance pending. Offer concrete next step for native checks; do not infer user acceptance.
