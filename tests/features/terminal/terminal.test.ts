import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TerminalOverlay } from '../../../src/features/terminal/components/TerminalOverlay';
import { TerminateConfirmationModal } from '../../../src/features/terminal/components/TerminateConfirmationModal';
import {
  terminalReducer,
  createInitialTerminalState,
  type TerminalState,
  type TerminalAction,
} from '../../../src/features/terminal/terminal-state';
import type { TerminalSessionDto } from '../../../src/core/terminal';

test('S2.1: TerminalOverlay renders full-window dialog with minimize and terminate controls', () => {
  const session: TerminalSessionDto = {
    id: 'term-proj-a',
    cwd: 'C:\\work\\project-alpha',
    canonicalCwd: 'C:\\work\\project-alpha',
    cols: 80,
    rows: 24,
    pid: 5678,
    running: true,
    createdAt: Date.now(),
  };

  const html = renderToStaticMarkup(
    React.createElement(TerminalOverlay, {
      isOpen: true,
      projectName: 'project-alpha',
      projectCwd: 'C:\\work\\project-alpha',
      session,
      locale: 'en',
      status: 'connected',
      onMinimize: () => {},
      onTerminate: () => {},
      onRetry: () => {},
    })
  );

  // Dialog accessibility and modal isolation
  assert.ok(html.includes('role="dialog"'), 'must have role="dialog"');
  assert.ok(html.includes('aria-modal="true"'), 'must specify aria-modal="true"');
  assert.ok(html.includes('terminal-overlay'), 'must have terminal-overlay class for full viewport coverage');

  // Header and controls
  assert.ok(html.includes('project-alpha') || html.includes('project-alpha'), 'must show project title or directory');
  assert.ok(html.includes('btn-terminal-minimize'), 'must expose minimize button');
  assert.ok(html.includes('btn-terminal-terminate'), 'must expose terminate button');
  assert.ok(html.includes('terminal-screen-container'), 'must include terminal screen container for xterm');
});

test('S2.2: TerminalOverlay renders responsive mobile layout classes and preserves controls', () => {
  const session: TerminalSessionDto = {
    id: 'term-proj-mobile',
    cwd: '/mobile/project',
    canonicalCwd: '/mobile/project',
    cols: 40,
    rows: 20,
    pid: 9999,
    running: true,
    createdAt: Date.now(),
  };

  const html = renderToStaticMarkup(
    React.createElement(TerminalOverlay, {
      isOpen: true,
      projectName: 'mobile-app',
      projectCwd: '/mobile/project',
      session,
      locale: 'es',
      status: 'connected',
      isMobile: true,
      onMinimize: () => {},
      onTerminate: () => {},
      onRetry: () => {},
    })
  );

  assert.ok(html.includes('is-mobile'), 'must contain mobile responsive class');
  assert.ok(html.includes('btn-terminal-minimize'), 'controls must remain present on mobile');
  assert.ok(html.includes('btn-terminal-terminate'), 'terminate must remain present on mobile');
});

test('S3.1: Minimize updates state to hidden without clearing session identity or process', () => {
  const initial = createInitialTerminalState();
  const openedState = terminalReducer(initial, {
    type: 'SESSION_OPENED',
    payload: {
      cwd: '/workspace/app',
      session: {
        id: 'term-app',
        cwd: '/workspace/app',
        canonicalCwd: '/workspace/app',
        cols: 80,
        rows: 24,
        pid: 101,
        running: true,
        createdAt: 1000,
        replay: 'initial history\n',
        cursor: 16,
      },
    },
  });

  assert.equal(openedState.isOpen, true);
  assert.equal(openedState.sessions['/workspace/app']?.pid, 101);

  // User clicks minimize
  const minimizedState = terminalReducer(openedState, {
    type: 'MINIMIZE',
  });

  assert.equal(minimizedState.isOpen, false, 'overlay must close/minimize');
  assert.equal(
    minimizedState.sessions['/workspace/app']?.pid,
    101,
    'session and process must NOT be destroyed on minimize'
  );

  // User reopens
  const reopenedState = terminalReducer(minimizedState, {
    type: 'OPEN',
    payload: { cwd: '/workspace/app' },
  });

  assert.equal(reopenedState.isOpen, true, 'overlay must reopen');
  assert.equal(
    reopenedState.sessions['/workspace/app']?.id,
    'term-app',
    'must preserve existing session on reopen'
  );
});

