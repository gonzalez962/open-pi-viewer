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
  - No manual model selection has occurred in the current context
  - Restoration has not already executed for this context key
  - Effective profile contains actionable configuration (`default_model` or `default_effort`)
- **Manual selection tracking**: When the user explicitly picks a model or effort via UI controls, `recordManualSelection()` records that context key, preventing subsequent rerenders or refreshes from overwriting user intent.
- **Explicit activation handling**: When the user explicitly activates a profile (`pi:profile-activated`), `resetManualSelection()` clears manual overrides and applies the newly activated profile.

### 2. Request Sequencing & Stale Completion Guard (`src/features/profiles/lib/profileRuntime.ts`, `useProfiles.ts`)
The `ProjectProfileRequestTracker` tags asynchronous profile queries:
- Asynchronous responses from slower prior project queries (e.g. Project A) resolve with an outdated request ID or mismatched working directory.
- `useProfiles` drops stale responses using `requestIdRef` before mutating component state.

### 3. Session Initialization Readiness (`src/features/providers/hooks/useModels.ts`)
`useModels` exposes `isSessionInitialized: boolean`:
- Signals when initial models, thinking levels, and session statistics have completed loading.
- Resets whenever the session changes or the connection is dropped.
- Guarantees `ProfileRuntimeCoordinator` does not race `useModels` or get overwritten by connect-time defaults.

### 4. Application Integration (`src/app/App.tsx`, `useProfileRuntime.ts`)
`App.tsx` coordinates `useModels`, `useProfiles`, and `useProfileRuntime`:
- Routes manual UI model selections from `ChatSessionView` through `handleManualSelectModel`, marking the selection as manual.
- Automatically restores the effective profile (project-specific or inherited global) once the session settles.
