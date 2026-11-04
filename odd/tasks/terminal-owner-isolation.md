# Isolated terminal sessions per owner

Objective: Remove directory ownership collisions without sharing terminal processes between identities.
Branch: fix/terminal-project-switch-path
Trigger: risk item 2 (terminal owner isolation/security)
Scope in: Web terminal manager indexing, owner-scoped lifecycle, regression tests, terminal documentation.
Scope out: Authentication changes, ownership transfer, automatic termination of other identities, frontend project routing, native single-user terminal, dependencies.
Rollback: Revert this work unit to restore exclusive canonical-directory indexing.
Success: Two authenticated identities open distinct terminals in one directory; reattachment and all operations remain owner-scoped.

## Expected files

- T1: `server/terminal/terminal-manager.ts`, `tests/server/terminal-security.test.ts`, `tests/server/terminal-regression.test.ts`, `tests/server/terminal-backend.test.ts`, `docs/terminal.md`

## Specs

### S1 — Separate sessions per identity [behavior]

> "continua la reparacion del bug de terminal"
> "Separate sessions per identity (recommended)"

- Different server-derived owners MUST be able to open separate terminal sessions for the same canonical directory without the reported directory ownership error.
- Reopening a live terminal with the same owner and canonical directory MUST reattach to that owner's session.
- **S1.1** Given owner A has a live terminal in a directory, when owner B opens that directory, then B receives a distinct terminal and each owner can independently reopen, get by cwd, list, and poll only their own session.
- **S1.2** Given both owners have terminals in one directory, when A closes its terminal and reopens the directory, then A receives a new session while B retains its original session and remains able to poll and reattach.

### S2 — Retain access isolation [behavior]

> "Separate sessions per identity (recommended)"

- The choice means independent terminals, not permission to access another identity's process.
- Existing server-side access checks MUST continue to reject cross-owner write, resize, poll, and close by session ID, and hide sessions from cross-owner get/list.
- Missing identity MUST NOT grant access to an identified owner's terminal; the public HTTP authentication/loopback policy MUST remain unchanged.
- **S2.1** Given separate A and B terminals in the same directory, when B attempts operations against A's ID, then write/resize/poll/close are rejected, get returns null, B's list excludes A, and A's session remains usable and unchanged by the rejected operations.

## Tasks

| ID | Specs | Route | Status | Evidence |
|---|---|---|---|---|
| T1 | S1, S2 | gentle-ai-worker; spec-guard security route | in_progress | Base 37d4cedb6951b854606359876d418f8fbad5164d; tests-only RED 4a6cae8; worker GREEN exit 0; scoped terminal regressions 16/16; independent verification pending |

## Log

- **L1** Original resumption request: "continua la reparacion del bug de terminal".
- **L2** User requested: "Review the delivered subagent output and continue."
- **L3** User selected: "Separate sessions per identity (recommended)" (isolated_per_owner).
- **D1 — Scope the fix to manager ownership indexing.** Choice: distinguish canonical-directory sessions by server-derived owner while retaining ID authorization. Alternatives: globally exclusive directories or ownership transfer. Rationale: terminal-manager currently indexes globally by cwd and rejects another owner; oauth-access can mint a new owner after a fresh login. There is no evidence of a wrong project cwd. Ownership transfer would expose an existing process and is not authorized.
- **D2 — Regression evidence.** Existing security test expects an undefined-owner open to fail only because an owned session occupies the directory. Update that outdated exclusivity assertion consistently with per-owner sessions while preserving HTTP authorization and rejection of cross-owner ID operations. Undefined and any string owner must never alias in the indexing representation.
- **D3 — Kind classification.** Selected outcome changes runtime behavior, so scenarios require RED/GREEN; no visual change or existing-only scenario is introduced.
- **E2** Worker reproduced the exact owner collision through public IPC (exit 1, stderr empty), focused command `npx tsx --tsconfig tsconfig.app.json --test --test-name-pattern="S1.1 S1.2 S2.1" tests/server/terminal-security.test.ts`. Logs: `C:\Users\Personal\AppData\Local\Temp\gpuCE44S\gaEE67cb\terminal-owner-red-gon1ih\`. Parent reviewed tests-only diff and committed RED as `4a6cae8`; production unchanged. Review note: asynchronous shell output can make exact DTO replay snapshots unstable; use observable stable fields or synchronization, and ensure each scenario ID is independently evidenced for gate.
- **E3** Worker implemented owner+canonical-cwd tuple indexing and retained per-ID guards. Focused GREEN exit 0; scoped security/regression/backend tests 16/16 pass. JUnit reporter runs successfully. Post-RED snapshot assertion changed to stable ID/PID/dimensions/liveness plus forbidden-input absence because shell startup output is asynchronous. Differential attempt is incomplete: base snapshot cannot resolve node-pty (base exit 1, current exit 0); no differential success claimed. Logs under `C:\Users\Personal\AppData\Local\Temp\gpuCE44S\gaV27mTA\`. Assessment: `reviewDue:false`, `reviewDueReason:under_budget`, RDD off; risk item 2 requires independent verifier. Implementation awaiting mechanical gate and independent verification.
- **E1** Journal reports zero uncertain mutations. Tracked working tree initially clean; unrelated untracked `.worktrees/` must remain untouched. Explorer ran no tests and did not reproduce the actual browser incident.
