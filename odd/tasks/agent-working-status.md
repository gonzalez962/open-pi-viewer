# Agent working status

Objective: Remove the redundant visible prompt label and derive the busy indicator from agent activity available in the viewer.
Branch: feat/agent-working-status; Base: 0468e7b44b14d9adef078e880b4ac833fb132bbd; Delivery: local commits only, no push or PR.
Trigger: explicit SDD; Scope in: prompt label and working indicator; Scope out: textarea removal, notification integration, backend/protocol changes; Rollback: revert this feature's commits; Success: label absent, textarea retained, dynamic indicator scenarios pass the SDD gate.

## Expected files

- T1: `src/app/App.tsx`, `src/features/chat/agent-working-status.ts`, `tests/features/chat/agent-working-status.test.ts`, `src/shared/locales/en.json`, `src/shared/locales/es.json`, `docs/architecture.md`

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

## Tasks

| ID | Specs | Route | Status | Evidence |
|---|---|---|---|---|
| T1 | S1, S2 | delegated gentle-ai-worker (explicit SDD) | done | RED cf96f5b0ee9f13e5182dd527b9c680381392e27b; GREEN d3d67c8014cf2b8e0df29ac7738c67189bdd2c31; official gate PASS |
| V1 | S1, S2 | independent gentle-ai-verify + mechanical gate | done | Original gate recheck exit 0 at head/spec-ref f5ccadd192c3c16b273bd5a81f2096f0ecb56e78; S1.1 N/A, S2.1–S2.6 COMPLIANT; all four checks pass |

## Log

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
