import { connectionReducer, type ConnectionAction } from './connection';
import { sessionsReducer, type SessionsAction } from './sessions';
import { messagingReducer, type MessagingAction } from './messaging';
import { toolExecutionReducer, type ToolExecutionAction } from './tool-execution';
import { modelsReducer, type ModelsAction } from './models';
import { INITIAL_STATE } from './initial-state';
import type { ChatSessionState } from '../types/chat-state';

export { INITIAL_STATE };
export type { ChatSessionState };

export * from './multi-project';

export type ChatAction =
  | ConnectionAction
  | SessionsAction
  | MessagingAction
  | ToolExecutionAction
  | ModelsAction;

/**
 * Pure state reducer for Pi desktop chat session, composed from per-concern slices.
 *
 * Each slice reducer inspects the action and returns the next state when it owns
 * that action, or `undefined` when the action belongs to a different slice. This
 * lets the composing reducer try each slice in turn without casts or a manually
 * maintained "which action types does each slice own" list.
 */
export function chatReducer(
  state: ChatSessionState,
  action: ChatAction
): ChatSessionState {
  const next =
    connectionReducer(state, action) ??
    sessionsReducer(state, action) ??
    messagingReducer(state, action) ??
    toolExecutionReducer(state, action) ??
    modelsReducer(state, action) ??
    state;

  if (
    action.type === 'NEW_SESSION_SUCCESS' ||
    action.type === 'NEW_CONVERSATION_SUCCESS' ||
    action.type === 'SWITCH_SESSION_SUCCESS'
  ) {
    if (next.subagents && next.subagents.length > 0) {
      return {
        ...next,
        subagents: [],
      };
    }
  }

  return next;
}
