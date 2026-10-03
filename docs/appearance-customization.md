# Visual Appearance & Theme Customization

Pi Viewer provides comprehensive visual customization allowing users to personalize theme presets, interactive accent colors, text and label typography colors, workspace area transparencies, agent work animations, and custom wallpapers. All visual customizations feature instantaneous live preview, atomic persistence, and unmount-safe rollback without interrupting active agent sessions or discarding prompts.

---

## Quick Path

To customize the interface appearance:

1. Open **Settings** from the application header or offline screen, then navigate to the **Theme & Styles** tab (or click **Theme Customizer →** from the **General** tab under **Preferences**).
2. Select a **Theme Preset** or fine-tune individual accent, text, or label colors.
3. Review changes in real time across the application and in the **Live Preview Sandbox**.
4. Adjust **Area Transparency** across the 5 independent workspace regions or configure a **Wallpaper**.
5. Click **Confirm and Apply Theme** to atomically save your preferences, or click **Reset to Previous Theme** to discard unconfirmed changes.

---

## 1. Lifecycle: Preview, Confirm, Cancel, and Reset

The customizer operates via a dedicated draft lifecycle orchestrated by `AppearanceLifecycleController` and `PreferencesController`:

```
Saved Preferences (Storage)
         │
         ▼ (begin / update)
   Active Draft ────────► Live DOM Preview (inline CSS variables)
         │
         ├─── Confirm ──► Atomic Storage Write ──► Update Saved Base
         │                     │ (on quota error)
         │                     └──► Error Banner (Saved Base Preserved)
         │
         ├─── Cancel  ──► Discard Draft ─────────► Revert DOM to Saved Base
         │
         └─── Unmount ──► Child Customizer Cancel (Restores Saved Base;
                          Root Shared Controller & System Watcher Remain Active)
```

### Lifecycle Actions

| Action | UI Trigger | Behavior & Invariants |
|---|---|---|
| **Live Preview** | Interactive controls | Updates inline CSS variables on `document.documentElement` immediately. **Zero disk or `localStorage` writes occur during previewing.** |
| **Confirm** | **Confirm and Apply Theme** (`theme.confirm_button`) | Validates the draft candidate and attempts an atomic storage write to `pi_viewer_ui_preferences`. On success, updates the saved baseline and closes the draft. On storage quota error (`QuotaExceededError`), the write aborts, **saved preferences are preserved intact**, and an error banner is displayed. |
| **Cancel** | **Reset to Previous Theme** (`theme.cancel_button`) | Discards all active uncommitted draft changes, clears preview inline styles, and restores the last confirmed preferences from storage. |
| **Reset All** | **Reset appearance to defaults** (`theme.reset_button`) | Atomically resets all visual appearance settings (accent, text, label, backgrounds, wallpaper, animation) back to application defaults while preserving language, theme selection, notifications, and custom commands. Persisted atomically to storage. |
| **Child Customizer Unmount** | Navigating tabs or closing Settings | Discards unconfirmed draft preview and restores the saved appearance (`controller.cancel()`). **Crucially, unmounting the child customizer does NOT stop or deactivate the root shared controller or its system media-query listener; the application-level shared controller and system watcher remain active.** |

---

## 2. Theme Presets & Dynamic System Theme

Pi Viewer includes 7 curated theme presets defined in `THEME_PRESET_DEFINITIONS`:

| Preset ID | Name (`nameKey`) | Description | Default Accent | Base Palette |
|---|---|---|---|---|
| `DjRomoro` | **DjRomoro Cyberpunk** | Futuristic dark aesthetics with high-contrast electric blue and neon cyan accents. | `#00e5ff` | Background `#05080d`, Surface `#07131d`, Border `#245066` |
| `Gentleman-Sexy-Djr` | **Gentleman Sexy DJR** | Deep burgundy and graphite tones with refined terracotta accents and warm balance. | `#F43888` | Background `#070508`, Surface `#130C12`, Border `#723C54` |
| `arch-electric` | **Arch Electric** | Hacker terminal vibe inspired by Arch Linux with cyan highlights and ultra-dark base. | `#1793d1` | Background `#05080d`, Surface `#07131d`, Border `#245066` |
| `Minimalist-Ninja` | **Minimalist Ninja** | Pure OLED black without boxes or frames for distraction-free prompt focus. | `#10B981` | Background `#000000`, Surface `#000000`, Border `#1f1f1f` |
| `dark` | **Dark Classic** | Balanced nocturnal palette based on GitHub Dark for extended daily use. | `#1f6feb` | Background `#0d1117`, Surface `#161b22`, Border `#30363d` |
| `light` | **Light Pro** | Clean, high-legibility light palette designed for bright working environments. | `#0969da` | Background `#ffffff`, Surface `#f6f8fa`, Border `#d0d7de` |
| `system` | **System Preference** | Dynamically follows the operating system's dark/light appearance setting. | Dynamic | Resolves dynamically to Light Pro or Dark Classic |

