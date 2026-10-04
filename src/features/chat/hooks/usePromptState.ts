import { useEffect, useState } from 'react';
import {
  abortPi,
  sendPromptPi,
} from '@infra/bridge';
import { generatePromptRequestId } from '@core/protocol';
import { buildCopyAllCodeText, getLastAssistantCodeBlocks } from '@core/markdown';
import { buildInsertCodeDraft } from '@core/prompt-controls-utils';
import {
  COMMANDS,
  decideCommandDispatch,
  describeReloadOutcome,
  type CommandSpec,
  type ReloadNotice,
  type ReloadOutcome,
  type ReloadRequest,
} from '@core/commands';
import type { ChatAction } from '@core/reducer';
import type { ChatMessage, ImageContent } from '@core/types/messages';
import { copyText } from '@shared/clipboard';
import { translate, type SupportedLocale } from '@shared/i18n';
import type { AttachedFile } from '../types';

/**
 * Builds the structured Markdown guide injected by "/help" (Issue #9): the full command
 * catalog split into client (run locally) and agent (forwarded to Pi) sections, localized
 * to `language`. Delivered via `ADD_SYSTEM_MESSAGE` so it renders through the existing
 * Markdown pipeline.
 */
function buildHelpMarkdown(
  language: SupportedLocale,
  commands: readonly CommandSpec[]
): string {
  const line = (c: CommandSpec) =>
    `- \`${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ''}\` — ${c.description[language]}`;
  const clientCommands = commands.filter((c) => c.execution === 'client');
  const agentCommands = commands.filter((c) => c.execution === 'agent');

  return [
    translate(language, 'command_palette.help_title'),
    '',
    translate(language, 'command_palette.help_client_heading'),
    '',
    ...clientCommands.map(line),
    '',
    translate(language, 'command_palette.help_agent_heading'),
    '',
    ...agentCommands.map(line),
  ].join('\n');
}

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
  /** Active UI language, used to localize the "/help" guide and the "/reload" notice. */
  language: SupportedLocale;
  /**
   * Starts a new conversation (Issue #9's "/new" client command), reusing the same flow as
   * the sidebar's "New session" button (`useSessions`'s `handleNewConversation`).
   */
  onNewConversation: () => void | Promise<void>;
  /**
   * Reconnects the current session (Issue #9's "/reload" client command), reusing the same
   * flow as the header's Retry button (`App.tsx`'s `requestRetry`). Returns 'busy' when a
   * connection/reset is already in progress, otherwise the started attempt's real outcome.
   */
  onReload: () => ReloadRequest;
  /**
   * Command catalog used for dispatch and "/help": built-ins plus the user's custom
   * commands (Issue #9 T7, see `buildCommandCatalog`). Defaults to the built-in `COMMANDS`.
   * Custom commands always resolve as 'agent', so they are forwarded to Pi verbatim.
   */
  commands?: readonly CommandSpec[];
  /**
   * Commands listed by "/help" (Issue #9 T8): the catalog minus the ones the user hid in
   * Settings. Defaults to `commands`. Dispatch always uses the full `commands` catalog, so
   * hiding is purely visual.
   */
  helpCommands?: readonly CommandSpec[];
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
  language,
  onNewConversation,
  onReload,
  commands = COMMANDS,
  helpCommands = commands,
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

  /**
   * Runs a recognized 'client' command locally (Issue #9 T4). Never called for 'agent' or
   * unrecognized commands — those fall through to the ordinary send path below and reach
   * Pi unchanged, exactly as typed.
   */
  const executeClientCommand = (commandId: string) => {
    switch (commandId) {
      case 'clear': {
        dispatch({ type: 'CLEAR_MESSAGES' });
        return;
      }
      case 'new': {
        void onNewConversation();
        return;
      }
      case 'reload': {
        // Issue #9 T6: report the reload's real outcome. The final notice is appended only
        // after the attempt settled, i.e. after its CONNECT_SUCCESS/SESSION_READY/
        // CONNECT_FAIL dispatch, so a session hydration that replaces the transcript cannot
        // wipe it.
        const notify = (notice: ReloadNotice) =>
          dispatch({
            type: 'ADD_SYSTEM_MESSAGE',
            payload: { content: translate(language, notice.key, notice.params) },
          });
        const request = onReload();
        if (request.status === 'busy') {
          notify(describeReloadOutcome(request));
          return;
        }
        dispatch({
          type: 'ADD_SYSTEM_MESSAGE',
          payload: { content: translate(language, 'command_palette.reload_notice') },
        });
        void request.result
          .catch(
            (err: unknown): ReloadOutcome => ({
              status: 'error',
              error: err instanceof Error ? err.message : String(err),
            })
          )
          .then((outcome) => notify(describeReloadOutcome(outcome)));
        return;
      }
      case 'help': {
        dispatch({
          type: 'ADD_SYSTEM_MESSAGE',
          payload: { content: buildHelpMarkdown(language, helpCommands) },
        });
        return;
      }
      default:
        return;
    }
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

    // Slash command dispatch (Issue #9 T4): a recognized 'client' command executes locally
    // and never reaches Pi. Skipped when files are attached — attaching a file alongside
    // "/something" is ambiguous enough that sending it literally is the safer default.
    // Agent commands and unrecognized "/xxx" commands are NOT special-cased here: they fall
    // straight through to the normal send below, which forwards `trimmed` unchanged.
    if (!hasAttachments) {
      const decision = decideCommandDispatch(trimmed, commands);
      if (decision.kind === 'client' && decision.command) {
        setPrompt('');
        executeClientCommand(decision.command.id);
        return;
      }
    }

    const defaultAttachmentText = attachedFiles.some((f) => f.type === 'image')
      ? '(see attached image)'
      : '(see attached file)';
    const reqId = generatePromptRequestId();

    const imageAttachments: ImageContent[] = attachedFiles
      .filter((f) => f.type === 'image' && Boolean(f.data))
      .map((f) => ({
        type: 'image',
        data: f.data!,
        mimeType: f.mimeType,
      }));

    dispatch({
      type: queuing ? 'PROMPT_QUEUED' : 'PROMPT_SUBMIT',
      payload: {
        id: reqId,
        message: trimmed || defaultAttachmentText,
        images: imageAttachments.length > 0 ? imageAttachments : undefined,
      },
    });

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
