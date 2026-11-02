# Windows atomic save recovery

Objective: Fix transient Windows rename failures when editing MCP and other persisted configuration.
Branch: fix/server-only-credentials
Trigger: risk item 1 (persisted configuration), item 3 (shared persistence), size (two runtime work units).
Scope in: Existing Node and Rust staged-file save/edit replacements, bounded transient rename recovery and destination preservation.
Scope out: Real user configuration, dependencies, publishing, unrelated package-lock.json changes, multi-file transactions, direct-write redesign.
Rollback: Revert each runtime work-unit commit independently.
Success: Injected transient rename failures recover; permanent failures retain the original destination and surface an error; affected persistence tests pass.

## Expected files

- T1: `server/atomic-file.ts`, `server/storage.ts`, `server/bridge/custom-providers.ts`, `server/bridge/models.ts`, `server/bridge/resource-activation.ts`, `server/bridge/resource-deletion.ts`, `server/bridge/kanban.ts`, `tests/server/atomic-file.test.ts`, `tests/server/mcp-secrets.test.ts`
- T2: `src-tauri/src/atomic_file.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/commands/config_files.rs`, `src-tauri/src/commands/kanban.rs`

## Specs

### S1 — MCP edit survives transient Windows replacement failures [behavior]

> "quise editar un mcp y paso esto error"
> "EPERM: operation not permitted, rename 'C:\\Users\\Personal\\.pi\\agent\\models.json.tmp.26108.1793591947127.9231dada-897c-4eb6-90b2-a2bdd3f05d90' -> 'C:\\Users\\Personal\\.pi\\agent\\mcp.json'"
> "si"

- MCP saves MUST recover from a transient Windows sharing/permission rename failure using bounded retries, without deleting the destination.
- A persistent failure MUST remain visible and MUST preserve the existing destination.
- Assumption: short Windows sharing locks are recoverable; permanent permission failures are not repairable by retry.
- **S1.1** Given the reported context7 global save payload and an injected transient Windows EPERM at replacement, when save_mcp_server runs, then it succeeds and the public inventory reflects the disabled context7 entry while unrelated entries survive.
- **S1.2** Given an existing MCP destination and persistent Windows EPERM, when save_mcp_server runs, then it fails, the original destination is unchanged and the temporary file is cleaned up.

### S2 — Other Node save/edit replacements use the same protection [behavior]

> "si ademas revisa que otros procesos de guardado o edicion tienen el mismo comportamiento para corregirlo"

- Existing Node staged save/edit replacements MUST share bounded Windows transient rename recovery without deleting or moving away the destination.
- Existing serialization, permission handling and successful public results MUST remain unchanged.
- **S2.1** Given staged Node persistence and transient Windows EPERM/EBUSY/EACCES, when replacement is attempted, then bounded retry succeeds with the expected destination contents.
- **S2.2** Given permanent or non-retryable rename failure, when Node replacement runs, then it reports the failure, preserves the original destination and cleans staged data; non-retryable failures are attempted once.

### S3 — Desktop save/edit replacements use equivalent protection [behavior]

> "si ademas revisa que otros procesos de guardado o edicion tienen el mismo comportamiento para corregirlo"

- Existing Rust staged save/edit replacements MUST use bounded Windows sharing/access-denied retry without removing the destination first.
- **S3.1** Given transient Windows sharing/access-denied failure, when a desktop staged replacement runs, then it retries to success and preserves the intended contents.
- **S3.2** Given persistent or non-retryable desktop replacement failure, when replacement runs, then it reports failure, preserves the original destination, cleans staged data and attempts non-retryable failures only once.

## Tasks

| ID | Specs | Route | Status | Evidence |
|---|---|---|---|---|
| T1 | S1-S2 | gentle-ai-worker | done | RED 6861770; implementation 0597f42; GREEN 8/8; Kanban 12/12; TypeScript exit0; dependent inventory failure reproduced on base |
| T2 | S3 | gentle-ai-worker | done | RED b940b36; implementation ef28285; GREEN 2/2; config_files 87/87; Kanban 1/1; independent static review found no concrete defect |
| T3 | S1-S3 | gentle-ai-verify | blocked | Needs human decision: gate exit2 (no JUnit report), compatibility differential unavailable; no further automatic verification |

## Log

