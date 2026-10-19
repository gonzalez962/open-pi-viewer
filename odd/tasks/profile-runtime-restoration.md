# Restore the active profile after project changes and reloads

Objective: Keep the runtime model aligned with the effective profile on view initialization.
Branch: fix/profile-runtime-restoration
Trigger: risk item 4 (asynchronous session initialization and profile restoration ordering)
Scope in: Initial profile model/effort restoration on reload and project switch; preserve manual selection and activation.
Scope out: Backend profile formats, provider policy, session history, publishing.
Rollback: Revert the implementation work-unit commit.
Success: Scenario tests fail without the fix and pass with it; scoped regression checks pass.
Base: 99da61e29c7244fd206d8182faaa51895884b4a1

## Expected files

- T1: `src/app/App.tsx`, `src/features/providers/hooks/useModels.ts`, `src/features/profiles/hooks/useProfiles.ts`, `src/features/profiles/hooks/useProfileRuntime.ts`, `src/features/profiles/lib/profileRuntime.ts`, `src/features/profiles/lib/sessionProfileSnapshot.ts`, `tests/app/profile-runtime-restoration.test.ts`, `tests/app/profiles-activation.test.ts`, `tests/features/profiles/session-profile-snapshot.test.ts`, `docs/profile-runtime-restoration.md`, `src/core/types/profiles.ts`, `tests/core/profiles.test.ts`, `src/features/providers/lib/modelSelection.ts`, `tests/app/profile-model-selection.test.ts`

## Specs

### S1 — Restore runtime after view reload [behavior]

> "cuando se cambia de proyecto o se recarga la vista no se aplica correctamente el perfil, se cambia el modelo"

- The system MUST apply the effective profile model and effort after a view reload, after session model initialization completes.
- **S1.1** Given an active profile and a different connect-time model, when the view reloads and initialization completes, then the runtime model and effort match that profile, without subsequent initialization overwriting them.
- **S1.2** Given a transient model selection failure on view reload, when reconnecting or reactivating the session, then recovery invalidates failure and restores without spinning infinite rerender loops.

### S2 — Restore runtime after project switching [behavior]

> "cuando se cambia de proyecto o se recarga la vista no se aplica correctamente el perfil, se cambia el modelo"

- The system MUST apply the destination project's effective profile rather than stale source-project profile data.
- **S2.1** Given projects with different effective profiles, when the project changes and initialization completes, then the destination profile model and effort are applied and late source-project results cannot replace them.
- **S2.2** Given a project switch after a transient failure in another context, when entering the destination project, then destination profile restoration proceeds cleanly.

### S3 — Preserve manual runtime selection [existing]

> "cuando se cambia de proyecto o se recarga la vista no se aplica correctamente el perfil, se cambia el modelo"

- Assumption (regression boundary): initialization restoration MUST NOT repeatedly reset a later manual selection in the same initialized context. Existing explicit activation, project-to-global inheritance, disconnected/busy guards, and absence of a profile MUST remain intact.
- **S3.1** Given a restored profile, when a user manually selects a model and ordinary rerenders occur, then restoration does not replace that selection; explicit profile activation still applies the requested profile.
- **S3.2** Given a project inheriting a global profile or having no effective profile, when restoration runs, then it applies the global profile or leaves the model unchanged, respectively; disconnected or busy sessions are not mutated.

### S4 — Stable session-bound effective configuration snapshot [behavior]

> "Queremos una configuración efectiva estable por sesión, no reconstruirla ni volver a aplicarla desde el proyecto en cada cambio de proyecto."

- **S4.1** On initial load of a session without saved snapshot, the system MUST capture and persist its effective profile, primary model, and reasoning effort bound to project and session identity.
- **S4.2** When switching away from a project and switching back, the system MUST reuse that session's stored snapshot instead of reloading and reapplying project defaults.
- **S4.3** The session configuration snapshot MUST be persisted to persistent storage (surviving a full view reload) with strict project/session scoping to avoid cross-project contamination.

### S5 — Synchronize runtime and confirm model with Pi RPC [behavior]

> "Al restaurarlo, sincronizarlo con el proceso Pi y confirmar el modelo real antes de mostrarlo como aplicado."

- **S5.1** When restoring a session snapshot, the system MUST synchronize with the running Pi process and confirm the real active model before displaying it as applied.
- **S5.2** If the Pi process rejects the model or reports a different active model, the UI must reflect the confirmed actual model rather than a stale unconfirmed snapshot.

### S6 — Profile reselection, manual changes, and profile edits lifecycle [behavior]

> "Seleccionar explícitamente otro perfil actualiza la configuración de esa sesión. Un cambio manual de modelo o esfuerzo se conserva en esa sesión. Editar la definición de un perfil afecta a sesiones nuevas. Las existentes conservan su configuración hasta volver a seleccionar explícitamente el perfil."

- **S6.1** When a user explicitly selects a different profile, the session snapshot MUST update to that new profile's configuration.
- **S6.2** When a user manually changes model or effort in a session, that manual configuration MUST be preserved in that session's snapshot across navigation and reloads.
- **S6.3** Editing an existing profile's definition affects newly created sessions only; existing sessions MUST retain their stable snapshot until the profile is explicitly re-selected.

