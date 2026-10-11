# Architecture & System Design

This document details the layered architecture of Pi Viewer, including its frontend dependency hierarchy, modular Rust backend, testing conventions, and mechanical boundary enforcement.

---

## 1. Overview & Architectural Principles

Pi Viewer began as a flat proof-of-concept and was restructured into a screaming architecture with strict dependency boundaries:

- **Hexagonal Boundary at Tauri IPC**: All native communication routes through typed IPC adapters (`src/infra/bridge.ts`) and bounded Rust domain modules (`src-tauri/src/commands/`).
- **Explicit Dependency Direction**: Inner layers know nothing about outer layers.
- **Zero Flat Clutter**: Every source module lives in an assigned layer or feature directory (`src/` root contains 0 flat files).
- **Separation of Tests**: Frontend tests live exclusively under `tests/` mirroring `src/`, discovered automatically by glob without manual registration.
- **Pure Logic Before React Glue**: State transitions, protocol parsing, and decision trees are implemented as pure, framework-agnostic units with separate unit tests; React components and hooks remain thin presentation and composition wrappers.

---

## 2. Frontend Layered Architecture

The frontend is structured into five concentric layers:

```
src/
  app/          Application shell, entry point, global view composition
  features/     Feature domains (chat, projects, providers, sessions, settings, workspace)
  infra/        Platform adapters (Tauri bridge, opener, preferences storage)
  shared/       Cross-cutting utilities (tokens, base CSS, theme, i18n, format, clipboard, scroll)
  core/         Pure business logic (protocol, session, reducer slices, domain types)
tests/          Mirrors src/, discovered by glob
```

### Dependency Rules

The dependency order is strictly inward:

$$\text{core} \longleftarrow \text{shared} \longleftarrow \text{infra} \longleftarrow \text{features} \longleftarrow \text{app}$$

| Layer | Path | Allowed Inbound Imports | Prohibited Imports | Responsibilities |
|---|---|---|---|---|
| **Core** | `src/core/` | Internal `core/` only | React (`react`, `react-dom`), Tauri (`@tauri-apps/*`), `@shared/*`, `@infra/*`, `@features/*`, `@app/*` | Protocol messages, JSONL session handling, chat reducer slices (`connection`, `messaging`, `models`, `sessions`, `tool-execution`), markdown parser, domain types. |
| **Shared** | `src/shared/` | `@core/*`, internal `shared/` | React, Tauri, `@infra/*`, `@features/*`, `@app/*` | Design tokens (`tokens.css`), base reset (`base.css`), theme resolution, i18n dictionaries (`en.json`, `es.json`) & translation, formatting helpers, clipboard & scroll controllers. |
| **Infra** | `src/infra/` | `@core/*`, `@shared/*`, internal `infra/` | React, `@features/*`, `@app/*` | The **only** layer permitted to import `@tauri-apps/*`. Native Tauri IPC invocation (`bridge.ts`), external opener adapter (`opener.ts`), preferences persistence (`preferences.ts`). |
| **Features** | `src/features/*` | `@core/*`, `@shared/*`, `@infra/*`, local feature files | Other features (`@features/<otherFeature>`), `@app/*` | Feature UI components, presentation logic, hooks, and feature stylesheets (`*.css`). Feature boundaries are strictly isolated: cross-feature dependencies are composed via props/slots in `app/App.tsx`. |
| **App** | `src/app/` | All layers (`@core/*`, `@shared/*`, `@infra/*`, `@features/*`) | None | Root composition (`App.tsx`), CSS cascade ordering (`main.tsx`), shell layout (`app.css`). |

### Path Aliases

Path aliases are defined consistently across `tsconfig.app.json`, `vite.config.ts`, and `tsx`:

- `@core/*` $\rightarrow$ `src/core/*`
- `@shared/*` $\rightarrow$ `src/shared/*`
- `@infra/*` $\rightarrow$ `src/infra/*`
- `@features/*` $\rightarrow$ `src/features/*`
- `@app/*` $\rightarrow$ `src/app/*`

The temporary legacy alias `@/*` has been completely retired. Deep relative imports (`../../`) across layers are disallowed.

