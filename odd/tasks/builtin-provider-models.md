# Built-in provider model editing

Objective: Edit authenticated built-in providers using the existing model editor and honor Pi enabledModels without modifying it.
Branch: audit/web-bridge-endpoints
Trigger: size (UI, model policy and web/desktop settings integration)
Scope in: Logged-in built-in model editor, provider overrides in models.json, read-only enabledModels support in web and Tauri, functional tests.
Scope out: Authentication changes, writing enabledModels, publishing, unrelated provider/profile refactors.
Rollback: Revert only this feature's implementation commits.
Success: Connected built-in providers expose a functional model editor; saved overrides survive reload; model pickers honor existing enabledModels and provider policies.
Baseline: 12ee2657715dca0207ead551ed90467b93da36f5

## Expected files

- T1: `src/features/providers/ProvidersView.tsx`, `src/features/providers/components/BuiltinOAuthAccounts.tsx`, `src/features/providers/components/ProviderModal.tsx`, `src/features/providers/components/ProviderModelDraftList.tsx`, `src/features/providers/hooks/useProviderModalForm.ts`, `src/features/providers/hooks/useProvidersData.ts`, `src/features/providers/hooks/useModels.ts`, `src/features/providers/providers.ts`, `src/features/providers/types.ts`, `src/core/types/providers.ts`, `src/infra/bridge.ts`, `src/shared/locales/en.json`, `src/shared/locales/es.json`, `server/bridge/models.ts`, `server/bridge/custom-providers.ts`, `server/web-ipc-bridge.ts`, `src-tauri/src/commands/config_files.rs`, `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs`, `tests/features/providers/builtin-model-editor.test.ts`, `tests/features/providers/enabled-models.test.ts`, `tests/server/enabled-models.test.ts`

## Specs

### S1 — Connected built-in model editor [behavior]

> "en los Built-in Providers los que esten logueados agrega la funcion para poder editar los modelos como en los customs providers ya que en mi caso tengo una configuracion restrictiva de que modelos estan habilitados para mostrar en pi, y si existe ese key enabledModels en settings.json tambien deberian agregarse si aun no esta la funcion"

- Authenticated built-in provider cards MUST expose model editing using the existing custom-provider model editor capabilities.
- The editor MUST load the provider catalog and existing saved overrides, including models hidden by restrictive picker settings, so the policy remains editable.
- Built-in editing MUST NOT require or fabricate a replacement API key/base URL/API type for OAuth providers.
- Saved edits MUST preserve unrelated provider configuration and authentication.
- **S1.1** Given connected and disconnected provider cards, when rendered, then only connected cards expose model editing.
- **S1.2** Given a connected built-in provider with catalog models and saved overrides, when editing, then the existing models and inclusion/exclusion policies are loaded, without requiring custom connection credentials.
- **S1.3** Given edited built-in models and policies, when saved and reloaded, then the edits persist in models.json while unrelated configuration remains intact.

### S2 — Read-only global model restrictions [behavior]

> "en los Built-in Providers los que esten logueados agrega la funcion para poder editar los modelos como en los customs providers ya que en mi caso tengo una configuracion restrictiva de que modelos estan habilitados para mostrar en pi, y si existe ese key enabledModels en settings.json tambien deberian agregarse si aun no esta la funcion"

User selected: "Como los personalizados (recomendado)" — save per-provider configuration in models.json and honor existing enabledModels without modifying the global list.

- The viewer MUST read enabledModels from Pi settings.json in both web and desktop modes.
- Nonempty enabledModels MUST restrict model picker results according to Pi's actual pattern contract; provider inclusion/exclusion restrictions MUST also apply.
- Missing or empty enabledModels MUST preserve unrestricted behavior.
- This feature MUST NOT write enabledModels.
- Settings read failures MUST NOT silently remove an established restrictive policy; errors SHOULD follow existing UI error conventions.
- **S2.1** Given nonempty enabledModels with exact references and wildcard patterns, when models load or refresh, then only matching models also allowed by provider policy appear.
- **S2.2** Given missing or empty enabledModels, when models load, then existing provider filtering behavior is unchanged.
- **S2.3** Given settings.json in web and desktop modes, when restrictions are read, then the same enabledModels values are returned without modifying the file or unrelated settings.

## Tasks

| ID | Specs | Route | Status | Evidence |
|---|---|---|---|---|
| T1 | S1, S2 | delegated (SDD size route) | pending | Baseline recorded; RED/GREEN pending |

## Log

- Original request is quoted verbatim in S1 and S2.
- **D1 — Persistence.** Choice: provider overrides in models.json and read-only global enabledModels. Alternative: editing global enabledModels. Rationale: user explicitly chose per-provider persistence; global writes could hide other providers.
- **D2 — Shared editor.** Choice: reuse existing ProviderModal and model-form flow with a built-in mode. Alternative: a separate duplicate editor. Rationale: existing custom editor already implements model metadata and inclusion/exclusion patterns.
- **D3 — Scope preservation.** Five prior local-change commits were explicitly authorized and completed before baseline. Only src-tauri/Cargo.toml retains content-free line-ending dirt, which this feature must not stage or modify.
- **D4 — Pattern semantics.** Explorer claims about negations are unverified. Writer must inspect installed Pi model scope implementation and follow actual enabledModels semantics, not invent new patterns.
- **D5 — Composer compatibility & resolver alignment.** Pi's installed `provider-composer.js` requires `baseUrl`, `headers`, `compat`, `modelOverrides`, `models`, `apiKey`, `oauth`, or `authHeader` for any provider entry in `models.json`. Built-in provider overrides without `baseUrl`/`api` persist a clean `compat: {}` object to satisfy the Pi composer without fabricating fake URLs or credentials. The model restriction matcher aligns directly with Pi's `resolveModelScopeFromModels` using `minimatch` for globs (`*`, `?`, `[...]`) and single-model alias/dated preference for non-glob fuzzy references.