test('S3.2: Switching active projects maintains background session continuity', () => {
  let state = createInitialTerminalState();

  // Open Project A
  state = terminalReducer(state, {
    type: 'SESSION_OPENED',
    payload: {
      cwd: '/projects/A',
      session: {
        id: 'term-A',
        cwd: '/projects/A',
        canonicalCwd: '/projects/A',
        cols: 80,
        rows: 24,
        pid: 201,
        running: true,
        createdAt: 100,
      },
    },
  });

  // Switch to Project B and open terminal for B
  state = terminalReducer(state, {
    type: 'SESSION_OPENED',
    payload: {
      cwd: '/projects/B',
      session: {
        id: 'term-B',
        cwd: '/projects/B',
        canonicalCwd: '/projects/B',
        cols: 80,
        rows: 24,
        pid: 202,
        running: true,
        createdAt: 200,
      },
    },
  });

  assert.equal(state.sessions['/projects/A']?.pid, 201, 'Project A process must remain stored');
  assert.equal(state.sessions['/projects/B']?.pid, 202, 'Project B process must remain stored');
  assert.equal(state.activeCwd, '/projects/B');

  // Switch back to Project A
  state = terminalReducer(state, {
    type: 'SWITCH_PROJECT',
    payload: { cwd: '/projects/A' },
  });

  assert.equal(state.activeCwd, '/projects/A');
  assert.equal(state.sessions['/projects/A']?.id, 'term-A');
  assert.equal(state.sessions['/projects/B']?.id, 'term-B');
});

test('S3.3: Terminate confirmation modal protects against accidental termination', () => {
  let confirmed = false;
  let cancelled = false;

  const html = renderToStaticMarkup(
    React.createElement(TerminateConfirmationModal, {
      isOpen: true,
      projectName: 'my-project',
      locale: 'en',
      onConfirm: () => { confirmed = true; },
      onCancel: () => { cancelled = true; },
    })
  );

  assert.ok(html.includes('role="alertdialog"'), 'must use role="alertdialog"');
  assert.ok(html.includes('Terminate') || html.includes('Finalizar'), 'must show terminate action');
  assert.ok(html.includes('Cancel') || html.includes('Cancelar'), 'must show cancel action');
});

test('S3.3: Confirmed termination resets active project session allowing clean recreate', () => {
  let state = createInitialTerminalState();
  state = terminalReducer(state, {
    type: 'SESSION_OPENED',
    payload: {
      cwd: '/projects/A',
      session: {
        id: 'term-A',
        cwd: '/projects/A',
        canonicalCwd: '/projects/A',
        cols: 80,
        rows: 24,
        pid: 500,
        running: true,
        createdAt: 1,
      },
    },
  });

  // User confirms termination
  state = terminalReducer(state, {
    type: 'SESSION_TERMINATED',
    payload: { cwd: '/projects/A' },
  });

  assert.equal(state.isOpen, false, 'overlay must close upon termination');
  assert.equal(state.sessions['/projects/A'], undefined, 'terminated session must be evicted from state');

  // Reopening gets fresh session
  state = terminalReducer(state, {
    type: 'SESSION_OPENED',
    payload: {
      cwd: '/projects/A',
      session: {
        id: 'term-A-new',
        cwd: '/projects/A',
        canonicalCwd: '/projects/A',
        cols: 80,
        rows: 24,
        pid: 501,
        running: true,
        createdAt: 2,
      },
    },
  });

  assert.equal(state.sessions['/projects/A']?.id, 'term-A-new');
  assert.equal(state.sessions['/projects/A']?.pid, 501);
});

test('Error state and retry: displays error banner and allows retry action', () => {
  const html = renderToStaticMarkup(
    React.createElement(TerminalOverlay, {
      isOpen: true,
      projectName: 'error-proj',
      projectCwd: '/error/path',
      session: null,
      locale: 'en',
      status: 'error',
      errorMessage: 'Failed to connect to terminal backend',
      onMinimize: () => {},
      onTerminate: () => {},
      onRetry: () => {},
    })
  );

  assert.ok(html.includes('terminal-error-banner'), 'must render error banner');
  assert.ok(html.includes('Failed to connect to terminal backend'), 'must show error text');
  assert.ok(html.includes('btn-terminal-retry'), 'must offer retry button');
});

test('Natural exit: displays exit code notice without crashing', () => {
  const session: TerminalSessionDto = {
    id: 'term-natural-exit',
    cwd: '/proj',
    canonicalCwd: '/proj',
    cols: 80,
    rows: 24,
    pid: 777,
    running: false,
    createdAt: 100,
  };

  const html = renderToStaticMarkup(
    React.createElement(TerminalOverlay, {
      isOpen: true,
      projectName: 'exited-proj',
      projectCwd: '/proj',
      session,
      locale: 'en',
      status: 'exited',
      exitCode: 0,
      onMinimize: () => {},
      onTerminate: () => {},
      onRetry: () => {},
    })
  );

  assert.ok(html.includes('terminal-exit-banner'), 'must display natural exit banner');
  assert.ok(html.includes('0'), 'must display exit code');
});
