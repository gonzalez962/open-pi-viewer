# Background jobs keep projects working
Objective: Keep project activity visible while background jobs are still running.
Branch: feat/background-job-activity | Base: 37d4cedb6951b854606359876d418f8fbad5164d
Trigger: risk item 4 (concurrent session/job lifecycles).
Scope in: RPC-visible background job lifecycle detection, project/session working indicators, live reattachment, and desktop tray activity.
Scope out: New job execution/control UI, dependencies, extension-bus events not carried over RPC, notification policy changes, publishing.
Rollback: Revert the implementation work unit and its tests/documentation.
Success: A running job keeps its project working after agent settlement; its termination clears only its own contribution.

## Specs

### S1 — Fresh feature branch [existing]
> "crea un rama nueva desde origin/main"
- Work MUST use a new branch rooted at origin/main.
- **S1.1** Given origin/main, when implementation starts, then feat/background-job-activity has that starting commit as its ancestor.

### S2 — Detect background work [behavior]
> "agrega soporte para detectar jobs para mostrar que el proyecto esta aun en proceso"
- The viewer MUST keep a project's working indication while its observed background jobs remain active, independently of agent streaming.
- The viewer MUST clear a job's contribution when its exit/stop is observed, without clearing unrelated jobs, sessions, or ongoing agent work.
- Existing waiting/input, prompt submission, session isolation, ordinary agent settlement, and disconnect behavior MUST remain intact.
- **S2.1** Given bash_background or monitor starts successfully, when the agent settles, then its project remains working without reporting agent streaming or disabling new prompts.
- **S2.2** Given multiple active jobs/sessions, when a job exits or is stopped, then only that job is removed and working ends only once no active job or agent remains.
- **S2.3** Given active jobs, when the web client reattaches to the live session or switches the selected session in that project, then the project still indicates work and the runtime is not pruned as idle.
- **S2.4** Given ordinary agent work or a pending input request without jobs, when existing events arrive, then existing activity/input behavior remains unchanged; errors or disconnects do not leave stale job indicators.
- **S2.5** Given desktop activity events for jobs and agent settlement, when a job is still active, then the tray remains busy until that job finishes without clearing other sessions.

### S3 — Reference-compatible evidence [behavior]
> "puedes usar de base el siguiente repo te doy permiso de leer el repo C:\\xampp\\htdocs\\trabajosgithub\\gentle-ai\\pi-notify"
- Detection SHOULD reuse the reference's RPC-visible gentleJobs details, background-start text fallback, job_stop results, and gentle-jobs.notice completion messages; malformed/failed events MUST NOT invent active jobs.
- **S3.1** Given structured gentleJobs starts/stops/notices or reference-compatible text starts/completions, when observed through public event handling, then active job state changes correctly; malformed/failed starts leave state unchanged.

## Expected files
- T1: `src/core/job-activity.ts`, `src/core/types/chat-state.ts`, `src/core/types/connection.ts`, `src/core/types/sessions.ts`, `src/core/types/events.ts`, `src/core/reducer/connection.ts`, `src/core/reducer/initial-state.ts`, `src/core/reducer/index.ts`, `src/features/chat/session-events.ts`, `src/features/chat/agent-working-status.ts`, `src/features/chat/session-actions.ts`, `src/features/chat/use-session-actions.ts`, `src/features/sessions/**`, `src/app/App.tsx`, `src/features/projects/projects.ts`, `src/features/projects/ProjectDock.tsx`, `src/infrastructure/bridge/**`, `src/infra/bridge/**`, `src/infra/web-ipc-client.ts`, `src/infra/bridge.ts`, `tests/core/session-reattach.test.ts`, `tests/infra/web-ipc-continuity.test.ts`, `tests/server/bridge/todo-restoration.test.ts`, `src-tauri/src/process.rs`, `server/bridge/rpc.ts`, `server/bridge/sessions.ts`, `src-tauri/src/tray_activity.rs`, `tests/core/job-activity.test.ts`, `tests/features/chat/background-job-activity.test.ts`, `tests/server/background-job-activity.test.ts`, `tests/features/chat/session-events.test.ts`, `tests/features/chat/agent-working-status.test.ts`, `tests/server/session-continuity.test.ts`, `README.md`

## Tasks
| ID | Specs | Route | Status | Commit/evidence |
|---|---|---|---|---|
| T1 | S2-S3 | gentle-ai-worker | done | RED: `911470a`; core/web: `0c91766`; native: `f3418dd` |
| T2 | S1-S3 | independent gentle-ai-verify | done | Scoped tests, identity probes, compiler, native lifecycle and baseline differential passed |

## Verification

- `npx tsc -b`: exit 0.
- Scoped TypeScript scenario/continuity run: 31 tests passed.
- Independent focused verification: 22 tests passed; file-only exits for selected, background and unknown sessions preserved the correct session state.
- Native settlement lifecycle and four tray tests passed. Coverage uses the shared production emission path and tray units; no manual GUI run was performed.
- Baseline differential against `37d4cedb6951b854606359876d418f8fbad5164d`: public controller message start, waiting prompt and selected waiting snapshot produced identical stdout/stderr and exit code 0.
- Core/web and native commits were assessed separately with independent verification for concurrent session lifecycles.
- These scoped checks do not constitute a mechanical scenario-gate approval.

## Log

- L1 (2026-07-24) original request: "crea un rama nueva desde origin/main y agrega soporte para detectar jobs para mostrar que el proyecto esta aun en proceso puedes usar de base el siguiente repo te doy permiso de leer el repo C:\xampp\htdocs\trabajosgithub\gentle-ai\pi-notify"
- D1 — Separate streaming and jobs. Choice: Track background jobs per session independently of main-agent activity. Alternative: Keep the agent busy until every job exits. Rationale: Background work must not disable new prompts.
- D2 — Use transported evidence. Choice: Recognize successful RPC tool results and custom completion notices. Alternative: Assume extension-bus sidebar events cross RPC. Rationale: Only the transported sources are established by the existing event path.
- E1 — Branch `feat/background-job-activity` started at `origin/main` commit `37d4cedb6951b854606359876d418f8fbad5164d`.
- E2 — Tests-only commit `911470a` observed TypeScript assertion failures and a Rust tray failure before implementation; ordinary continuity tests passed.
- E3 — Review slices: core/web `0c91766` and native `f3418dd`. The feature aggregate exceeds 400 authored lines; review these behavior slices separately rather than as one small change.
- L2 — User authorized commits: "si crea commits y revisa esos bloqueos".
- L3 — User confirmed requirement kinds: "si esta bien". S1 is existing (branch ancestry evidence); S2 and S3 are behavior.
- L4 — User clarified documentation scope: "bueno me refieria a dejar la envidencia de la limitante en local pero podemos dejar el documento md versionado eso te parece bien?" and authorized applying it: "listo aplica". Keep the specification and functional evidence versioned; retain tooling investigation details in an ignored local note. No publishing is authorized by this documentation change.
