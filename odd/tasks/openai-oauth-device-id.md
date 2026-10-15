# OpenAI OAuth installation identity
Objective: Supply Pi's official installation identity callback from the shared OAuth helper.
Baseline: 2ef4804f486d33ece5a50a3f5665ee989b8c6bc9
Trigger: risk item 2 (authentication integration).
Scope in: Shared helper login callback, isolated regression tests, OAuth integration documentation.
Scope out: Real login, user credentials/settings, provider protocol changes, static allowlist changes, publishing.
Rollback: Revert this feature's commits only.
Success: New OpenAI login receives a stable installation UUID using Pi SettingsManager; legacy flow remains functional.

## Expected files

- T1: `src-tauri/pi-oauth-helper.mjs`, `tests/infra/oauth-helper.test.ts`, `docs/web-oauth.md`

## Specs

### S1 — Official installation identity [behavior]

> "solo deja el icono sin fondo, luego crea commit y despues revisa este error Sign in with ChatGPT requires a device ID (UUID) for this installation con el provider nuevo de OPENAI, porque el legacy funciona el nuevo es que falla"
> "si implementa"

- Shared helper MUST supply the official fourth login argument `getDeviceId`, backed by SDK SettingsManager and the effective agent home.
- Identity MUST be stable across helper subprocesses and MUST NOT be generated anew for each login.
- Existing settings and credentials MUST be preserved; tests MUST use isolated temporary homes without real authentication/network.
- **S1.1** Given a new OpenAI login requiring installation identity, when helper invokes SDK login, then a valid UUID is available through the official callback instead of the reported missing-device-ID error.
- **S1.2** Given subsequent helper logins against the same temporary agent home, when the callback is used, then the same UUID is returned and unrelated settings remain unchanged.

### S2 — Preserve legacy login [existing]

> "porque el legacy funciona el nuevo es que falla"

- The helper MUST preserve existing legacy login and cancellation behavior.
- **S2.1** Given the legacy provider, when login runs, then existing success and interaction behavior remains intact without requiring the provider to request identity.

## Tasks

| ID | Specs | Route | Status | Evidence |
|---|---|---|---|---|
| T1 | S1, S2 | delegated (spec-guard authentication risk) | in_progress | Baseline recorded; RED/GREEN pending |

## Log

- **L1 — Request.** Original request and implementation authorization are quoted verbatim in Specs.
- **D1 — SDK contract.** Choice: SDK SettingsManager plus fourth login argument `{ getDeviceId: () => settingsManager.getOrCreateDeviceId() }`. Alternatives: invented runtime constructor options or standalone device-id file. Rationale: authorized SDK source inspection confirmed interactive-mode.js:5270 and settings-manager.js:829-835; project helper currently omits options at login invocation.
- **D2 — Shared fix.** Both web and desktop spawn src-tauri/pi-oauth-helper.mjs. No provider allowlist changes: dynamic discovery already reaches the new provider, and allowlist omission is not this failure's cause.
- **D3 — Evidence.** S2 is existing behavior, verified GREEN; S1 requires executed failing assertions at a tests-only RED commit, not import errors. Do not repeat prior feature's SDD evidence defect.
- **D4 — Scope safety.** Preserve content-free src-tauri/Cargo.toml dirt. No personal auth/settings reads, real OAuth requests, or logging UUID/credentials. User authorized reading the specific installed SDK package for contract verification, not unrelated paths.