### Dynamic System Theme Synchronization
When `system` preset is active, `watchSystemTheme()` listens to OS `(prefers-color-scheme: dark)` media query events. The listener is wrapped in an idempotent, StrictMode-safe lifecycle hook that updates root CSS tokens dynamically when the OS theme toggles.

---

## 3. Five Independent Workspace Areas

Users can independently customize background colors and opacity levels across 5 workspace regions under **Background & Transparency per Area**:

| Area Key | Name (`labelKey`) | Target Element / Region | Default Color Source |
|---|---|---|---|
| `canvas` | **Global Canvas** (`theme.area_canvas`) | Window background canvas (`.app-container`, body) | Preset `bg` |
| `sidebar` | **Sidebars (Dock & Sessions)** (`theme.area_sidebar`) | Project dock (`.project-dock`) and session history drawer (`.session-history-drawer`) | Preset `surface` |
| `chat` | **Main Area (Agent Responses / Chat)** (`theme.area_chat`) | Chat message stream viewport (`.chat-viewport`) | Preset `bg` |
| `prompt` | **Prompt Area (Input / Footer)** (`theme.area_prompt`) | Prompt composer container (`.app-footer`) and input box (`.prompt-textarea`) | Preset `surface` |
| `cards` | **Cards & Bubbles** (`theme.area_cards`) | Assistant message cards (`.message-card`, `.assistant-card`), thinking blocks (`.thinking-block`), user bubbles | Preset `surface` |

### Area Controls
- **Background Opacity Slider**: Adjustable from `0%` (fully transparent) to `100%` (fully opaque) in 5% increments. Includes quick-action shortcuts for **0% (Make Transparent)** and **100%**. Setting opacity below 100% reveals underlying canvas colors or wallpaper layers.
- **Background Color Picker**: Choose from quick palette swatches or specify an arbitrary 3-digit or 6-digit hex color via the native color picker.
- **Reset Area**: Restores that specific area's background color and opacity to preset defaults without affecting other areas.

---

## 4. Color Overrides & Agent Work Animation

### Interactive Color Overrides
- **Accent Color Override** (`customAccent`): Customizes interactive elements, button highlights, active tabs, and focus rings. Managed via palette swatches or custom hex input. Includes a **Reset** button to return to the preset default.
- **Text Color Override** (`customTextColor`): Overrides primary body and message stream text color across the workspace (`--fg-default`, `--text-primary`).
- **Labels & Tags Color Override** (`customLabelColor`): Overrides badges, tags, inline code blocks, and syntax keywords (`--activity-badge-fg`, `--md-inline-code-fg`, `--tag-color`, `--syntax-keyword`).

### Agent Work Animation ("Working")
The animated activity indicator displayed while the agent is running (`.prompt-degraciao-loader`) supports 3 modes under **Work Loading Animation ("Working")**:

| Mode | Mode Key | Description & Controls |
|---|---|---|
| **Multicolor (Rainbow)** | `multicolor` | Default continuous multi-hue gradient animation. |
| **Single Color** | `single` | Displays a unified custom pulse color. Allows picking a custom primary color (`--loader-color1`) with automated border and glow alpha derivation. |
| **Two Colors (Dual)** | `dual` | Displays a two-tone alternating pulse. Allows picking primary (`--loader-color1`) and secondary (`--loader-color2`) colors with matching glow effects. |

---

## 5. Background Image (Wallpaper)

