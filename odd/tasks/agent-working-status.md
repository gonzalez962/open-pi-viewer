# Agent working status

Objective: Remove the redundant visible prompt label and derive the busy indicator from agent activity available in the viewer.
Branch: feat/agent-working-status; Base: 0468e7b44b14d9adef078e880b4ac833fb132bbd; Delivery: local commits only, no push or PR.
Trigger: explicit SDD; Scope in: prompt label and working indicator; Scope out: textarea removal, notification integration, backend/protocol changes; Rollback: revert this feature's commits; Success: label absent, textarea retained, dynamic indicator scenarios pass the SDD gate.

## Expected files

- T1: `src/app/App.tsx`, `src/features/chat/agent-working-status.ts`, `tests/features/chat/agent-working-status.test.ts`, `src/shared/locales/en.json`, `src/shared/locales/es.json`, `docs/architecture.md`

- T2: `src/core/types/chat-state.ts`, `src/core/types/events.ts`, `src/core/types/agent-activity.ts`, `src/core/agent-activity.ts`, `src/core/reducer/initial-state.ts`, `src/core/reducer/index.ts`, `src/core/reducer/connection.ts`, `src/core/reducer/messaging.ts`, `src/features/chat/session-events.ts`, `src/features/chat/agent-working-status.ts`, `src/app/App.tsx`, `src/shared/locales/en.json`, `src/shared/locales/es.json`, `tests/features/chat/agent-working-status.test.ts`, `tests/features/chat/subagent-activity.test.ts`, `docs/architecture.md`

## Specs

### S1 — Remove the redundant visible label [presentational]

> "no quiero eliminar el texto que dice Prompt lo siento redundante es el label."

- The viewer MUST remove only the visible label above the prompt textarea, preserving message composition and an accessible textarea name.
- **S1.1** Given the normal prompt composer, when it renders, then the redundant visible Prompt label is absent and the prompt textarea remains available.

### S2 — Detect agent activity in the working text [behavior]

> "vamos a cambiar el comportamiento elimina el elemento prompt-input, luego en los textos de working vamos a detectar los estados del agente como se hace en este repo C:\xampp\htdocs\trabajosgithub\gentle-ai\pi-notify"

- The busy indicator MUST derive its text from the current agent activity instead of a fixed Working string, following pi-notify's phase plus active-tool presentation for evidence the viewer receives.
- Assumption: this change adapts reference detection to existing viewer messages and tool events; it does not add reference-only in-process phase registries, notification transports, or external subagent telemetry to RPC.
- Assumption: current `gentle_odd_phase` tool arguments are explicit phase evidence; absent them, streaming thinking/text and currently executing tools provide activity evidence, otherwise Working is the fallback. Completed historical runs MUST NOT supply current activity.
- **S2.1** Given a busy run with an explicit phase tool call, when the indicator is derived, then it displays that phase and does not list the phase-reporting tool as execution work.
- **S2.2** Given a busy run executing tools, when the indicator is derived, then it includes formatted currently running tool names, deduplicates names, strips MCP prefixes, excludes pi-notify's control tools, and limits the suffix to three items plus an overflow count.
- **S2.3** Given a busy run with streaming thinking or assistant text and no explicit phase or running tools, when the indicator is derived, then it distinguishes thinking from response generation.
- **S2.4** Given a busy run without current activity evidence or after the current tool finishes, when the indicator is derived, then it falls back without reusing completed tools or phases from an earlier run.
- **S2.5** Given an idle agent or a disconnected session containing old running blocks, when the indicator is derived, then no current working activity is reported.
- **S2.6** Given English or Spanish UI preferences, when current activity is displayed, then phase and fallback labels use the selected UI language while tool identities remain recognizable.

### S3 — Live agent and subagent activity [behavior]

> "no esta cambiando prompt-label-wrapper segun el estado del agente/subagente como en pi-notify"

- The prompt indicator MUST reflect actual live agent/subagent activity rather than just the main-agent busy flag.
- **S3.1** Given a current-session gentle-agents.activity/v1 setWidget snapshot, when RPC activity arrives, then active task identity, status and last step update the target project's indicator, without opening a dialog.
- **S3.2** Given queued, running or waiting subagents, when their activity changes or the main agent settles, then the indicator continues to represent active subagents, prioritizes waiting, and stops representing tasks once a new snapshot marks them finished or removes them.
- **S3.3** Given malformed, unrelated or stale-session widget data, when it arrives, then it does not corrupt live activity, open a dialog or mark a stale session waiting; disconnect or session replacement clears old activity.
- **S3.4** Given primary-agent tool activity without an explicit phase call, when the indicator is derived, then common read/search, write/edit and validation commands convey exploration, implementation or checking phases; explicit valid phases retain precedence and unknown commands remain conservative.
- Assumption: read/search tools map to exploration, write/edit to implementation; bash validation is recognized by explicit test/build/check commands only, never by arbitrary shell text. No in-process registry or new backend transport is required. Activity snapshots already arrive via setWidget; no runtime subagent state is inferred from a completed dispatch.

