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
| T1 | S1-S2 | gentle-ai-worker | in_progress | Base 002a9237f63394ac8ce6ee07d62587bc8ee683b8; tests-only commit pending |
| T2 | S3 | gentle-ai-worker | pending | — |
| T3 | S1-S3 | gentle-ai-verify | pending | Independent matrix and scoped checks |

## Log

- **L1** Original request: quise editar un mcp y paso esto error\n: \n"EPERM: operation not permitted, rename 'C:\\Users\\Personal\\.pi\\agent\\models.json.tmp.26108.1793591947127.9231dada-897c-4eb6-90b2-a2bdd3f05d90' -> 'C:\\Users\\Personal\\.pi\\agent\\mcp.json'" este es el payload {"cmd":"save_mcp_server","args":{"name":"context7","server":{"type":"stdio","serverType":"stdio","enabled":false,"disabled":true,"command":"npx","args":["-y","--package=@upstash/context7-mcp@4.4.4","--","context7-mcp"]},"scope":"global"}}
- **L2** User: continau
- **L3** User: si
- **L4** User: si ademas revisa que otros procesos de guardado o edicion tienen el mismo comportamiento para corregirlo
- **D1 — Replacement strategy.** Choice: one bounded rename-only retry helper per runtime; retain validation, staging and permissions at callers; no destination-delete or backup dance. Alternatives: direct overwrites (non-atomic), unbounded retry (hangs), remove target (data-loss window). Rationale: custom-providers.ts:238-274 shares the MCP failure; config_files.rs:2145 has an unsafe backup fallback; equivalent rename sites exist in activation, storage and Kanban.
- **D2 — Proof boundaries.** Synthetic failures run in isolated test fixtures, never the real user agent directory. Native Windows lock timing is not deterministic; injected platform and rename behavior prove bounded policy. Existing public behavior will be checked against the base where runnable. No package/dependency changes authorized.
- Existing unrelated working change: package-lock.json; do not stage, revert or edit it.
