# Restore the architecture check (#260)

Objective: Fix the two reported architecture violations without broad suite triage.
Branch: fix/check-arch-260
Trigger: risk items 2 (relocation of credential storage code) and 3 (internal Docker view composition contract).
Scope in: Existing layer and alias rules and affected callers. Scope out: the 48 general-suite failures, dependency changes and installs.
Rollback: Revert the issue-specific commits in reverse order. Success: `npm run check:arch` exits 0 with 9/9 passing.

## Expected files

- T1: `tests/architecture.test.ts`, `tests/features/chat/file-reference-download.test.ts`, `tests/features/docker/docker-view.test.ts`, `tests/features/mcp/argument-roundtrip.test.ts`, `tests/infra/docker-stream.test.ts`
- T2: `src/features/providers/hooks/useModels.ts`, `src/features/sessions/session-actions.ts`, `src/core/session-stats.ts`
- T3: `src/features/settings/SettingsView.tsx`, `src/features/projects/github-clone.ts`, `src/infra/github-credentials.ts`
- T4: `src/app/App.tsx`, `src/app/components/DockerViewAdapter.tsx`, `src/features/docker/DockerView.tsx`, `tests/features/docker/docker-view.test.ts`

## Specs

### S1 — Restore the reported architecture check [behavior]

> si dejemos de fuera de momento los otros 48 fallos, ataquemos ese fallo de check:arch

- `npm run check:arch` MUST pass without weakening either rule.
- **S1.1** Given repository source, when the architecture suite checks feature imports, then the feature layer has no imports of `app` or of sibling features.
- **S1.2** Given repository source and tests, when the architecture suite checks imports, then no retired `@/*` or deep relative imports remain.

## Tasks

| ID | Specs | Route | Status | Evidence |
|---|---|---|---|---|
| T1 | S1.1–S1.2 | worker | done | RED `f5feb74` (7/9); alias fix `c4ab7ce` (S1.2 green, architecture 8/9, affected tests 77/77) |
| T2 | S1.1 | worker | done | `3320914`; affected tests 24/24, provider violation gone |
| T3 | S1.1 | worker | done | `1bd43d5`; affected tests 72/72, Settings violation gone; independent security verification in T5 |
| T4 | S1.1 | worker | done | `eda4578`; architecture 9/9, Docker SSR 63/63, typecheck passed |
| T5 | S1 | independent verifier | in_progress | Verify the committed candidate; no full suite or dependency installs |

## Log

- **L1** Original request: ataquemos este issue que esta molestando en las pruebas https://github.com/gonzalez962/open-pi-viewer/issues/260 igual ya lo hemos detectado, lee el issue en modo lectura sin ejecutar ni instalar nada
- **L2** Implementation authorization: si dejemos de fuera de momento los otros 48 fallos, ataquemos ese fallo de check:arch
- **E1** At `a59324f`, the existing command reproduced both reported failures (1 exit; 7/9). Use those existing tests as RED; label their test names for gate matching without changing the assertions, in a tests-only checkpoint before making either green. Do not add duplicate architecture checks. Test only the affected modules.
- **D1** Choice: use existing layer aliases in tests, keeping Docker dynamic imports after the CSS stub. Alternative: new aliases or exceptions. Rationale: `tsconfig.app.json` and Vite already agree on aliases.
- **D2** Choice: pure stats helper to core, PAT helpers verbatim to infra, with original feature exports re-exporting the same functions. Alternative: duplicate helpers or rewrite callers. Rationale: `session-actions.ts` helper uses only core types and an injected fetch; PAT helpers already depend on infra and Tauri. Preserve guard behavior, PAT data flow, storage key, return types and permissions.
- **E2** Delivery slice boundary: `1bd43d5` closes the credential extraction (315 authored lines cumulative); `eda4578` is a separate 118-line Docker composition slice, for 419 cumulative lines excluding the task document. No remote delivery authorized.
- **D3** Choice: app-owned Docker adapter supplies the existing confirmation and toast UI to the feature. Alternative: expand the narrowly scoped shared React exception. Rationale: `src/app/App.tsx` is the only production DockerView caller; keep its behavior including modal and toast fallback, and exercise the adapter for old standalone test uses. Do not introduce no-op defaults or duplicate toast contexts. Keep `UpdateLogModal` and `subscribeDockerToasts` exports and avoid changing the feature controller.