## Tasks

| ID | Specs | Route | Status | Evidence |
|---|---|---|---|---|
| T1 | S1, S2 | delegated gentle-ai-worker (explicit SDD) | done | RED cf96f5b0ee9f13e5182dd527b9c680381392e27b; GREEN d3d67c8014cf2b8e0df29ac7738c67189bdd2c31; official gate PASS |
| V1 | S1, S2 | independent gentle-ai-verify + mechanical gate | done | Original gate recheck exit 0 at head/spec-ref f5ccadd192c3c16b273bd5a81f2096f0ecb56e78; S1.1 N/A, S2.1–S2.6 COMPLIANT; all four checks pass |

| T2 | S3, preserve S1/S2 | delegated gentle-ai-worker (SDD followup) | implemented; verification pending | Base fa440f6a9d0ef1c5d0a0afcbd8f30b226f022ce1; RED 6364dd4bebad04d529ff99cfb2c708d4337c8fae; GREEN b5513b6737cf39762470261fdf89e90b8c45481c |
| V2 | S3, preserve S1/S2 | independent verifier + scoped gate | blocker recheck in_progress | Initial gate PASS at c778946; S3.3 regression RED e8090d5461ffc0b8349cdeacde4858ca8fd3afce; correction GREEN 75d8316ec1a34f19d5a823c7208d30fe7c14fb17; independent recheck pending |

## Log

