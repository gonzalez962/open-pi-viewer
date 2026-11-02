# Mobile project attention toasts

Objective: Surface attention-worthy activity from other projects in a top mobile toast.
Branch: feat/mobile-project-attention-toasts
Trigger: risk item 4 (concurrent multi-project event streams); item 3 (shared event controller used by existing notifications).
Scope in: Mobile top toasts for completion, errors and waiting for user input across all sessions of other known projects, including connection/process errors; local dismissal and optional project navigation.
Scope out: Desktop/OS notification redesign, automatic project switching, new agent outcome heuristics, navigation to a specific session, changes to prior session-binding fix.
Rollback: Revert this feature's commits; no persistent data changes.
Success: Scenario-ID tests fail before implementation and pass afterward; existing event notifications remain compatible.
Base: aabe509f3f883298bf90bf19c48ab0ca541a9a9f
Delivery: auto-chain; chain_strategy=feature-branch-chain selected by user. Forecast approximately 420-520 authored lines excluding this specification. Review slices: A structured attention/controller+hook and controller tests; B mobile toast/App/locales/docs and component tests. Shared RED commit a512f5993e4cd52b5c46e9708600a2e5258b2411; no push or PR authorized.

## Expected files

- T1: `src/features/chat/session-events.ts`, `src/features/chat/hooks/useSessionEvents.ts`, `src/app/App.tsx`, `src/app/project-attention.ts`, `src/app/ProjectAttentionToast.tsx`, `src/app/project-attention.css`, `src/shared/locales/en.json`, `src/shared/locales/es.json`, `tests/features/chat/project-attention.test.ts`, `tests/app/project-attention.test.ts`, `README.md`

## Specs

### S1 — Attention from all other-project sessions [behavior]

> "otra caracteristica que hay que implementar en movil es complicado ver el estado de los otros proyectos, debemos de integrar un toast en la parte superior para notificar cuando un proyecto necesite atencion ya sea que termino, ocurrio un error o cualquier estado del agente que requiera atencion del usuario"

> "Todas las sesiones y errores de conexión (recomendado)"

- Mobile MUST surface completion, errors and user-input requests from known projects other than the active project, across selected and nonselected sessions and connection/process errors.
- Existing outcome classification MUST be reused; explicit cancellation MUST NOT become an attention alert.
- **S1.1** Given another known project with selected or nonselected sessions, when its agent completes, fails, or requests user input, then the correct originating project and attention type are emitted and displayed on mobile.
- **S1.2** Given another project's connection/process error, when its status arrives even for a nonselected session, then an error attention event is surfaced without changing the active conversation.

### S2 — Top mobile toast with stable origin [behavior]

> "debemos de integrar un toast en la parte superior para notificar cuando un proyecto necesite atencion"

- The toast MUST appear at the top within mobile safe areas, identify its originating project and attention state, and be dismissible and accessible.
- It MUST NOT appear for the active or an unknown project, nor on desktop. It MUST NOT switch projects automatically.
- Repeated delivery of the same attention event MUST NOT flood the screen; new turns MUST remain eligible.
- **S2.1** Given viewport at or below the existing 768px mobile threshold, when another known project needs attention, then a top toast contains its name and localized state and can be dismissed; desktop, active and unknown project events do not show it.
- **S2.2** Given duplicate delivery for a session turn, when notifications repeat, then no duplicate toast appears; a subsequent turn can notify again, and explicit cancellation does not notify.

### S3 — Preserve existing notifications [existing]

> "otra caracteristica que hay que implementar en movil"

- In-app notification delivery MUST remain independent from OS permission and focused-window suppression. Existing desktop notification behavior and selected-session event routing MUST remain unchanged.
- **S3.1** Given existing selected-session completion, input and cancellation events, when processed, then existing notification and chat dispatch behavior remains unchanged while an optional in-app callback works without OS delivery permission.

## Tasks

| ID | Specs | Route | Status | Evidence |
|---|---|---|---|---|
| T1 | S1-S3 | gentle-ai-worker | in_progress | RED a512f5993e4cd52b5c46e9708600a2e5258b2411; slice A bc82026882ba3dffa68536f95fcbe36486a9f7f4 GREEN14 controller+42 existing; slice B in_progress |
| T2 | S1-S3 | gentle-ai-verify | pending | Independent scenario gate and scoped regression checks |

## Log

