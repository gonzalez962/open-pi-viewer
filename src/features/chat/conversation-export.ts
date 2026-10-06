import {
  exportToMarkdown,
  exportToJson,
  generateExportFilename,
  isExportableTranscript,
} from '@core/export';
import type { ChatAction } from '@core/reducer';
import type { ChatMessage, TextBlock } from '@core/types/messages';
import type { SessionSummary } from '@core/types/sessions';
import {
  saveConversationExport,
  type SaveExportPayload,
  type SaveExportOptions,
} from '@infra/conversation-export';
import type { SupportedLocale } from '@shared/i18n';

export type ResolvedExportFormat = 'markdown' | 'json';

export type ParseExportFormatResult =
  | { ok: true; format: ResolvedExportFormat }
  | { ok: false; raw: string };

/**
 * Parses raw argument text into a resolved export format.
 * - Defaults to 'markdown' on empty or whitespace-only input.
 * - Accepts 'md' (case-insensitive) as 'markdown'.
 * - Accepts 'json' (case-insensitive) as 'json'.
 * - Rejects any other or extra arguments locally.
 */
export function parseExportFormat(args: string): ParseExportFormatResult {
  const trimmed = args.trim();
  if (!trimmed) {
    return { ok: true, format: 'markdown' };
  }
  const lower = trimmed.toLowerCase();
  if (lower === 'md') {
    return { ok: true, format: 'markdown' };
  }
  if (lower === 'json') {
    return { ok: true, format: 'json' };
  }
  return { ok: false, raw: trimmed };
}

/**
 * Resolves session title for export metadata and filenames:
 * Prefers trimmed customTitle, falls back to trimmed firstMessage, or undefined.
 * Never invents an activeSession.name property.
 */
export function resolveExportTitle(
  session?: Pick<SessionSummary, 'customTitle' | 'firstMessage'> | null
): string | undefined {
  const custom = session?.customTitle?.trim();
  if (custom) return custom;
  const first = session?.firstMessage?.trim();
  if (first) return first;
  return undefined;
}

/**
 * Checks whether transcript contains exportable content beyond empty placeholders.
 * Adheres to canonical text precedence and content omission policy:
 * - When blocks contain text blocks, they take precedence; content is not duplicated.
 * - When blocks contain no text blocks, canonical text falls back to content.
 * - Thinking blocks are strictly omitted and do not count as exportable content.
 * - Tool calls (name and status) and images (metadata) count as exportable content.
 */
export function hasExportableContent(
  messages?: readonly ChatMessage[] | null
): boolean {
  if (!messages || !isExportableTranscript(messages)) return false;
  return messages.some((m) => {
    // 1. Resolve canonical text following precedence
    let canonicalText = '';
    if (Array.isArray(m.blocks) && m.blocks.length > 0) {
      const textBlocks = m.blocks.filter(
        (b): b is TextBlock => b.type === 'text' && typeof b.text === 'string'
      );
      if (textBlocks.length > 0) {
        canonicalText = textBlocks.map((b) => b.text).join('');
      } else {
        canonicalText = typeof m.content === 'string' ? m.content : '';
      }
    } else {
      canonicalText = typeof m.content === 'string' ? m.content : '';
    }

    if (canonicalText.trim().length > 0) {
      return true;
    }

    // 2. Tool calls (name and status) count as exportable
    if (
      Array.isArray(m.blocks) &&
      m.blocks.some((b) => b.type === 'tool_call')
    ) {
      return true;
    }

    // 3. Image attachments (metadata) count as exportable
    if (Array.isArray(m.images) && m.images.length > 0) {
      return true;
    }

    return false;
  });
}

export type ExportOutcome =
  | { status: 'success'; filename: string; outcome?: 'saved' | 'initiated'; path?: string }
  | { status: 'cancelled' }
  | { status: 'empty' }
  | { status: 'invalid_format'; error: string }
  | { status: 'failed'; error: string };