- **L1** Original request: quise editar un mcp y paso esto error\n: \n"EPERM: operation not permitted, rename 'C:\\Users\\Personal\\.pi\\agent\\models.json.tmp.26108.1793591947127.9231dada-897c-4eb6-90b2-a2bdd3f05d90' -> 'C:\\Users\\Personal\\.pi\\agent\\mcp.json'" este es el payload {"cmd":"save_mcp_server","args":{"name":"context7","server":{"type":"stdio","serverType":"stdio","enabled":false,"disabled":true,"command":"npx","args":["-y","--package=@upstash/context7-mcp@4.4.4","--","context7-mcp"]},"scope":"global"}}
- **L2** User: continau
- **L3** User: si
- **L4** User: si ademas revisa que otros procesos de guardado o edicion tienen el mismo comportamiento para corregirlo
- **D1 — Replacement strategy.** Choice: one bounded rename-only retry helper per runtime; retain validation, staging and permissions at callers; no destination-delete or backup dance. Alternatives: direct overwrites (non-atomic), unbounded retry (hangs), remove target (data-loss window). Rationale: custom-providers.ts:238-274 shares the MCP failure; config_files.rs:2145 has an unsafe backup fallback; equivalent rename sites exist in activation, storage and Kanban.
- **D2 — Proof boundaries.** Synthetic failures run in isolated test fixtures, never the real user agent directory. Native Windows lock timing is not deterministic; injected platform and rename behavior prove bounded policy. Existing public behavior will be checked against the base where runnable. No package/dependency changes authorized.
- Existing unrelated working change: package-lock.json; do not stage, revert or edit it.
- **D3 — Review slice boundary.** Prior branch work through 002a9237f63394ac8ce6ee07d62587bc8ee683b8 is outside this feature. Windows persistence review starts at 1230450 (specification), with separate Node and Rust implementation commits; no accumulated-branch review or publication is authorized. Split implementation units if their authored diff exceeds approximately 400 lines.
- **L5 — RED review.** Initial Node RED had 4 failing new tests / 3 existing passes, but S1.1/S2.1 failed on the temporary filename before injecting EPERM. Corrected assertion order. Accepted RED at 6861770: `./node_modules/.bin/tsx --tsconfig tsconfig.app.json --test tests/server/atomic-file.test.ts tests/server/mcp-secrets.test.ts`, exit 1, 7 tests / 3 pass / 4 fail. S1.1/S2.1 injected EPERM; S1.2/S2.2 attempts: 1. No implementation yet at this commit.
- **L6 — Disjoint preparation.** T2 Rust tests-only preparation runs concurrently with T1 Node implementation; only T1 is the visible primary task. No overlapping allowed edit surfaces.
- **L7 — Rust runner ownership.** Rust worker has no background execution tool. Parent executes focused Cargo commands with bash_background using in-project src-tauri/target artifacts; worker only prepares source/tests. No external directory access or dependency changes are needed.
- **L8 — Node GREEN and dependent failure.** Focused Node command from L5 exit 0, 8 pass. Scoped storage/model/provider/resource dependent run exit 1: 97 pass, 1 fail, 1 skip. Partial local MCP definitions expected ['data.js'], got [] (baseline status not established). Native probe skipped because PI_VIEWER_NATIVE_PROBE_MODULE unset. Independent verifier investigating baseline and ordinary differential behavior.
- **L9 — Rust RED.** `cargo test --manifest-path src-tauri/Cargo.toml windows_atomic_save -- --nocapture` exit 101; 2 fail / 0 pass / 315 filtered. Both fail on 'destination moved' exposing backup fallback. Commit b940b36 includes tests plus rename injection routing seam; tests-only gate limitation must be reported, not concealed. Rust implementation authorized after observed RED.
- **L10 — Independent Node evidence.** Verifier reran focused tests exit0 8pass; Kanban exit0 12pass. Base targeted inventory test exit1 with same [] vs ['data.js'] failure, proving it predates this work (models.ts intentionally redacts args). Static audit confirms all 12 baseline server rename sites route through helper. Optional native probe remains skipped, not passed.
- **L11 — Final runtime evidence.** TypeScript `./node_modules/.bin/tsc -b --pretty false` exit0. Rust job-3 exit0: windows_atomic_save 2pass; commands::config_files::tests 87pass; commands::kanban::tests 1pass. Only linker informational warning. Independent Rust static reviewer found no concrete defect; raw Windows error33/native locking not directly tested.
- **L12 — Missing verification / decision stop.** Node gate attempted once with base002a923, red6861770, head0597f42, only S1,S2 and JUnit reporter; exit2: no JUnit report at atomic-save-results.xml. No mechanical scenario matrix available; Rust gate not run (no JUnit adapter and tests-only routing-seam limitation). Base/current public-interface differential not executed because verifier scratch restrictions conflict with project read boundaries. Do not claim full compatibility or spec-guard completion. Needs human decision on separately authorizing repair of verification tooling versus retaining partial proof. No further automatic checks.
- **L13 — Assessment.** RDD off. Node assessment initially native-unassessable due then-untracked Rust helper, plan independent verifier. Rust committed range assessment native medium/escalated item1 high, reviewDue false, plan writer self-verification plus independent verifier; both runtime checks and static independent reviews obtained. No push or PR performed. package-lock.json untouched.
