# Visual Customization

## Objective
Adapt PR #28 visual functionality onto current main without obsolete IPC/project changes.

## Scope and constraints
Theme presets, accent/text/label colors, five area backgrounds, wallpaper, work animation, preview/save/cancel. Preserve backend, project/session fixes, Vite ports and existing preferences. Single writer; no push or PR creation. RDD explicitly disabled clone-local; functional checks and risk-based independent verification still required. Base: 570c66521c180cc0548566ffc7afa987c0069c03. Source theme commit: 34301aae832e77d2ea4e6a6d11667d532d8bba8c. Branch: feat/visual-customization.

## Tasks
- [ ] T1 Prepare isolated integration baseline. In progress: fresh main fetched, clean feature branch created; confirm theme-only surfaces. Check: source delta and clean baseline. Commit: pending.
- [ ] T2 Implement validated appearance preferences and preset support. Tests: legacy data, invalid inputs, persistence/reset failures. Commit: pending.
- [ ] T3 Implement draft/preview/commit lifecycle and centralized style restoration. Tests: preview never persists, cancel/unmount restores saved values, system theme works. Commit: pending.
- [ ] T4 Integrate modular accessible translated customizer and real UI styling. Checks: render tests, architecture, build, functional UI. Commit: pending.
- [ ] T5 Implement bounded wallpaper processing and explicit error handling. Tests: safe URLs, size limits, invalid files, failed save, image settings. Commit: pending.
- [ ] T6 Verify complete integration and document usage/limitations. Checks: npm test, npm run check:arch, npm run build, browser preview/save/cancel/reload; desktop check if available. Preserve project/session regression tests. Commit: pending.

## Acceptance criteria
Only visual surfaces change. Existing preferences remain readable. Confirm persists atomically; cancel and unmount restore persisted appearance. Wallpaper failures do not destroy saved preferences. Translated keyboard-accessible controls. Checks and unavailable checks recorded honestly.

## Progress and evidence
RDD command: gentle-ai review mode disable --scope clone => off (clone_local), global remains on.
No functional checks executed yet. No source edits yet. Integration expected to exceed normal review budget; keep behavior-oriented work-unit commits, no compressed formatting to reduce line count.

## Next step
Finish T1 baseline inspection and commit tracking, then delegate T2 as bounded writer with test-first verification.
