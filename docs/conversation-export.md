# Conversation Export

Pure deterministic Markdown and versioned JSON serializers for the current loaded conversation in Open Pi Viewer.

## Overview

Conversation export allows users to export the active transcript displayed in the viewer into clean Markdown (`.md`) or versioned JSON (`.json`) files.

This document describes the pure core logic implemented in **T1** (`src/core/export.ts` and `src/core/types/export.ts`). Browser download triggers, `/export` slash-command registration, and UI integration are part of **T2** and **T3** and are tracked as pending.

## Content Policy: `conversation_summary`

The exporter implements the explicit `conversation_summary` privacy policy:

| Field | Included? | Notes |
|---|---|---|
| **Message text** | Yes | Full canonical message text preserved. |
| **Role & timestamp** | Yes | Capitalized role label and display timestamp. |
| **Tool calls** | Restricted | **Name and status only** (`running`, `completed`, `error`). |
| **Tool arguments** | **No** | Completely omitted (prevents leaking tokens, paths, keys). |
| **Tool output** | **No** | Completely omitted (prevents leaking command/file data). |
| **Thinking blocks** | **No** | Completely omitted (internal reasoning is excluded). |
| **Image attachments** | Restricted | **Count and MIME types only**. Base64/binary data omitted. |
| **Environment / CWD** | **No** | Working directory and absolute paths are never added. |
| **Session store paths** | **No** | Internal session storage locations are never added. |

> **Important Disclosure**: No automatic secret or credential redaction is performed on message text. Users are notified to review transcripts before sharing.

## Quick path (Core API)

```typescript
import {
  exportToMarkdown,
  exportToJson,
  generateExportFilename,
  isExportableTranscript,
} from '@core/export';

// 1. Validate transcript has messages
if (!isExportableTranscript(messages)) {
  // Reject or inform user (T2/T3 flow)
}

// 2. Generate export content (explicit timestamp or deterministic epoch fallback)
const mdContent = exportToMarkdown(messages, {
  title: 'Bug Investigation',
  exportedAt: '2026-03-30T15:00:00.000Z', // When omitted or invalid, defaults to '1970-01-01T00:00:00.000Z'
});

const jsonContent = exportToJson(messages, {
  title: 'Bug Investigation',
  exportedAt: '2026-03-30T15:00:00.000Z',
});

// 3. Generate safe portable filename
const filename = generateExportFilename({
  title: 'Bug Investigation',
  format: 'markdown', // or 'json'
  exportedAt: '2026-03-30T15:00:00.000Z', // When omitted or invalid, defaults to '1970-01-01'
});
// Output: "bug-investigation-2026-03-30.md"
```

## Canonical Text Precedence

In Open Pi Viewer's messaging architecture:
1. `ChatMessage.content` contains the full accumulated string text.
2. `ChatMessage.blocks` contains parsed blocks (`TextBlock`, `ThinkingBlock`, `ToolCallBlock`).

To avoid duplicating content:
- When `blocks` contains one or more `TextBlock` items, those text blocks represent the authoritative, ordered segments (interleaved with tool calls). `content` is **not** appended again.
- When `blocks` contains no `TextBlock` items (or `blocks` is empty/undefined), `content` is used as the canonical text.
- When `blocks` contains tool calls and `content` is non-empty without text blocks, `content` provides the text explanation while `blocks` provides the tool call entries.

## Format Specifications

### 1. Markdown Export (`.md`)

- **Disclosures Header**: States loaded transcript scope, omission policy, and secret redaction notice.
- **Message Headers**: `## User (10:00:00 AM)` or `## Assistant (10:00:05 AM)`.
- **Attached Images**: `*[Images: 2 (image/png, image/jpeg)]*`.
- **Tool Executions**: `_Tool:_ `tool_name` (status: completed)`.
- **Formatting Safety**: Emits clean standard Markdown. Tool names have control characters, backticks, and `<>` stripped so no executable HTML tags or broken code spans can be injected. Authored markdown fences and inline code in message text are preserved intact.

### 2. Versioned JSON Export (`.json`)

