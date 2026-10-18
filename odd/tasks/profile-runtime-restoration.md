# Restore the active profile after project changes and reloads

Objective: Keep the runtime model aligned with the effective profile on view initialization.
Branch: fix/github-modal-clone-permissions
Trigger: risk item 4 (asynchronous session initialization and profile restoration ordering)
Scope in: Initial profile model/effort restoration on reload and project switch; preserve manual selection and activation.
Scope out: Backend profile formats, provider policy, session history, publishing.
Rollback: Revert the implementation work-unit commit.
Success: Scenario tests fail without the fix and pass with it; scoped regression checks pass.
Base: 99da61e29c7244fd206d8182faaa51895884b4a1

## Expected files

- T1: `src/app/App.tsx`, `src/features/providers/hooks/useModels.ts`, `src/features/profiles/hooks/useProfiles.ts`, `src/features/profiles/hooks/useProfileRuntime.ts`, `src/features/profiles/lib/profileRuntime.ts`, `tests/app/profile-runtime-restoration.test.ts`, `tests/app/profiles-activation.test.ts`, `docs/profile-runtime-restoration.md`

## Specs

### S1 — Restore runtime after view reload [behavior]

> "cuando se cambia de proyecto o se recarga la vista no se aplica correctamente el perfil, se cambia el modelo"

- The system MUST apply the effective profile model and effort after a view reload, after session model initialization completes.
- **S1.1** Given an active profile and a different connect-time model, when the view reloads and initialization completes, then the runtime model and effort match that profile, without subsequent initialization overwriting them.

### S2 — Restore runtime after project switching [behavior]

> "cuando se cambia de proyecto o se recarga la vista no se aplica correctamente el perfil, se cambia el modelo"

- The system MUST apply the destination project's effective profile rather than stale source-project profile data.
- **S2.1** Given projects with different effective profiles, when the project changes and initialization completes, then the destination profile model and effort are applied and late source-project results cannot replace them.

### S3 — Preserve manual runtime selection [existing]

> "cuando se cambia de proyecto o se recarga la vista no se aplica correctamente el perfil, se cambia el modelo"

- Assumption (regression boundary): initialization restoration MUST NOT repeatedly reset a later manual selection in the same initialized context. Existing explicit activation, project-to-global inheritance, disconnected/busy guards, and absence of a profile MUST remain intact.
- **S3.1** Given a restored profile, when a user manually selects a model and ordinary rerenders occur, then restoration does not replace that selection; explicit profile activation still applies the requested profile.
- **S3.2** Given a project inheriting a global profile or having no effective profile, when restoration runs, then it applies the global profile or leaves the model unchanged, respectively; disconnected or busy sessions are not mutated.

## Tasks

| ID | Specs | Route | Status | Evidence |
|---|---|---|---|---|
| T1 | S1-S3 | gentle-ai-worker; independent gentle-ai-verify | in_progress | Initial attempt 133df7f/6f35220 failed verification; authorized corrective attempt from 6f35220, new genuine RED and GREEN pending |

## Log

- **L1 (2026-08-14)** original request: "cuando se cambia de proyecto o se recarga la vista no se aplica correctamente el perfil, se cambia el modelo"
- **L2** User authorized reading spec-guard SKILL.md and template.md outside the project.
- **L3** User selected "Autorizar pruebas y commits locales": behavior classification and local tests/correction commits authorized; no push/PR.
- **L4** Verification rejected the initial implementation: delayed metadata is latched as no-profile, stale cwd profile and session readiness are observable, in-flight restores overlap and continue effort updates across context changes, manual selection is dropped during restoration. Initial RED is synthetic and invalid. Gate exit 2 because this spec is ignored and absent from HEAD.
- **L5** User: "arregla". User explicitly selected "Sí, abandonar y corregir". Native abandonment of review-9dfd0d251cdd3cff committed (operator_disposition, actor pi), followed by inspect; no source commits deleted. Do not restart the unchanged abandoned candidate.
- **D4 — Corrective attempt and real evidence.** Choice: append a fresh tests-only RED commit exercising current production code, then implement and independently verify once; preserve initial commits and mark their evidence invalid. Include this exact spec with force-add (only this file, no ignore-rule changes) to make the mandatory gate executable. Alternatives: rewrite initial history or skip gate; rejected. All correction work stays within existing expected surfaces plus this spec. New RED must run the same tests that turn GREEN, with no conditional missing-module assertions or private-state mutation. Meaningful integration coverage must test metadata/session readiness and runtime coordination, not a test-only request tracker.
- **D1 — Sequence restoration after session initialization.** Choice: expose readiness for the current session context and coordinate one-time profile application with profile loading. Alternatives: blindly apply on every profile refresh, or fix backend defaults. Rationale: App.tsx:855-912 applies only manual events; useModels.ts:160-248 asynchronously restores defaults; independent effects can overwrite one another. Keep the fix frontend-scoped and reject stale project loads.
- **D2 — Preserve existing manual behavior.** S3 is an existing regression boundary; GREEN evidence only because manual activation already works. Existing tests/app/profiles-activation.test.ts simulates handlers rather than exercising App wiring; new checks must execute production coordination and check wiring where needed.
- **D3 — Tracking and commits.** This bounded fix uses one task under the mandatory high-risk spec-guard route. Existing branch is non-default and was clean. Do not touch unrelated feature documents; the expected new coordinator files do not overlap them. Existing profile/runtime documents concern earlier completed work.
