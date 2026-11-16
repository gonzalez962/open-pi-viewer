import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { useSessions } from '@features/sessions/hooks/useSessions';

test('S1.2 switch restoration captures originating cwd and result session identity', async () => {
  const internal = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
  const previousDispatcher = internal.current;
  const previousWindow = globalThis.window;
  const previousIsTauri = (globalThis as any).isTauri;
  let finish!: (value: any) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  const restored: any[] = [];
  const win: any = { isTauri: true, __IS_WEB_IPC__: true, __TAURI_INTERNALS__: { invoke: async (cmd: string) => {
    if (cmd === 'switch_session') return pending;
    if (cmd === 'list_sessions') return [];
    return null;
  } } };
  Object.assign(globalThis, { window: win, isTauri: true });
  internal.current = { useRef(value: any) { return { current: value }; }, useCallback(fn: any) { return fn; }, useEffect() {} };
  const options: any = {
    activeProjectId: 'A', config: { workingDirectory: '/a' }, connectionStatus: 'connected',
    isBusy: false, isConnected: true, isConnecting: false, isResetting: false, isSwitchingSession: false,
    sessionId: 'old', sessionFile: '/a/old', showSettings: false,
    dispatch() {}, t: (key: string) => key, setShowSettings() {}, requestFileTreeRefresh() {},
    restoreExtensionPrompts: (requests: any[]) => restored.push(...requests),
    pinAndHide() {}, scrollToBottomNextFrame() {}, startConnection: async () => {},
  };
  try {
    const hook = useSessions(options);
    const switching = hook.handleSelectSession({ id: 'new', path: '/a/new', firstMessage: '', messageCount: 0, isActive: false });
    options.config = { workingDirectory: '/b' };
    finish({ cancelled: false, sessionId: 'new', sessionFile: '/a/new', activity: 'waiting', pendingExtensionPrompts: [{ type: 'extension_ui_request', id: 'q', method: 'input' }] });
    await switching;
    assert.deepEqual(restored, [{ type: 'extension_ui_request', id: 'q', method: 'input', cwd: '/a', sessionId: 'new', sessionFile: '/a/new' }]);
  } finally { internal.current = previousDispatcher; Object.assign(globalThis, { window: previousWindow, isTauri: previousIsTauri }); }
});

test('S2.1 delayed creation dispatches only to originating project and leaves B conversation alone', async () => {
  const internal = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
  const previousDispatcher = internal.current;
  const previousWindow = globalThis.window;
  const previousIsTauri = (globalThis as any).isTauri;
  const refs: any[] = [];
  let index = 0;
  const actions: any[] = [];
  const calls: any[] = [];
  let resolveNew!: (value: any) => void;
  const pending = new Promise((resolve) => { resolveNew = resolve; });
  const win: any = { isTauri: true, __IS_WEB_IPC__: true, __TAURI_INTERNALS__: { invoke: async (cmd: string, args: any) => {
    calls.push({ cmd, args });
    if (cmd === 'new_session') return pending;
    if (cmd === 'list_sessions') return [];
    return null;
  } } };
  Object.assign(globalThis, { window: win, isTauri: true });
  internal.current = {
    useRef(value: any) { const i = index++; return refs[i] ?? (refs[i] = { current: value }); },
    useCallback(fn: any) { return fn; },
    useEffect() {},
  };
  const options: any = {
    activeProjectId: 'A', config: { workingDirectory: '/a' }, connectionStatus: 'connected',
    isBusy: false, isConnected: true, isConnecting: false, isResetting: false, isSwitchingSession: false,
    sessionId: 'old-a', sessionFile: '/a/old', showSettings: false,
    dispatch: (action: any) => actions.push(action), t: (key: string) => key,
    setShowSettings() {}, requestFileTreeRefresh() {}, pinAndHide() {}, scrollToBottomNextFrame() {}, startConnection: async () => {},
  };
  try {
    index = 0;
    const a = useSessions(options);
    const creation = a.handleNewConversation();
    index = 0;
    useSessions({ ...options, activeProjectId: 'B', config: { workingDirectory: '/b' }, sessionId: 'old-b', sessionFile: '/b/old' });
    resolveNew({ cancelled: false, sessionId: 'new-a', sessionFile: '/a/new' });
    await creation;
    await Promise.resolve();
    const newActions = actions.filter((action) => action.type.startsWith('NEW_CONVERSATION_'));
    assert.deepEqual(newActions.map((action) => [action.type, action.targetProjectId]), [['NEW_CONVERSATION_START', 'A'], ['NEW_CONVERSATION_SUCCESS', 'A']]);
    assert.equal(newActions[1].payload.sessionId, 'new-a');
    assert.deepEqual(calls.find((call) => call.cmd === 'new_session')?.args, { payload: { workingDirectory: '/a' } });
    const lists = actions.filter((action) => action.type.startsWith('LOAD_SESSIONS_'));
    assert.ok(lists.every((action) => action.targetProjectId === 'A'));
  } finally { internal.current = previousDispatcher; Object.assign(globalThis, { window: previousWindow, isTauri: previousIsTauri }); }
});
