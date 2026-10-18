# Profile Runtime Restoration Architecture

## Context & Motivation

When reloading the application view or switching between projects, the active profile's model and reasoning effort were previously not restored to the runtime session. Instead, connect-time defaults or stale session state prevailed, or late asynchronous completions from previous projects could overwrite newly selected destination project state.

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
- **Manual selection tracking**: When the user explicitly picks a model or effort via UI controls, `recordManualSelection()` records that context key and immediately cancels pending restoration continuations, preventing subsequent rerenders or refreshes from overwriting user intent.
- **Explicit activation handling**: When the user explicitly activates a profile (`pi:profile-activated`), `resetManualSelection()` clears manual overrides and applies the newly activated profile.

### 2. Directory Tagging & Stale Completion Guard (`src/features/profiles/hooks/useProfiles.ts`)
`useProfiles` tags loaded state with `loadedCwd`:
- Asynchronous responses from slower prior project queries (e.g. Project A) resolve with an outdated request ID or mismatched working directory and are dropped.
- `loadedCwd` ensures `effectiveProfile` returns null while destination metadata is loading, preventing source-project profiles from momentarily leaking into the destination project.

### 3. Keyed Session Initialization Readiness (`src/features/providers/hooks/useModels.ts`)
`useModels` exposes synchronous `isSessionInitialized: boolean`:
- Keyed to `sessionId`: when the session changes, `isSessionInitialized` is synchronously false on the first render, preventing old session readiness from leaking.
- Sets true only after `loadSessionParams` successfully settles for the active session.
- Guarantees `ProfileRuntimeCoordinator` does not race `useModels` or get overwritten by connect-time defaults.

### 4. Application Integration (`src/app/App.tsx`, `useProfileRuntime.ts`)
`App.tsx` coordinates `useModels`, `useProfiles`, and `useProfileRuntime`:
- Routes manual UI model selections from `ChatSessionView` through `handleManualSelectModel`, marking the selection as manual and cancelling pending restoration continuations.
- Automatically restores the effective profile (project-specific or inherited global) once both session initialization and profile metadata load have settled.
