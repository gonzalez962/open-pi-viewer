import {
  exportToMarkdown,
  exportToJson,
  generateExportFilename,
  isExportableTranscript,
} from '@core/export';
import type { ChatAction } from '@core/reducer';
import type { ChatMessage, TextBlock } from '@core/types/messages';
import type { SessionSummary } from '@core/types/sessions';
import { triggerDownload } from '@infra/download';
import { translate, type SupportedLocale } from '@shared/i18n';

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
  | { status: 'success'; filename: string }
  | { status: 'empty' }
  | { status: 'invalid_format'; error: string }
  | { status: 'failed'; error: string };

export interface ExportConversationOptions {
  args: string;
  messages: readonly ChatMessage[];
  sessionTitle?: string;
  language: SupportedLocale;
  dispatch: (action: ChatAction) => void;
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
 * Pure feature controller for /export execution:
 * 1. Validates format arguments locally (default md; rejects extra/invalid args).
 * 2. Snapshots messages before any dispatch/feedback occurs.
 * 3. Encompasses entire preparation pipeline (empty checks, clock, serialization, download) in try/catch.
 * 4. Captures timestamp once at boundary and passes to filename + serializers.
 * 5. Initiates host download adapter and dispatches visible system notices.
 */
export function exportConversation({
  args,
  messages,
  sessionTitle,
  language,
  dispatch,
  downloadAdapter = { triggerDownload },
  now = () => new Date(),
}: ExportConversationOptions): ExportOutcome {
  // 1. Validate format arguments locally
  const parsedFormat = parseExportFormat(args);
  if (!parsedFormat.ok) {
    const content = translate(
      language,
      'command_palette.export_invalid_format',
      { format: parsedFormat.raw }
    );
    dispatch({
      type: 'ADD_SYSTEM_MESSAGE',
      payload: { content },
    });
    return { status: 'invalid_format', error: parsedFormat.raw };
  }

  // 2. Snapshot messages BEFORE any feedback or dispatch
  const messagesSnapshot = Array.isArray(messages) ? [...messages] : [];

  // Encompass entire preparation and download pipeline in try/catch
  try {
    // 3. Check for exportable content
    if (!hasExportableContent(messagesSnapshot)) {
      const content = translate(language, 'command_palette.export_empty');
      dispatch({
        type: 'ADD_SYSTEM_MESSAGE',
        payload: { content },
      });
      return { status: 'empty' };
    }

    // 4. Capture timestamp ONCE at feature boundary
    const timestamp = now();

    // 5. Generate content and safe filename
    const format = parsedFormat.format;
    const filename = generateExportFilename({
      title: sessionTitle,
      format,
      exportedAt: timestamp,
    });

    const content =
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

    // 6. Trigger host download initiation
    const result = downloadAdapter.triggerDownload({
      content,
      filename,
      mimeType,
    });

    if (result.success && result.initiated) {
      const notice = translate(language, 'command_palette.export_success', {
        filename: result.filename,
      });
      dispatch({
        type: 'ADD_SYSTEM_MESSAGE',
        payload: { content: notice },
      });
      return { status: 'success', filename: result.filename };
    } else {
      const errorMsg = result.error || 'Download initiation failed';
      const notice = translate(language, 'command_palette.export_failed', {
        error: errorMsg,
      });
      dispatch({
        type: 'ADD_SYSTEM_MESSAGE',
        payload: { content: notice },
      });
      return { status: 'failed', error: errorMsg };
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const notice = translate(language, 'command_palette.export_failed', {
      error: errorMsg,
    });
    dispatch({
      type: 'ADD_SYSTEM_MESSAGE',
      payload: { content: notice },
    });
    return { status: 'failed', error: errorMsg };
  }
}
