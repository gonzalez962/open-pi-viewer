# Visible MCP arguments
Objective: Expose editable MCP arguments while retaining other credential redaction.
Trigger: risk item 2 (intentional credential visibility policy change).
Scope in: MCP argument response and editor hint; env/header/URL protection unchanged. Scope out: all other credential policy.
Rollback: Revert this feature work unit. Success: API returns arguments and editor receives them, other secrets remain absent.

## Expected files
- T1: `server/bridge/models.ts`, `tests/server/mcp-secrets.test.ts`, `src/features/mcp/components/McpModal.tsx`, `src/features/mcp/types.ts`, `tests/features/mcp/argument-roundtrip.test.ts`, `src/shared/locales/en.json`, `src/shared/locales/es.json`, `README.md`

## Specs
### S1 — Visible editable arguments [behavior]
> "listo ya encontre el fallo. otra cosa con los cambios realizados para asegurar los secretos o credenciales, los argumentos de los mcps estan ocultos y la verdad seria obligacion del usuario usar las variables de entorno para agregar secretos a los mcps"
> "si aplica"
- Context: user accepted exposing only MCP arguments, preserving environment/header/URL redaction.
- MCP inventory MUST return the configured arguments so the existing editor can display and edit them. Environment values, header values and URLs MUST remain redacted.
- **S1.1** Given an MCP with arguments and env/header/URL secrets, when inventory is requested, then arguments match stored values and other secret values remain absent.
- Argument help MUST state that arguments are visible and secrets belong in environment variables. The editor MUST NOT show a masked-arguments placeholder.
- **S1.2** Given stored arguments containing whitespace, quotes, backslashes or empty values, when inventory is loaded into the editor and saved unchanged, then the exact argument array survives and other secrets remain redacted.
- **S1.3** Given configured arguments, when the user clears the editor argument field and saves, then inventory returns an empty argument array while unrelated fields and secrets remain unchanged. Omitted args in partial API updates MUST still preserve stored arguments.

## Tasks
| ID | Specs | Route | Status | Evidence |
|---|---|---|---|---|
| T1 | S1 | gentle-ai-worker | blocked | Needs human decision: final review found manual quoted Windows trailing-backslash/UNC parser regression; implementation uncommitted |
| T2 | S1 | gentle-ai-verify | blocked | Bounded correction/recheck exhausted; static regression not yet reproduced, no further automatic verification |

## Log
- L1 user: listo ya encontre el fallo. otra cosa con los cambios realizados para asegurar los secretos o credenciales, los argumentos de los mcps estan ocultos y la verdad seria obligacion del usuario usar las variables de entorno para agregar secretos a los mcps
- L2 assistant scope accepted: ¿Querés que deje visibles y editables **solamente los argumentos**, manteniendo la protección actual de valores de variables de entorno, headers y URL?
- L3 user: si aplica
- D1 Choice: return actual args in existing inventory sanitizer, retain metadata and all other redaction, remove masked placeholder and update hints. Alternatives: hide all args (prevents editing), automatic secret detection (unrequested/unreliable). Rationale: models.ts:130-132 currently empties args; existing form maps server args to argsText.
- User explicitly accepts responsibility for secrets placed in visible args; env support depends on actual MCP server.
- Existing package-lock.json change is unrelated and must remain untouched. Prior windows-atomic-saves verification blocker is separate, not reopened.
- L4 RED: `npm exec -- tsx --tsconfig tsconfig.app.json --test --test-name-pattern="S1.1 MCP inventory" tests/server/mcp-secrets.test.ts`, exit1, actual [] expected ['secret-argument']; prior redaction assertions pass. Tests-only commit6d810a7; implementation resumed.
- D2 Review slice: base b7af738, RED6d810a7, upcoming implementation commit; prior persistence/credential branch work excluded. No push or PR authorized.
- L5 GREEN evidence: combined `npm exec -- tsx --tsconfig tsconfig.app.json --test tests/server/mcp-secrets.test.ts tests/features/mcp/mcp.test.ts` exit1,10pass1fail. All5 server tests including S1.1 and edited args roundtrip pass; preview fallback addStdioRes.success expected true got false at frontend test339. Independent reviewer checks baseline before attributing failure.
- L7 Independent review found existing format/parse does not roundtrip quotes/empty strings and empty editor omits args. These prevent requested editing and are necessary in-scope correction. One bounded correction batch adds S1.2/S1.3 tests and fixes, then one recheck. Existing blank-array preservation test must reflect intentionally changed explicit-clear behavior, while omission preserves. Preview failure statically established pre-existing: bridge and test unchanged versus RED; bridge rejects preview args/env.
- L8 Correction evidence: `npm exec -- tsx --tsconfig tsconfig.app.json --test tests/features/mcp/argument-roundtrip.test.ts` exit1,0pass2fail; S1.2 loses whitespace/quotes/empty args and S1.3 retains original args. Then combined argument-roundtrip + mcp-secrets exit0,8pass. Format quotes/escapes each value; parse decodes generated quotes/backslashes. Explicit[] clears, omission preserves. Final reviewer rechecks only these blockers; final tsc job6 running. No differential/gate proof available, not claimed.
- L10 User: listo crea commit. Explicitly authorized committing current implementation, not further parser correction or publishing. Known Windows manual-entry finding remains unresolved; focused8pass and final TypeScript exit0. Exclude unrelated package-lock.json.
- L9 Final bounded review found static manual-entry regression: double-quoted Windows directory ending with backslash, e.g. `"C:\Program Files\"`, splits into fragments; quoted UNC double backslashes collapse. Generated-prefill roundtrip tests pass but do not cover these existing manual inputs. No independent executable reproduction yet. Correction/recheck budget exhausted: stop for human decision before further changes; do not claim final completion or commit implementation. Final TypeScript job6 may still complete asynchronously.
- L6 TypeScript `./node_modules/.bin/tsc -b --pretty false` exit0. ASSESS escalated item2 -> independent verifier required, RDDoff, reviewDue false. Assessment includes unrelated pre-existing package-lock.json; that path is not part of this implementation and will not be committed.