The wallpaper subsystem (`src/features/settings/wallpaper.ts` and `src/infra/preferences.ts`) enables users to display custom artwork or bundled branding behind transparent workspace areas.

### Supported Image Sources & Security Validation

Images can be supplied via bundled preset, external web URL, or local file upload:

| Scheme / Source | Syntax Example | Validation & Security Rules |
|---|---|---|
| **Bundled Presets** | `/wallpapers/minimalist-ninja-1080p.jpg` | Validated by `isSafeImageUrl()` to begin with `/wallpapers/`. Strictly rejects path traversal patterns (`..` or `\`). |
| **Web URLs (HTTP/HTTPS)** | `https://example.com/wallpaper.jpg` | Validated via `URL` constructor to permit standard `http:` or `https:` protocols. (Note: does not filter embedded user credentials). |
| **Data URLs** | `data:image/png;base64,...` | Bounded to $\le 1\text{ MiB}$ encoded length. `isSafeImageUrl()` permits `png`, `jpeg`, `jpg`, `webp`, `gif`, `bmp`, and `svg+xml` data URLs. |
| **Prohibited Schemes** | `javascript:`, `vbscript:`, `data:text/html`, `file:` | **Strictly rejected** by `isSafeImageUrl()`. Input fails validation and leaves prior saved state untouched. |

> **CSS Formatting & Injection Boundaries**: Wallpaper URLs are formatted for CSS `background-image: url(...)` using `formatCssUrl()`, which wraps the URL with `JSON.stringify(url)`. While this escapes double quotes, newlines, and control characters, CSS `url(...)` parsing across browser engines can have subtle edge cases; JSON stringification alone is not a categorical syntax or security guarantee. Security relies fundamentally on the strict scheme and format allowlist enforced by `isSafeImageUrl()`.

### Privacy Notice for Remote URLs
When an external `http://` or `https://` URL is configured, the desktop WebView issues an HTTP request to that remote server when rendering the background. A visible warning banner is displayed:
> *ℹ️ Warning: Remote images contact an external host when loaded.*

Users who wish to maintain offline privacy should use bundled presets or local device uploads.

### Bundled Wallpapers
Pi Viewer bundles an optimized 1080p preset plus the full original asset:
- **Minimalist Ninja (1080p)**: `/wallpapers/minimalist-ninja-1080p.jpg` (optimized 1080p preset)
- **Minimalist Ninja (Original)**: `/wallpapers/minimalist-ninja.jpg` (unscaled original image)

---

## 6. Device Upload Pipeline & Safety Limits

When uploading a wallpaper from a local device, Pi Viewer processes the image client-side through a bounded memory and canvas pipeline before storing it:

```
File Selected
     │
     ├── 1. Pre-Read Validation (MIME check & 5 MiB size cap)
     │        └── Failure: "Image file exceeds the 5 MiB limit"
     │
     ├── 2. FileReader (Data URL conversion)
     │
     ├── 3. Dimension Decode & Resolution Gate (<= 16 MP cap)
     │        └── Failure: "Image resolution exceeds 16 megapixels limit"
     │
     ├── 4. Bounding Box Rescale (max 1280px dimension, aspect preserved)
     │
     ├── 5. Canvas Compression Loop (JPEG qualities: 0.8 -> 0.6 -> 0.4 -> 0.2)
     │        └── Encoded length <= 1 MiB?
     │              ├── Yes: Success -> Stage Data URL
     │              └── No:  Failure: "Could not compress image within 1 MiB"
```

### Safety Limits & Processing Specifications

| Parameter | Limit | Enforcement Point | Technical Scope & Boundary |
|---|---|---|---|
| **Allowed Upload Formats** | JPEG, PNG, WebP, GIF | Pre-read file MIME check | Enforced by `validateWallpaperFileInput()`. Rejects SVG, BMP, or non-raster formats (`invalid_type`). |
| **Input File Size Cap** | **5 MiB** (5,242,880 bytes) | Pre-read file size check | Validates file metadata before reading, but does not prevent all downstream memory allocation during `FileReader` execution (`file_too_large`). |
| **Post-Decode Pixel Cap** | **16 MP** (16,777,216 pixels) | Pre-canvas decode check | Enforced **after** image decode and **before** canvas allocation. Protects canvas allocation memory, but cannot prevent the browser's initial image decoding memory allocation or all decompression bombs (`pixel_limit_exceeded`). |
| **Output Bounding Box** | **1280 px** maximum dimension | Aspect-ratio preserving rescale | Bounded canvas dimensions (e.g. 1920x1080 rescales to 1280x720). |
| **Encoded Storage Cap** | **1 MiB** (1,048,576 characters) | Stepped JPEG canvas output | Evaluated across stepped qualities `[0.8, 0.6, 0.4, 0.2]`. If all fail, fails cleanly without falling back to unbounded raw data. |

### Important Format Conversion Behaviors
- **Transparency Loss**: Uploaded images are drawn to canvas and compressed to `image/jpeg` to ensure predictable byte sizing. Any transparency in PNG or WebP files is rendered against the canvas default background (alpha channel is not preserved).
- **Static GIF (No Animation)**: Drawing an animated GIF onto HTML5 2D canvas produces a static image without animation (the browser renders a static frame with no animation playback; not guaranteed to be the first frame across all browser engines).

### Upload Cancellation & Concurrency Coordination
Image processing runs asynchronously in the background coordinated by `WallpaperProcessCoordinator`:
- **Generation Invalidation**: Upload cancellation invalidates generation counters and triggers `AbortSignal` checks evaluated between processing stages (pre-read, post-read, pre-canvas, and between compression quality steps).
- **Active I/O Limits**: The browser adapter does NOT abort active in-flight `FileReader` reading or `Image` decoding operations mid-stream (no active I/O abort in the adapter).
- **Trigger Actions**: Typing into the URL input stages the draft URL but does NOT cancel an in-flight upload. Explicit actions—clicking **Apply URL** (or pressing Enter in the URL field), selecting a bundled preset, clicking clear, unchecking the enable toggle, or confirming/cancelling/resetting—cancel in-flight processing immediately.

### Wallpaper Display Properties

| Setting | Options / Range | CSS Mapping |
|---|---|---|
| **Image Fit** | Cover, Contain, Stretch (`100% 100%`), Repeat Tile, Auto | Maps to `background-size`. Notice: `repeat` is mapped to `background-size: auto; background-repeat: repeat;` to maintain standards compliance. |
| **Position** | Center, Top, Bottom, Left, Right | Maps to `background-position`. |
| **Opacity** | 0% to 100% (default 40%) | Controls wallpaper layer alpha (`opacity: <value>`). |
| **Blur Filter** | 0 px to 30 px (default 0 px) | Maps to CSS `filter: blur(<value>px)`. |

---

## 7. Storage Quota Resilience & Architecture Boundary

### Storage Quota Resilience
All confirmed customizations are serialized into the single `pi_viewer_ui_preferences` JSON key in `localStorage`:
- Storage operations are wrapped in `try / catch` blocks handling `QuotaExceededError` or browser security restrictions.
- In the event of a storage write failure:
  1. **Saved preferences are NOT modified or overwritten.**
  2. The failure error is surfaced in the UI error banner.
  3. The active preview remains visible in the DOM so the user does not lose their configuration, but the draft is not marked as confirmed.

### Architecture Scope & Rust Backend Boundary
- **Backend Preserved**: The visual customization subsystem is entirely frontend-driven (`src/features/settings/`, `src/infra/preferences.ts`, `src/shared/theme.ts`).
- **No Rust IPC Changes**: Tauri commands and Rust domain modules (`src-tauri/src/commands/`) remain unchanged and out of scope for visual customization.

---

## 8. Verification Status & Known Limitations

| Check | Status | Details |
|---|---|---|
| **Full Unit & Integration Suite** | **Passed** | Full frontend test suite (1056 tests passing across core, features, infra, shared, and architecture suites). |
| **Architectural Boundary Rules** | **Passed** | `npm run check:arch` passes all 8 boundary rules. |
| **Production Build** | **Passed** | `npm run build` compiles frontend assets with zero TypeScript or bundling errors. |
| **Browser / Tauri Runtime Walkthrough** | **Pending (T7)** | Test environment harness lacks Playwright/browser runners. Automated runtime browser execution, computed styles across all five areas, and desktop acceptance remain pending task T7 runtime verification rather than asserting complete source contracts. |