## Tasks

| ID | Specs | Route | Status | Evidence |
|---|---|---|---|---|
| T1 | S1-S6 | gentle-ai-worker; independent gentle-ai-verify | done | Resolved via commits d31098b, 7316815, 6f89598; all 1977 tests pass. Closes #125 |

## Log

- **L1 (2026-08-14)** original request: "cuando se cambia de proyecto o se recarga la vista no se aplica correctamente el perfil, se cambia el modelo"
- **L2** User authorized reading spec-guard SKILL.md and template.md outside the project.
- **L3** User selected "Autorizar pruebas y commits locales": behavior classification and local tests/correction commits authorized; no push/PR.
- **L4** Verification rejected the initial implementation: delayed metadata is latched as no-profile, stale cwd profile and session readiness are observable, in-flight restores overlap and continue effort updates across context changes, manual selection is dropped during restoration. Initial RED is synthetic and invalid. Gate exit 2 because this spec is ignored and absent from HEAD.
- **L6** User reports: "aun esta el bug que se cambia el modelo principal al cambiar de proyecto o recargar, no respeta la config del perfil seleccionado". User authorized a new bounded attempt: "si arregla". No push or PR. Corrective RED d31665d and GREEN 5f55374 passed mechanical gate but independent recheck reproduced stale effort continuation while destination is loading or has no profile. Static investigation additionally found that handleSelectModel swallows RPC failure and coordinator latches success. Catalog/casing causes remain hypotheses until reproduced. New attempt MUST exercise actual selection handlers/RPC outcomes and project routing, not only coordinator callbacks that assign variables. Preserve pending Rust fixes and Cargo.toml changes; no edits/commits of those files.
- **L5** User: "arregla". User explicitly selected "Sí, abandonar y corregir". Native abandonment of review-9dfd0d251cdd3cff committed (operator_disposition, actor pi), followed by inspect; no source commits deleted. Do not restart the unchanged abandoned candidate.
- **L7 (2026-10-18)** User approved architectural redesign: "podemos mantener un estado fijo para los perfiles cuando se cargue la sesion? es decir que quede en un estado el modelo y el perfil y no dependa de cargar el proyecto actual de nuevo? ... al cargar la vista por primera vez obtiene los datos y se guardan los datos para evitar la recarga entre cada cambio de proyecto".
- **L8 (2026-10-18)** User reports: "el bug no esta corregido del todo cuando se cambia rapidamente entre proyectos se queda congelado el modelo del proyecto anterior en le selector aunque aparentemente internamente si se respetan los modelos". Root cause: `snapshotRecord.provider` was saved as null or empty when using profiles, causing `if (targetModelId && targetProvider)` to evaluate false and silently skip `params.onSelectModel`; additionally `lastRestoredContextKey` was not reset on context switch; `onConnectSuccess` discarded `res.model` when project was already hydrated; and `useModels` defaulted to `activeModels[0]` without checking snapshot. Fixed with provider extraction from qualified model names/availableModels, resetting `lastRestoredContextKey` on context switch, syncing `res.model` on reconnection, and deriving immediate `effectiveModelInfo` in `App.tsx`. Verified with 1977 passing unit/regression tests.
- **D5 — Stable Session Profile Snapshot Architecture.** Choice: maintain a persistent session configuration snapshot (`SessionProfileSnapshot`) keyed strictly by `${cwd}::${sessionId}`. On first view load without a saved record, determine effective profile, model, and effort once and persist. When switching projects and returning, reuse the session snapshot instead of reloading and applying project configuration. Editing a profile definition affects new sessions only; existing sessions retain snapshot until explicit re-selection. A manual change of model or effort updates the session snapshot. Reconcile and confirm real active model with Pi process before displaying as applied.
- **D4 — Corrective attempt and real evidence.** Choice: append a fresh tests-only RED commit exercising current production code, then implement and independently verify once; preserve initial commits and mark their evidence invalid. Include this exact spec with force-add (only this file, no ignore-rule changes) to make the mandatory gate executable. Alternatives: rewrite initial history or skip gate; rejected. All correction work stays within existing expected surfaces plus this spec. New RED must run the same tests that turn GREEN, with no conditional missing-module assertions or private-state mutation. Meaningful integration coverage must test metadata/session readiness and runtime coordination, not a test-only request tracker.
- **D1 — Sequence restoration after session initialization.** Choice: expose readiness for the current session context and coordinate one-time profile application with profile loading. Alternatives: blindly apply on every profile refresh, or fix backend defaults. Rationale: App.tsx:855-912 applies only manual events; useModels.ts:160-248 asynchronously restores defaults; independent effects can overwrite one another. Keep the fix frontend-scoped and reject stale project loads.
- **D2 — Preserve existing manual behavior.** S3 is an existing regression boundary; GREEN evidence only because manual activation already works. Existing tests/app/profiles-activation.test.ts simulates handlers rather than exercising App wiring; new checks must execute production coordination and check wiring where needed.
- **D3 — Tracking and commits.** This bounded fix uses one task under the mandatory high-risk spec-guard route. Existing branch is non-default and was clean. Do not touch unrelated feature documents; the expected new coordinator files do not overlap them. Existing profile/runtime documents concern earlier completed work.
