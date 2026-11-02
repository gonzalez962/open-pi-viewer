# New-session project binding

Objective: Create each server session in its requesting project without weakening project isolation.
Branch: fix/new-session-project-binding
Trigger: risk item 4 (shared server cwd and asynchronous project switching); item 2 (preserve project isolation).
Scope in: Explicit originating project throughout new-session creation, validate before writing, keep late responses scoped to the origin, preserve desktop and project mismatch rejection.
Scope out: Pool redesign, switch-session redesign, path mapping redesign, RPC startup readiness changes.
Rollback: Revert this feature's implementation commit; no stored-session migration is involved.
Success: Two-project creation and delayed-response tests fail before the fix and pass after it, while existing affected behavior remains green.
Base: 96854d39a87f5c0bce6d2b9f274c0a66bc9c11e1
Delivery: ask-on-risk; forecast approximately 300-400 authored lines; no push or PR authorized.

## Expected files

- T1: `src/infra/bridge.ts`, `src/infra/web-ipc-client.ts`, `src/features/sessions/hooks/useSessions.ts`, `src/core/types/sessions.ts`, `server/web-ipc-bridge.ts`, `server/bridge/sessions.ts`, `tests/infra/new-session-project-binding.test.ts`, `tests/server/new-session-project-binding.test.ts`, `tests/features/sessions/new-session-project-binding.test.ts`, `tests/core/protocol.test.ts`, `README.md`

## Specs

### S1 — Create in the requesting project [behavior]

> "hay un detalle al crear una nueva sesion en mi server, no se apunto correctamente al proyecto y lanzo un error que no estaba relacionada la sesion nueva con el proyecto, lo cual me parece correcto pero hay que arreglar ese bug para que no pase de nuevo y se verifique el proyecto y cree correctamente la sesion, analiza primero"

- New-session creation MUST use the requesting project's directory rather than another client's global active directory.
- The server MUST validate the requested project directory before writing a session; invalid directories MUST NOT create records or mutate active session state.
- **S1.1** Given client A's project and a global active project B, when A creates a session, then the file and header belong to A and its next prompt targets A's new session.
- **S1.2** Given an invalid requested directory, when creating a session, then creation rejects without creating a session or changing active session state.

### S2 — Keep asynchronous results in the originating project [behavior]

> "lisot aplica"

- An in-flight creation MUST remain associated with the originating project if the user changes projects before its response arrives.
- **S2.1** Given a creation in A pending while B becomes active, when A's response arrives, then B's foreground and UI conversation remain unchanged and A receives its own result.

### S3 — Preserve existing interfaces and isolation [existing]

> "lo cual me parece correcto"

- The fix MUST preserve existing desktop new-session invocation and server rejection of a session from another project.
- **S3.1** Given existing desktop invocation, when requesting a new session, then the existing invocation contract still works.
- **S3.2** Given a session from B and a prompt for A, when the server handles the prompt, then it rejects with `Session does not belong to project`.

## Tasks

| ID | Specs | Route | Status | Evidence |
|---|---|---|---|---|
| T1 | S1-S3 | gentle-ai-worker | implemented; documentation follow-up | RED 0f13c4faaf57f2f26e8d9ef0ede769c88afdcd9f; GREEN 8/8 focused, 131/131 scoped existing; TypeScript exit 0; implementation commit pending |
| T2 | S1-S3 | gentle-ai-verify | in_progress | Preparing committed candidate for independent scenario gate and scoped regression verification |

## Log

- **L1** original request: "hay un detalle al crear una nueva sesion en mi server, no se apunto correctamente al proyecto y lanzo un error que no estaba relacionada la sesion nueva con el proyecto, lo cual me parece correcto pero hay que arreglar ese bug para que no pase de nuevo y se verifique el proyecto y cree correctamente la sesion, analiza primero"
- **L2** implementation authorization: "lisot aplica"
- **D1 — Origin binding.** Choice: carry the originating cwd explicitly through the existing bridge and route UI completion to the captured project. Alternatives: rely on shared getActiveCwd or remove mismatch checks. Rationale: creation currently omits cwd and handleNewSession reads a process-global cwd; removing checks would hide cross-project corruption.
- **D2 — Scope.** Choice: preserve legacy desktop calls and existing route normalization; no pool or session-switch redesign. Alternatives: rebuild all session routing. Rationale: minimal repair for the reported creation bug.
- Scenario S2.1 is the asynchronous edge case from the approved analysis. S3 covers existing preservation, so GREEN-only evidence is appropriate for S3; S1-S2 require observed RED before implementation. Kind labels reflect the authorized behavior repair (S1-S2) and the user's explicit existing-behavior preservation request, "lo cual me parece correcto" (S3), rather than an autonomous visual-testing decision.
- Parent source spot checks: server/bridge/sessions.ts handleNewSession writes getActiveCwd; server/web-ipc-bridge.ts new_session ignores args; src/infra/web-ipc-client.ts response applies to current foreground; useSessions already exposes activeProjectId and refs for origin routing.
- Existing untracked `.worktrees/` belongs to other work and MUST remain untouched. No overlapping open-feature paths were identified from the existing feature names; only this feature document and enumerated T1 surfaces are authorized.
- **L5 — Implementation evidence.** Worker reports focused JUnit 8/8 and existing scoped 131/131 (web-session-reattach, session-continuity, session-actions, protocol), both exit 0. TypeScript `tsc --noEmit -p tsconfig.app.json --incremental false` initially failed on test Array.at, then passed after indexed-access repair. Parent read entire source diff. No differential check yet. Native assess: high by concurrency item 4 escalation, RDD off, independent verifier required, reviewDue false. README follow-up delegated before candidate commit. No real server deploy or browser end-to-end exercise claimed.
- **L4 — RED evidence.** Parent ran `./node_modules/.bin/tsx --tsconfig tsconfig.app.json --test --test-reporter=junit tests/infra/new-session-project-binding.test.ts tests/server/new-session-project-binding.test.ts tests/features/sessions/new-session-project-binding.test.ts`: exit 1, 7 tests, 3 pass, 4 expected failures (S1.1 server project mismatch, S1.2 invalid directory writes, S2.1 hook and foreground origin loss). Tests-only commit: 0f13c4faaf57f2f26e8d9ef0ede769c88afdcd9f, 170 authored lines. Existing origin/main difference includes pre-feature work and is excluded from this feature's budget; slice base remains 96854d39a87f5c0bce6d2b9f274c0a66bc9c11e1.
- **L3 — Delegation constraint.** Initial worker returned without changes because its role forbids staging/committing. Parent owns all commits. T1 resumed for tests only, followed by parent RED commit and then worker source implementation. No RED/GREEN evidence exists yet.
