import { useEffect, useState } from 'react';
import {
  abortPi,
  sendPromptPi,
  type PromptImageAttachment,
} from '@infra/bridge';
import { generatePromptRequestId } from '@core/protocol';
import { buildCopyAllCodeText, getLastAssistantCodeBlocks } from '@core/markdown';
import { buildInsertCodeDraft } from '@core/prompt-controls-utils';
import type { ChatAction } from '@core/reducer';
import type { ChatMessage } from '@core/types/messages';
import { copyText } from '@shared/clipboard';
import type { AttachedFile } from '../types';

export interface UsePromptStateOptions {
  isReadyToSend: boolean;
  isBusy: boolean;
  /**
   * True when a follow-up prompt can be queued while the agent is busy (connected,
   * hydrated, not resetting). Distinct from `isReadyToSend`, which gates an ordinary
   * idle send; the two are mutually exclusive since `isReadyToSend` requires `!isBusy`.
   */
  canQueue: boolean;
  pendingPromptId: string | null;
  dispatch: React.Dispatch<ChatAction>;
  /**
   * T5a's scroll primitive (`useChatScroll`'s `pinAndJumpToBottom`), injected rather than
   * imported directly so this hook stays inside `features/chat` without reaching into
   * another cluster's internals.
   */
  pinAndJumpToBottom: () => void;
  /**
   * Active project's chat messages, used only by the Alt+C / Alt+I global code shortcuts
   * (Issue #7) to locate the last assistant message's code blocks.
   */
  messages: ChatMessage[];
}

/**
 * Prompt cluster: the textarea draft, send/abort handlers, and the Enter-to-send key binding.
 */
export function usePromptState({
  isReadyToSend,
  isBusy,
  canQueue,
  pendingPromptId,
  dispatch,
  pinAndJumpToBottom,
  messages,
}: UsePromptStateOptions) {
  const [prompt, setPrompt] = useState('');
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);

  // Global Alt+C (copy all executable code from the last assistant message with code) /
  // Alt+I (insert its last snippet into the prompt draft) shortcuts (Issue #7). Uses
  // event.code (KeyC/KeyI) rather than event.key so both bindings work across keyboard
  // layouts. All matching/selection logic is pure core (`@core/markdown`); this effect is
  // thin glue wiring it to the DOM and the prompt draft setter.
  useEffect(() => {
    function handleGlobalCodeShortcut(e: KeyboardEvent) {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;

      if (e.code === 'KeyC') {
        const blocks = getLastAssistantCodeBlocks(messages);
        const text = buildCopyAllCodeText(blocks);
        if (text === null) return;
        e.preventDefault();
        void copyText(text);
        return;
      }

      if (e.code === 'KeyI') {
        const blocks = getLastAssistantCodeBlocks(messages);
        const last = blocks[blocks.length - 1];
        if (!last || last.isDiff) return;
        e.preventDefault();
        setPrompt((prev) => buildInsertCodeDraft(prev, last.code, last.language));
      }
    }

    window.addEventListener('keydown', handleGlobalCodeShortcut);
    return () => window.removeEventListener('keydown', handleGlobalCodeShortcut);
  }, [messages]);

  const addAttachedFiles = (files: AttachedFile[]) => {
    setAttachedFiles((prev) => [...prev, ...files]);
  };

  const removeAttachedFile = (id: string) => {
    setAttachedFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const clearAttachedFiles = () => {
    setAttachedFiles([]);
  };

  // handleSend/handleAbort/handleKeyDown stay plain functions, recreated every render,
  // exactly as they were in App.tsx (they were never wrapped in useCallback there).
  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = prompt.trim();
    const hasAttachments = attachedFiles.length > 0;
    // isReadyToSend and canQueue are mutually exclusive (canQueue requires isBusy, which
    // isReadyToSend excludes); `queuing` picks which lifecycle this submit follows.
    const queuing = !isReadyToSend && canQueue;
    if ((!trimmed && !hasAttachments) || (!isReadyToSend && !canQueue)) return;

    const defaultAttachmentText = attachedFiles.some((f) => f.type === 'image')
      ? '(see attached image)'
      : '(see attached file)';
    const reqId = generatePromptRequestId();
    dispatch({
      type: queuing ? 'PROMPT_QUEUED' : 'PROMPT_SUBMIT',
      payload: { id: reqId, message: trimmed || defaultAttachmentText },
    });

    const imageAttachments: PromptImageAttachment[] = attachedFiles
      .filter((f) => f.type === 'image' && f.data)
      .map((f) => ({
        type: 'image',
        data: f.data!,
        mimeType: f.mimeType,
      }));

    const textFiles = attachedFiles.filter((f) => f.type === 'text' && f.content !== undefined);
    let messageToSend = trimmed;
    if (textFiles.length > 0) {
      const fileBlocks = textFiles
        .map((f) => `<file name="${f.name}">\n${f.content}\n</file>`)
        .join('\n\n');
      messageToSend = messageToSend ? `${messageToSend}\n\n${fileBlocks}` : fileBlocks;
    }
    const otherFiles = attachedFiles.filter((f) => f.type !== 'image' && f.type !== 'text');
    if (otherFiles.length > 0) {
      const otherBlocks = otherFiles
        .map((f) => `<attached_${f.type} name="${f.name}" size="${f.size}" mime="${f.mimeType}" />`)
        .join('\n');
      messageToSend = messageToSend ? `${messageToSend}\n\n${otherBlocks}` : otherBlocks;
    }
    if (!messageToSend && imageAttachments.length > 0) {
      messageToSend = '(see attached image)';
    } else if (!messageToSend && attachedFiles.length > 0) {
      messageToSend = '(see attached file)';
    }

    setPrompt('');
    setAttachedFiles([]);
    pinAndJumpToBottom();

    try {
      const res = await sendPromptPi(
        reqId,
        messageToSend,
        imageAttachments.length > 0 ? imageAttachments : undefined,
        undefined,
        queuing ? 'followUp' : undefined
      );
      if (!res?.id) {
        throw new Error('Backend response missing required request ID');
      }
      // A queued follow-up's acceptance must not disturb the in-flight prompt's state
      // (pendingPromptId keeps tracking the running turn), so only an idle send dispatches
      // PROMPT_ACCEPTED here.
      if (!queuing) {
        dispatch({
          type: 'PROMPT_ACCEPTED',
          payload: { id: res.id },
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      dispatch({
        type: queuing ? 'QUEUED_PROMPT_REJECTED' : 'PROMPT_REJECTED',
        payload: { id: reqId, error: msg },
      });
    }
  };

  const handleAbort = async () => {
    if (!isBusy) return;
    const targetPromptId = pendingPromptId;
    dispatch({ type: 'ABORT_CLICKED' });
    try {
      await abortPi();
    } catch {
      // Ignored
    } finally {
      dispatch({
        type: 'ABORT_COMPLETED',
        payload: { promptId: targetPromptId },
      });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend(e);
    }
  };

  return {
    prompt,
    setPrompt,
    attachedFiles,
    addAttachedFiles,
    removeAttachedFile,
    clearAttachedFiles,
    handleSend,
    handleAbort,
    handleKeyDown,
  };
}
