# Pi Viewer

Desktop chat interface and session viewer for Pi built with Tauri 2, React 18, TypeScript, and Vite.

[![Built with Gentle-AI](https://raw.githubusercontent.com/Gentleman-Programming/gentle-ai/main/docs/assets/brand/built-with-gentle-ai.png)](https://github.com/Gentleman-Programming/gentle-ai)

## Current MVP Status

The Pi Viewer MVP is fully functional and verified:
- **Auto-Startup & Configuration**: Automatically connects on launch using saved connection configuration; includes an in-app **Settings** panel and explicit **Retry** on disconnect/error.
- **Session Continuity**: Viewer-owned real Pi session persistence across application restarts, historical message hydration on startup, and clean **New conversation** reset.
- **Localization & Themes**: English base/fallback and Spanish UI dictionaries (`src/locales/*.json`) with key parity and safe interpolation; Dark (default), Light, and System themes with complete CSS tokens; immediate preferences persistence in Settings without bridge reconnection or prompt loss.
- **Readable Assistant Responses**: Safe Markdown subset rendering exclusively for assistant responses (headings 1-6, paragraphs, nested lists, strong/emphasis, inline code, fenced code blocks with sanitized language labels and localized copy buttons, and safe links opening the OS default external handler with destination display and copy controls). Strict plain-text literal isolation for user and system messages; no `dangerouslySetInnerHTML`, bounded native opener wrapper (no WebView navigation), and zero raw HTML execution.
- **Verified Codebase**: 368 frontend unit tests (`npm test`), 72 native Rust bridge tests (`cargo test`), frontend production build (`npm run build`), architectural boundary verification (`npm run check:arch`), and native typecheck (`cargo check`) all pass cleanly.
- **Desktop Acceptance**: End-to-end desktop walkthrough (launch, chat, close/reopen with context, New conversation, empty-session reopening, and external link desktop opening) requires user confirmation on real desktop environment.

## Quick Start

### Prerequisites
- **Node.js**: v18+ (tested on v22.x) and npm v10+
- **Rust toolchain**: rustc and cargo (tested with MSVC on Windows)
- **Pi Coding Agent**: Installed locally (e.g. via npm or pnpm)

### Setup & Verification Commands

```bash
# 1. Install frontend dependencies
npm install

# 2. Run frontend unit tests (368 tests across core, infra, shared, features, and architecture)
npm test

# 3. Verify architectural boundary invariants mechanically (8 boundary rules)
npm run check:arch

# 4. Verify frontend production build
npm run build

# 5. Verify native Rust bridge compilation & unit tests (72 tests across domain submodules)
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml

# 6. Launch desktop application in development mode
npm run tauri dev
```

> **Note on Portable Environment Discovery**: Pi Viewer discovers your Pi CLI entrypoint and project directory across platforms without assuming workstation-specific hardcoded paths. On initial launch, the application awaits host discovery before connecting; if configuration is unconfigured or ambiguous, actionable diagnostics prompt you to review settings. Valid saved settings are preserved in `localStorage`, and the **Settings** panel includes environment detection and directory browsing.

## Run the web service from a production build

Requires Node.js 22.9 or newer. You manage the Pi CLI, MCP tools, credentials, and other external dependencies separately.

```bash
npm run build
npm run start
```

`build` produces the frontend in `dist/` and the compiled Node backend in `dist-server/`. `start` runs that backend directly with Node, without Vite's development server, HMR, or a TypeScript runtime. Keep both build directories together. The default address is `0.0.0.0:5173`; use `HOST` and `PORT` environment variables to change it.

The existing authentication, IPC, OAuth, and SSE routes are shared with development mode. `start` loads `.env` from the project root before initializing the backend. Variables already defined in the process environment take precedence. The file is optional; Vite-specific `.env.local` and mode files are not loaded by `start`. For a public VPS, enable the existing web authentication and use HTTPS. See [web authentication](docs/web-oauth.md). Pi and its tools run as the service's OS user and retain that user's filesystem permissions. Restarting the service interrupts running Pi sessions.

`npm run preview` remains a frontend-only preview, not the service startup command.

## Notifications in web and desktop

In **Settings → Notifications**, use the **Enable system notifications** switch to activate or pause alerts. Turning it on requests browser/system permission if needed; there is no separate permission button. **Test notification** is available whenever the switch is on (except during an in-flight notification action) and also requests missing permission before sending a test. The switch replaces the general enable checkbox; the individual notification options remain listed below it. Pausing stops automatic popups and app sounds and disables the test button without resetting those options. Task completion and requests for input identify their origin in the title using this hierarchy: custom project name, Git repository name, then working-folder name. The body contains only the localized event message; the working-directory path is not displayed. Repository lookup uses the event's directory, not the active tab; if Git lookup fails, the folder name is used. Test notifications remain generic. Alerts include localized text, never conversation contents. Existing notification preferences and focus suppression apply; alerts from different sessions are debounced independently.

- **Web:** requires HTTPS or localhost, browser permission, and an open page. Browser popups request silent delivery; the sound preference controls the app's audio tone. Browser and operating-system policies may suppress delivery or audio.
- **Tauri:** uses the official native notification plugin while the app is running, including when hidden in the tray. Desktop popup sound is controlled by OS notification settings, not the app's sound toggle; the app avoids adding a second audio tone. On Windows, verify notification behavior with the installed application, not only development mode.
- **Blocked permissions:** change browser or system permissions and return to Settings to refresh status. Permission requests occur only after turning on the switch or clicking **Test notification**. A successful test means submission, not proof that the system displayed it.

These in-page alerts require the viewer to be open. For browser/mobile delivery with the page closed while the server keeps Pi running, see [Web Push setup](docs/web-push.md). Web Push uses the same notification switch and project naming, with per-device subscriptions and authorization expiry. Native desktop notification clicks are not guaranteed to reopen a specific session; use the tray to reopen the app.

## Architecture & Verification Status

| Area | Implementation | Verified Status |
|------|----------------|-----------------|
| **Frontend Shell & Layers** | React 18 + TypeScript + Vite (`src/app/`, `features/`, `infra/`, `shared/`, `core/`) | **Operational** (368 unit tests pass; `npm run build` clean; `npm run check:arch` clean) |
| **Native RPC Bridge** | Tauri 2 domain submodules (`src-tauri/src/commands/`) | **Operational** (72 Rust tests pass; `cargo check` clean) |
| **Session Continuity** | Viewer-owned session tracking, hydration, reset | **Operational** (Hydration & reset verified in tests) |
| **UI Foundations** | Pure i18n (en/es), Themes (dark/light/system), Prefs | **Operational** (Immediate application & storage verified) |
| **Assistant Markdown** | Safe subset parser, copy controls, main-thread native opener | **Operational** (Opener & markdown unit tests pass; pure React rendering) |
| **Desktop Experience** | End-to-end desktop launch & chat workflow | **User-Confirmed** (Walkthrough verified by user, not agent-observed) |

## System Architecture

Pi Viewer follows a layered hexagonal architecture. Detailed design documentation, layer dependency rules, and testing conventions are documented in [docs/architecture.md](docs/architecture.md):

- **Frontend Layers**: `core` (pure business logic) $\leftarrow$ `shared` (cross-cutting tokens, theme, i18n) $\leftarrow$ `infra` (Tauri IPC bridge, preferences) $\leftarrow$ `features` (chat, projects, providers, sessions, settings, workspace) $\leftarrow$ `app` (composition shell).
- **Mechanical Boundary Checks**: `npm run check:arch` automatically validates layer import restrictions, cross-feature isolation, absence of test files in `src/`, and elimination of flat root files.
- **Modular Rust Backend**: IPC commands are decomposed into domain modules (`connection`, `models`, `config_files`, `sessions`, `workspace`, `external`) under `src-tauri/src/commands/` with inline unit tests.

## Prompt file attachments

Attach files using the attachment menu, drag and drop them onto the message history or prompt, or paste files/images from the clipboard while the prompt is focused. All paths validate the selected model's input capabilities: images, audio, and video require their corresponding modality; text/code documents are read as text; binary documents require file input support. Unsupported or unreadable files are listed without discarding accepted files. Ordinary text paste remains unchanged. Attachments are unavailable while disconnected, changing models, or while the agent is busy.

## Core Features & Design

### UI Localization & Theme Customization
- **Full Appearance Customizer & Live Preview**: Complete visual customizer with instant live DOM preview, 7 theme presets (including Cyberpunk, Arch Electric, Gentleman Sexy DJR, and Minimalist Ninja OLED), 5 independent workspace transparency areas, custom text/label/accent overrides, customizable agent work loading animation, and bounded wallpaper uploads. Detailed usage guide, safety limits, and lifecycle semantics are documented in [docs/appearance-customization.md](docs/appearance-customization.md).
- **JSON Dictionaries with Key Parity**: Locales live in `src/shared/locales/en.json` and `src/shared/locales/es.json`. All chrome labels, aria descriptions, tooltips, hints, and empty states are externalized into stable keys. Parameter interpolation (`{count}`, `{flags}`, `{status}`) uses safe string replacement without HTML insertion.
- **Contract-Preserving Presentation Mapping**: Reducer internals and RPC contracts remain untouched in English. Presentation helpers (`formatLocalizedStatus` and `formatLocalizedStatusDetail`) explicitly map connection states and known status details to localized strings while passing through arbitrary technical error strings verbatim.
- **Reusable Theme Tokens**: CSS tokens in `src/styles.css` define complete palettes for `:root` (dark default) and `[data-theme="light"]`. Tokens cover background canvas, surface, borders, inputs, focus rings, disabled controls, error banners, user message bubbles, and buttons. Native `color-scheme` property is synchronized to the root document.
- **StrictMode-Safe System Theme Watcher**: When `system` theme is selected, `watchSystemTheme()` listens to `(prefers-color-scheme: dark)` changes and returns an idempotent cleanup function that prevents listener leaks across React remounts.
- **Draft/Confirm/Cancel Lifecycle**: Appearance selections preview immediately via inline CSS variables without writing to disk. Changes are committed atomically to `pi_viewer_ui_preferences` on **Confirm**, or discarded cleanly on **Cancel** or modal unmount without invoking bridge reconnection, resetting conversation context, or discarding typed prompts. Storage quota errors preserve saved preferences intact.

### Safe Markdown Rendering & Copy Controls
- **Strict Role Isolation**: Only assistant messages are processed by the safe Markdown parser. User and system messages remain literal plain text (`.message-literal`) with preserved whitespace (`white-space: pre-wrap;`), guaranteeing that user prompts containing markdown or HTML syntax are never parsed or styled as HTML.
- **Safe Markdown Subset & Bounded Depth**: Supports headings (levels 1-6), paragraphs, unordered lists (`-`, `*`, `+`), ordered lists (`1.`, `2.`), nested list hierarchies up to an explicit maximum depth (`MAX_LIST_NESTING_DEPTH = 6`), strong (`**`, `__`), emphasis (`*`, `_`), combined strong/emphasis (`***`, `___`), inline code (`` `...` ``), and fenced code blocks (```` ``` ````, `~~~`). Beyond the list nesting depth cap, deeply indented sub-lines are deterministically flattened into the parent item without call stack recursion or content loss.
- **Zero Raw HTML Execution**: All text nodes and content are rendered via pure React elements; `dangerouslySetInnerHTML` is forbidden. Raw HTML tags (such as `<script>`, `<img>`, `<iframe>`) are escaped as plain text by React JSX.
- **Streaming & Delimiter Discipline**: Unclosed code fences at EOF automatically stream as code blocks, enabling immediate formatted code rendering during active token generation. The animated streaming dot is positioned strictly outside the parsed Markdown tree. Unclosed inline formatting delimiters (`*`, `**`, `` ` ``, `[`) remain deterministic literal text.
- **Fenced Code Blocks with Accessible Dynamic Copy Feedback**: Code block headers display sanitized language labels (cleaned against HTML/control character injection, bounded to 32 characters) and an independent localized Copy button. Copy buttons reside in the block header completely outside `<pre><code>` to prevent capturing button text during code selection. Copy actions dynamically update their accessible `aria-label` ("Copied...", "Failed...") and expose a polite `aria-live="polite"` status region to ensure screen readers announce completion without noisy idle chatter.
- **Strict Link Security Policy & Native Opener Integration**: Links are validated against an allowlist permitting only `http`, `https`, and `mailto` via a shared defense-in-depth policy. Dangerous protocols (`javascript:`, `data:`, `file:`, `tauri:`, `vbscript:`), URLs containing user credentials (`user:password@`), mailto URLs with queries, fragments, percent-encoding (`%`), or multiple recipients, and malformed URLs render as inert plain text in assistant responses rather than interactive links that fail on click. As a documented design limitation, nested parentheses inside link destinations (e.g. unencoded Wikipedia URLs) are not parsed to preserve linear bounded scanning without ReDoS; standard URL percent-encoding should be used. Links never render a navigable `href` attribute on anchor elements that could navigate the Tauri WebView; every link action triggers `preventDefault()`, displays destination URL inline, provides a discoverable platform-adaptive localized hint (`[Ctrl+click to open]` on Windows/Linux, `[Cmd+click to open]` on macOS; localized to Spanish as well), and provides a dedicated Copy URL button with dynamic screen reader feedback. Link activation requires deliberate user intent: **Ctrl+click** (Windows/Linux) or **Cmd+click** (macOS) on the primary mouse button (plain click does nothing: no preventDefault/stopPropagation, no time/state changes) and **Ctrl+Enter** or **Cmd+Enter** for accessible keyboard activation (plain Enter/Space do not open and do not prevent default, preserving normal browser scrolling). Safe links invoke the bounded custom Tauri command `open_external_url`, which validates the URL natively before coordinating execution via `coordinate_open_url`: a shared atomic state machine (`QUEUED` -> `CLAIMED` / `CANCELLED`) enforces mutual exclusion between the main-thread scheduled closure and timeout cancellation. If timeout cancels before closure execution, the closure is prevented from ever invoking the OS opener; if the closure claims before timeout, the coordinator awaits the synchronous opener result with a secondary completion fail-safe, eliminating race conditions, ghost launches, and duplicate opens upon retry. On opener failure, an adjacent visible localized error with safe technical detail is rendered with `role="none"` and linked via `aria-describedby` (persisting until next eligible activation/retry without auto-clearing after 2.5s), while screen reader announcements route exclusively through a single polite live region (`aria-live="polite"`), preventing double-alert chatter. `console.error` logs sanitized error context without logging full destination URLs to protect sensitive queries/tokens. Direct opener permissions are not exposed to the WebView (`core:default` capability preserved). The pure `LinkOpenerController` debounces rapid duplicate activations (preventing keydown + synthetic click double-firing), safely ignores concurrent in-flight activations, and drops stale updates upon unmount. Failures in opening never remove or impair the independent Copy URL button.
- **Dependency-Injectable Clipboard Helper**: `copyText` uses standard `navigator.clipboard.writeText` when available with an automatic fallback to an offscreen transient `<textarea>` and `document.execCommand('copy')`. The helper restores previous DOM selection and activeElement focus, guarantees removal of transient DOM nodes in a `finally` block, and avoids logging payload content. A pure `CopyController` state machine provides unmount-safe and StrictMode-safe timer cleanup.
- **Theme Consistency**: Complete design tokens in `src/styles.css` cover code blocks, inline code, borders, links, hover states, scrollbars, and focus rings for Dark (default), Light, and System themes. Assistant message containers use `white-space: normal;` while code blocks preserve exact formatting with `white-space: pre;`.
- **PiColor Code Cards**: Fenced code blocks render as redesigned cards with a Nerd Font-style language icon (rendered from a bundled 5 KB subset of the MIT-licensed Symbols Nerd Font in `public/fonts/`, so no local Nerd Font install is required), an optional highlighted filename (from extended fence headers such as ```` ```typescript:src/path/file.ts ```` , ```` ```rust filename="engine.rs" ```` , ```` ```title="notes.md" ```` , or a bare ```` ```main.go ```` with the language inferred from its extension), a language badge, a line counter, and both the existing Copy button and a new "Insert into prompt" button (hidden for diff/patch content) that appends the snippet to the prompt draft wrapped in a fenced block. Syntax highlighting (`src/core/picolor.ts`) sits on top of `highlight.js` and additionally recognizes method/function calls, PascalCase type names, and universal operators, plus dedicated per-line add/remove/hunk coloring for diffs; output is always a safe array of `{ text, className }` tokens rendered as plain React text — never `dangerouslySetInnerHTML`. Two global shortcuts operate on the last assistant message's code: **Alt+C** copies every executable (non-diff) code block, and **Alt+I** inserts its last snippet into the prompt. The code-card layout and highlighting approach are adapted from the [DarkKevo/pi-messages](https://github.com/DarkKevo/pi-messages) base repository.

### Auto-Startup, Settings & Retry
- **Desktop Background Sessions**: Closing the main Tauri window hides it to the system tray and keeps Pi execution, messages, and pending dialogs alive. The tray dot alternates blue/yellow on a 1.6-second cycle while Pi is working, stays green when ready, and turns red on process, bridge, or tool errors. Errors take priority until that session starts a new run or reconnects successfully. Colors match the default project indicators. Click the tray icon or choose **Open Pi Viewer** to return. Choose **Exit Pi Viewer** to terminate the application and its Pi processes. If tray initialization fails, closing exits normally. Forced termination and machine restart do not preserve live execution.
- **Automatic Connection**: On launch, Pi Viewer attempts to start the Pi RPC bridge using stored configuration.
- **Web Session Continuity**: Closing or reloading the browser leaves Pi running while the web bridge remains active. Reattachment restores live messages, activity, and pending extension dialogs. Browser disconnect is distinct from aborting work or explicitly stopping a session. Server restart recovery is not included; see [web bridge lifecycle](docs/architecture.md#web-bridge-session-continuity).
- **Settings Panel**: Accessible via the header or offline screen to configure:
  - `General Preferences`: Interface Theme and Display Language (English, Español).
  - `Theme & Styles`: Full appearance customizer with live preview, presets, area transparency, and wallpaper settings.
  - `Node Executable Path`: Defaults to `node` (or absolute path).
  - `Pi CLI Entrypoint`: Absolute path to the Pi CLI `cli.js`.
  - `Working Directory`: Absolute path to the target project directory.
- **Validation & Persistence**: Draft settings are validated before application and saved to `localStorage`.
- **Explicit Retry**: If the subprocess disconnects or encounters an error, an explicit **Retry** button initiates reconnection without replaying user prompts.

### Session Continuity & New Conversation
- **Viewer-Owned Sessions**: Pi Viewer tracks session files per working directory. First use creates a viewer-owned session without implicitly adopting unmanaged CLI conversations.
- **Startup Hydration**: On connection, previous messages are retrieved from Pi via `get_messages` and hydrated into the UI chat view before enabling prompt input.
- **New Conversation**: The **New conversation** button initiates a clean reset via `new_session`, clearing both the active Pi session context and visible UI messages.
- **Historical Session Verification**: When resuming an existing session, the bridge verifies session file existence before spawning to prevent silent data loss or state corruption.

### Active Pi Environment & Direct Wrapper Architecture
- **Direct Argv Spawning**: The Rust backend spawns Node directly with an argument vector:
  ```text
  node <pi_entrypoint> --mode rpc --approve [--session <session_file>]
  ```
  Direct argv execution avoids shell interpreter string parsing and argument-splitting vulnerabilities associated with shell wrappers (e.g. `cmd.exe` or `.bat` files).
- **Direct Unrestricted Wrapper & Active Pi Ecosystem**: Pi Viewer operates as an unrestricted direct wrapper for the Pi CLI runtime. It provides full, unconstrained access to all Pi built-in tools (`read`, `edit`, `write`, `bash`/`powershell`), extensions, MCP servers, skills (global and project), prompt templates, passive context discovery (`AGENTS.md`), and project trust (`--approve`). The child process runs directly without restrictive tool allowlists, `--exclude-tools`, or guard extensions (`-e`).
- **Local Credentials & Model Reuse**: Pi accesses local user configuration (`~/.pi/agent/`) for model selection and provider authentication directly within the subprocess. The frontend neither reads, handles, nor stores credentials.
- **Extension UI Safety & Notification Handling**: Extension UI interaction is handled deterministically via pure action classification (`decide_extension_ui_action`). Any modal dialog requests (`select`, `confirm`, `input`, `editor`, or unhandled dialog methods) emitted by extensions are answered immediately with `cancelled: true` on child stdin to prevent UI execution stalls. Fire-and-forget notifications and widget updates (`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`) are safely consumed without sending cancellation responses. Tool approval requests (`confirm` with `tool_approval:<tool>`) route to auto-approval under unrestricted execution or to the frontend approval modal (`pi://tool-approval-request`) if controlled execution is configured.
- **Safe Markdown Rendering**: Assistant responses are parsed and rendered via a safe AST subset (zero `dangerouslySetInnerHTML`). User messages remain literal plain text.

### Tool Execution Visibility & Agent Activity
- **Collapsible Thinking Accordion**: Assistant thinking/reasoning blocks stream in real-time with an animated pulse indicator, expand by default while active, and collapse when reasoning is complete. Users can freely expand or collapse the reasoning accordion.
- **Collapsible Tool Execution Cards**: Tool invocations display clean tool icons and names (`read`, `grep`, `find`, `ls`), a concise primary argument badge (e.g. file path or search pattern), status badges (`Running`, `Completed`, `Failed`), and an expandable card body containing full arguments and output with a one-click Copy button and max-height scrolling (~300px).
- **Session Continuity & Hydration**: Historical sessions preserve thinking and tool call activity. On startup, `hydrateChatMessages` pairs historical `role === 'toolResult'` messages with their preceding assistant `toolCall` blocks by `toolCallId`, populating output and execution status without cluttering the chat stream with standalone raw tool result records.

### Custom Model Providers & Model Classification
- **Native Configuration Storage**: Manage custom model providers and model definitions persisted in `~/.pi/agent/models.json` directly from the **Providers** section in Settings. Supports standard OpenAI Chat Completions, OpenAI Responses API, Anthropic Messages API, Google Generative AI, and Ollama/local OpenAI-compatible servers.
- **Controlled Refresh & No Auto-Save**: Model discovery and API refresh are performed strictly on-demand from within the provider **Edit** modal. Models fetched from endpoints are loaded into the interactive draft list without automatically overwriting saved settings, allowing users to review, add, customize, or remove models before explicitly saving.
- **Dynamic Characteristics & Classification**: Fetched models are enriched with advanced attributes according to classification rules:
  - **Reasoning Capabilities & Thinking Levels**: Identifies reasoning models via supported efforts (`low`, `medium`, `high`), default levels, capabilities, and naming patterns, generating strict thinking level maps (`thinkingLevelMap`) and reasoning effort lists (`reasoningEfforts`).
  - **Recommended Context Windows**: Automatically resolves family-specific context caps (272,000 for OpenAI/GPT/Codex, 200,000 for Claude, 370,000 for Gemini, and 128,000 default) ensuring safe context limits without memory exhaustion.
  - **Output Token Safety Caps**: Bounded to a safe default of 16,384 tokens and capped at a maximum of 65,536 tokens.
  - **Vision / Image Modalities**: Detects vision capabilities via input modalities, API capabilities, and keyword analysis, setting `input: ['text', 'image']`.
  - **Reference / Attribution**: The model classification and characteristics enrichment logic is adapted from the [cliproxyapi-dynamic-provider extension by @j0k3r-dev-rgl](https://github.com/j0k3r-dev-rgl/j0k3r-pi/blob/main/extensions/cliproxyapi-dynamic-provider.ts).

### Persistent Project Terminal
- **One Terminal Per Canonical Project Directory**: Interactive terminal sessions survive UI minimization, project switching, and client reconnection across Web and Desktop (Tauri) deployments without losing running shell processes or buffered output.
- **Full-Window Responsive Overlay**: Built on `@xterm/xterm` and `@xterm/addon-fit`, filling the viewport on desktop and adapting dimensions to mobile viewports via `ResizeObserver`.
- **Session Continuity & Explicit Close**: Minimizing or closing the overlay halts frontend polling while leaving the backend process running. Explicit termination requires user confirmation via an accessible dialog (`role="alertdialog"`), cleanly killing the targeted session and child process tree. Reopening after termination starts a fresh session.
- **Security & Multi-Tenant Isolation**: Enforces loopback restrictions, anti-spoofing header policies, and same-origin validation without exposing shell output over shared SSE broadcasts. Documented in [docs/terminal.md](docs/terminal.md).

### Narrow Typed IPC
Tauri IPC does not expose generic command execution or raw RPC pass-through. The frontend communicates exclusively through eight bounded, typed commands:

| Command | Purpose |
|---------|---------|
| `connect` | Validates paths, manages generation gating, and spawns the Pi RPC subprocess (with optional `--session`). |
| `disconnect` | Gracefully terminates and reaps the active subprocess. |
| `send_prompt` | Validates prompt length (bounded to 512 KB) and forwards user prompt to Pi. |
| `abort` | Signals Pi to cancel in-flight response generation. |
| `get_bridge_state` | Returns current connection status, generation, and active session details. |
| `get_messages` | Retrieves historical messages from Pi for startup hydration. |
| `new_session` | Requests conversation reset, clearing context and visible history. |
| `get_session_persistence_status` | Checks current session file existence and persistence state. |

### Process Lifecycle & Framing Safety
- **Strict LF JSONL Framing**: Subprocess stdout is decoded byte-by-byte, splitting records strictly on LF (`\n`, `0x0A`) with optional `\r` stripped. Records are never split on Unicode line terminators (`U+2028`, `U+2029`), and multi-byte UTF-8 sequences split across chunks are preserved intact. A 16 MB bounded buffer limit prevents out-of-memory errors.
- **Bounded Stderr Diagnostics**: Child stderr is drained into a 64 KB ring buffer for internal diagnostics without leaking secrets or environment variables. Raw stderr strings are not forwarded across the IPC boundary; safe generic exit and error status descriptions are presented instead.
- **Generation & Lifecycle Gating**: Every connection transition increments an atomic generation counter. In-flight handshakes are cancelled on disconnect or concurrent connect calls, pending command maps are cleaned up on all timeout and error paths, and stale session events never corrupt new sessions.
- **Single Terminal Authority**: The process monitor/reaper task serves as the single terminal authority per generation. Stdout EOF does not emit a competing status event, preventing race conditions.
- **Streaming & Token Discipline**: Only `text_delta` tokens stream into chat messages, filtering out internal `thinking_delta` and `toolcall_delta` payloads. Non-assistant `message_end` events are ignored, and streaming flags are authoritatively finalized on abort, disconnect, and process exit.
- **Shutdown Cleanup**: The child PID is tracked and reaped upon explicit disconnect, window destruction, or application exit. Tauri's `prevent_exit()` is used on application exit to await asynchronous child process reaping. `kill_on_drop(true)` provides defense-in-depth against leaked processes.
- **Process Termination Scope**: Direct child process termination signals and reaps the immediate Node process. In read-only or controlled mutation mode, Node reaps managed child operations. However, direct process termination does not guarantee process-tree cleanup across all platforms if descendant processes were spawned by terminal tools or extensions; full OS-level process-tree management (such as Windows Job Objects or POSIX process groups) would be required if arbitrary external tools or subagents were executed.

## Checklist

- [x] Tauri 2 + React 18 + TypeScript + Vite desktop application shell
- [x] Auto-startup on launch with local configuration storage (`localStorage`)
- [x] Settings panel for Node path, Pi entrypoint, and working directory with draft validation
- [x] Connection lifecycle state management with explicit Retry for offline/error states
- [x] Real Pi session continuity across application restarts (viewer-owned session model)
- [x] Historical message hydration on startup (`get_messages`)
- [x] New conversation action with context and message reset (`new_session`)
- [x] JSON-based UI internationalization (English base/fallback and Spanish dictionary with key parity)
- [x] Reusable theme system with complete CSS tokens (Dark default, Light, System) and StrictMode-safe media listener
- [x] Immediate UI preferences persistence in Settings without RPC bridge reconnection or prompt loss
- [x] Safe Markdown subset parser and pure React renderer for assistant responses (zero dangerouslySetInnerHTML)
- [x] Code blocks with sanitized language info strings and localized Copy/Copied/Failed feedback
- [x] Safe link policy (http/https/mailto allowlist, main-thread native opener via official tauri-plugin-opener, Ctrl/Meta+click intent policy, visible error persistence/retry, WebView navigation prevention, inline destination, and independent Copy URL)
- [x] Dependency-injectable clipboard helper with transient textarea fallback and focus/selection restoration
- [x] Narrow typed Tauri IPC bridge with 9 bounded commands (no arbitrary RPC/shell access)
- [x] Rust Pi RPC subprocess bridge (`src-tauri/src/process.rs`, `framing.rs`, `commands.rs`)
- [x] Strict LF framing, UTF-8 boundary preservation, and Unicode separator safety
- [x] Extension UI dialog request cancellation and fire-and-forget notification handling
- [x] Unrestricted direct Pi wrapper (full access to all built-in tools, extensions, MCP servers, skills, prompt templates, and project trust via `--mode rpc --approve`)
- [x] Bounded stderr ring buffer without secret/credential leakage across IPC
- [x] Plain-text message rendering (XSS prevention)
- [x] Tool execution visibility & Agent Activity (thinking accordions, collapsible tool execution cards, tool execution visibility, and hydration pairing)
- [x] Layered frontend architecture (`core`, `shared`, `infra`, `features`, `app`) with 0 flat files in `src/` root
- [x] Modular Rust backend domain submodules (`commands/{connection, models, config_files, sessions, workspace, external}`)
- [x] 368 frontend unit tests passing (`npm test`) with mechanical architecture boundary verification (`npm run check:arch`)
- [x] 72 native Rust bridge unit tests passing (`cargo test`)
- [x] Frontend build clean (`npm run build`) and Rust typecheck clean (`cargo check`)
- [x] Desktop acceptance walkthrough user-confirmed (tool execution cards, thinking blocks, multi-turn isolation, and chat viewport scrolling)

## Web Server Authentication

When exposing Pi Viewer over an external domain or untrusted network (beyond internal networks like Tailscale), activate server-side web authentication via environment variables.

### Environment Configuration

Configure these variables in your server environment or project-root `.env` file (loaded server-only by both `dev` and `start`):

```bash
# Strict "true" or "false" (default: false). When false, web authentication is disabled.
PI_VIEWER_AUTH_ENABLED=false

# Server-only shared secret key for web authentication.
# Required and non-blank when PI_VIEWER_AUTH_ENABLED=true. Startup fails if missing.
PI_VIEWER_AUTH_KEY=replace-with-a-secure-random-passphrase

# Explicitly set to "true" when serving behind an HTTPS reverse proxy.
# Emits the "Secure" cookie attribute. Arbitrary forwarded headers (e.g. X-Forwarded-Proto) are NOT trusted.
PI_VIEWER_AUTH_SECURE_COOKIE=false

# Optional session validity duration in days (default: 1 day / 24 hours if unset).
# Accepts positive numbers (e.g. 7 for a week, 30 for a month, or 0.5 for 12 hours).
# PI_VIEWER_AUTH_SESSION_DAYS=1

# Optional paired Cloudflare Turnstile bot protection for the web login gate.
# Ignored when PI_VIEWER_AUTH_ENABLED=false. With auth enabled, both keys must be paired.
# The site key is public and delivered via GET /api/auth/status to render the widget.
# PI_VIEWER_TURNSTILE_SITE_KEY=0x4AAAAAAAbcdef123456789

# Server-only Turnstile secret key for Cloudflare siteverify validation.
# NEVER prefix with VITE_ or expose to the client.
# PI_VIEWER_TURNSTILE_SECRET_KEY=0x4AAAAAAAbcdef123456789secret
```

### Cloudflare Turnstile Bot Protection

When exposing the web viewer to the internet, you can optionally configure Cloudflare Turnstile to defend the login gate against automated credential attacks:

- **Paired Keys & Auth Prerequisite**: With `PI_VIEWER_AUTH_ENABLED=true`, `PI_VIEWER_TURNSTILE_SITE_KEY` and `PI_VIEWER_TURNSTILE_SECRET_KEY` must be configured together; an unpaired key fails startup. When web authentication is disabled, Turnstile settings are ignored (including unpaired keys), no challenge is required, and no Siteverify request is made.
- **Local Test Keys**: Cloudflare's published dummy site key `1x00000000000000000000AA` and secret `1x0000000000000000000000000000000AA` can be used on `localhost`, `127.0.0.1`, or `::1`. Dummy responses omit production action/hostname bindings; only these exact public test secrets and the official dummy token receive local test compatibility. Upstream success, access-key validation, and attempt limits still apply. Never use dummy keys for a deployed service; use real keys with the configured domain. Restart the server after changing keys.
- **Server-Only Secret**: `PI_VIEWER_TURNSTILE_SECRET_KEY` is consumed exclusively by the server worker during siteverify. Never prefix it with `VITE_` or expose it in client code or build outputs.
- **Cloudflare Hostname & Reverse Proxy Preservation**: Configure your domain in the Cloudflare Turnstile dashboard. Reverse proxies (e.g. Nginx, Caddy) must preserve the original `Host` header including non-default ports (e.g. `proxy_set_header Host $http_host;`), as existing same-origin checks validate `Host` against `Origin`/`Referer`, and server siteverify strictly validates that Cloudflare's verified `hostname` matches the request's parsed `Host` hostname (port ignored).
- **Transport Security & HTTPS**: Turnstile does not encrypt traffic. Always deploy behind HTTPS and set `PI_VIEWER_AUTH_SECURE_COOKIE=true` in production so session cookies include the `Secure` flag.
- **Siteverify Validation & Fail-Closed Errors**: The server worker validates submitted tokens via `https://challenges.cloudflare.com/turnstile/v0/siteverify` with a 10-second timeout. Validation strictly requires `action === 'login'` and matching hostname. Missing token returns `400 Bad Request`; rejected token returns `403 Forbidden`; unreachable upstream or timeout fails closed with `503 Service Unavailable`.
- **Limiter & Proxy Socket IP Aggregation**: Turnstile admission limits all login attempts (counting both successes and failures without reset) to 5 attempts per 60 seconds by socket IP (bounded up to 4,096 distinct entries without eviction). Because client IP is derived from the direct socket to prevent header spoofing, multiple users behind a reverse proxy share the proxy socket IP bucket.
- **External Script Access**: Client browsers must have network access to `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit`. Ensure ad blockers or restrictive CSP headers permit Cloudflare challenge scripts.
- **Manual Browser Acceptance**: Automated unit tests exercise client lifecycle helpers and validation logic; browser test walkthroughs use mocked interfaces without live Cloudflare credentials. Production walkthrough against live Cloudflare servers requires manual browser acceptance on a real domain with valid Cloudflare keys.

### Security Architecture & Limitations

- **Fail-Closed Startup**: If `PI_VIEWER_AUTH_ENABLED=true` is set without a non-blank `PI_VIEWER_AUTH_KEY`, or with an invalid value (anything other than strictly `"true"` or `"false"`), server startup fails immediately with an actionable error.
- **Strict Perimeter Defense**: All privileged `/api` endpoints (`/api/ipc`, `/api/events`, `/api/oauth/authorize`, `/api/engram-daemon`) require an active session when auth is enabled. Unauthenticated calls return `401 Unauthorized`.
- **Strict Bootstrap Routes**: Bootstrap endpoints (`GET /api/auth/status`, `POST /api/auth/login`, `POST /api/auth/logout`) use exact path matching on normalized pathnames. Prefix variations such as `/api/auth/login/evil` never bypass authentication and fail closed with 401.
- **CSRF & Same-Origin Enforcement**: Authenticated API routes and login/logout enforce same-origin validation matching the `Host` header against `Origin`, `Referer`, or `Sec-Fetch-Site: same-origin`. Cross-origin calls receive `403 Forbidden`. Arbitrary `X-Forwarded-Host` headers are never trusted.
- **Web Logout**: The logout control appears directly below Settings in the navigation footer when web authentication is enabled. A reusable in-app confirmation dialog (`src/app/components/ConfirmationModal.tsx`) explains that Pi processes and ongoing work keep running. It accepts custom title, message, action labels and callbacks; focuses Cancel initially, contains keyboard focus, restores focus on dismissal, and disables dismissal/actions while pending. Escape, Cancel, or clicking the backdrop dismiss it without logging out. Cancelling makes no logout request; confirming revokes only browser access and closes its event streams. Desktop and auth-disabled viewers do not show the control.
- **Streaming Leases & SSE Termination**: Active `/api/events` EventSource streams are bound to the session lease. When a session expires (after the configured session TTL via `PI_VIEWER_AUTH_SESSION_DAYS`, default 24 hours) or the user logs out, active SSE connections are terminated (`res.end()`), and watchdog timers are cleaned up immediately without leaks.
- **Resource Bounding & Rate Limiting**: Login attempts are rate-limited per client IP (5 failed attempts per 60 seconds return `429 Too Many Requests`). Web login request bodies are capped at 8 KB (`413 Payload Too Large`), and in-memory sessions are bounded (oldest evicted when capacity is reached). Event streams are limited to 8 per session owner and 256 globally; evicted sessions lose their active streams.
- **No Public Domain Auto-Detection**: Authentication is strictly opt-in via `PI_VIEWER_AUTH_ENABLED`. Pi Viewer never inspects Host headers to automatically guess whether an address is public or internal.
- **OAuth Isolation**: Built-in provider OAuth (`PI_VIEWER_OAUTH_ACCESS_KEY` / `pi_oauth_session`) remains strictly isolated with its own session state and owner boundaries.

### Transport Security: Authentication Is Not Encryption

The login controls **who can access the API**. It does not encrypt network traffic or enable HTTPS. The current Vite server has no native TLS configuration; browser requests and event streams use the page's protocol. The login key is sent in a JSON request body, so plain HTTP outside an encrypted tunnel can expose the key, session cookie, prompts, and responses to interception or tampering.

| Access path | Transport protection |
|-------------|----------------------|
| HTTP through Tailscale | The Tailscale tunnel encrypts traffic only when it actually travels through the tunnel. Access through a separate LAN or public address is not automatically protected. |
| HTTP over a LAN or public domain | Pi Viewer does not encrypt this traffic. Do not send credentials or sensitive conversations over an untrusted HTTP connection. |
| HTTPS with a correctly configured reverse proxy | TLS protects traffic between the browser and the proxy. The proxy-to-application connection must also be protected or restricted to local loopback. |

**`PI_VIEWER_AUTH_SECURE_COOKIE=true` does not enable HTTPS.** It adds the cookie's `Secure` attribute so the browser sends the session cookie only over a secure connection. Use `false` for local HTTP testing and `true` for HTTPS access. `HttpOnly` prevents JavaScript from reading the cookie; `SameSite=Strict` restricts cross-site cookie delivery. Neither encrypts packets.

### Domain Access Checklist

A recommended connection layout is:

```text
Browser -- HTTPS --> Caddy/Nginx -- local HTTP --> Pi Viewer (127.0.0.1)
```

1. Configure a valid TLS certificate and expose only the HTTPS reverse proxy. Redirect HTTP to HTTPS before users submit credentials.
2. Enable web login with a long, random, private key:

   ```dotenv
   PI_VIEWER_AUTH_ENABLED=true
   PI_VIEWER_AUTH_KEY="replace-with-a-long-random-key"
   PI_VIEWER_AUTH_SECURE_COOKIE=true
   ```

3. Restart the server after changing environment variables. Never prefix secrets with `VITE_` or commit a real `.env` key.
4. Restrict the application listener to loopback (for example, `npm run dev -- --host 127.0.0.1`) and block direct access to its port with firewall rules. The current default is `0.0.0.0`, which listens on all available interfaces.
5. If the proxy and application run on different machines, protect their connection with TLS or an appropriately restricted encrypted tunnel instead of assuming the second hop is secure.
6. For login-free internal access, restrict network reachability to the intended Tailscale clients using firewall rules and tailnet access controls. Disabling login grants access to anyone who can reach the web API.

### Remaining Deployment Hardening

These are limitations of the current web server, not features provided by the login:

- The bridge runs in Vite's development server. A login and an HTTPS proxy do not turn it into a production server; the authentication middleware protects the API, not every Vite development endpoint or development WebSocket.
- The general `/api/ipc` handler currently buffers request bodies without a transport-level size cap. The 8 KB cap above applies to web login, not all IPC requests. A proxy request-size limit is a useful additional defense, not a replacement for an application-side limit.
- The Engram proxy still emits permissive `Access-Control-Allow-Origin: *` headers. With web authentication enabled, the same-origin guard runs first; these headers should nevertheless be tightened as part of deployment hardening.
- Shared-key login is not per-user authorization or isolation. A person holding the key can access the privileged viewer API, including operations that act on the host through Pi.

The login's approved code review is **not an audit of the deployed network, reverse proxy, or entire development server**. Verify those boundaries separately before public exposure.
