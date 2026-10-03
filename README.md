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
- **Automatic Connection**: On launch, Pi Viewer attempts to start the Pi RPC bridge using stored configuration.
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