- **L7** followup: "no esta cambiando prompt-label-wrapper segun el estado del agente/subagente como en pi-notify"
- **D4 — Actual telemetry ingestion.** Choice: parse bounded gentle-agents.activity/v1 setWidget snapshots into per-project state, deriving identity/status/lastStep only, preserving dialog and session isolation. Alternatives: infer from dispatch (incorrect) or invent external polling. Rationale: publisher uses tasks[].summary fields; existing controller drops non-dialog widget messages. Child protocol source inspected, no writes outside viewer.
- **P11** Correction worker delivered e8090d5461ffc0b8349cdeacde4858ca8fd3afce (tests-only) and 75d8316ec1a34f19d5a823c7208d30fe7c14fb17 (parser one-line fix). Parent verified actual hashes and diff: malformed tasks returns null; missing/null/string/number regression added to S3.3, valid [] still clears. Worker reports 12 focused pass, full 1740 pass / 0 fail / 1 optional skip, build success. Updated official gate against original T2 RED and final candidate, plus independent recheck limited to S3.3 blocker, required before RDD. No further source corrections authorized unless the same blocker still fails.
- **P10** Independent verifier mv7j4kam-6-p4gz returned official gate exit 0: S3.1–S3.4 COMPLIANT and all scope/RED/skip/regression checks pass; full suite 1740 pass / 0 fail / 1 optional skip, architecture 8/8, build successful. Nevertheless concrete production-controller probe proves unmet S3.3: schema-valid missing/non-array tasks returns [] in src/core/agent-activity.ts:17 and wipes active subagents. This is a confirmed implementation blocker, not an environment failure. Authorize one bounded correction batch: parser returns null for malformed tasks, durable controller regression covers omitted/null/string/number tasks while valid [] still clears. Independent recheck limited to this blocker and official S3 gate evidence follows; no native review yet.
- **P9** Worker delivered actual widget ingestion and per-project subagent state; reported focused 12/12, full suite 1740 pass / 0 fail / 1 optional skip, architecture 8/8 and successful build. Parent verified RED/GREEN hashes and baseline scope; independent verification pending, not declared complete. Parent review focus: malformed snapshot.tasks currently returns [] and may erase valid activity rather than ignore malformed input (S3.3); real source project/session handling and main-idle telemetry lifecycle require probes. No source changes by parent.
- **P8** Prior scoped native review review-ec84a22c28c62744 approved and acknowledged; authority burned for its exact candidate. Followup S3 is a new work unit and does not reopen old authority. Baseline fa440f6; new tests-only commit and separate gate range required.
- **L1** original request: "vamos a cambiar el comportamiento elimina el elemento prompt-input, luego en los textos de working vamos a detectar los estados del agente como se hace en este repo C:\xampp\htdocs\trabajosgithub\gentle-ai\pi-notify"
- **L2** clarification: "no quiero eliminar el texto que dice Prompt lo siento redundante es el label."
- **L3** routing: "hagamoslo con sdd"
- **L4** human coverage selection: "No probar el cambio visual"; label is presentational, dynamic indicator is behavior with RED/GREEN.
- **L5** human authorization: "Sí, autorizo los commits locales"; tests-only and implementation commits allowed, no push or PR.
- **L6** continuation: "listo continua"
- **D1 — Reuse viewer state.** Choice: pure activity derivation from existing per-project chat state and tool blocks. Alternatives: new reducer fields or new backend telemetry. Rationale: existing tool reducers record running/completed tools and arguments; avoids shared runtime contract changes. Reference: pi-notify/lib/herdr.ts:281-340; viewer src/core/reducer/tool-execution.ts and src/core/reducer/messaging.ts.
- **D2 — Phase transport boundary.** Choice: explicit phase tool arguments and observable message/tool activity, not cross-process Symbol registry access. Alternatives: transport new phase events. Rationale: pi-notify reads an in-process registry the browser cannot access; this scope remains frontend-only. Active dialogs already replace the normal composer, so their existing waiting UI is preserved.
- **D3 — Gate execution.** Choice: Node test runner JUnit reporter and gentle-sdd gate with explicit base, RED commit, task scope and report path. Rationale: gentle-sdd 0.1.0 is installed and requires real isolated RED/GREEN evidence. Throwaway gate checkouts and dependency setup are authorized; no dependency changes or external reference repository writes.
- **P1** Clean starting tree verified. New branch created from feat/web-push-notifications. Expected surfaces do not overlap active writers in this session; no existing feature document names agent-working-status. Source edits have not started.
- **P2** Worker reported focused 7/7 GREEN, full suite 1735 pass / 0 fail / 1 optional skip, architecture 8/8, and successful client/server build. Parent verified actual Git hashes (worker's full hashes were inaccurate): RED cf96f5b0ee9f13e5182dd527b9c680381392e27b; GREEN d3d67c8014cf2b8e0df29ac7738c67189bdd2c31. RED is tests-only. Actual branch diff is 706 insertions / 5 deletions across six implementation/test files; no push or PR.
- **P3** Feature file is ignored by existing repository rules. Explicitly stage only this document so gate can read the specification from a committed ref. Independent verifier must run gate against actual hashes; do not manufacture a scenario matrix. Review of accumulated earlier repository changes remains an unresolved scope question; this feature's verification proceeds separately.
- **P4** Independent gate returned exit 1, empty stderr, S1.1 N/A, all six S2 scenarios UNTESTED, scope/tests-only RED/skip checks pass, regression check fails with 88 RED-passing tests absent in GREEN output. No compliant verdict. Verifier attributes this to Windows cmd.exe quoting, but report lacks exact child process exit codes/stderr/JUnit artifacts establishing causality. Read-only incident diagnosis delegated before authorizing any workaround or gate recheck. Active-assistant lookup inside message loop is an advisory only; no corrective source scope added.
- **P5** Native RDD START for accumulated target sha256:00120442025a39354681ddf2bdd1b6ea94063a2a771af4a30f1c30bf2b60c646 failed pre-native with operation_timeout, mutation not started, retry_safe false, next_action stop. No lineage or approval claimed; manual action needed, no automatic retry.
- **P6** Diagnostic verifier inspected retained sdd-scratch-uWgP5d artifacts: RED and HEAD each contain 1736 raw testcase tags; RED 1728 pass / 7 fail / 1 skip, HEAD 1735 pass / 0 fail / 1 skip. Shell argv probe refutes prior quoting hypothesis. Installed gentle-sdd/lib/junit.mjs TESTCASE regex uses [^>]* and stops at literal > inside quoted XML name attributes; HEAD parser reads only 224 cases, swallowing S2 scenarios. A read-only corrected-parser probe recovers 1736 cases and zero regressions; this is diagnostic evidence, NOT official gate approval. Current official matrix remains failed. No external files were modified. Requires explicit authorization for separate gentle-sdd source fix or user-installed fix before the one bounded official recheck. Concurrency and glob changes are irrelevant; retain original test command.
- **P7** User authorized official recheck: "listo prueba de nuevo". Original gate command, unchanged refs and full-suite JUnit runner, completed as job-1 with exit 0 after 1m58s. Parent read raw output: pass=true; S1.1 N/A; S2.1–S2.6 COMPLIANT; scope, red-tests-only, skip-markers and regression all pass. External parser blocker resolved. Evidence covers exact head/spec-ref f5ccadd192c3c16b273bd5a81f2096f0ecb56e78; subsequent task-log updates do not alter implementation. T1/V1 closed for SDD. Native RDD timeout from P5 remains unresolved and no native approval is claimed. No push or PR.