- **L7 — Slice B partial evidence.** Worker implemented App callback/queue wiring, top safe-area hook-free ProjectAttentionToast, bounded queue helpers, locale strings and README. Reports focused20/20 and scoped existing67/67 pass. TypeScript exit2: four implicit-any callbacks in slice A's controller tests, outside sliceB boundary; parent resumed worker with that exact test path for annotation-only repair. Parent reviewed all sliceB source/diff. No browser integration, differential or independent gate yet. Existing controller/hook source unchanged by sliceB. Queue capacity3 evicts oldest and prunes on project/viewport changes.

- **L6 — Slice A evidence.** Worker changed controller, hook and controller test: 61 insertions/1 deletion. New controller tests RED12/GREEN14 after fixing duplicate cancellation; 42 affected existing session-event/notification tests pass, both final commands exit0. Parent reviewed full diff and committed bc82026882ba3dffa68536f95fcbe36486a9f7f4. Component tests intentionally remain RED until slice B. Native assess committed slice: high by concurrency item4, RDD off, reviewDue false, independent verifier required. Hook freshness/OS focus and base differential not independently exercised yet. Slice A review boundary is bc82026; slice B follows from it; no push/PR performed.

- **L4 — Review strategy decision.** User selected "Cadena sobre rama de la característica (recomendado)". Plan source work in sequential review slices A (controller/hook attention stream) and B (mobile presentation), preserving shared tests-only RED commit. This is local commit organization only; no publication authorized.
- **L5 — Parent RED.** Ran `./node_modules/.bin/tsx --tsconfig tsconfig.app.json --test tests/features/chat/project-attention.test.ts tests/app/project-attention.test.ts`: exit 1, 17 tests, 16 failures, 1 existing preservation pass, no skips. Five component failures are missing-module resolution; eleven controller failures are missing attention callback. RED commit a512f5993e4cd52b5c46e9708600a2e5258b2411 contains only two test files, 170 authored lines. Tests cover dismissal and top safe-area via production component once implemented. Implementation not yet present.

- **L3 — Initial tests review.** Worker added only tests/features/chat/project-attention.test.ts and tests/app/project-attention.test.ts; reported `tsx --tsconfig tsconfig.app.json --test` on both: exit 1, 15 tests, 14 failures, 1 existing preservation pass. New component missing; controller callback absent. Parent read both test files. Before committing RED, resumed tests-only worker to add dismiss interaction/no automatic navigation/top-safe-area assertions and reclassify new callback's OS-independence test from existing S3 to behavior S1. No production edits yet; no permission/focused-window browser execution claimed.

- **L1** original request: "otra caracteristica que hay que implementar en movil es complicado ver el estado de los otros proyectos, debemos de integrar un toast en la parte superior para notificar cuando un proyecto necesite atencion ya sea que termino, ocurrio un error o cualquier estado del agente que requiera atencion del usuario"
- **L2** scope answer: "Todas las sesiones y errores de conexión (recomendado)" to the question whether all sessions and connection errors or only selected sessions should notify.
- **D1 — Delivery seam.** Choice: optional structured attention callback in existing SessionEventController, forwarded through fresh hook refs, separate from OS notification delivery. Alternatives: reuse OS delivery debounce or repurpose settings toast container. Rationale: focused-window suppression would defeat mobile foreground use; settings toasts are scoped to settings and bottom-aligned.
- **D2 — Minimal presentation.** Choice: bounded, dismissible top mobile toast using known project identity, existing 768px threshold, localized completion/error/waiting labels and safe-area spacing. Project button MAY use normal project navigation; never auto-switch. Alternatives: global notification framework or specific-session navigation. Rationale: user asked to see other projects' attention states, not rebuild routing.
- **D3 — Dedup.** Choice: local per-turn/event identity reset on agent_start; bounded records. Alternatives: OS notification debounce (only records successful deliveries). Rationale: in-app path must work with denied permissions and repeated events, including nonselected sessions.
- Prior feature odd/tasks/new-session-project-binding.md has local blocked-verification notes and MUST NOT be changed or committed with this feature. Existing untracked .worktrees MUST remain untouched. This branch starts at the prior implementation commit; previous independent verification blocker remains unresolved, not silently closed.
- Worker role cannot commit; parent owns tests-only RED and implementation commits. Scope kinds above reflect explicit behavioral request and existing behavior preservation; no pure-visual-only requirement is separately introduced.
