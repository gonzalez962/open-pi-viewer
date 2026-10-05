import { useCallback } from 'react';
import type { ChatAction } from '@core/reducer';
import type { ChatMessage } from '@core/types/messages';
import type { SupportedLocale } from '@shared/i18n';
import { exportConversation, type ExportOutcome } from '../conversation-export';

export interface UseConversationExportOptions {
  messages: readonly ChatMessage[];
  sessionTitle?: string;
  language: SupportedLocale;
  dispatch: React.Dispatch<ChatAction>;
}

/**
 * Hook providing export callback for slash command /export dispatch in chat.
 */
export function useConversationExport({
  messages,
  sessionTitle,
  language,
  dispatch,
}: UseConversationExportOptions) {
  const handleExport = useCallback(
    (args: string): Promise<ExportOutcome> => {
      return exportConversation({
        args,
        messages,
        sessionTitle,
        language,
        dispatch,
      });
    },
    [messages, sessionTitle, language, dispatch]
  );

  return { handleExport };
}