export interface ExportConversationOptions {
  args: string;
  messages: readonly ChatMessage[];
  sessionTitle?: string;
  language: SupportedLocale;
  /** @deprecated Retained for backward compatibility; export feedback now uses ephemeral toast rather than ADD_SYSTEM_MESSAGE. */
  dispatch?: (action: ChatAction) => void;
  /** Optional callback invoked when validation passes and serialization/save begins. */
  onProgress?: () => void;
  /**
   * Platform-aware save adapter (Tauri native dialog or browser download).
   * Defaults to saveConversationExport from @infra/conversation-export.
   * Injected in tests to avoid real I/O.
   */
  saveAdapter?: (
    payload: SaveExportPayload,
    options?: SaveExportOptions
  ) => ReturnType<typeof saveConversationExport>;
  /** @deprecated Use saveAdapter. Kept for tests that mock browser downloads directly. */
  downloadAdapter?: {
    triggerDownload: (payload: {
      content: string;
      filename: string;
      mimeType?: string;
    }) => {
      success: boolean;
      initiated: boolean;
      filename: string;
      error?: string;
    };
  };
  now?: () => Date;
}

/**
 * Async feature controller for /export execution:
 * 1. Validates format arguments locally (default md; rejects extra/invalid args).
 * 2. Snapshots messages before any feedback occurs.
 * 3. Encompasses entire preparation + save pipeline in try/catch.
 * 4. Captures timestamp once at boundary and passes to filename + serializers.
 * 5. Notifies onProgress before platform adapter interaction.
 * 6. Delegates persistence to saveAdapter (Tauri: native Save As dialog; web: browser download).
 * 7. Returns 'cancelled' silently when user dismisses the native dialog.
 * 8. Never dispatches ADD_SYSTEM_MESSAGE: feedback is handled ephemerally by toast UI.
 */
export async function exportConversation({
  args,
  messages,
  sessionTitle,
  language: _language,
  dispatch: _dispatch,
  onProgress,
  saveAdapter = saveConversationExport,
  downloadAdapter,
  now = () => new Date(),
}: ExportConversationOptions): Promise<ExportOutcome> {
  // 1. Validate format arguments locally
  const parsedFormat = parseExportFormat(args);
  if (!parsedFormat.ok) {
    return { status: 'invalid_format', error: parsedFormat.raw };
  }

  // 2. Snapshot messages BEFORE any feedback or save occurs
  const messagesSnapshot = Array.isArray(messages) ? [...messages] : [];

  try {
    // 3. Check for exportable content
    if (!hasExportableContent(messagesSnapshot)) {
      return { status: 'empty' };
    }

    // 4. Signal progress now that validation has passed
    onProgress?.();

    // 5. Capture timestamp ONCE at feature boundary
    const timestamp = now();

    // 6. Generate serialized content and safe filename
    const format = parsedFormat.format;
    const filename = generateExportFilename({
      title: sessionTitle,
      format,
      exportedAt: timestamp,
    });

    const serialized =
      format === 'json'
        ? exportToJson(messagesSnapshot, {
            title: sessionTitle,
            exportedAt: timestamp,
          })
        : exportToMarkdown(messagesSnapshot, {
            title: sessionTitle,
            exportedAt: timestamp,
          });

    const mimeType =
      format === 'json'
        ? 'application/json;charset=utf-8'
        : 'text/markdown;charset=utf-8';

    // 7. Persist via platform-aware adapter (native dialog in Tauri, browser download on web)
    // Legacy downloadAdapter path kept for backward compatibility with existing tests.
    if (downloadAdapter) {
      const result = downloadAdapter.triggerDownload({
        content: serialized,
        filename,
        mimeType,
      });
      if (result.success && result.initiated) {
        return { status: 'success', filename: result.filename, outcome: 'initiated' };
      }
      const errorMsg = result.error || 'Download initiation failed';
      return { status: 'failed', error: errorMsg };
    }

    const saveResult = await saveAdapter({ content: serialized, defaultFilename: filename, format, mimeType });

    if (saveResult.outcome === 'cancelled') {
      // User dismissed the native dialog — silent, no error message
      return { status: 'cancelled' };
    }

    if (saveResult.outcome === 'saved') {
      return {
        status: 'success',
        filename: saveResult.filename,
        outcome: 'saved',
        path: saveResult.path,
      };
    }

    if (saveResult.outcome === 'initiated') {
      return {
        status: 'success',
        filename: saveResult.filename,
        outcome: 'initiated',
      };
    }

    // Unexpected outcome
    return { status: 'failed', error: 'Unexpected save result' };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { status: 'failed', error: errorMsg };
  }
}
