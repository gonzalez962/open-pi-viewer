# Built-in provider configuration catalog
Objective: Display complete runtime model catalog in built-in provider configuration so users can configure model filters.
Baseline: 2e518ed02c4f01a1c010bc297d9ada8ad2838f6e
Trigger: size (shared helper, web/desktop bridges and editor integration).
Scope in: Dedicated read-only configuration catalog command, editor initial load and refresh, existing custom-style filters.
Scope out: Chat picker/filter changes, provider aliases, fabricated model lists, OAuth changes, real login or personal credential inspection, publishing.
Rollback: Revert only this feature's commits.
Success: Built-in configuration shows complete provider models without an active chat session and preserves existing inclusion/exclusion settings.

## Expected files

- T1: `src-tauri/pi-oauth-helper.mjs`, `src-tauri/src/commands/oauth.rs`, `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs`, `server/bridge/oauth.ts`, `server/web-ipc-bridge.ts`, `src/infra/bridge.ts`, `src/features/providers/ProvidersView.tsx`, `src/features/providers/hooks/useProviderModalForm.ts`, `tests/infra/oauth-helper.test.ts`, `tests/server/oauth.test.ts`, `tests/server/oauth-dispatch.test.ts`, `tests/features/providers/builtin-model-editor.test.ts`

## Specs

### S1 — Complete catalog in provider configuration [behavior]

> "donde necesito ver los modelos es en la configuracion de los providers ahi no se ven. para poder seleccionar que debo usar"
> "si correcto porque en la vista de configuracion necesito poder hacer los filtros como en los demas providers customs"

- Built-in provider configuration MUST load the complete catalog for the exact provider ID from Pi runtime, independent of chat session, authentication availability and picker restrictions.
- Initial editor load and its refresh MUST use the configuration catalog and merge existing model overrides and inclusion/exclusion policies.
- **S1.1** Given a built-in provider without an active chat session, when its catalog is requested in web or desktop, then runtime catalog models and accurate editor metadata are returned for only that provider.
- **S1.2** Given restrictive settings and saved provider policies, when opening or refreshing its configuration, then catalog models remain available for editing and saved policies remain intact.

### S2 — Preserve boundaries [existing]

> "si correcto porque en la vista de configuracion necesito poder hacer los filtros como en los demas providers customs"

- Chat MUST continue using its existing authenticated model source and filters; openai and openai-codex MUST remain distinct.
- Catalog responses MUST expose only allowlisted model metadata, never credentials or arbitrary provider fields.
- Catalog queries MUST NOT mutate user settings, authentication or model configuration, initiate OAuth/network refreshes, or bypass existing web request authorization.
- **S2.1** Given catalog loading, when configuration is queried, then chat source/filter behavior is unchanged and provider IDs remain distinct.
- **S2.2** Given catalog source with extra sensitive fields, when projected, then only safe model metadata is returned and configuration files remain unchanged.

## Tasks

| ID | Specs | Route | Status | Evidence |
|---|---|---|---|---|
| T1 | S1,S2 | delegated (SDD size route) | in_progress | RED/GREEN pending |

## Log

- **D1 — Separate catalog.** Choice: helper catalog action backed by runtime.getModels with refreshOnCreate:false; dedicated web/desktop command. Alternative: reuse chat available snapshot. Rationale: snapshot depends on session/authentication; web existing source is incomplete.
- **D2 — Scope.** Do not change getAvailableModelsPi/useModels or enabledModels semantics. Do not alias distinct providers. User specifically requests configuration filtering like customs.
- **D3 — Safety.** Reuse existing subprocess resolution, confinement, validation and request authorization. Do not add catalog to authentication-mutating paths unnecessarily. Parent source inspection confirms web catalog defect; explorer claims of completely nonmutating helper setup require verification (existing helper creates effective home). Catalog action should avoid creating files/directories merely to enumerate models where feasible.
- **D4 — Evidence.** Tests-only RED commit must execute failing S1 assertions rather than import crashes. S2 protects existing behavior with GREEN. Tests use temporary homes and fixture SDK only; no personal auth/settings reads or login. Preserve Cargo.toml line-ending dirt.