---

## 3. Feature Slices & Isolation

Features live under `src/features/<feature-name>/`:

- **`chat`**: Activity blocks, message stream, prompt controls, chat scrolling, copy feedback, session event listener.
- **`projects`**: Project dock sidebar, project registry persistence, monogram calculation, hover expansion.
- **`providers`**: Providers management view, provider modal form, custom models draft builder, API model classification & enrichment.
- **`sessions`**: Session history sidebar, session item chips, delete confirmation dialog, session action decision logic.
- **`settings`**: Settings view, appearance & language settings, connection configuration, draft validation.
- **`workspace`**: File tree navigation, git status tracking, file viewer modal, diff hunk display.

### Cross-Feature Composition Pattern

Features never import other features directly. When a component in one feature needs to display or interact with another feature, the interaction is inverted:

1. **Slot Props**: The parent component declares a `React.ReactNode` or render prop (e.g. `SessionSidebar` receives `filesPanel: React.ReactNode`).
2. **Injected Callbacks**: Hooks accept callbacks for cross-cutting triggers (e.g. `useConnection` accepts `onConnected` which `App` connects to `useChatScroll`'s `pinAndJumpToBottom`).
3. **Shared Utilities**: Reusable domain-agnostic helpers (e.g. `formatFileSize`) are lifted to `@shared/`.

---

## Web bridge session continuity

The browser is a subscriber, not the owner of Pi processes. While the Vite web bridge remains running, closing or reloading a browser leaves active work and pending extension dialogs alive. Reopening the same session reuses its Pi process and loads live messages, activity, and pending requests. EventSource reconnection also refreshes attached sessions to reconcile missed events.

| Web IPC action | Effect |
|---|---|
| `disconnect` or closing the SSE stream | Detaches the client without terminating Pi. |
| `abort` | Cancels the current operation while keeping the session process alive; an optional `payload.sessionFile` targets a specific session. |
| `stop_session` | Terminates only `payload.sessionFile`; the session file is required. This is web-only IPC, not a new native command or UI button. |
| `connect` | Returns the existing fields plus `activity` (`idle`, `busy`, `waiting`) and `pendingExtensionPrompts`. Live processes supply messages through Pi RPC. |

Agent completion events are matched against the selected session of their destination project, including background projects. Web subprocess exits emit project/session-scoped bridge status changes so the project indicator leaves its busy state; stale exits from replaced sessions are ignored.

Dialog responses preserve the originating session file and must match a pending request on a live process. Repeated, stale, or wrong-session responses fail without creating a process. Pool cleanup never evicts working or waiting sessions; simultaneous attachments share one startup.

**Lifetime limit:** stopping/restarting the web bridge or rebooting the machine does not preserve execution. Session history can still be reopened, but automatic recovery of interrupted operations is not implemented. Native desktop explicit exit still terminates Pi processes; closing its main window hides it to the system tray as described below. This does not add per-browser authorization or tenant isolation to the existing shared bridge.

Regression coverage: `tests/server/session-continuity.test.ts`, `tests/core/session-reattach.test.ts`, and `tests/infra/web-session-reattach.test.ts` use isolated fake subprocesses and connection adapters.

## Web resource deletion

The web bridge supports `delete_mcp_server` and `delete_pi_resource` (extensions and packages). Deletion removes the selected definition from its configuration file, not extension source files or installed packages. Autoload-only extensions without a settings entry cannot be deleted this way; use activation controls to disable them. Removing a settings entry does not stop filesystem auto-discovery. Other definitions and configuration fields are preserved, and writes replace the file atomically.

An explicit `global` scope never modifies project configuration; `project` requires a working directory and never falls back to global configuration. Without a scope, a matching project definition takes precedence over the global definition. MCP supports both `mcpServers` and legacy `servers` maps in the supported project config locations. Invalid requests, missing definitions, and malformed target files fail without changing configuration. Activation policy files are unchanged. Already-running sessions must be restarted or reloaded for configuration changes to take effect.

Regression coverage: `tests/server/resource-deletion.test.ts` exercises the web IPC dispatcher using isolated configuration files.

## Desktop background lifecycle

Tauri keeps the application process and its webview alive when the main window closes. `src-tauri/src/tray.rs` provides **Open Pi Viewer** and **Exit Pi Viewer**; a left-click on the tray icon also restores, unminimizes, and focuses the existing window. `CloseRequested` prevents window destruction and hides the window only when the tray exists and shutdown has not begun. There is no frontend unmount, session reload, or independent daemon. Native listeners aggregate Pi activity by working directory and use cached green, blue, amber, and red tray icons. While working, a native task switches blue/amber every 800 ms (a 1.6-second cycle); when idle or failed it waits for events without a timer. Errors override working/ready colors and remain red until the affected session starts a new run or reconnects successfully. Process/bridge errors and failed tool executions are included. Colors match the default project indicator palette, not custom themes; `agent_settled` and terminal status changes clear that session's activity.

Explicit tray exit enters the existing `ExitRequested` cleanup, cancelling OAuth work and terminating/reaping Pi sessions before exiting. If tray initialization fails, the ordinary close-and-cleanup path remains available rather than hiding an inaccessible window. Forced termination, logout, and reboot are not execution checkpoints. `src-tauri/src/background.rs` tests the close decision independently from the OS tray.

## 4. Backend Modular Rust Architecture

The Rust backend (`src-tauri/src/`) manages the Pi subprocess, JSONL line framing, and IPC commands. All commands are modularized into domain submodules under `src-tauri/src/commands/`:

```
src-tauri/src/
  commands/
    mod.rs          AppState definition, submodule declarations, and command re-exports
    connection.rs   Subprocess connection, prompt lifecycle, abort, and tool approval
    models.rs       Model switching, thinking levels, session stats, and RPC helpers
    config_files.rs Custom providers (models.json) & thinking levels (settings.json) I/O
    sessions.rs     Session persistence checks, .jsonl parsing, listing, switching, deletion
    workspace.rs    File tree traversal, file preview, git status, and unified diff
    external.rs     External URL validation, opener coordinator, and directory picker
  framing.rs        LF-delimited JSONL stream decoder with UTF-8 boundary preservation
  process.rs        Subprocess spawning, process lifecycle monitor, and stdin/stdout channels
  lib.rs            Tauri application builder and command registration (tauri::generate_handler!)
  main.rs           Native application entry point
```

### Command Registration & Macro Compatibility

In Tauri 2, `tauri::generate_handler![commands::connect, ...]` relies on macro-generated symbols (`__cmd__*` and `__tauri_command_name_*`).

`src-tauri/src/commands/mod.rs` re-exports both the command functions and their corresponding macro symbols for all 28 commands. As a result, `src-tauri/src/lib.rs` registers the complete command surface without requiring any changes when commands are moved across domain submodules.

### Rust Unit Testing Convention

In Rust, `#[cfg(test)] mod tests` placed directly within the module under test is the idiomatic convention, providing direct access to private items and helper functions. All 45 command unit tests remain inline in their respective domain submodules:

- `connection.rs`: 7 tests
- `models.rs`: 3 tests
- `config_files.rs`: 8 tests
- `sessions.rs`: 6 tests
- `workspace.rs`: 1 test
- `external.rs`: 20 tests

---

## 5. Mechanical Boundary Enforcement

Architecture boundaries are mechanically verified on every test run via `tests/architecture.test.ts`.

You can run the architectural check independently:

```bash
npm run check:arch
```

The automated check validates:
1. `src/` contains 0 flat files and only the 5 designated layer directories.
2. `src/` contains 0 test files (`*.test.ts` / `*.test.tsx`).
3. `core/` imports only `core/` (zero React, zero Tauri, zero outer layers).
4. `shared/` does not import outer layers, React, or Tauri.
5. `infra/` does not import features, app, or React.
6. `features/*` never import other features or `app/`.
7. The retired `@/*` alias and deep relative `../../` imports are completely absent.
8. The backend `commands.rs` monolith is absent and all 6 domain submodules + `mod.rs` are present.
