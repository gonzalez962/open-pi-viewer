# Profile Runtime Restoration Architecture

## Context & Motivation

When reloading the application view or switching between projects, the active profile's model and reasoning effort were previously not restored to the runtime session. Instead, connect-time defaults or stale session state prevailed, or late asynchronous completions from previous projects could overwrite newly selected destination project state.

## Web project declarations

In web mode, selecting a project profile publishes its agent overrides to the Gentle profile store and writes `.pi/gentle-ai/profile.json` at the worktree root (or the selected directory outside Git). Desktop is not updated for now. Global activation and preview keep their existing behavior.

Gentle profile names are stable hashes of Open Pi profile IDs, so projects selecting the same profile share its routing. Saving an already published profile updates that shared entry even from another project or without a cwd; declarations are not rewritten and existing sessions are not rebound. Never-published profiles do not implicitly activate or publish. Ownership metadata in the Gentle store prevents overwriting foreign entries; a publication marker in the Open Pi profile lets later saves distinguish published profiles without consulting optional Gentle configuration for inactive profiles. Selecting a legacy profile migrates only that project's declaration. Saving an already-selected pre-marker profile also migrates that declaration without reselection, after verifying its old content hash and stored routing against the profile before the edit. If the explicitly selected project's declaration is missing, saving creates it (and its parent directories) using the stable profile identity, while still checking Gentle store ownership before publication. Existing declarations with mismatched evidence produce an explicit partial-save error instead of claiming synchronization. Old content-hash entries and other declarations remain untouched. If synchronization fails after saving, the error reports the partial save.

Gentle's clone-local pin takes precedence over this declaration. Existing session bindings and persisted or frozen session routing are not rebound; a new session may be needed. Publication is serialized within this server process, not across processes. If `GENTLE_SHELL_PREFIX` is set, the server currently cannot prove the bundled runtime's config destination and fails before writing; bundled use requires a supported verified runtime/config-destination integration rather than a silent fallback.

## Architecture & Core Components

### 1. Production Coordinator (`src/features/profiles/lib/profileRuntime.ts`)
The `ProfileRuntimeCoordinator` provides deterministic state management and sequencing:
- **Session context tagging**: State is tagged to `${cwd}::${sessionId}` to track restoration per project/session.
- **Restoration decision engine**: `decideProfileRestoration` verifies:
  - Connection is active (`isConnected === true`)
  - Session is idle (`!isBusy`)
  - Session parameter initialization is complete (`isSessionInitialized === true`)
  - Profile metadata is loaded (`isProfilesLoaded !== false`) and tagged to current directory (`loadedCwd === cwd`)
  - No manual model selection has occurred in the current context
  - Restoration has not already executed for this context key
  - Effective profile contains actionable configuration (`default_model` or `default_effort`)
- **Stale continuation invalidation & deduplication**: Each restore execution generates a run ID. In-flight continuations check that the run remains current before executing subsequent RPCs (such as setting effort after awaiting model selection), preventing delayed operations from overwriting newer destination contexts. Concurrent restore calls for the same context key are deduplicated.
- **Context switch cancellation during loading or no-profile**: When switching context to a project that is still loading metadata or has no profile assigned, any in-flight restore from the prior context is immediately cancelled, preventing late effort RPCs or false success latching from affecting the destination.
- **RPC failure, retry loop prevention, and lifecycle recovery**: If model selection RPC fails (e.g. backend error or provider offline), the failure is recorded for the context so it does not latch false success (`lastRestoredContextKey` stays unset) and does not spin infinite effect/RPC retry loops on subsequent re-renders. When a genuine lifecycle event occurs (reconnecting or reactivating project/session), failure state is invalidated so restoration can resume automatically without manual reset or timers, while preserving any user manual selection.
- **Manual selection tracking**: When the user explicitly picks a model or effort via UI controls, `recordManualSelection()` records that context key and immediately cancels pending restoration continuations, preventing subsequent rerenders or refreshes from overwriting user intent.
- **Explicit activation handling**: When the user explicitly activates a profile (`pi:profile-activated`), `resetManualSelection()` clears manual overrides and applies the newly activated profile.

### 2. Directory Tagging & Stale Completion Guard (`src/features/profiles/hooks/useProfiles.ts`)
`useProfiles` tags loaded state with `loadedCwd`:
- Asynchronous responses from slower prior project queries (e.g. Project A) resolve with an outdated request ID or mismatched working directory and are dropped.
- `loadedCwd` ensures `effectiveProfile` returns null while destination metadata is loading, preventing source-project profiles from momentarily leaking into the destination project.

### 3. Keyed Session Initialization Readiness & Scoped Target Dispatch (`src/features/providers/hooks/useModels.ts`, `src/features/providers/lib/modelSelection.ts`)
`useModels` and `executeModelSelection` provide:
- Keyed to `sessionId`, `cwd`, and `projectId`: when project or session changes, `isSessionInitialized` is synchronously false on the first render, preventing old session readiness from leaking.
- Sets true only after `loadSessionParams` successfully settles for the active session, directory, and project.
- Guarantees `ProfileRuntimeCoordinator` does not race `useModels` or get overwritten by connect-time defaults.
- Model change and thinking level dispatches carry `targetProjectId`, so asynchronous operations resolving after project switching are routed only to their originating project slice in `multiProjectChatReducer` and cannot mutate the newly active project.
- Errors during model selection are propagated back to callers rather than silently swallowed, notifying the coordinator of failures.

### 4. Application Integration (`src/app/App.tsx`, `useProfileRuntime.ts`)
`App.tsx` coordinates `useModels`, `useProfiles`, and `useProfileRuntime`:
- Routes manual UI model selections from `ChatSessionView` through `handleManualSelectModel`, marking the selection as manual and cancelling pending restoration continuations.
- Automatically restores the effective profile (project-specific or inherited global) once both session initialization and profile metadata load have settled.

### 5. Stable Session Profile Snapshot Architecture (`sessionProfileSnapshot.ts`, D5)
- Captures effective configuration (profile reference, model, provider, reasoning effort) bound to `${cwd}::${sessionId}` on first session load.
- Re-uses this session snapshot across project navigation without re-loading project configurations or clobbering active state.
- Survives view reloads via persistent storage (`PI_VIEWER_SESSION_PROFILE_SNAPSHOTS_STORAGE_KEY`).
- Confirms actual active model with Pi process before marking as restored.
- Retains session configuration when profile definitions are edited on disk (affects new sessions only). Explicit reselection or manual changes update the session snapshot.