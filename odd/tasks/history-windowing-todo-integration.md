# Conversational history and ToDo integration

Objective: Preserve complete ToDo restoration while introducing conversational history windows in web and Tauri.
Issue: https://github.com/gonzalez962/open-pi-viewer/issues/175
Base: 26fd04688e021600eb02416b57a14b1c1f4dbf31
Delivery: feature-branch-chain selected by user; draft tracker and two review slices. No merge into main authorized.
Rollback: Revert the feature slices; stored session files are unchanged.

## Specs

- S1: "vale resuelve para mantener ambas funcionalidades correctamente" — ToDo MUST be derived from full history; returned messages and hasMore MUST use conversational windowing.
- S2: "Cadena sobre rama de la característica (recomendado)" — Web and Rust MUST remain separate focused review slices with their tests.
- S3: "tengo conflictos en un archivo que esta chocando con otra implementacion que tambien quiero mantener revisa y me das el diagnostico antes de aplicar cualquier cosa" — The ToDo restoration from main MUST NOT be removed.

## Tasks

| ID | Specs | Route | Status | Commit |
|---|---|---|---|---|
| T1 | S1,S3 | parent | done | d862413 conflict resolution; 37 scoped tests, TypeScript, whitespace checks pass |
| T2 | S2 | parent | in_progress | Reconstruct tracker, web slice (259 lines), Rust slice (162 lines); preserve final source tree |
| T3 | S1-S3 | parent | pending | Publish draft chain and update existing PR #176 base without merging main |

## Log

- Original request: "vale resuelve para mantener ambas funcionalidades correctamente".
- User chose "Cadena sobre rama de la característica (recomendado)" after combined regression increased the PR to421 changed lines.
- Conflict reproduced by merge --no-commit origin/main: only two hunks in server/bridge/sessions.ts; windowMessages and todoFromHistory composed rather than choosing one side.
- New combined test preserves older ToDo outside the visible history,70 activity records,custom limit,loadAll and cross-session isolation. First run37/37 passed but TypeScript failed new test inference; fixed annotations/narrowing, final run37/37 and TypeScript passed (job30 exit0).
- Rust empty-text parity repair already observed RED then3 focused tests passed; Rust source unchanged by conflict resolution.
- Final combined reference d862413. Original branches and main worktree notes preserved. No dependency changes or main integration.
