# Persistent Project Terminal

## Overview

The Persistent Project Terminal feature provides an interactive terminal session per canonical project directory across Web and Desktop (Tauri) deployments. The terminal survives UI minimization, tab switches, and client reconnections without losing shell processes or buffered output, while supporting explicit user termination.

## Architecture

- **Web Backend (T1)**: Implemented in Node.js via `node-pty` and `TerminalManager` (`server/terminal/**`). Exposes terminal lifecycle over authenticated IPC and dedicated poll transport.
- **Native Backend (T2 - Planned)**: Planned native Rust backend to be managed via `portable-pty` in `src-tauri/src/terminal.rs`, exposing matching Tauri commands.
- **UI / Frontend (T3 - Planned)**: Planned full-window responsive terminal overlay using `xterm.js` (`src/features/terminal/**`), attaching to backend sessions and handling desktop/mobile resizing.

## Lifecycle & Isolation

- **One Session Per Canonical Working Directory**: Each project has at most one active terminal session indexed by its resolved canonical path (`resolveCanonicalCwd`). Reopening an existing project directory reattaches to the existing running process and restores buffered history.
- **Process Isolation**: Terminal processes run completely independently in their respective working directories. Input or output in project A never crosses into project B.
- **Session Continuity (S3.1, S3.2)**: Minimizing the terminal overlay, navigating between projects, or disconnecting and reconnecting a client preserves backend processes and retains up to 256 KB of bounded scrollback history.
- **Explicit Close (S3.3)**: Explicit termination kills the targeted shell process and its child process tree, releasing all OS locks. Reopening the project afterwards spawns a new session with a fresh PID and buffer.

## Security & Transport Model (S4.1)

### Access Control & Origin Integrity
- **Loopback Enforcement**: When web authentication is disabled, access is strictly limited to verified loopback addresses (`127.0.0.1`, `::1`, and loopback hosts). Remote requests without authentication are rejected with `401 Unauthorized` or `403 Forbidden`.
- **Anti-Spoofing**: Header-based loopback indicators (`x-forwarded-for`, `x-real-ip`) are never trusted for shell access.
- **Same-Origin Validation**: All terminal requests must satisfy Same-Origin integrity. Cross-origin requests (`Sec-Fetch-Site: cross-site`, mismatching `Origin`) are rejected before process spawning or interaction.
- **Multi-Tenant / Owner Isolation**: Terminal sessions are tagged with their authenticated owner. Cross-tenant attempts to read, write, resize, poll, or close sessions are rejected with `403 Forbidden`.

### Dedicated Authorized Poll Transport (`terminal_poll`)
- **No Shared SSE Broadcast**: Terminal data (keystrokes, command output, credentials) is strictly forbidden from broadcasting over the shared `/api/events` SSE stream, where unauthenticated or cross-tenant clients could intercept data.
- **Incremental Polling**: Output is streamed to authorized clients via the dedicated `terminal_poll` command. Clients provide a monotonic char `cursor` and optional `timeoutMs` (bounded long-polling). The server returns incremental data, updated cursor position, and process running state.
- **Disconnect Cancellation & Concurrency Bounds**: Long-poll operations monitor client disconnect (`req.on('close')`) to unlisten and clear timers immediately. Concurrent long-poll requests per session are bounded (max 16).

## Public Command Contract

Web contract implemented in `server/web-api.ts` (T1), with shared types in `src/core/terminal.ts`. Desktop (`src-tauri/`, T2) and Frontend (`src/features/terminal/`, T3) bindings are planned.

### 1. `terminal_open`
Opens or attaches to an interactive shell for the specified working directory using the platform default shell.
- **Request**:
  ```ts
  {
    cwd: string;           // Required project working directory
    cols?: number;         // Initial columns (default 80)
    rows?: number;         // Initial rows (default 24)
  }
  ```
- **Response**: `TerminalSessionDto`
  ```ts
  {
    id: string;            // Session ID (e.g. "term_uuid")
    cwd: string;           // Original requested path
    canonicalCwd: string;  // Realpath on host OS
    cols: number;
    rows: number;
    pid: number;
    running: boolean;
    createdAt: number;
    replay?: string;       // Bounded scrollback output
    cursor?: number;       // Absolute head cursor offset matching replay
  }
  ```

### 2. `terminal_write`
Writes standard input to the running terminal.
- **Request**:
  ```ts
  {
    id: string;            // Terminal session ID
    data: string;          // Characters or escape sequences to write
  }
  ```
- **Response**: `{ ok: true }`

### 3. `terminal_resize`
Resizes the PTY viewport dimensions.
- **Request**:
  ```ts
  {
    id: string;            // Terminal session ID
    cols: number;          // Columns (> 0)
    rows: number;          // Rows (> 0)
  }
  ```
- **Response**: `{ ok: true }`

### 4. `terminal_poll`
Retrieves incremental terminal output using cursor pagination.
- **Request**:
  ```ts
  {
    id: string;            // Terminal session ID
    cursor?: number;       // Character offset to read from (default 0)
    timeoutMs?: number;    // Long-poll timeout in ms (0-30000, default 0)
  }
  ```
- **Response**: `TerminalPollResult`
  ```ts
  {
    id: string;
    data: string;          // Incremental text since cursor
    cursor: number;        // New head cursor offset
    running: boolean;
    exitCode?: number | null;
    signal?: number;
  }
  ```

### 5. `terminal_close`
Terminates the terminal session and closes child processes.
- **Request**:
  ```ts
  {
    id: string;            // Terminal session ID
  }
  ```
- **Response**: `{ ok: true }`

### 6. `terminal_get`
Retrieves active session details by session ID or directory.
- **Request**:
  ```ts
  {
    id?: string;
    cwd?: string;
  }
  ```
- **Response**: `TerminalSessionDto | null`

### 7. `terminal_list`
Lists all running terminal sessions belonging to the authenticated caller.
- **Request**: `{}`
- **Response**: `TerminalSessionDto[]`

## Process Termination & Cleanup

- **Windows ConPTY**:
  - `resolveDefaultShell()` resolves `%COMSPEC%` (`cmd.exe`) or `powershell.exe` rather than POSIX `SHELL` environment variables (e.g., MSYS, Git Bash, or Cygwin bash), preventing broken console signal handlers.
  - Process cleanup escalates to tree termination (`taskkill.exe /F /T /PID`) to release open directory handles immediately and prevent `EBUSY` errors when temporary project directories are removed.
- **POSIX**:
  - Process termination signals the session process group (`process.kill(-pid, signal)`) ensuring child processes spawned under the shell are cleaned up rather than orphaned.

## Build Externalization

Because `node-pty` includes native C++ addons (`.node`), it must be externalized from Vite frontend bundling. `vite.config.ts` declares:
```ts
optimizeDeps: {
  exclude: ['node-pty'],
},
ssr: {
  external: ['node-pty'],
},
```
For production server builds via `vite.server.config.ts`, `node-pty` is loaded at runtime via Node.js `createRequire(import.meta.url)('node-pty')`.