```json
{
  "schemaVersion": 1,
  "metadata": {
    "schemaVersion": 1,
    "title": "Bug Investigation",
    "exportedAt": "2026-03-30T15:00:00.000Z",
    "messageCount": 2,
    "disclosures": {
      "scope": "Export reflects the currently loaded transcript in the viewer only, not persistent session history or backend storage.",
      "contentPolicy": "conversation_summary: message text, roles, timestamps, tool names and status, and image metadata (counts/MIMEs). Omitted: thinking blocks, tool arguments, tool outputs/paths, and binary/base64 image data.",
      "secretRedactionNotice": "No automatic text secret or credential redaction is performed. Please review before sharing."
    }
  },
  "messages": [
    {
      "role": "user",
      "timestamp": "10:00:00 AM",
      "text": "Please inspect the error.",
      "images": {
        "count": 1,
        "mimeTypes": ["image/png"]
      }
    },
    {
      "role": "assistant",
      "timestamp": "10:00:05 AM",
      "text": "The error was resolved.",
      "tools": [
        {
          "name": "grep",
          "status": "completed"
        }
      ]
    }
  ]
}
```

## Filename Sanitization & Portability

Export filenames are generated via `sanitizeExportFilename` and `generateExportFilename`:
- **Windows reserved devices**: Names such as `CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9` (and variations like `CON.txt`) are prefixed with `session-` to prevent OS filesystem errors.
- **Path separators and traversal**: Directory separators (`/`, `\`) and sequences (`..`) are replaced with dashes.
- **Control characters**: `U+0000` through `U+001F` and `U+007F` are removed.
- **Trailing dots and spaces**: Stripped to prevent Windows naming violations.
- **Length bound**: Title slug is bounded to 50 characters. Windows reserved device prefixes are applied before bounding length to ensure the final slug never exceeds 50 characters.
- **Unicode surrogate pairs**: Truncation avoids cutting between high and low surrogate code units at the 50-character boundary.
- **Fallback sanitization**: When the title is missing or stripped away, the fallback title itself is sanitized against the same rules. If the fallback produces an empty slug, it defaults to `pi-conversation`.
- **Determinism & Epoch Fallbacks**: Accepts `exportedAt` (Date or ISO 8601 string). When absent, malformed, or an `Invalid Date` object, pure domain utilities deterministically fall back to the Unix epoch (`1970-01-01` for filenames, `1970-01-01T00:00:00.000Z` for markdown/JSON metadata), never accessing the ambient system clock.
- **Consistent UTC Parsing**: Date strings with timezone offsets (such as `2026-01-01T01:00:00+05:00`) are parsed and converted to UTC (`2025-12-31`). Calendar components are validated intentionally to reject impossible dates (such as `2026-02-31` or `9999-99-99`), falling back to epoch rather than normalizing to another date.

## Integration Roadmap

| Task | Scope | Status |
|---|---|---|
| **T1** | Pure serializers, types, safe filenames, policy tests, documentation | **Completed** |
| **T2** | Browser/native download adapter (`src/infra/download.ts`), `/export` command registration | Pending |
| **T3** | Hook orchestration (`useConversationExport`), UI command wire-up, end-to-end checks | Pending |

## Acceptance Checklist

- [x] Pure deterministic Markdown serializer (`exportToMarkdown`).
- [x] Versioned JSON serializer with schema version 1 (`exportToJson`).
- [x] Disclosures for loaded-transcript scope, omission policy, and secret redaction notice in both formats.
- [x] Omission of thinking blocks, tool arguments, tool outputs, and image base64 data.
- [x] Inclusion of message text, roles, timestamps, tool names, tool status, image counts, and MIME types.
- [x] Canonical text precedence avoids duplicate text between `content` and `blocks`.
- [x] Safe filename generation handling Windows device names, trailing dots/spaces, controls, traversal, and bounded length.
- [x] Input immutability verified (no array or object mutation).
- [x] Empty transcript handling and `isExportableTranscript` guard.
- [x] Architecture boundary verified (zero imports outside `core/`).
