# ODD agent indicators

## Objective and scope
Deliver Issue #22 semantic left-aligned delegation indicators, inspired by deimerjr PR #29. Preserve intra-message grouping, category controls and appearance. Orchestrator requires explicit delegation; unknown targets retain identity; labels describe dispatch, never inferred background completion. No Issue #31 cards, bridge, folder picker or appearance redesign.

## Delivery decision
User authorized commits and publication of two stacked PRs, with size exceptions, on 2026-10-03. Foundation targets main; UI targets foundation. No tracker needed: foundation is independently landable pure extraction API and tests. No merges, force pushes or deletion of original PR #29 authorized. Each PR credits deimerjr and links #22; UI closes #22 after parent integration. Both slices exceed400; one cohesive splitting pass retained tests/comments.

## Tasks
- [x] T1 — Foundation commit ab83dfb (631 changed lines), UI commit7e25934 (449 changed lines), both verified on integrated candidate.
- [x] T2 — Standalone foundation independently verified: helper13, full1078, architecture8, build and diff check pass. Integrated UI: full1086, focused80, architecture8, build and browser pass. Evidence recorded in this document.
- [x] T3 — Published #50 foundation -> main and #51 UI -> foundation, with credit, type:feature and accepted size exceptions; verified bases/heads and clean slice counts. Evidence-document commit accompanies UI.

## Acceptance and observed evidence
- Exact dispatch detection excludes query/control/messaging tools; strict known-role classification; malformed JSON rejected safely.
- Dispatching/Dispatched/Dispatch failed accurately describe invocation evidence; no background completion claims.
- Existing tests preserved, Orchestrator only on delegation, localized accessible labels and reduced motion.
- Initial classification and narrow-layout defects corrected with observed RED/GREEN regressions.
- Final independent verification: full1086 passed (0 failures/skips), focused80 passed, architecture8 passed, build succeeded (202 modules), diff check clean.
- Browser: isolated actual React component/CSS harness, NOT real Pi E2E. At320px long unknown label fully wraps; card/header/pill scrollWidth equals clientWidth. Multiple roles/counts, category controls,1280px layout and reduced-motion verified. Own server/browser/temp artifacts cleaned.
- RDD clone-local off. Native assess unavailable due untracked declaration; conservative independent verification performed. Earlier verifier timeout was not counted as success.

## Rollback and boundaries
Foundation rollback removes helper and helper tests only. UI rollback removes additive rendering/styles/locales/component regressions without changing grouping. Foundation previous boundary main a64b5ce; UI previous boundary foundation commit to record below. Verification evidence document belongs with UI delivery; its lines increase second PR review budget and must be reported honestly.

## Next step
PR #50: https://github.com/gonzalez962/open-pi-viewer/pull/50 (+631/-0,2 files). PR #51: https://github.com/gonzalez962/open-pi-viewer/pull/51 (UI +445/-4,5 files before this evidence document). Issue22 status:approved recorded from human implementation approval; each PR type:feature. No remote checks registered at publication; local results are not CI. Follow-up: human reviews/merges #50 first, then retarget/reconcile #51 to main with UI-only diff, especially after squash. No merge performed. Evidence document adds review lines to #51, update published count after push.
