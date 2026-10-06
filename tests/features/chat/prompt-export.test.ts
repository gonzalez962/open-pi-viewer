import assert from 'node:assert/strict';
import test from 'node:test';

import { decideCommandDispatch, COMMANDS } from '@core/commands';
import { planPromptDispatch } from '@features/chat/hooks/usePromptState';

test('client dispatch integration: /export resolves as client command with parsed args', () => {
  const bare = decideCommandDispatch('/export', COMMANDS);
  assert.equal(bare.kind, 'client');
  assert.equal(bare.command?.id, 'export');
  assert.equal(bare.args, '');

  const withMd = decideCommandDispatch('/export md', COMMANDS);
  assert.equal(withMd.kind, 'client');
  assert.equal(withMd.command?.id, 'export');
  assert.equal(withMd.args, 'md');

  const withJson = decideCommandDispatch('/export json', COMMANDS);
  assert.equal(withJson.kind, 'client');
  assert.equal(withJson.command?.id, 'export');
  assert.equal(withJson.args, 'json');

  const withInvalid = decideCommandDispatch('/export foo', COMMANDS);
  assert.equal(withInvalid.kind, 'client');
  assert.equal(withInvalid.command?.id, 'export');
  assert.equal(withInvalid.args, 'foo');
});

test('planPromptDispatch: /export enforces normal readiness guards and blocks when offline', () => {
  // Finding 2: actual UI disables textarea/send offline, so planner offline promises false.
  // Normal readiness guards (!isReadyToSend && !canQueue) block /export offline.
  const offlineExport = planPromptDispatch({
    prompt: '/export',
    hasAttachments: false,
    isReadyToSend: false,
    canQueue: false,
  });
  assert.equal(offlineExport.action, 'blocked');

  const offlineExportJson = planPromptDispatch({
    prompt: '/export json',
    hasAttachments: false,
    isReadyToSend: false,
    canQueue: false,
  });
  assert.equal(offlineExportJson.action, 'blocked');
});

test('planPromptDispatch: /export executes locally when ready or within canQueue busy state', () => {
  // 1. Ready idle execution
  const readyExport = planPromptDispatch({
    prompt: '/export',
    hasAttachments: false,
    isReadyToSend: true,
    canQueue: false,
  });
  assert.equal(readyExport.action, 'client_command');
  assert.equal(readyExport.commandId, 'export');
  assert.equal(readyExport.args, '');

  // 2. Ready with format arguments
  const readyExportMd = planPromptDispatch({
    prompt: '/export md',
    hasAttachments: false,
    isReadyToSend: true,
    canQueue: false,
  });
  assert.equal(readyExportMd.action, 'client_command');
  assert.equal(readyExportMd.commandId, 'export');
  assert.equal(readyExportMd.args, 'md');

  // 3. Busy state with canQueue allows local export (consistent with active UI queueing)
  const busyExport = planPromptDispatch({
    prompt: '/export json',
    hasAttachments: false,
    isReadyToSend: false,
    canQueue: true,
  });
  assert.equal(busyExport.action, 'client_command');
  assert.equal(busyExport.commandId, 'export');
  assert.equal(busyExport.args, 'json');
});

test('planPromptDispatch: /export recognized locally regardless of attachments and never sent to agent', () => {
  // Finding 1: /export must never be forwarded to agent as send_prompt when attachments are present.
  const attachedExport = planPromptDispatch({
    prompt: '/export',
    hasAttachments: true,
    isReadyToSend: true,
    canQueue: false,
  });
  assert.equal(attachedExport.action, 'client_command');
  assert.equal(attachedExport.commandId, 'export');
  assert.equal(attachedExport.args, '');

  const attachedExportJson = planPromptDispatch({
    prompt: '/export json',
    hasAttachments: true,
    isReadyToSend: true,
    canQueue: false,
  });
  assert.equal(attachedExportJson.action, 'client_command');
  assert.equal(attachedExportJson.commandId, 'export');
  assert.equal(attachedExportJson.args, 'json');

  // Attached /export during busy queueable state executes locally
  const attachedBusyExport = planPromptDispatch({
    prompt: '/export md',
    hasAttachments: true,
    isReadyToSend: false,
    canQueue: true,
  });
  assert.equal(attachedBusyExport.action, 'client_command');
  assert.equal(attachedBusyExport.commandId, 'export');

  // Attached /export during offline state is blocked
  const attachedOfflineExport = planPromptDispatch({
    prompt: '/export',
    hasAttachments: true,
    isReadyToSend: false,
    canQueue: false,
  });
  assert.equal(attachedOfflineExport.action, 'blocked');
});

test('planPromptDispatch: preserves existing behavior for other commands and messages', () => {
  // Other client commands blocked while offline
  const offlineClear = planPromptDispatch({
    prompt: '/clear',
    hasAttachments: false,
    isReadyToSend: false,
    canQueue: false,
  });
  assert.equal(offlineClear.action, 'blocked');

  // Other client commands run when ready
  const readyClear = planPromptDispatch({
    prompt: '/clear',
    hasAttachments: false,
    isReadyToSend: true,
    canQueue: false,
  });
  assert.equal(readyClear.action, 'client_command');
  assert.equal(readyClear.commandId, 'clear');

  // Finding 1: Other client commands when files attached fall through to send_prompt (unchanged)
  const attachedClear = planPromptDispatch({
    prompt: '/clear',
    hasAttachments: true,
    isReadyToSend: true,
    canQueue: false,
  });
  assert.equal(attachedClear.action, 'send_prompt');

  // Agent commands blocked while offline
  const offlineAgent = planPromptDispatch({
    prompt: '/compact',
    hasAttachments: false,
    isReadyToSend: false,
    canQueue: false,
  });
  assert.equal(offlineAgent.action, 'blocked');

  // Plain text prompts blocked while offline
  const offlineText = planPromptDispatch({
    prompt: 'hello world',
    hasAttachments: false,
    isReadyToSend: false,
    canQueue: false,
  });
  assert.equal(offlineText.action, 'blocked');

  // Plain text prompts queue while busy
  const busyText = planPromptDispatch({
    prompt: 'hello follow-up',
    hasAttachments: false,
    isReadyToSend: false,
    canQueue: true,
  });
  assert.equal(busyText.action, 'send_prompt');

  // Empty input with no attachments blocked
  const emptyBlocked = planPromptDispatch({
    prompt: '',
    hasAttachments: false,
    isReadyToSend: true,
    canQueue: false,
  });
  assert.equal(emptyBlocked.action, 'blocked');
});
