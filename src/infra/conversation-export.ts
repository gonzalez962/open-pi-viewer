import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  triggerDownload,
  type DownloadOptions,
  type DownloadPayload,
  type DownloadResult,
} from './download';

export type ExportSaveOutcome = 'saved' | 'cancelled' | 'initiated';

export interface ExportSavedResult {
  outcome: 'saved';
  status: 'saved';
  path: string;
  filename: string;
}

export interface ExportCancelledResult {
  outcome: 'cancelled';
  status: 'cancelled';
}

export interface ExportInitiatedResult {
  outcome: 'initiated';
  status: 'initiated';
  filename: string;
}

export type SaveExportResult =
  | ExportSavedResult
  | ExportCancelledResult
  | ExportInitiatedResult;

export interface SaveExportPayload {
  content: string;
  filename?: string;
  defaultFilename?: string;
  format: 'markdown' | 'json' | 'md' | string;
  mimeType?: string;
}

export interface SaveExportOptions {
  invokeFn?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  isTauriFn?: () => boolean;
  triggerDownloadFn?: (
    payload: DownloadPayload,
    options?: DownloadOptions
  ) => DownloadResult;
  downloadOptions?: DownloadOptions;
}

/**
 * Platform adapter for conversation export persistence.
 *
 * In Tauri desktop environment:
 * - Invokes backend `save_conversation_export` command.
 * - Displays native OS Save As dialog via backend `rfd`.
 * - Backend writes UTF-8 file before returning the chosen path.
 * - Dialog cancellation returns `{ outcome: 'cancelled', status: 'cancelled' }`.
 * - Native invocation errors propagate directly to caller (NEVER falls back to web download in Tauri).
 *
 * In Web browser preview environment:
 * - Falls back to host Blob + temporary anchor click (`triggerDownload`).
 * - Returns honest `{ outcome: 'initiated', status: 'initiated', filename }`
 *   signifying download manager was triggered without false persistent save guarantees.
 */
export async function saveConversationExport(
  payload: SaveExportPayload,
  options?: SaveExportOptions
): Promise<SaveExportResult> {
  const defaultFilename = (payload.defaultFilename || payload.filename || '').trim();
  const content = payload.content;
  const format = payload.format;

  const inTauri = options?.isTauriFn
    ? options.isTauriFn()
    : options?.invokeFn !== undefined
      ? true
      : isTauri();

  if (inTauri) {
    const invokeFn = options?.invokeFn ?? invoke;
    const selectedPath = await invokeFn<string | null>('save_conversation_export', {
      defaultFilename,
      content,
      format,
    });

    if (selectedPath) {
      return {
        outcome: 'saved',
        status: 'saved',
        path: selectedPath,
        filename: defaultFilename,
      };
    }

    return {
      outcome: 'cancelled',
      status: 'cancelled',
    };
  }

  // Web environment: browser anchor click download
  const downloadFn = options?.triggerDownloadFn ?? triggerDownload;
  const mimeType =
    payload.mimeType ||
    (format.toLowerCase() === 'json'
      ? 'application/json;charset=utf-8'
      : 'text/markdown;charset=utf-8');

  const dlResult = downloadFn(
    {
      content,
      filename: defaultFilename,
      mimeType,
    },
    options?.downloadOptions
  );

  if (dlResult.success && dlResult.initiated) {
    return {
      outcome: 'initiated',
      status: 'initiated',
      filename: dlResult.filename,
    };
  }

  throw new Error(dlResult.error || 'Download initiation failed');
}
