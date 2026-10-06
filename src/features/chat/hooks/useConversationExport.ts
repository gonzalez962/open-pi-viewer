import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatAction } from '@core/reducer';
import type { ChatMessage } from '@core/types/messages';
import {
  type SaveExportPayload,
  type SaveExportOptions,
  saveConversationExport,
} from '@infra/conversation-export';
import { translate, type SupportedLocale } from '@shared/i18n';
import { exportConversation, type ExportOutcome } from '../conversation-export';
import type { ExportToastState } from '../components/ExportToast';

export interface UseConversationExportOptions {
  messages: readonly ChatMessage[];
  sessionTitle?: string;
  language: SupportedLocale;
  /** @deprecated Retained for backward compatibility. */
  dispatch?: React.Dispatch<ChatAction>;
  autoDismissMs?: number;
  saveAdapter?: (
    payload: SaveExportPayload,
    options?: SaveExportOptions
  ) => ReturnType<typeof saveConversationExport>;
}

export interface UseConversationExportResult {
  handleExport: (args: string) => Promise<ExportOutcome>;
  toast: ExportToastState | null;
  dismissToast: () => void;
}

/**
 * Hook providing export orchestration, in-progress loading feedback,
 * and ephemeral accessible toast result notifications (5s auto-dismiss).
 */
export function useConversationExport({
  messages,
  sessionTitle,
  language,
  dispatch,
  autoDismissMs = 5000,
  saveAdapter,
}: UseConversationExportOptions): UseConversationExportResult {
  const [toast, setToast] = useState<ExportToastState | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearDismissTimer = useCallback(() => {
    if (dismissTimerRef.current !== null) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
  }, []);

  const scheduleDismiss = useCallback(
    (ms: number) => {
      clearDismissTimer();
      dismissTimerRef.current = setTimeout(() => {
        setToast(null);
        dismissTimerRef.current = null;
      }, ms);
    },
    [clearDismissTimer]
  );

  const dismissToast = useCallback(() => {
    clearDismissTimer();
    setToast(null);
  }, [clearDismissTimer]);

  useEffect(() => {
    return () => {
      clearDismissTimer();
    };
  }, [clearDismissTimer]);

  const handleExport = useCallback(
    async (args: string): Promise<ExportOutcome> => {
      clearDismissTimer();

      const outcome = await exportConversation({
        args,
        messages,
        sessionTitle,
        language,
        dispatch,
        saveAdapter,
        onProgress: () => {
          setToast({
            type: 'loading',
            message: translate(language, 'command_palette.export_in_progress'),
          });
        },
      });

      switch (outcome.status) {
        case 'cancelled': {
          // Native dialog cancellation is completely silent
          setToast(null);
          break;
        }
        case 'success': {
          const message =
            outcome.outcome === 'saved'
              ? translate(language, 'command_palette.export_saved', {
                  filename: outcome.filename,
                })
              : translate(language, 'command_palette.export_success', {
                  filename: outcome.filename,
                });
          setToast({ type: 'success', message });
          scheduleDismiss(autoDismissMs);
          break;
        }
        case 'empty': {
          setToast({
            type: 'info',
            message: translate(language, 'command_palette.export_empty'),
          });
          scheduleDismiss(autoDismissMs);
          break;
        }
        case 'invalid_format': {
          setToast({
            type: 'error',
            message: translate(language, 'command_palette.export_invalid_format', {
              format: outcome.error,
            }),
          });
          scheduleDismiss(autoDismissMs);
          break;
        }
        case 'failed': {
          setToast({
            type: 'error',
            message: translate(language, 'command_palette.export_failed', {
              error: outcome.error,
            }),
          });
          scheduleDismiss(autoDismissMs);
          break;
        }
      }

      return outcome;
    },
    [
      messages,
      sessionTitle,
      language,
      dispatch,
      saveAdapter,
      autoDismissMs,
      clearDismissTimer,
      scheduleDismiss,
    ]
  );

  return { handleExport, toast, dismissToast };
}
