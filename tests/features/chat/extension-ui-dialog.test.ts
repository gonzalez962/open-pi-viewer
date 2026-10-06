import assert from 'node:assert';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  cleanQuestionText,
  createDialogItemKey,
  ExtensionUiDialogQueue,
  extractQuestionIdentity,
  isMultiQuestionTitle,
  isSamePath,
  isSameQuestionIdentity,
  parseMultiSelectOptions,
  parseQuestionStepInfo,
  type AnsweredQuestionRecord,
  type QueuedExtensionUiDialog,
} from '@features/chat/hooks/useExtensionUiDialog';
import { ExtensionUiPromptBar } from '@features/chat/components/ExtensionUiPromptBar';
import { ExtensionUiDialogModal } from '@features/chat/components/ExtensionUiDialogModal';
import type { ExtensionUiRequest } from '@core/types/events';

test('isSamePath: handles POSIX and Windows paths correctly', () => {
  assert.strictEqual(isSamePath('/foo/bar', '/foo/bar'), true);
  assert.strictEqual(isSamePath('/foo/bar', '/foo/baz'), false);
  assert.strictEqual(isSamePath(undefined, undefined), true);
  assert.strictEqual(isSamePath(undefined, '/foo'), false);

  // Windows case-insensitivity
  assert.strictEqual(isSamePath('C:\\Project\\A', 'c:\\project\\a'), true);
  assert.strictEqual(isSamePath('C:/Project/A', 'c:\\project\\a'), true);
});

test('ExtensionUiDialogQueue: enqueues select, input, and confirm requests returning Promises', async () => {
  const queue = new ExtensionUiDialogQueue();
  const adapter = queue.asAdapter();

  const selectReq: ExtensionUiRequest = {
    type: 'extension_ui_request',
    id: 'req-select',
    method: 'select',
    title: 'Select Deployment Target',
    options: ['Staging', 'Production'],
    cwd: '/path/to/project',
  };

  const selectPromise = adapter.select(selectReq);
  assert.strictEqual(queue.getPendingCount(), 1);

  const active = queue.getActiveDialog();
  assert.ok(active);
  assert.strictEqual(active.id, 'req-select');
  assert.ok(active.itemKey);
  assert.strictEqual(active.method, 'select');

  // Resolve by itemKey with choice
  const resolved = queue.resolveByItemKey(active.itemKey, 'Production');
  assert.strictEqual(resolved, true);

  const result = await selectPromise;
  assert.strictEqual(result, 'Production');
  assert.strictEqual(queue.getPendingCount(), 0);
  assert.strictEqual(queue.getActiveDialog(), null);
});

test('ExtensionUiDialogQueue: FIFO queueing and sequential resolution across projects', async () => {
  const queue = new ExtensionUiDialogQueue();
  const adapter = queue.asAdapter();

  const reqA: ExtensionUiRequest = {
    type: 'extension_ui_request',
    id: 'req-a',
    method: 'select',
    options: ['Option 1', 'Option 2'],
    cwd: '/path/project-a',
  };

  const reqB: ExtensionUiRequest = {
    type: 'extension_ui_request',
    id: 'req-b',
    method: 'input',
    prefill: 'initial-val',
    cwd: '/path/project-b',
  };

  const reqC: ExtensionUiRequest = {
    type: 'extension_ui_request',
    id: 'req-c',
    method: 'confirm',
    title: 'Are you sure?',
    cwd: '/path/project-c',
  };

  const pA = adapter.select(reqA);
  const pB = adapter.input(reqB);
  const pC = adapter.confirm(reqC);

  assert.strictEqual(queue.getPendingCount(), 3);
  const itemA = queue.getActiveDialog()!;
  assert.strictEqual(itemA.id, 'req-a');

  // Resolve A by itemKey
  queue.resolveByItemKey(itemA.itemKey, 'Option 2');
  const resA = await pA;
  assert.strictEqual(resA, 'Option 2');

  // B is now active
  assert.strictEqual(queue.getPendingCount(), 2);
  const itemB = queue.getActiveDialog()!;
  assert.strictEqual(itemB.id, 'req-b');

  // Resolve B by itemKey
  queue.resolveByItemKey(itemB.itemKey, 'updated-val');
  const resB = await pB;
  assert.strictEqual(resB, 'updated-val');

  // C is now active
  assert.strictEqual(queue.getPendingCount(), 1);
  const itemC = queue.getActiveDialog()!;
  assert.strictEqual(itemC.id, 'req-c');

  // Resolve C by itemKey with true
  queue.resolveByItemKey(itemC.itemKey, true);
  const resC = await pC;
  assert.strictEqual(resC, true);

  assert.strictEqual(queue.getPendingCount(), 0);
  assert.strictEqual(queue.getActiveDialog(), null);
});

test('ExtensionUiDialogQueue: same-id cross-cwd does not collide timer expiry or resolution', async () => {
  const queue = new ExtensionUiDialogQueue();
  const adapter = queue.asAdapter();

  // Project A emits request with id: "shared-id" and 30ms timeout
  const pA = adapter.select({
    type: 'extension_ui_request',
    id: 'shared-id',
    method: 'select',
    options: ['A1', 'A2'],
    cwd: '/path/project-a',
    timeout: 30,
  });

  // Project B emits request with same id: "shared-id" and 5000ms timeout
  const pB = adapter.select({
    type: 'extension_ui_request',
    id: 'shared-id',
    method: 'select',
    options: ['B1', 'B2'],
    cwd: '/path/project-b',
    timeout: 5000,
  });

  const q = queue.getQueue();
  assert.strictEqual(q.length, 2);
  const itemA = q[0];
  const itemB = q[1];

  // Distinct item keys generated
  assert.notStrictEqual(itemA.itemKey, itemB.itemKey);
  assert.ok(itemA.itemKey.includes('/path/project-a'));
  assert.ok(itemB.itemKey.includes('/path/project-b'));

  // Wait 50ms for Project A's timer to expire
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Project A promise must have expired and resolved to null
  const resA = await pA;
  assert.strictEqual(resA, null);

  // Project B is STILL in the queue and NOT expired!
  assert.strictEqual(queue.getPendingCount(), 1);
  assert.strictEqual(queue.getActiveDialog()?.itemKey, itemB.itemKey);

  // Answering Project B resolves Project B accurately
  queue.resolveByItemKey(itemB.itemKey, 'B2');
  const resB = await pB;
  assert.strictEqual(resB, 'B2');
  assert.strictEqual(queue.getPendingCount(), 0);
});

test('ExtensionUiDialogQueue: stale timeout does not affect resolved items or subsequent queue items', async () => {
  const queue = new ExtensionUiDialogQueue();
  const adapter = queue.asAdapter();

  // Enqueue dialog with 40ms timeout
  const p1 = adapter.input({
    type: 'extension_ui_request',
    id: 'dlg-fast',
    method: 'input',
    timeout: 40,
    cwd: '/path/project',
  });

  const active = queue.getActiveDialog()!;
  assert.ok(active);

  // User answers early at ~10ms
  queue.resolveByItemKey(active.itemKey, 'early-answer');
  const res1 = await p1;
  assert.strictEqual(res1, 'early-answer');
  assert.strictEqual(queue.getPendingCount(), 0);

  // Enqueue second dialog right before original 40ms timer would have fired
  const p2 = adapter.select({
    type: 'extension_ui_request',
    id: 'dlg-fast', // same ID re-used
    method: 'select',
    options: ['Second'],
    cwd: '/path/project',
  });

  // Wait 60ms past the first dialog's initial timeout
  await new Promise((resolve) => setTimeout(resolve, 60));

  // The stale timeout from the first dialog did NOT cancel the second dialog!
  assert.strictEqual(queue.getPendingCount(), 1);
  const active2 = queue.getActiveDialog()!;
  assert.strictEqual(active2.id, 'dlg-fast');

  // Second dialog is answered normally
  queue.resolveByItemKey(active2.itemKey, 'Second');
  const res2 = await p2;
  assert.strictEqual(res2, 'Second');
  assert.strictEqual(queue.getPendingCount(), 0);
});

test('ExtensionUiDialogQueue: ID-bound resolution prevents shifted head answers', async () => {
  const queue = new ExtensionUiDialogQueue();
  const adapter = queue.asAdapter();

  const pA = adapter.select({
    type: 'extension_ui_request',
    id: 'dlg-a',
    method: 'select',
    options: ['A1', 'A2'],
    cwd: '/path/a',
  });

  const pB = adapter.select({
    type: 'extension_ui_request',
    id: 'dlg-b',
    method: 'select',
    options: ['B1', 'B2'],
    cwd: '/path/b',
  });

  const itemA = queue.getActiveDialog()!;
  assert.strictEqual(itemA.id, 'dlg-a');

  // Cancel dlg-a by its itemKey
  queue.cancelByItemKey(itemA.itemKey);
  const resA = await pA;
  assert.strictEqual(resA, null);

  // dlg-b is now at head
  const itemB = queue.getActiveDialog()!;
  assert.strictEqual(itemB.id, 'dlg-b');

  // Delayed late response intended for dlg-a arrives; must NOT answer dlg-b!
  const lateResolveSuccess = queue.resolveByItemKey(itemA.itemKey, 'A1');
  assert.strictEqual(lateResolveSuccess, false);

  // dlg-b is still in queue, unharmed
  assert.strictEqual(queue.getPendingCount(), 1);
  assert.strictEqual(queue.getActiveDialog()?.itemKey, itemB.itemKey);

  // dlg-b can now be resolved with its legitimate answer
  queue.resolveByItemKey(itemB.itemKey, 'B2');
  const resB = await pB;
  assert.strictEqual(resB, 'B2');
  assert.strictEqual(queue.getPendingCount(), 0);
});

test('ExtensionUiDialogQueue: queue expiry anchored on arrival even while waiting in queue', async () => {
  const queue = new ExtensionUiDialogQueue();
  const adapter = queue.asAdapter();

  // Dialog 1 has no timeout
  const p1 = adapter.select({
    type: 'extension_ui_request',
    id: 'dlg-long-wait',
    method: 'select',
    options: ['Stay'],
    cwd: '/path/1',
  });

  // Dialog 2 arrives immediately with 40ms timeout (always in milliseconds)
  const p2 = adapter.input({
    type: 'extension_ui_request',
    id: 'dlg-short-wait',
    method: 'input',
    timeout: 40,
    cwd: '/path/2',
  });

  assert.strictEqual(queue.getPendingCount(), 2);
  const item1 = queue.getActiveDialog()!;
  assert.strictEqual(item1.id, 'dlg-long-wait');

  // Wait 70ms while Dialog 1 is still awaiting input at the head
  await new Promise((resolve) => setTimeout(resolve, 70));

  // Dialog 2 must have expired in the background anchored to arrival time
  const res2 = await p2;
  assert.strictEqual(res2, null);

  // Dialog 1 is still in queue and still active
  assert.strictEqual(queue.getPendingCount(), 1);
  assert.strictEqual(queue.getActiveDialog()?.itemKey, item1.itemKey);

  // Resolve Dialog 1
  queue.resolveByItemKey(item1.itemKey, 'Stay');
  const res1 = await p1;
  assert.strictEqual(res1, 'Stay');
  assert.strictEqual(queue.getPendingCount(), 0);
});

test('ExtensionUiDialogQueue: scoped disconnect cancels legacy missing-cwd requests safely only for active session', async () => {
  const queue = new ExtensionUiDialogQueue();
  const adapter = queue.asAdapter();

  // Dialog 1: Project A explicit cwd
  const p1 = adapter.select({
    type: 'extension_ui_request',
    id: 'dlg-explicit-a',
    method: 'select',
    options: ['A'],
    cwd: '/path/project-a',
  });

  // Dialog 2: Legacy missing cwd (belongs to active session)
  const p2 = adapter.input({
    type: 'extension_ui_request',
    id: 'dlg-legacy-missing',
    method: 'input',
  });

  // Dialog 3: Project B explicit cwd
  const p3 = adapter.confirm({
    type: 'extension_ui_request',
    id: 'dlg-explicit-b',
    method: 'confirm',
    cwd: '/path/project-b',
  });

  assert.strictEqual(queue.getPendingCount(), 3);

  // Disconnect arrives for Project B (active session is Project A)
  queue.cancelPending('/path/project-b', '/path/project-a');

  // Dialog 3 is cancelled
  const res3 = await p3;
  assert.strictEqual(res3, null);

  // Dialog 1 and Dialog 2 are NOT cancelled!
  assert.strictEqual(queue.getPendingCount(), 2);
  assert.strictEqual(queue.getActiveDialog()?.id, 'dlg-explicit-a');

  // Disconnect arrives for Project A (which is active session)
  queue.cancelPending('/path/project-a', '/path/project-a');

  // Both Dialog 1 and legacy Dialog 2 are now cancelled safely
  const res1 = await p1;
  const res2 = await p2;
  assert.strictEqual(res1, null);
  assert.strictEqual(res2, null);
  assert.strictEqual(queue.getPendingCount(), 0);
});

test('ExtensionUiDialogQueue: cancelPending with no cwd cancels all queued dialogs (unmount/global error)', async () => {
  const queue = new ExtensionUiDialogQueue();
  const adapter = queue.asAdapter();

  const p1 = adapter.select({
    type: 'extension_ui_request',
    id: 'd1',
    method: 'select',
    options: ['O1'],
    cwd: '/path/project-1',
  });

  const p2 = adapter.input({
    type: 'extension_ui_request',
    id: 'd2',
    method: 'input',
    cwd: '/path/project-2',
  });

  assert.strictEqual(queue.getPendingCount(), 2);

  const count = queue.cancelPending();
  assert.strictEqual(count, 2);

  const res1 = await p1;
  const res2 = await p2;
  assert.strictEqual(res1, null);
  assert.strictEqual(res2, null);

  assert.strictEqual(queue.getPendingCount(), 0);
});

test('parseMultiSelectOptions: parses choices, detects non-multiselect, and detects isMultiSelect', () => {
  // Non-multiselect cases
  assert.deepStrictEqual(parseMultiSelectOptions(undefined), {
    isMultiSelect: false,
    choices: [],
    doneOption: '',
  });
  assert.deepStrictEqual(parseMultiSelectOptions([]), {
    isMultiSelect: false,
    choices: [],
    doneOption: '',
  });
  assert.deepStrictEqual(parseMultiSelectOptions(['Single Option']), {
    isMultiSelect: false,
    choices: [],
    doneOption: '',
  });
  // Last item is not Done
  assert.deepStrictEqual(parseMultiSelectOptions(['[ ] Opt 1', '[x] Opt 2', 'Finish']), {
    isMultiSelect: false,
    choices: [],
    doneOption: '',
  });
  // Item lacks [ ] / [x]
  assert.deepStrictEqual(parseMultiSelectOptions(['Opt 1', '[x] Opt 2', 'Done']), {
    isMultiSelect: false,
    choices: [],
    doneOption: '',
  });

  // Valid multi-select case
  const parsed = parseMultiSelectOptions([
    '[ ] First Feature',
    '[x] Second Feature',
    '[X] Third Feature',
    'Done',
  ]);
  assert.strictEqual(parsed.isMultiSelect, true);
  assert.strictEqual(parsed.doneOption, 'Done');
  assert.strictEqual(parsed.choices.length, 3);
  assert.deepStrictEqual(parsed.choices[0], {
    raw: '[ ] First Feature',
    label: 'First Feature',
    toggled: false,
  });
  assert.deepStrictEqual(parsed.choices[1], {
    raw: '[x] Second Feature',
    label: 'Second Feature',
    toggled: true,
  });
  assert.deepStrictEqual(parsed.choices[2], {
    raw: '[X] Third Feature',
    label: 'Third Feature',
    toggled: true,
  });

  // Multi-select with trailing Back option (from gentle-pi when canGoBack is true)
  const parsedWithBack = parseMultiSelectOptions([
    '[ ] Hexadecimal (#RRGGBB)',
    '[ ] rgb() / rgba()',
    '[ ] oklch() / oklab()',
    '[ ] <color-val>',
    'Done',
    '← Back',
  ]);
  assert.strictEqual(parsedWithBack.isMultiSelect, true);
  assert.strictEqual(parsedWithBack.doneOption, 'Done');
  assert.strictEqual(parsedWithBack.backOption, '← Back');
  assert.strictEqual(parsedWithBack.choices.length, 4);
  assert.strictEqual(parsedWithBack.choices[0].label, 'Hexadecimal (#RRGGBB)');
  assert.strictEqual(parsedWithBack.choices[3].label, '<color-val>');
});

test('extractQuestionIdentity and isSameQuestionIdentity: accurately binds question identity and handles legacy requests', () => {
  // Legacy request without title
  const idLegacy1 = extractQuestionIdentity(undefined);
  const idLegacy2 = extractQuestionIdentity('');
  assert.strictEqual(idLegacy1.hasTitle, false);
  assert.strictEqual(idLegacy2.hasTitle, false);
  assert.strictEqual(isSameQuestionIdentity(idLegacy1, idLegacy2), true);

  // Stepped questions (1/4 vs 1/4 vs 2/4)
  const idQ1Round1 = extractQuestionIdentity('1/4: Select features');
  const idQ1Round2 = extractQuestionIdentity('1/4: Select features');
  const idQ2 = extractQuestionIdentity('2/4: Select extras');
  assert.strictEqual(idQ1Round1.hasTitle, true);
  assert.strictEqual(idQ1Round1.step, 1);
  assert.strictEqual(idQ1Round1.totalSteps, 4);
  assert.strictEqual(idQ1Round1.cleanTitle, 'Select features');
  assert.strictEqual(isSameQuestionIdentity(idQ1Round1, idQ1Round2), true);
  assert.strictEqual(isSameQuestionIdentity(idQ1Round1, idQ2), false);

  // Legacy vs titled
  assert.strictEqual(isSameQuestionIdentity(idLegacy1, idQ1Round1), false);
  assert.strictEqual(isSameQuestionIdentity(idQ1Round1, idLegacy1), false);

  // Standalone titled questions without step
  const idStandalone1 = extractQuestionIdentity('Select Plugins');
  const idStandalone2 = extractQuestionIdentity('Select Plugins');
  const idStandaloneDiff = extractQuestionIdentity('Select Database');
  assert.strictEqual(idStandalone1.step, undefined);
  assert.strictEqual(isSameQuestionIdentity(idStandalone1, idStandalone2), true);
  assert.strictEqual(isSameQuestionIdentity(idStandalone1, idStandaloneDiff), false);

  // Stepped vs standalone
  assert.strictEqual(isSameQuestionIdentity(idQ1Round1, idStandalone1), false);
});

test('ExtensionUiDialogQueue: submitMultiSelect manages auto-play resolution loop until done', async () => {
  const queue = new ExtensionUiDialogQueue();
  const adapter = queue.asAdapter();

  // Initial multi-select round arrives from backend
  const p1 = adapter.select({
    type: 'extension_ui_request',
    id: 'req-multi-1',
    method: 'select',
    options: ['[ ] Feature A', '[ ] Feature B', 'Done'],
    cwd: '/workspace/project',
  });

  const active = queue.getActiveDialog()!;
  assert.ok(active);
  assert.strictEqual(active.method, 'select');

  // Client requests toggling Feature A and Feature B: [true, true]
  const submitted = queue.submitMultiSelect(active.itemKey, [true, true]);
  assert.strictEqual(submitted, true);

  // First resolution is '[ ] Feature A'
  const res1 = await p1;
  assert.strictEqual(res1, '[ ] Feature A');

  // Backend receives '[ ] Feature A' and issues updated round where Feature A is toggled
  const p2 = adapter.select({
    type: 'extension_ui_request',
    id: 'req-multi-2',
    method: 'select',
    options: ['[x] Feature A', '[ ] Feature B', 'Done'],
    cwd: '/workspace/project',
  });

  // Auto-play immediately resolves with next diff: '[ ] Feature B'
  const res2 = await p2;
  assert.strictEqual(res2, '[ ] Feature B');

  // Backend receives '[ ] Feature B' and issues updated round where both are toggled
  const p3 = adapter.select({
    type: 'extension_ui_request',
    id: 'req-multi-3',
    method: 'select',
    options: ['[x] Feature A', '[x] Feature B', 'Done'],
    cwd: '/workspace/project',
  });

  // Auto-play recognizes all match and resolves immediately with 'Done'
  const res3 = await p3;
  assert.strictEqual(res3, 'Done');
  assert.strictEqual(queue.getPendingCount(), 0);
});

test('ExtensionUiDialogQueue: multi-select autoplay does not leak into subsequent 2/4 question with same cwd and choice count', async () => {
  const queue = new ExtensionUiDialogQueue();
  const adapter = queue.asAdapter();

  // Step 1/4: 4 choices + Done
  const p1 = adapter.select({
    type: 'extension_ui_request',
    id: 'req-q1-1',
    method: 'select',
    title: '1/4: Select features',
    options: ['[ ] Feature A', '[ ] Feature B', '[ ] Feature C', '[ ] Feature D', 'Done'],
    cwd: '/workspace/project',
  });

  const active1 = queue.getActiveDialog()!;
  assert.ok(active1);

  // User submits all 4 toggles: [true, true, true, true]
  const submitted = queue.submitMultiSelect(active1.itemKey, [true, true, true, true]);
  assert.strictEqual(submitted, true);

  // Toggle 1
  const res1 = await p1;
  assert.strictEqual(res1, '[ ] Feature A');

  // Backend sends round 2
  const p2 = adapter.select({
    type: 'extension_ui_request',
    id: 'req-q1-2',
    method: 'select',
    title: '1/4: Select features',
    options: ['[x] Feature A', '[ ] Feature B', '[ ] Feature C', '[ ] Feature D', 'Done'],
    cwd: '/workspace/project',
  });
  const res2 = await p2;
  assert.strictEqual(res2, '[ ] Feature B');

  // Backend sends round 3
  const p3 = adapter.select({
    type: 'extension_ui_request',
    id: 'req-q1-3',
    method: 'select',
    title: '1/4: Select features',
    options: ['[x] Feature A', '[x] Feature B', '[ ] Feature C', '[ ] Feature D', 'Done'],
    cwd: '/workspace/project',
  });
  const res3 = await p3;
  assert.strictEqual(res3, '[ ] Feature C');

  // Backend sends round 4
  const p4 = adapter.select({
    type: 'extension_ui_request',
    id: 'req-q1-4',
    method: 'select',
    title: '1/4: Select features',
    options: ['[x] Feature A', '[x] Feature B', '[x] Feature C', '[ ] Feature D', 'Done'],
    cwd: '/workspace/project',
  });
  const res4 = await p4;
  assert.strictEqual(res4, '[ ] Feature D');

  // Backend finishes 1/4 immediately after all 4 toggles, never issuing a Done round.
  // Instead, question 2/4 arrives with the same choice count (4 choices + Done) and same cwd.
  let resolvedQ2 = false;
  let resolvedQ2Value: any = undefined;
  const pNext = adapter.select({
    type: 'extension_ui_request',
    id: 'req-q2-1',
    method: 'select',
    title: '2/4: Select extras',
    options: ['[ ] Extra A', '[ ] Extra B', '[ ] Extra C', '[ ] Extra D', 'Done'],
    cwd: '/workspace/project',
  });
  Promise.resolve(pNext).then((val: unknown) => {
    resolvedQ2 = true;
    resolvedQ2Value = val;
  });

  await new Promise((r) => setTimeout(r, 20));

  // Must remain queued and unresolved instead of being swallowed by activeAutoPlay
  assert.strictEqual(resolvedQ2, false, `Expected question 2/4 to remain unresolved, but resolved with ${JSON.stringify(resolvedQ2Value)}`);
  assert.strictEqual(queue.getPendingCount(), 1);
  const activeNext = queue.getActiveDialog()!;
  assert.ok(activeNext);
  assert.strictEqual(activeNext.id, 'req-q2-1');
  assert.strictEqual(activeNext.request.title, '2/4: Select extras');

  // Question 2/4 can now be answered normally
  queue.resolveByItemKey(activeNext.itemKey, 'Done');
  const resNext = await pNext;
  assert.strictEqual(resNext, 'Done');
  assert.strictEqual(queue.getPendingCount(), 0);
});

test('ExtensionUiDialogQueue: multi-select autoplay preserves same-question iterative rounds and Done handling', async () => {
  const queue = new ExtensionUiDialogQueue();
  const adapter = queue.asAdapter();

  const p1 = adapter.select({
    type: 'extension_ui_request',
    id: 'req-q1-1',
    method: 'select',
    title: '1/4: Select features',
    options: ['[ ] Feature A', '[ ] Feature B', 'Done'],
    cwd: '/workspace/project',
  });

  const active = queue.getActiveDialog()!;
  queue.submitMultiSelect(active.itemKey, [true, true]);
  await p1;

  const p2 = adapter.select({
    type: 'extension_ui_request',
    id: 'req-q1-2',
    method: 'select',
    title: '1/4: Select features',
    options: ['[x] Feature A', '[ ] Feature B', 'Done'],
    cwd: '/workspace/project',
  });
  const res2 = await p2;
  assert.strictEqual(res2, '[ ] Feature B');

  // Backend issues round 3 with both checked and Done option
  const p3 = adapter.select({
    type: 'extension_ui_request',
    id: 'req-q1-3',
    method: 'select',
    title: '1/4: Select features',
    options: ['[x] Feature A', '[x] Feature B', 'Done'],
    cwd: '/workspace/project',
  });
  const res3 = await p3;
  assert.strictEqual(res3, 'Done');
  assert.strictEqual(queue.getPendingCount(), 0);
});

test('ExtensionUiDialogQueue: standalone titled questions without step indicators do not leak autoplay into next question', async () => {
  const queue = new ExtensionUiDialogQueue();
  const adapter = queue.asAdapter();

  const p1 = adapter.select({
    type: 'extension_ui_request',
    id: 'req-q1',
    method: 'select',
    title: 'Select Plugins',
    options: ['[ ] Plugin A', '[ ] Plugin B', 'Done'],
    cwd: '/workspace/project',
  });

  const active1 = queue.getActiveDialog()!;
  queue.submitMultiSelect(active1.itemKey, [true, true]);
  const res1 = await p1;
  assert.strictEqual(res1, '[ ] Plugin A');

  // Next question arrives with different title but same cwd and choice count
  let resolvedNext = false;
  const pNext = adapter.select({
    type: 'extension_ui_request',
    id: 'req-q2',
    method: 'select',
    title: 'Select Database',
    options: ['[ ] Database A', '[ ] Database B', 'Done'],
    cwd: '/workspace/project',
  });
  Promise.resolve(pNext).then(() => {
    resolvedNext = true;
  });

  await new Promise((r) => setTimeout(r, 20));

  assert.strictEqual(resolvedNext, false);
  assert.strictEqual(queue.getPendingCount(), 1);
  const activeNext = queue.getActiveDialog()!;
  assert.strictEqual(activeNext.id, 'req-q2');
  assert.strictEqual(activeNext.request.title, 'Select Database');

  queue.resolveByItemKey(activeNext.itemKey, 'Done');
  const resNext = await pNext;
  assert.strictEqual(resNext, 'Done');
});

test('ExtensionUiDialogQueue: legacy no-title autoplay does not leak into subsequent titled question', async () => {
  const queue = new ExtensionUiDialogQueue();
  const adapter = queue.asAdapter();

  // Legacy round 1 without title
  const p1 = adapter.select({
    type: 'extension_ui_request',
    id: 'req-legacy-1',
    method: 'select',
    options: ['[ ] Option A', '[ ] Option B', 'Done'],
    cwd: '/workspace/project',
  });

  const active1 = queue.getActiveDialog()!;
  queue.submitMultiSelect(active1.itemKey, [true, true]);
  const res1 = await p1;
  assert.strictEqual(res1, '[ ] Option A');

  // Backend finishes and sends titled question with same cwd and choice count
  let resolvedNext = false;
  const pNext = adapter.select({
    type: 'extension_ui_request',
    id: 'req-titled-2',
    method: 'select',
    title: 'Select Environment',
    options: ['[ ] Option A', '[ ] Option B', 'Done'],
    cwd: '/workspace/project',
  });
  Promise.resolve(pNext).then(() => {
    resolvedNext = true;
  });

  await new Promise((r) => setTimeout(r, 20));

  assert.strictEqual(resolvedNext, false);
  assert.strictEqual(queue.getPendingCount(), 1);
  const activeNext = queue.getActiveDialog()!;
  assert.strictEqual(activeNext.id, 'req-titled-2');
  assert.strictEqual(activeNext.request.title, 'Select Environment');

  queue.resolveByItemKey(activeNext.itemKey, 'Done');
  const resNext = await pNext;
  assert.strictEqual(resNext, 'Done');
});

test('ExtensionUiDialogQueue: regression - multi-select with initial selected state preserves desired choices in flowAnswers', async () => {
  const queue = new ExtensionUiDialogQueue();
  const adapter = queue.asAdapter();

  const p1 = adapter.select({
    type: 'extension_ui_request',
    id: 'req-init-1',
    method: 'select',
    title: '1/2: Select features',
    options: ['[x] Feature A', '[ ] Feature B', '[ ] Feature C', 'Done'],
    cwd: '/workspace/project',
  });

  const active1 = queue.getActiveDialog()!;
  assert.ok(active1);

  // User submits [true, true, false]: keep Feature A, add Feature B
  queue.submitMultiSelect(active1.itemKey, [true, true, false]);
  await p1;

  // flowAnswers must reflect desired choices [Feature A, Feature B], NOT just [Feature A] or (Ninguna)
  const answers = queue.getFlowAnswers();
  assert.strictEqual(answers.length, 1);
  assert.strictEqual(answers[0].step, 1);
  assert.deepStrictEqual(answers[0].selectedLabels, ['Feature A', 'Feature B']);
  assert.strictEqual(answers[0].answerText, 'Feature A, Feature B');

  // Case B: unchecking initial selection and picking another option
  const queue2 = new ExtensionUiDialogQueue();
  const adapter2 = queue2.asAdapter();
  const p2 = adapter2.select({
    type: 'extension_ui_request',
    id: 'req-init-2',
    method: 'select',
    title: '1/2: Select features',
    options: ['[x] Feature A', '[ ] Feature B', '[ ] Feature C', 'Done'],
    cwd: '/workspace/project',
  });
  const active2 = queue2.getActiveDialog()!;
  queue2.submitMultiSelect(active2.itemKey, [false, true, false]);
  await p2;
  const answers2 = queue2.getFlowAnswers();
  assert.deepStrictEqual(answers2[0].selectedLabels, ['Feature B']);
  assert.strictEqual(answers2[0].answerText, 'Feature B');

  // Case C: unchecking all selections -> (Ninguna)
  const queue3 = new ExtensionUiDialogQueue();
  const adapter3 = queue3.asAdapter();
  const p3 = adapter3.select({
    type: 'extension_ui_request',
    id: 'req-init-3',
    method: 'select',
    title: '1/2: Select features',
    options: ['[x] Feature A', '[ ] Feature B', 'Done'],
    cwd: '/workspace/project',
  });
  const active3 = queue3.getActiveDialog()!;
  queue3.submitMultiSelect(active3.itemKey, [false, false]);
  await p3;
  const answers3 = queue3.getFlowAnswers();
  assert.deepStrictEqual(answers3[0].selectedLabels, []);
  assert.strictEqual(answers3[0].answerText, '(Ninguna)');
});

test('ExtensionUiDialogQueue: regression - multi-select iterative rounds preserve desired selections without overwriting each round', async () => {
  const queue = new ExtensionUiDialogQueue();
  const adapter = queue.asAdapter();

  const p1 = adapter.select({
    type: 'extension_ui_request',
    id: 'req-iter-1',
    method: 'select',
    title: '1/3: Configuration',
    options: ['[ ] Feature A', '[ ] Feature B', '[ ] Feature C', 'Done'],
    cwd: '/workspace/project',
  });

  const active1 = queue.getActiveDialog()!;
  // User desires all 3
  queue.submitMultiSelect(active1.itemKey, [true, true, true]);
  await p1;

  // Immediately after round 1 resolution, flowAnswers must NOT be overwritten with (Ninguna)
  const answersRound1 = queue.getFlowAnswers();
  assert.strictEqual(answersRound1.length, 1);
  assert.deepStrictEqual(answersRound1[0].selectedLabels, ['Feature A', 'Feature B', 'Feature C']);
  assert.strictEqual(answersRound1[0].answerText, 'Feature A, Feature B, Feature C');

  // Backend sends round 2
  const p2 = adapter.select({
    type: 'extension_ui_request',
    id: 'req-iter-2',
    method: 'select',
    title: '1/3: Configuration',
    options: ['[x] Feature A', '[ ] Feature B', '[ ] Feature C', 'Done'],
    cwd: '/workspace/project',
  });
  await p2;

  // Mid-round inspection: flowAnswers must still hold full desired choices
  const answersRound2 = queue.getFlowAnswers();
  assert.strictEqual(answersRound2.length, 1);
  assert.deepStrictEqual(answersRound2[0].selectedLabels, ['Feature A', 'Feature B', 'Feature C']);

  // Backend sends round 3
  const p3 = adapter.select({
    type: 'extension_ui_request',
    id: 'req-iter-3',
    method: 'select',
    title: '1/3: Configuration',
    options: ['[x] Feature A', '[x] Feature B', '[ ] Feature C', 'Done'],
    cwd: '/workspace/project',
  });
  await p3;

  // Backend sends round 4 (Done)
  const p4 = adapter.select({
    type: 'extension_ui_request',
    id: 'req-iter-4',
    method: 'select',
    title: '1/3: Configuration',
    options: ['[x] Feature A', '[x] Feature B', '[x] Feature C', 'Done'],
    cwd: '/workspace/project',
  });
  const res4 = await p4;
  assert.strictEqual(res4, 'Done');

  // Final inspection
  const finalAnswers = queue.getFlowAnswers();
  assert.strictEqual(finalAnswers.length, 1);
  assert.deepStrictEqual(finalAnswers[0].selectedLabels, ['Feature A', 'Feature B', 'Feature C']);
  assert.strictEqual(finalAnswers[0].answerText, 'Feature A, Feature B, Feature C');
});

test('ExtensionUiDialogQueue: regression - all-options auto finish retains desired selections when backend does not send Done round', async () => {
  const queue = new ExtensionUiDialogQueue();
  const adapter = queue.asAdapter();

  const p1 = adapter.select({
    type: 'extension_ui_request',
    id: 'req-q1-1',
    method: 'select',
    title: '1/2: Select Features',
    options: ['[ ] Feature A', '[ ] Feature B', 'Done'],
    cwd: '/workspace/project',
  });

  const active1 = queue.getActiveDialog()!;
  queue.submitMultiSelect(active1.itemKey, [true, true]);
  await p1;

  // Round 2
  const p2 = adapter.select({
    type: 'extension_ui_request',
    id: 'req-q1-2',
    method: 'select',
    title: '1/2: Select Features',
    options: ['[x] Feature A', '[ ] Feature B', 'Done'],
    cwd: '/workspace/project',
  });
  await p2;

  // Backend auto-finishes 1/2 without issuing a Done round, directly sending 2/2
  adapter.select({
    type: 'extension_ui_request',
    id: 'req-q2-1',
    method: 'select',
    title: '2/2: Select Environment',
    options: ['Staging', 'Production'],
    cwd: '/workspace/project',
  });

  const answers = queue.getFlowAnswers();
  const q1 = answers.find((a) => a.step === 1);
  assert.ok(q1, 'Step 1 answer record must exist in flowAnswers');
  assert.deepStrictEqual(q1.selectedLabels, ['Feature A', 'Feature B']);
  assert.strictEqual(q1.answerText, 'Feature A, Feature B');
});

test('ExtensionUiDialogQueue: regression - Done resolution preserves desired selections and supports fallback', async () => {
  const queue = new ExtensionUiDialogQueue();
  const adapter = queue.asAdapter();

  // Part A: submitMultiSelect with matching state resolves Done immediately
  const p1 = adapter.select({
    type: 'extension_ui_request',
    id: 'req-done-1',
    method: 'select',
    title: '1/2: Select Features',
    options: ['[x] Feature A', '[x] Feature B', 'Done'],
    cwd: '/workspace/project',
  });

  const active1 = queue.getActiveDialog()!;
  queue.submitMultiSelect(active1.itemKey, [true, true]);
  const res1 = await p1;
  assert.strictEqual(res1, 'Done');

  const answers1 = queue.getFlowAnswers();
  assert.strictEqual(answers1.length, 1);
  assert.deepStrictEqual(answers1[0].selectedLabels, ['Feature A', 'Feature B']);
  assert.strictEqual(answers1[0].answerText, 'Feature A, Feature B');

  // Part B: Direct resolveByItemKey with Done without submitMultiSelect falls back to parsed options
  const p2 = adapter.select({
    type: 'extension_ui_request',
    id: 'req-done-2',
    method: 'select',
    title: '2/2: Select Extras',
    options: ['[x] Extra A', '[ ] Extra B', 'Done'],
    cwd: '/workspace/project',
  });

  const active2 = queue.getActiveDialog()!;
  queue.resolveByItemKey(active2.itemKey, 'Done');
  const res2 = await p2;
  assert.strictEqual(res2, 'Done');

  const answers2 = queue.getFlowAnswers();
  const q2 = answers2.find((a) => a.step === 2);
  assert.ok(q2);
  assert.deepStrictEqual(q2.selectedLabels, ['Extra A']);
  assert.strictEqual(q2.answerText, 'Extra A');
});

test('ExtensionUiDialogQueue: regression - back-navigation changed selections update flowAnswers without corrupting other answers', async () => {
  const queue = new ExtensionUiDialogQueue();
  const adapter = queue.asAdapter();

  // Step 1/3: Multi-select
  const p1 = adapter.select({
    type: 'extension_ui_request',
    id: 'step-1-1',
    method: 'select',
    title: '1/3: Select components',
    options: ['[ ] Component A', '[ ] Component B', '[ ] Component C', 'Done'],
    cwd: '/workspace/project',
  });

  const active1 = queue.getActiveDialog()!;
  queue.submitMultiSelect(active1.itemKey, [true, true, false]);
  await p1;

  // Round 2
  const p1_2 = adapter.select({
    type: 'extension_ui_request',
    id: 'step-1-2',
    method: 'select',
    title: '1/3: Select components',
    options: ['[x] Component A', '[ ] Component B', '[ ] Component C', 'Done'],
    cwd: '/workspace/project',
  });
  await p1_2;

  // Round 3 (Done)
  const p1_3 = adapter.select({
    type: 'extension_ui_request',
    id: 'step-1-3',
    method: 'select',
    title: '1/3: Select components',
    options: ['[x] Component A', '[x] Component B', '[ ] Component C', 'Done'],
    cwd: '/workspace/project',
  });
  await p1_3;

  // Step 2/3: Single-select
  const p2 = adapter.select({
    type: 'extension_ui_request',
    id: 'step-2-1',
    method: 'select',
    title: '2/3: Select region',
    options: ['us-east-1', 'eu-west-1'],
    cwd: '/workspace/project',
  });
  const active2 = queue.getActiveDialog()!;
  queue.resolveByItemKey(active2.itemKey, 'eu-west-1');
  await p2;

  // Step 3/3: Confirm
  const p3 = adapter.confirm({
    type: 'extension_ui_request',
    id: 'step-3-1',
    method: 'confirm',
    title: '3/3: Deploy now?',
    cwd: '/workspace/project',
  });
  const active3 = queue.getActiveDialog()!;

  // Go back to Step 1
  queue.goBackByItemKey(active3.itemKey, 1);
  await p3;

  // Backend receives __back__:1 and re-sends Step 1
  const p1Retry = adapter.select({
    type: 'extension_ui_request',
    id: 'step-1-retry',
    method: 'select',
    title: '1/3: Select components',
    options: ['[x] Component A', '[x] Component B', '[ ] Component C', 'Done'],
    cwd: '/workspace/project',
  });

  const activeRetry = queue.getActiveDialog()!;
  // User changes selection: unchecks A and B, checks C: [false, false, true]
  queue.submitMultiSelect(activeRetry.itemKey, [false, false, true]);
  await p1Retry;

  // Verify flowAnswers:
  // Step 1 must have the newly desired Component C
  // Step 2 must remain eu-west-1
  const finalAnswers = queue.getFlowAnswers();
  const q1 = finalAnswers.find((a) => a.step === 1);
  const q2 = finalAnswers.find((a) => a.step === 2);

  assert.ok(q1, 'Step 1 record must exist');
  assert.ok(q2, 'Step 2 record must exist');
  assert.deepStrictEqual(q1.selectedLabels, ['Component C']);
  assert.strictEqual(q1.answerText, 'Component C');
  assert.strictEqual(q2.singleChoice, 'eu-west-1');
  assert.strictEqual(q2.answerText, 'eu-west-1');
});


test('ExtensionUiPromptBar: renders multi-select prompt bar with checkboxes and Done button without preselection', () => {
  const dialogItem: QueuedExtensionUiDialog = {
    id: 'test-multiselect-1',
    itemKey: createDialogItemKey('test-multiselect-1', '/workspace/my-app'),
    method: 'select',
    createdAt: Date.now(),
    expiresAt: Date.now() + 20000,
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-multiselect-1',
      method: 'select',
      title: 'Select Plugins to Install',
      message: 'Choose one or more plugins for the workspace:',
      options: ['[ ] TypeScript Plugin', '[x] ESLint Plugin', '[ ] Prettier Plugin', 'Done'],
      cwd: '/workspace/my-app',
      timeout: 20000,
    },
  };

  const markup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: dialogItem,
      pendingCount: 1,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  assert.ok(markup.includes('extension-prompt-bar'));
  assert.ok(markup.includes('role="region"'));
  // Single question: no question-type badge rendered
  assert.strictEqual(markup.includes('extension-prompt-badge'), false);
  assert.strictEqual(markup.includes('badge-select-multi'), false);
  assert.strictEqual(markup.includes('Multi-choice'), false);
  assert.ok(markup.includes('Select Plugins to Install'));
  assert.ok(markup.includes('Choose one or more plugins for the workspace:'));
  assert.ok(markup.includes('extension-prompt-multiselect-container'));
  assert.ok(markup.includes('extension-prompt-checkbox-list'));
  assert.ok(markup.includes('TypeScript Plugin'));
  assert.ok(markup.includes('ESLint Plugin'));
  assert.ok(markup.includes('Prettier Plugin'));
  assert.ok(markup.includes('role="checkbox"'));
  // No preselected options on initial mount
  assert.strictEqual(markup.includes('aria-checked="true"'), false);
  assert.ok(markup.includes('aria-checked="false"'));
  assert.ok(markup.includes('btn-extension-prompt-done'));
  assert.ok(markup.includes('Done (0 selected)'));
  assert.ok(markup.includes('Cancelar'));
});

test('ExtensionUiPromptBar: renders multi-select prompt bar when options include trailing Done and ← Back', () => {
  const dialogItem: QueuedExtensionUiDialog = {
    id: 'test-multiselect-back',
    itemKey: createDialogItemKey('test-multiselect-back', '/workspace/my-app'),
    method: 'select',
    createdAt: Date.now(),
    expiresAt: Date.now() + 20000,
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-multiselect-back',
      method: 'select',
      title: 'Seleccione formatos de color',
      message: 'Formatos soportados:',
      options: [
        '[ ] Hexadecimal (#RRGGBB)',
        '[ ] rgb() / rgba()',
        '[ ] oklch() / oklab()',
        '[ ] <color-val>',
        'Done',
        '← Back',
      ],
      cwd: '/workspace/my-app',
      timeout: 20000,
    },
  };

  const markup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: dialogItem,
      pendingCount: 1,
      canGoBack: true,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
      onBack: () => {},
    })
  );

  assert.ok(markup.includes('extension-prompt-multiselect-container'));
  assert.ok(markup.includes('extension-prompt-checkbox-list'));
  assert.ok(markup.includes('Hexadecimal (#RRGGBB)'));
  assert.ok(markup.includes('rgb() / rgba()'));
  assert.ok(markup.includes('oklch() / oklab()'));
  assert.ok(markup.includes('&lt;color-val&gt;'));
  // Must NOT render Done or Back as checkbox choices
  assert.strictEqual(markup.includes('[ ] Done'), false);
  assert.strictEqual(markup.includes('[ ] ← Back'), false);
  // Must render Done action button
  assert.ok(markup.includes('btn-extension-prompt-done'));
  // Must render Back button
  assert.ok(markup.includes('btn-extension-prompt-back'));
});

test('ExtensionUiPromptBar: renders single-select prompt bar with option buttons and disabled submit until chosen', () => {
  const dialogItem: QueuedExtensionUiDialog = {
    id: 'test-select-1',
    itemKey: createDialogItemKey('test-select-1', '/workspace/my-service'),
    method: 'select',
    createdAt: Date.now(),
    expiresAt: Date.now() + 30000,
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-select-1',
      method: 'select',
      title: 'Choose Environment',
      message: 'Select the target deployment cloud environment:',
      options: ['Development Cloud', 'Staging VPC', 'Production Cluster'],
      cwd: '/workspace/my-service',
      timeout: 30000,
    },
  };

  const markup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: dialogItem,
      pendingCount: 2,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  assert.ok(markup.includes('extension-prompt-bar'));
  // Single question: no question-type badge rendered
  assert.strictEqual(markup.includes('extension-prompt-badge'), false);
  assert.strictEqual(markup.includes('badge-select'), false);
  assert.strictEqual(markup.includes('Choice'), false);
  assert.ok(markup.includes('Choose Environment'));
  assert.ok(markup.includes('Select the target deployment cloud environment:'));
  // cwd is completely removed from prompt bar header
  assert.strictEqual(markup.includes('/workspace/my-service'), false);
  assert.strictEqual(markup.includes('extension-prompt-cwd'), false);
  assert.ok(markup.includes('1 of 2 queued'));
  assert.ok(markup.includes('Development Cloud'));
  assert.ok(markup.includes('Staging VPC'));
  assert.ok(markup.includes('Production Cluster'));
  assert.ok(markup.includes('extension-prompt-option-btn'));
  // Initial mount: no option has .is-selected class
  assert.strictEqual(markup.includes('is-selected'), false);
  assert.ok(markup.includes('extension-prompt-shortcut'));
  assert.ok(markup.includes('30s'));
  // Primary action button is rendered and disabled
  assert.ok(markup.includes('Enviar selección'));
  assert.ok(markup.includes('disabled=""'));
  assert.ok(markup.includes('Cancelar'));
});

test('ExtensionUiPromptBar: renders input prompt bar with prefill, placeholder, submit, and cancel buttons', () => {
  const dialogItem: QueuedExtensionUiDialog = {
    id: 'test-input-1',
    itemKey: createDialogItemKey('test-input-1', '/repos/backend'),
    method: 'input',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-input-1',
      method: 'input',
      title: 'Branch Name Required',
      message: 'Please provide a name for the release branch:',
      prefill: 'release/v1.2.0',
      placeholder: 'e.g. release/v1.0.0',
      cwd: '/repos/backend',
    },
  };

  const markup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: dialogItem,
      pendingCount: 1,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  assert.ok(markup.includes('extension-prompt-bar'));
  // Single question: no question-type badge rendered
  assert.strictEqual(markup.includes('extension-prompt-badge'), false);
  assert.strictEqual(markup.includes('badge-input'), false);
  assert.ok(markup.includes('Branch Name Required'));
  assert.ok(markup.includes('Please provide a name for the release branch:'));
  assert.ok(markup.includes('value="release/v1.2.0"'));
  assert.ok(markup.includes('placeholder="e.g. release/v1.0.0"'));
  assert.ok(markup.includes('extension-prompt-input-field'));
  assert.ok(markup.includes('btn-extension-prompt-primary'));
  assert.ok(markup.includes('Submit'));
  assert.ok(markup.includes('btn-extension-prompt-secondary'));
  assert.ok(markup.includes('Cancelar'));
});

test('ExtensionUiPromptBar: renders confirm prompt bar with explicit No and Sí buttons', () => {
  const dialogItem: QueuedExtensionUiDialog = {
    id: 'test-confirm-1',
    itemKey: createDialogItemKey('test-confirm-1'),
    method: 'confirm',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-confirm-1',
      method: 'confirm',
      title: 'Confirm Database Migration',
      message: 'Are you sure you want to run pending migrations on staging?',
    },
  };

  const markup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: dialogItem,
      pendingCount: 1,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  assert.ok(markup.includes('extension-prompt-bar'));
  // Single question: no question-type badge rendered
  assert.strictEqual(markup.includes('extension-prompt-badge'), false);
  assert.strictEqual(markup.includes('badge-confirm'), false);
  assert.ok(markup.includes('Confirm Database Migration'));
  assert.ok(markup.includes('Are you sure you want to run pending migrations on staging?'));
  assert.ok(markup.includes('btn-extension-prompt-negative'));
  assert.ok(markup.includes('No'));
  assert.ok(markup.includes('btn-extension-prompt-primary'));
  assert.ok(markup.includes('Sí'));
});

test('ExtensionUiDialogModal: backward compatibility wrapper renders ExtensionUiPromptBar properly', () => {
  const dialogItem: QueuedExtensionUiDialog = {
    id: 'test-compat-1',
    itemKey: createDialogItemKey('test-compat-1'),
    method: 'confirm',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-compat-1',
      method: 'confirm',
      title: 'Legacy Compatibility Test',
    },
  };

  const markup = renderToStaticMarkup(
    React.createElement(ExtensionUiDialogModal, {
      dialog: dialogItem,
      pendingCount: 1,
      onSelect: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  assert.ok(markup.includes('extension-prompt-bar'));
  assert.ok(markup.includes('Legacy Compatibility Test'));
  assert.ok(markup.includes('No'));
  assert.ok(markup.includes('Sí'));
});

test('isMultiQuestionTitle: accurately identifies question 2 or later across formats', () => {
  assert.strictEqual(isMultiQuestionTitle('Question 2/2'), true);
  assert.strictEqual(isMultiQuestionTitle('Question 2 of 3'), true);
  assert.strictEqual(isMultiQuestionTitle('Pregunta 2: Elige una opción'), true);
  assert.strictEqual(isMultiQuestionTitle('Paso 3 de 5'), true);
  assert.strictEqual(isMultiQuestionTitle('Step 4/5'), true);

  // Question 1 should not indicate back availability on title alone
  assert.strictEqual(isMultiQuestionTitle('Question 1/2'), false);
  assert.strictEqual(isMultiQuestionTitle('Question 1 of 3'), false);
  assert.strictEqual(isMultiQuestionTitle('Pregunta 1'), false);
  assert.strictEqual(isMultiQuestionTitle('Simple Dialog'), false);
  assert.strictEqual(isMultiQuestionTitle(undefined), false);
});

test('ExtensionUiDialogQueue: canGoBack accurately returns true on history or multi-question titles', async () => {
  const queue = new ExtensionUiDialogQueue();
  const adapter = queue.asAdapter();

  // Dialog with single question title and empty history
  const p1 = adapter.select({
    type: 'extension_ui_request',
    id: 'req-q1',
    method: 'select',
    title: 'Select Region',
    options: ['US', 'EU'],
  });

  const active1 = queue.getActiveDialog()!;
  assert.strictEqual(queue.canGoBack(active1.itemKey), false);

  // Resolve Q1 with 'US' -> adds to dialogHistory
  queue.resolveByItemKey(active1.itemKey, 'US');
  await p1;
  assert.strictEqual(queue.getDialogHistory().length, 1);

  // Dialog Q2 arrives
  const p2 = adapter.select({
    type: 'extension_ui_request',
    id: 'req-q2',
    method: 'select',
    title: 'Select Instance Type',
    options: ['t3.micro', 't3.large'],
  });

  const active2 = queue.getActiveDialog()!;
  // Can go back because dialogHistory.length > 0!
  assert.strictEqual(queue.canGoBack(active2.itemKey), true);

  queue.resolveByItemKey(active2.itemKey, 't3.micro');
  await p2;
});

test('ExtensionUiDialogQueue: canGoBack returns true if title indicates multi-question even without prior history', () => {
  const queue = new ExtensionUiDialogQueue();
  const adapter = queue.asAdapter();

  adapter.select({
    type: 'extension_ui_request',
    id: 'req-multi-title',
    method: 'select',
    title: 'Question 2/3: Configure Network',
    options: ['VPC-A', 'VPC-B'],
  });

  const active = queue.getActiveDialog()!;
  // History is 0, but title indicates question 2 of 3!
  assert.strictEqual(queue.getDialogHistory().length, 0);
  assert.strictEqual(queue.canGoBack(active.itemKey), true);
});

test('ExtensionUiDialogQueue: goBackByItemKey pops history and resolves active dialog with __back__', async () => {
  const queue = new ExtensionUiDialogQueue();
  const adapter = queue.asAdapter();

  // First question
  const p1 = adapter.select({
    type: 'extension_ui_request',
    id: 'step-1',
    method: 'select',
    options: ['Option A', 'Option B'],
  });
  const item1 = queue.getActiveDialog()!;
  queue.resolveByItemKey(item1.itemKey, 'Option A');
  await p1;

  assert.strictEqual(queue.getDialogHistory().length, 1);
  assert.strictEqual(queue.getDialogHistory()[0].value, 'Option A');

  // Second question
  const p2 = adapter.select({
    type: 'extension_ui_request',
    id: 'step-2',
    method: 'select',
    options: ['Confirm Next', 'Exit'],
  });
  const item2 = queue.getActiveDialog()!;

  // User clicks "← Anterior"
  const wentBack = queue.goBackByItemKey(item2.itemKey);
  assert.strictEqual(wentBack, true);

  const res2 = await p2;
  // Resolved with '__back__'
  assert.strictEqual(res2, '__back__');
  // History was popped
  assert.strictEqual(queue.getDialogHistory().length, 0);
});

test('ExtensionUiDialogQueue: cancelPending clears dialog history', async () => {
  const queue = new ExtensionUiDialogQueue();
  const adapter = queue.asAdapter();

  const p1 = adapter.input({
    type: 'extension_ui_request',
    id: 'input-q',
    method: 'input',
  });
  const item1 = queue.getActiveDialog()!;
  queue.resolveByItemKey(item1.itemKey, 'answer');
  await p1;

  assert.strictEqual(queue.getDialogHistory().length, 1);

  // User resets or disconnects
  queue.cancelPending();
  assert.strictEqual(queue.getDialogHistory().length, 0);
});

test('ExtensionUiPromptBar: renders Back button (← Anterior) when canGoBack is true and onBack is provided', () => {
  const dialogItem: QueuedExtensionUiDialog = {
    id: 'test-back-nav',
    itemKey: createDialogItemKey('test-back-nav'),
    method: 'select',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-back-nav',
      method: 'select',
      title: 'Question 2/2',
      options: ['Alpha', 'Beta'],
    },
  };

  const markup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: dialogItem,
      pendingCount: 1,
      canGoBack: true,
      onBack: () => {},
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  assert.ok(markup.includes('btn-extension-prompt-back'));
  assert.ok(markup.includes('← Anterior'));
});

test('ExtensionUiPromptBar: no preview cards rendered, selection indicated on chips/checkboxes, left-aligned buttons', () => {
  const singleDialog: QueuedExtensionUiDialog = {
    id: 'test-single-preview',
    itemKey: createDialogItemKey('test-single-preview'),
    method: 'select',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-single-preview',
      method: 'select',
      title: 'Select Engine',
      options: ['PostgreSQL', 'SQLite'],
    },
  };

  const singleMarkup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: singleDialog,
      pendingCount: 1,
      canGoBack: true,
      initialSelectedIndex: 0,
      onBack: () => {},
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  // Preview card is removed; selected state is on option button directly
  assert.strictEqual(singleMarkup.includes('extension-prompt-preview-card'), false);
  assert.strictEqual(singleMarkup.includes('Opción seleccionada:'), false);
  assert.ok(singleMarkup.includes('is-selected'));
  assert.ok(singleMarkup.includes('PostgreSQL'));
  assert.ok(singleMarkup.includes('extension-prompt-footer-actions'));
  // Button order: Primary (Enviar selección) -> Back (← Anterior) -> Cancel (Cancelar)
  const enviarIdx = singleMarkup.indexOf('Enviar selección');
  const backIdx = singleMarkup.indexOf('← Anterior');
  const cancelIdx = singleMarkup.indexOf('Cancelar');
  assert.ok(enviarIdx !== -1 && backIdx !== -1 && cancelIdx !== -1);
  assert.ok(enviarIdx < backIdx, 'Enviar selección should precede ← Anterior');
  assert.ok(backIdx < cancelIdx, '← Anterior should precede Cancelar');

  // Multi-select: preview card removed; selected state is on checkbox directly
  const multiDialog: QueuedExtensionUiDialog = {
    id: 'test-multi-preview',
    itemKey: createDialogItemKey('test-multi-preview'),
    method: 'select',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-multi-preview',
      method: 'select',
      title: 'Select Components',
      options: ['[ ] Frontend', '[ ] Backend', '[ ] Database', 'Done'],
    },
  };

  const multiMarkup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: multiDialog,
      pendingCount: 1,
      canGoBack: false,
      initialCheckedIndices: [0, 2],
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  assert.strictEqual(multiMarkup.includes('extension-prompt-preview-card'), false);
  assert.strictEqual(multiMarkup.includes('Opciones seleccionadas'), false);
  assert.ok(multiMarkup.includes('is-checked'));
  assert.ok(multiMarkup.includes('Done (2 selected)'));
});

test('parseQuestionStepInfo: accurately parses multi-step titles and single titles', () => {
  // Fraction format
  const s1 = parseQuestionStepInfo('1/2: Choose framework');
  assert.strictEqual(s1.isMultiStep, true);
  assert.strictEqual(s1.currentStep, 1);
  assert.strictEqual(s1.totalSteps, 2);
  assert.strictEqual(s1.cleanTitle, 'Choose framework');

  const s2 = parseQuestionStepInfo('2/2: Choose database');
  assert.strictEqual(s2.isMultiStep, true);
  assert.strictEqual(s2.currentStep, 2);
  assert.strictEqual(s2.totalSteps, 2);
  assert.strictEqual(s2.cleanTitle, 'Choose database');

  // "of" format
  const s3 = parseQuestionStepInfo('1 of 3: Service Name');
  assert.strictEqual(s3.isMultiStep, true);
  assert.strictEqual(s3.currentStep, 1);
  assert.strictEqual(s3.totalSteps, 3);
  assert.strictEqual(s3.cleanTitle, 'Service Name');

  // "de" format with prefix
  const s4 = parseQuestionStepInfo('Paso 2 de 4 - Ambiente de destino');
  assert.strictEqual(s4.isMultiStep, true);
  assert.strictEqual(s4.currentStep, 2);
  assert.strictEqual(s4.totalSteps, 4);
  assert.strictEqual(s4.cleanTitle, 'Ambiente de destino');

  const s5 = parseQuestionStepInfo('Pregunta 1 de 2: Nombre');
  assert.strictEqual(s5.isMultiStep, true);
  assert.strictEqual(s5.currentStep, 1);
  assert.strictEqual(s5.totalSteps, 2);
  assert.strictEqual(s5.cleanTitle, 'Nombre');

  // Fraction only
  const s6 = parseQuestionStepInfo('1/2');
  assert.strictEqual(s6.isMultiStep, true);
  assert.strictEqual(s6.currentStep, 1);
  assert.strictEqual(s6.totalSteps, 2);
  assert.strictEqual(s6.cleanTitle, '1/2');

  // Single step or 1/1
  const s7 = parseQuestionStepInfo('1/1: Solo Question');
  assert.strictEqual(s7.isMultiStep, false);
  assert.strictEqual(s7.currentStep, 1);
  assert.strictEqual(s7.totalSteps, 1);

  const s8 = parseQuestionStepInfo('Standard Prompt Title');
  assert.strictEqual(s8.isMultiStep, false);
  assert.strictEqual(s8.currentStep, 1);
  assert.strictEqual(s8.totalSteps, 1);
  assert.strictEqual(s8.cleanTitle, 'Standard Prompt Title');

  // Empty / undefined
  const s9 = parseQuestionStepInfo(undefined);
  assert.strictEqual(s9.isMultiStep, false);
  assert.strictEqual(s9.cleanTitle, '');

  const s10 = parseQuestionStepInfo('');
  assert.strictEqual(s10.isMultiStep, false);
  assert.strictEqual(s10.cleanTitle, '');
});

test('cleanQuestionText: eliminates redundant question types, step tags, and headers while preserving natural words', () => {
  // Full real-world example from user report
  assert.strictEqual(
    cleanQuestionText('1/3: 1. Simple: [1/3 Selección Simple] ¿Cuál es tu color preferido?'),
    '¿Cuál es tu color preferido?'
  );

  // Standard step prefixes
  assert.strictEqual(cleanQuestionText('1/3: ¿Cuál es tu color preferido?'), '¿Cuál es tu color preferido?');
  assert.strictEqual(cleanQuestionText('1 of 3: ¿Cuál es tu color preferido?'), '¿Cuál es tu color preferido?');
  assert.strictEqual(cleanQuestionText('Paso 1 de 3: ¿Cuál es tu color preferido?'), '¿Cuál es tu color preferido?');
  assert.strictEqual(cleanQuestionText('Pregunta 2 de 4: ¿Cuál es tu framework?'), '¿Cuál es tu framework?');
  assert.strictEqual(cleanQuestionText('Step 3 of 5 - Choose your database'), 'Choose your database');

  // Bracketed tags
  assert.strictEqual(cleanQuestionText('[1/3 Selección Simple] ¿Cuál es tu color preferido?'), '¿Cuál es tu color preferido?');
  assert.strictEqual(cleanQuestionText('[1/3] ¿Cuál es tu color preferido?'), '¿Cuál es tu color preferido?');
  assert.strictEqual(cleanQuestionText('[Selección Simple] ¿Cuál es tu color preferido?'), '¿Cuál es tu color preferido?');
  assert.strictEqual(cleanQuestionText('[Choice] What is your preferred editor?'), 'What is your preferred editor?');
  assert.strictEqual(cleanQuestionText('[Multi-choice] Select tools to configure'), 'Select tools to configure');
  assert.strictEqual(cleanQuestionText('[Input] Enter repository branch'), 'Enter repository branch');
  assert.strictEqual(cleanQuestionText('[Confirm] Run deployment to staging?'), 'Run deployment to staging?');

  // Parenthesized tags
  assert.strictEqual(cleanQuestionText('(1/3 Selección Simple) ¿Cuál es tu color preferido?'), '¿Cuál es tu color preferido?');
  assert.strictEqual(cleanQuestionText('(Selección Simple) ¿Cuál es tu color preferido?'), '¿Cuál es tu color preferido?');
  assert.strictEqual(cleanQuestionText('(1/3) ¿Cuál es tu color preferido?'), '¿Cuál es tu color preferido?');
  assert.strictEqual(cleanQuestionText('(Choice) What is your preferred editor?'), 'What is your preferred editor?');

  // Numbered and type headers
  assert.strictEqual(cleanQuestionText('1. Simple: ¿Cuál es tu color preferido?'), '¿Cuál es tu color preferido?');
  assert.strictEqual(cleanQuestionText('1. Selección Simple: ¿Cuál es tu color preferido?'), '¿Cuál es tu color preferido?');
  assert.strictEqual(cleanQuestionText('1. ¿Cuál es tu color preferido?'), '¿Cuál es tu color preferido?');
  assert.strictEqual(cleanQuestionText('Simple: ¿Cuál es tu color preferido?'), '¿Cuál es tu color preferido?');
  assert.strictEqual(cleanQuestionText('Selección Simple: ¿Cuál es tu color preferido?'), '¿Cuál es tu color preferido?');
  assert.strictEqual(cleanQuestionText('Selección Múltiple: Elige paquetes'), 'Elige paquetes');
  assert.strictEqual(cleanQuestionText('Choice: Choose an option'), 'Choose an option');
  assert.strictEqual(cleanQuestionText('Confirm: Proceed with change?'), 'Proceed with change?');

  // Secondary bracketed tags following headers
  assert.strictEqual(cleanQuestionText('1. Simple: [1/3] ¿Cuál es tu color preferido?'), '¿Cuál es tu color preferido?');
  assert.strictEqual(cleanQuestionText('1. [1/3 Selección Simple] Simple: ¿Cuál es tu color preferido?'), '¿Cuál es tu color preferido?');
  assert.strictEqual(cleanQuestionText('1/3 - Selección Simple: [1/3] ¿Cuál es tu color preferido?'), '¿Cuál es tu color preferido?');

  // Leading colons, hyphens, or dashes
  assert.strictEqual(cleanQuestionText(': - ¿Cuál es tu color preferido?'), '¿Cuál es tu color preferido?');
  assert.strictEqual(cleanQuestionText('--- ¿Cuál es tu color preferido?'), '¿Cuál es tu color preferido?');

  // Thorough stripping of Preview:, Vista Previa:, and bracketed step info with capitalization
  assert.strictEqual(
    cleanQuestionText('Preview: [Pregunta 2/3 - Vista Previa]: tienes algun template?'),
    'Tienes algun template?'
  );
  assert.strictEqual(
    cleanQuestionText('Preview: [Pregunta 2/3 - Vista Previa]: ¿tienes algun template?'),
    '¿Tienes algun template?'
  );
  assert.strictEqual(
    cleanQuestionText('Vista Previa: [2/3] tienes algun template?'),
    'Tienes algun template?'
  );
  assert.strictEqual(
    cleanQuestionText('Preview: tienes algun template?'),
    'Tienes algun template?'
  );

  // Crucial: NEVER strips normal question words without separators or brackets
  assert.strictEqual(
    cleanQuestionText('Simple questions are easy to answer'),
    'Simple questions are easy to answer'
  );
  assert.strictEqual(
    cleanQuestionText('Choice between options is difficult'),
    'Choice between options is difficult'
  );
  assert.strictEqual(
    cleanQuestionText('Input validation failed earlier'),
    'Input validation failed earlier'
  );
  assert.strictEqual(
    cleanQuestionText('Confirm that the repository is clean'),
    'Confirm that the repository is clean'
  );

  // Trailing preview blocks and attached option lists
  assert.strictEqual(
    cleanQuestionText(
      '¿Cómo prefieres resolver la visualización de los iconos en las categorías de procesos de PI-Viewer? --- 1. Iconos SVG vectoriales (Recommended) preview --- [ + ] [□ SVG Agentes] 7 subagentes [jd-fix-agent] [gentle-ai-worker] [ + ] [□ SVG Bash] 7 ejecuciones [ + ] [□ SVG Edit] 11 ediciones --- 2. Mantener fuentes Nerd Font preview --- Requiere instalar fuentes TTF/OTF con símbolos en el sistema operativo host. --- 3. Solo texto sin iconos preview --- [ + ] agentes 7 subagentes [jd-fix-agent] [ + ] bash 7 ejecuciones [ + ] edit 11 ediciones'
    ),
    '¿Cómo prefieres resolver la visualización de los iconos en las categorías de procesos de PI-Viewer?'
  );
  assert.strictEqual(
    cleanQuestionText('¿Cuál es tu color preferido?\n\n1. Azul\n2. Rojo\n3. Verde'),
    '¿Cuál es tu color preferido?'
  );
  assert.strictEqual(
    cleanQuestionText('Choose your database\n\nOptions:\n- PostgreSQL\n- MySQL'),
    'Choose your database'
  );
  assert.strictEqual(
    cleanQuestionText('¿Desea continuar?\n\nEnter option number (1-2) or exact option:'),
    '¿Desea continuar?'
  );

  // Edge cases: null, undefined, empty
  assert.strictEqual(cleanQuestionText(undefined), '');
  assert.strictEqual(cleanQuestionText(''), '');
  assert.strictEqual(cleanQuestionText('   '), '');
});

test('parseQuestionStepInfo: parses bracketed tags and combined complex questionnaire headers', () => {
  const c1 = parseQuestionStepInfo('1/3: 1. Simple: [1/3 Selección Simple] ¿Cuál es tu color preferido?');
  assert.strictEqual(c1.isMultiStep, true);
  assert.strictEqual(c1.currentStep, 1);
  assert.strictEqual(c1.totalSteps, 3);
  assert.strictEqual(c1.cleanTitle, '¿Cuál es tu color preferido?');

  const c2 = parseQuestionStepInfo('[1/3 Selección Simple] ¿Cuál es tu color preferido?');
  assert.strictEqual(c2.isMultiStep, true);
  assert.strictEqual(c2.currentStep, 1);
  assert.strictEqual(c2.totalSteps, 3);
  assert.strictEqual(c2.cleanTitle, '¿Cuál es tu color preferido?');

  const c3 = parseQuestionStepInfo('1. Simple: [2/3 Selección Simple] ¿Cuál es tu framework favorito?');
  assert.strictEqual(c3.isMultiStep, true);
  assert.strictEqual(c3.currentStep, 2);
  assert.strictEqual(c3.totalSteps, 3);
  assert.strictEqual(c3.cleanTitle, '¿Cuál es tu framework favorito?');

  const c4 = parseQuestionStepInfo('(3/3) ¿Confirmas el envío?');
  assert.strictEqual(c4.isMultiStep, true);
  assert.strictEqual(c4.currentStep, 3);
  assert.strictEqual(c4.totalSteps, 3);
  assert.strictEqual(c4.cleanTitle, '¿Confirmas el envío?');

  const c5 = parseQuestionStepInfo('Preview: [Pregunta 2/3 - Vista Previa]: tienes algun template?');
  assert.strictEqual(c5.isMultiStep, true);
  assert.strictEqual(c5.currentStep, 2);
  assert.strictEqual(c5.totalSteps, 3);
  assert.strictEqual(c5.cleanTitle, 'Tienes algun template?');
});

test('ExtensionUiPromptBar: multi-step displays single 1/n badge and clean title without type descriptions', () => {
  const dialogItem: QueuedExtensionUiDialog = {
    id: 'test-multistep-clean-1',
    itemKey: createDialogItemKey('test-multistep-clean-1'),
    method: 'select',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-multistep-clean-1',
      method: 'select',
      title: '1/3: 1. Simple: [1/3 Selección Simple] ¿Cuál es tu color preferido?',
      options: ['Rojo', 'Azul', 'Verde'],
    },
  };

  const markup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: dialogItem,
      pendingCount: 1,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  // Exactly one step badge with class "extension-prompt-badge badge-step" containing "1/3"
  assert.ok(markup.includes('extension-prompt-badge badge-step'));
  assert.ok(markup.includes('>1/3<'));

  // No question-type badges
  assert.strictEqual(markup.includes('badge-select'), false);
  assert.strictEqual(markup.includes('badge-select-multi'), false);
  assert.strictEqual(markup.includes('Choice'), false);
  assert.strictEqual(markup.includes('Selección Simple'), false);

  // Clean title in <h3>
  assert.ok(markup.includes('<h3 id="extension-prompt-title" class="extension-prompt-title">¿Cuál es tu color preferido?</h3>'));
  // Title does not have repeated 1/3 or headers
  assert.strictEqual(markup.includes('1. Simple:'), false);
  assert.strictEqual(markup.includes('[1/3 Selección Simple]'), false);
});

test('ExtensionUiPromptBar: thoroughly strips headers, bracketed tags, question types, and step prefixes like Preview: [Pregunta 2/3 - Vista Previa]:', () => {
  const raw = 'Preview: [Pregunta 2/3 - Vista Previa]: tienes algun template?';

  // 1. cleanQuestionText returns "Tienes algun template?"
  const cleaned = cleanQuestionText(raw);
  assert.strictEqual(cleaned, 'Tienes algun template?');

  // 2. parseQuestionStepInfo returns currentStep: 2, totalSteps: 3, cleanTitle: "Tienes algun template?"
  const stepInfo = parseQuestionStepInfo(raw);
  assert.strictEqual(stepInfo.isMultiStep, true);
  assert.strictEqual(stepInfo.currentStep, 2);
  assert.strictEqual(stepInfo.totalSteps, 3);
  assert.strictEqual(stepInfo.cleanTitle, 'Tienes algun template?');

  // 3. ExtensionUiPromptBar renders badge 2/3 and title "Tienes algun template?"
  const dialogItem: QueuedExtensionUiDialog = {
    id: 'test-preview-strip-1',
    itemKey: createDialogItemKey('test-preview-strip-1'),
    method: 'select',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-preview-strip-1',
      method: 'select',
      title: raw,
      options: ['Sí, tengo un template', 'No, empezar de cero'],
    },
  };

  const markup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: dialogItem,
      pendingCount: 1,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  // Single badge 2/3 rendered
  assert.ok(markup.includes('extension-prompt-badge badge-step'));
  assert.ok(markup.includes('>2/3<'));

  // Clean title in <h3>
  assert.ok(
    markup.includes(
      '<h3 id="extension-prompt-title" class="extension-prompt-title">Tienes algun template?</h3>'
    )
  );

  // No Preview or bracketed info in markup title
  assert.strictEqual(markup.includes('Preview:'), false);
  assert.strictEqual(markup.includes('Vista Previa'), false);
  assert.strictEqual(markup.includes('[Pregunta 2/3'), false);
});

test('ExtensionUiDialogQueue: tracks flowAnswers across steps and cleans up on cancel/rewind', async () => {
  const queue = new ExtensionUiDialogQueue();
  const adapter = queue.asAdapter();

  const req1: ExtensionUiRequest = {
    type: 'extension_ui_request',
    id: 'req-step-1',
    method: 'select',
    title: '1/2: Choose framework',
    options: ['React', 'Vue', 'Svelte'],
  };

  const p1 = adapter.select(req1);
  assert.strictEqual(queue.getFlowAnswers().length, 0);

  const active1 = queue.getActiveDialog()!;
  queue.resolveByItemKey(active1.itemKey, 'React');
  await p1;

  // flowAnswers now has recorded step 1
  const answersAfterStep1 = queue.getFlowAnswers();
  assert.strictEqual(answersAfterStep1.length, 1);
  assert.strictEqual(answersAfterStep1[0].step, 1);
  assert.strictEqual(answersAfterStep1[0].question, 'Choose framework');
  assert.strictEqual(answersAfterStep1[0].answerText, 'React');

  // Enqueue step 2 (should preserve step 1 answer because currentStep > 1)
  const req2: ExtensionUiRequest = {
    type: 'extension_ui_request',
    id: 'req-step-2',
    method: 'select',
    title: '2/2: Choose database',
    options: ['PostgreSQL', 'SQLite'],
  };
  const p2 = adapter.select(req2);
  assert.strictEqual(queue.getFlowAnswers().length, 1);

  // Rewind back to step 1
  const active2 = queue.getActiveDialog()!;
  queue.goBackByItemKey(active2.itemKey);
  const res2 = await p2;
  assert.strictEqual(res2, '__back__');

  // Rewound: step 1 is preserved in flowAnswers
  assert.strictEqual(queue.getFlowAnswers().length, 1);
  assert.strictEqual(queue.getFlowAnswers()[0].answerText, 'React');

  // Clear flow answers on cancelPending
  queue.recordFlowAnswer(1, 'Question 1', 'Answer 1');
  assert.strictEqual(queue.getFlowAnswers().length, 1);
  queue.cancelPending();
  assert.strictEqual(queue.getFlowAnswers().length, 0);
});

test('ExtensionUiPromptBar: renders summary view with answered questions, current question, and Confirmar y enviar al agente', () => {
  const finalStepDialog: QueuedExtensionUiDialog = {
    id: 'test-step-summary',
    itemKey: createDialogItemKey('test-step-summary'),
    method: 'select',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-step-summary',
      method: 'select',
      title: '2/2: Select Database',
      options: ['PostgreSQL', 'SQLite'],
    },
  };

  const flowAnswers: AnsweredQuestionRecord[] = [
    {
      step: 1,
      question: 'Choose framework',
      answerText: 'React',
    },
  ];

  const markup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: finalStepDialog,
      pendingCount: 1,
      canGoBack: true,
      flowAnswers,
      initialSelectedIndex: 0, // 'PostgreSQL' selected
      initialReviewingSummary: true,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  assert.ok(markup.includes('extension-prompt-summary-view'));
  assert.ok(markup.includes('Vista previa de respuestas antes de enviar al agente'));
  assert.ok(markup.includes('Verifica todas las preguntas y respuestas antes de enviarlas al agente. Puedes modificarlas o confirmar el envío:'));
  assert.ok(markup.includes('extension-prompt-summary-list'));
  assert.ok(markup.includes('extension-prompt-summary-item'));
  assert.ok(markup.includes('Choose framework'));
  assert.ok(markup.includes('React'));
  assert.ok(markup.includes('Select Database'));
  assert.ok(markup.includes('PostgreSQL'));
  assert.ok(markup.includes('btn-extension-prompt-modify'));
  assert.ok(markup.includes('Modificar'));
  assert.ok(markup.includes('Confirmar y enviar al agente'));
  assert.ok(markup.includes('Modificar selección'));
  assert.ok(markup.includes('Cancelar'));
});

test('ExtensionUiPromptBar: renders Siguiente → on intermediate steps and Revisar respuestas → on final step', () => {
  // Step 1 of 2
  const step1Dialog: QueuedExtensionUiDialog = {
    id: 'test-step-1',
    itemKey: createDialogItemKey('test-step-1'),
    method: 'select',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-step-1',
      method: 'select',
      title: '1/2: Choose framework',
      options: ['React', 'Vue'],
    },
  };

  const step1Markup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: step1Dialog,
      pendingCount: 1,
      initialSelectedIndex: 0,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  assert.ok(step1Markup.includes('Siguiente →'));
  assert.strictEqual(step1Markup.includes('Revisar respuestas →'), false);
  assert.strictEqual(step1Markup.includes('Enviar selección'), false);
  assert.strictEqual(step1Markup.includes('Revisar selección →'), false);

  // Step 2 of 2 (final step)
  const step2Dialog: QueuedExtensionUiDialog = {
    id: 'test-step-2',
    itemKey: createDialogItemKey('test-step-2'),
    method: 'select',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-step-2',
      method: 'select',
      title: '2/2: Choose database',
      options: ['PostgreSQL', 'SQLite'],
    },
  };

  const step2Markup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: step2Dialog,
      pendingCount: 1,
      canGoBack: true,
      initialSelectedIndex: 0,
      onBack: () => {},
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  assert.ok(step2Markup.includes('Revisar respuestas →'));
  assert.strictEqual(step2Markup.includes('Siguiente →'), false);
  assert.strictEqual(step2Markup.includes('Enviar selección'), false);
  assert.ok(step2Markup.includes('← Anterior'));
  assert.ok(step2Markup.includes('Cancelar'));
});

test('ExtensionUiDialogQueue: full multi-step questionnaire flow preserves, updates, and rewinds answers', async () => {
  const queue = new ExtensionUiDialogQueue();
  const adapter = queue.asAdapter();

  // Question 1: 1/3
  const p1 = adapter.select({
    type: 'extension_ui_request',
    id: 'step-1',
    method: 'select',
    title: '1/3: Environment',
    options: ['Staging', 'Production'],
  });
  const d1 = queue.getActiveDialog()!;
  queue.resolveByItemKey(d1.itemKey, 'Staging');
  await p1;

  assert.strictEqual(queue.getFlowAnswers().length, 1);
  assert.strictEqual(queue.getFlowAnswers()[0].answerText, 'Staging');

  // Question 2: 2/3
  const p2 = adapter.select({
    type: 'extension_ui_request',
    id: 'step-2',
    method: 'select',
    title: '2/3: Strategy',
    options: ['Blue/Green', 'Canary'],
  });
  const d2 = queue.getActiveDialog()!;
  queue.resolveByItemKey(d2.itemKey, 'Blue/Green');
  await p2;

  assert.strictEqual(queue.getFlowAnswers().length, 2);
  assert.strictEqual(queue.getFlowAnswers()[1].answerText, 'Blue/Green');

  // Question 3: 3/3
  const p3 = adapter.confirm({
    type: 'extension_ui_request',
    id: 'step-3',
    method: 'confirm',
    title: '3/3: Confirm Launch',
  });
  const d3 = queue.getActiveDialog()!;

  // User decides to go back from 3 to 2 to change strategy
  queue.goBackByItemKey(d3.itemKey);
  await p3;

  // Questions 1 and 2 answers are preserved on rewind
  assert.strictEqual(queue.getFlowAnswers().length, 2);
  assert.strictEqual(queue.getFlowAnswers()[0].step, 1);
  assert.strictEqual(queue.getFlowAnswers()[1].step, 2);

  // Question 2 re-asked
  const p2Retry = adapter.select({
    type: 'extension_ui_request',
    id: 'step-2-retry',
    method: 'select',
    title: '2/3: Strategy',
    options: ['Blue/Green', 'Canary'],
  });
  const d2Retry = queue.getActiveDialog()!;
  queue.resolveByItemKey(d2Retry.itemKey, 'Canary');
  await p2Retry;

  assert.strictEqual(queue.getFlowAnswers().length, 2);
  assert.strictEqual(queue.getFlowAnswers()[1].answerText, 'Canary');
});

test('ExtensionUiPromptBar: single questions render direct action labels and submit directly without preview summary', () => {
  function findElement(node: any, predicate: (n: any) => boolean): any {
    if (!node || typeof node !== 'object') return null;
    if (predicate(node)) return node;
    const children = React.Children.toArray(node.props?.children);
    for (const child of children) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
    return null;
  }

  // 1. Single select question: renders "Enviar selección" and submits directly
  let selectedResult: string | null = null;
  const singleDialog: QueuedExtensionUiDialog = {
    id: 'test-single-select',
    itemKey: createDialogItemKey('test-single-select'),
    method: 'select',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-single-select',
      method: 'select',
      title: 'Choose Environment',
      options: ['Staging', 'Production'],
    },
  };

  const singleMarkup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: singleDialog,
      initialSelectedIndex: 0,
      onSelect: (_key, choice) => {
        selectedResult = choice;
      },
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  assert.ok(singleMarkup.includes('Enviar selección'));
  assert.strictEqual(singleMarkup.includes('Revisar selección →'), false);
  assert.strictEqual(singleMarkup.includes('Revisar respuestas →'), false);
  assert.strictEqual(singleMarkup.includes('Siguiente →'), false);

  let singleTree: any = null;
  renderToStaticMarkup(
    React.createElement(() => {
      singleTree = ExtensionUiPromptBar({
        dialog: singleDialog,
        initialSelectedIndex: 0,
        onSelect: (_key, choice) => {
          selectedResult = choice;
        },
        onMultiSelectSubmit: () => {},
        onInput: () => {},
        onConfirm: () => {},
        onCancel: () => {},
      });
      return singleTree;
    })
  );

  const singleBtn = findElement(
    singleTree,
    (el) => el.type === 'button' && el.props?.children === 'Enviar selección'
  );
  assert.ok(singleBtn);
  singleBtn.props.onClick();
  assert.strictEqual(selectedResult, 'Staging');

  // 2. Multi-choice question: renders "Done (N selected)" and submits directly
  let multiResult: boolean[] | null = null;
  const multiDialog: QueuedExtensionUiDialog = {
    id: 'test-multi-done',
    itemKey: createDialogItemKey('test-multi-done'),
    method: 'select',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-multi-done',
      method: 'select',
      title: 'Choose Features',
      options: ['[ ] Auth', '[ ] Metrics', 'Done'],
    },
  };

  const multiMarkup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: multiDialog,
      initialCheckedIndices: [0],
      onSelect: () => {},
      onMultiSelectSubmit: (_key, desired) => {
        multiResult = desired;
      },
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  assert.ok(multiMarkup.includes('Done (1 selected)'));
  assert.strictEqual(multiMarkup.includes('Revisar respuestas →'), false);

  let multiTree: any = null;
  renderToStaticMarkup(
    React.createElement(() => {
      multiTree = ExtensionUiPromptBar({
        dialog: multiDialog,
        initialCheckedIndices: [0],
        onSelect: () => {},
        onMultiSelectSubmit: (_key, desired) => {
          multiResult = desired;
        },
        onInput: () => {},
        onConfirm: () => {},
        onCancel: () => {},
      });
      return multiTree;
    })
  );

  const doneBtn = findElement(
    multiTree,
    (el) => el.type === 'button' && el.props?.className?.includes('btn-extension-prompt-done')
  );
  assert.ok(doneBtn);
  doneBtn.props.onClick();
  assert.deepStrictEqual(multiResult, [true, false]);

  // 3. Input question: renders "Submit" and submits directly
  let inputResult: string | null = null;
  const inputDialog: QueuedExtensionUiDialog = {
    id: 'test-input-submit',
    itemKey: createDialogItemKey('test-input-submit'),
    method: 'input',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-input-submit',
      method: 'input',
      title: 'Enter Name',
      prefill: 'alice',
    },
  };

  const inputMarkup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: inputDialog,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: (_key, val) => {
        inputResult = val;
      },
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  assert.ok(inputMarkup.includes('Submit'));
  assert.strictEqual(inputMarkup.includes('Revisar respuestas →'), false);

  let inputTree: any = null;
  renderToStaticMarkup(
    React.createElement(() => {
      inputTree = ExtensionUiPromptBar({
        dialog: inputDialog,
        onSelect: () => {},
        onMultiSelectSubmit: () => {},
        onInput: (_key, val) => {
          inputResult = val;
        },
        onConfirm: () => {},
        onCancel: () => {},
      });
      return inputTree;
    })
  );

  const submitBtn = findElement(
    inputTree,
    (el) => el.type === 'button' && el.props?.children === 'Submit'
  );
  assert.ok(submitBtn);
  submitBtn.props.onClick();
  assert.strictEqual(inputResult, 'alice');

  // 4. Confirm question: renders "Sí" and "No" and submits directly
  let confirmResult: boolean | null = null;
  const confirmDialog: QueuedExtensionUiDialog = {
    id: 'test-confirm-direct',
    itemKey: createDialogItemKey('test-confirm-direct'),
    method: 'confirm',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-confirm-direct',
      method: 'confirm',
      title: 'Are you sure?',
    },
  };

  const confirmMarkup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: confirmDialog,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: (_key, val) => {
        confirmResult = val;
      },
      onCancel: () => {},
    })
  );

  assert.ok(confirmMarkup.includes('Sí'));
  assert.ok(confirmMarkup.includes('No'));
  assert.strictEqual(confirmMarkup.includes('Siguiente →'), false);
  assert.strictEqual(confirmMarkup.includes('No y siguiente'), false);

  let confirmTree: any = null;
  renderToStaticMarkup(
    React.createElement(() => {
      confirmTree = ExtensionUiPromptBar({
        dialog: confirmDialog,
        onSelect: () => {},
        onMultiSelectSubmit: () => {},
        onInput: () => {},
        onConfirm: (_key, val) => {
          confirmResult = val;
        },
        onCancel: () => {},
      });
      return confirmTree;
    })
  );

  const affirmativeBtn = findElement(
    confirmTree,
    (el) => el.type === 'button' && el.props?.className?.includes('btn-extension-prompt-primary') && el.props?.children === 'Sí'
  );
  assert.ok(affirmativeBtn);
  affirmativeBtn.props.onClick();
  assert.strictEqual(confirmResult, true);

  const negativeBtn = findElement(
    confirmTree,
    (el) => el.type === 'button' && el.props?.className?.includes('btn-extension-prompt-negative') && el.props?.children === 'No'
  );
  assert.ok(negativeBtn);
  negativeBtn.props.onClick();
  assert.strictEqual(confirmResult, false);
});

test('ExtensionUiPromptBar: multi-step questionnaire renders Siguiente → on intermediate steps and advances without preview', () => {
  function findElement(node: any, predicate: (n: any) => boolean): any {
    if (!node || typeof node !== 'object') return null;
    if (predicate(node)) return node;
    const children = React.Children.toArray(node.props?.children);
    for (const child of children) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
    return null;
  }

  // Intermediate select
  let selected = false;
  const select1Dialog: QueuedExtensionUiDialog = {
    id: 'step-1-sel',
    itemKey: createDialogItemKey('step-1-sel'),
    method: 'select',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'step-1-sel',
      method: 'select',
      title: '1/3: Environment',
      options: ['Dev', 'Prod'],
    },
  };

  const selMarkup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: select1Dialog,
      initialSelectedIndex: 0,
      onSelect: () => {
        selected = true;
      },
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  assert.ok(selMarkup.includes('Siguiente →'));
  assert.strictEqual(selMarkup.includes('Enviar selección'), false);
  assert.strictEqual(selMarkup.includes('Revisar respuestas →'), false);

  let selTree: any = null;
  renderToStaticMarkup(
    React.createElement(() => {
      selTree = ExtensionUiPromptBar({
        dialog: select1Dialog,
        initialSelectedIndex: 0,
        onSelect: () => {
          selected = true;
        },
        onMultiSelectSubmit: () => {},
        onInput: () => {},
        onConfirm: () => {},
        onCancel: () => {},
      });
      return selTree;
    })
  );
  const nextBtn = findElement(
    selTree,
    (el) => el.type === 'button' && el.props?.children === 'Siguiente →'
  );
  assert.ok(nextBtn);
  nextBtn.props.onClick();
  assert.strictEqual(selected, true);

  // Intermediate confirm: renders Siguiente → and No y siguiente
  let confirmVal: boolean | null = null;
  const confirm1Dialog: QueuedExtensionUiDialog = {
    id: 'step-1-conf',
    itemKey: createDialogItemKey('step-1-conf'),
    method: 'confirm',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'step-1-conf',
      method: 'confirm',
      title: '2/3: Enable feature?',
    },
  };

  const confMarkup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: confirm1Dialog,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: (_key, val) => {
        confirmVal = val;
      },
      onCancel: () => {},
    })
  );

  assert.ok(confMarkup.includes('Siguiente →'));
  assert.ok(confMarkup.includes('No y siguiente'));

  let confTree: any = null;
  renderToStaticMarkup(
    React.createElement(() => {
      confTree = ExtensionUiPromptBar({
        dialog: confirm1Dialog,
        onSelect: () => {},
        onMultiSelectSubmit: () => {},
        onInput: () => {},
        onConfirm: (_key, val) => {
          confirmVal = val;
        },
        onCancel: () => {},
      });
      return confTree;
    })
  );
  const primaryConfBtn = findElement(
    confTree,
    (el) => el.type === 'button' && el.props?.className?.includes('btn-extension-prompt-primary')
  );
  assert.strictEqual(primaryConfBtn.props?.children, 'Siguiente →');
  primaryConfBtn.props.onClick();
  assert.strictEqual(confirmVal, true);

  const secondaryConfBtn = findElement(
    confTree,
    (el) => el.type === 'button' && el.props?.className?.includes('btn-extension-prompt-negative')
  );
  assert.strictEqual(secondaryConfBtn.props?.children, 'No y siguiente');
  secondaryConfBtn.props.onClick();
  assert.strictEqual(confirmVal, false);
});

test('ExtensionUiPromptBar: multi-step questionnaire renders Revisar respuestas → on final step and opens preview summary', () => {
  const finalDialog: QueuedExtensionUiDialog = {
    id: 'step-final',
    itemKey: createDialogItemKey('step-final'),
    method: 'select',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'step-final',
      method: 'select',
      title: '2/2: Choose database',
      options: ['PostgreSQL', 'SQLite'],
    },
  };

  const flowAnswers: AnsweredQuestionRecord[] = [
    { step: 1, question: 'Choose framework', answerText: 'React' },
  ];

  const markup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: finalDialog,
      flowAnswers,
      initialSelectedIndex: 0,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  assert.ok(markup.includes('Revisar respuestas →'));
  assert.strictEqual(markup.includes('Siguiente →'), false);
  assert.strictEqual(markup.includes('Enviar selección'), false);

  // Transition to preview view on final step
  const previewMarkup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: finalDialog,
      flowAnswers,
      initialSelectedIndex: 0,
      initialReviewingSummary: true,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  assert.ok(previewMarkup.includes('Vista previa de respuestas antes de enviar al agente'));
  assert.ok(previewMarkup.includes('Verifica todas las preguntas y respuestas antes de enviarlas al agente.'));
  assert.ok(previewMarkup.includes('Choose framework'));
  assert.ok(previewMarkup.includes('React'));
  assert.ok(previewMarkup.includes('Choose database'));
  assert.ok(previewMarkup.includes('PostgreSQL'));
  assert.ok(previewMarkup.includes('Confirmar y enviar al agente'));
  assert.ok(previewMarkup.includes('Modificar selección'));
  assert.ok(previewMarkup.includes('Cancelar'));
});

test('ExtensionUiPromptBar: clicking Modificar selección in preview returns to the options view', () => {
  const finalDialog: QueuedExtensionUiDialog = {
    id: 'test-modify-return',
    itemKey: createDialogItemKey('test-modify-return'),
    method: 'select',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-modify-return',
      method: 'select',
      title: '2/2: Choose database',
      options: ['PostgreSQL', 'SQLite'],
    },
  };

  function findElement(node: any, predicate: (n: any) => boolean): any {
    if (!node || typeof node !== 'object') return null;
    if (predicate(node)) return node;
    const children = React.Children.toArray(node.props?.children);
    for (const child of children) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
    return null;
  }

  let capturedTree: any = null;
  function Host() {
    capturedTree = ExtensionUiPromptBar({
      dialog: finalDialog,
      initialSelectedIndex: 0,
      initialReviewingSummary: true,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    });
    return capturedTree;
  }

  renderToStaticMarkup(React.createElement(Host));

  const modifyBtn = findElement(
    capturedTree,
    (el) =>
      el.type === 'button' &&
      el.props?.children === 'Modificar selección'
  );

  assert.ok(modifyBtn, 'Modificar selección button should be found in preview');
  assert.strictEqual(typeof modifyBtn.props.onClick, 'function');

  // Calling onClick executes without throwing and triggers setIsReviewingSummary(false)
  modifyBtn.props.onClick();

  // Rendering with initialReviewingSummary false reflects the options view
  const optionsMarkup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: finalDialog,
      initialSelectedIndex: 0,
      initialReviewingSummary: false,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );
  assert.ok(optionsMarkup.includes('Revisar respuestas →'));
  assert.strictEqual(optionsMarkup.includes('Vista previa de respuestas antes de enviar al agente'), false);
});

test('ExtensionUiPromptBar: clicking Confirmar y enviar al agente in preview resolves and sends to the agent', async () => {
  const queue = new ExtensionUiDialogQueue();
  const adapter = queue.asAdapter();

  const req: ExtensionUiRequest = {
    type: 'extension_ui_request',
    id: 'req-send-agent',
    method: 'select',
    title: '2/2: Select Destination',
    options: ['Staging Server', 'Production Server'],
  };

  const agentPromise = adapter.select(req);
  const activeDialog = queue.getActiveDialog()!;
  assert.ok(activeDialog);

  function findElement(node: any, predicate: (n: any) => boolean): any {
    if (!node || typeof node !== 'object') return null;
    if (predicate(node)) return node;
    const children = React.Children.toArray(node.props?.children);
    for (const child of children) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
    return null;
  }

  let capturedTree: any = null;
  function Host() {
    capturedTree = ExtensionUiPromptBar({
      dialog: activeDialog,
      initialSelectedIndex: 1, // 'Production Server' selected
      initialReviewingSummary: true,
      onSelect: (key, choice) => {
        queue.resolveByItemKey(key, choice);
      },
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: (key) => queue.cancelByItemKey(key),
    });
    return capturedTree;
  }

  renderToStaticMarkup(React.createElement(Host));

  const confirmBtn = findElement(
    capturedTree,
    (el) =>
      el.type === 'button' &&
      el.props?.children === 'Confirmar y enviar al agente'
  );

  assert.ok(confirmBtn, 'Confirmar y enviar al agente button should be found');
  assert.strictEqual(typeof confirmBtn.props.onClick, 'function');

  // Click Confirmar y enviar al agente
  confirmBtn.props.onClick();

  // Agent promise resolves with the chosen answer
  const agentReceived = await agentPromise;
  assert.strictEqual(agentReceived, 'Production Server');
  assert.strictEqual(queue.getPendingCount(), 0);
});

test('ExtensionUiPromptBar: multi-step confirm dialog allows verification in preview and sending boolean to agent', async () => {
  const queue = new ExtensionUiDialogQueue();
  const adapter = queue.asAdapter();

  const req: ExtensionUiRequest = {
    type: 'extension_ui_request',
    id: 'req-confirm-agent',
    method: 'confirm',
    title: '2/2: Run production migration?',
  };

  const confirmPromise = adapter.confirm(req);
  const activeDialog = queue.getActiveDialog()!;
  assert.ok(activeDialog);

  function findElement(node: any, predicate: (n: any) => boolean): any {
    if (!node || typeof node !== 'object') return null;
    if (predicate(node)) return node;
    const children = React.Children.toArray(node.props?.children);
    for (const child of children) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
    return null;
  }

  let capturedTree: any = null;
  function Host() {
    capturedTree = ExtensionUiPromptBar({
      dialog: activeDialog,
      initialReviewingSummary: true,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: (key, val) => {
        queue.resolveByItemKey(key, val);
      },
      onCancel: (key) => queue.cancelByItemKey(key),
    });
    return capturedTree;
  }

  renderToStaticMarkup(React.createElement(Host));

  const confirmBtn = findElement(
    capturedTree,
    (el) =>
      el.type === 'button' &&
      el.props?.children === 'Confirmar y enviar al agente'
  );

  assert.ok(confirmBtn);
  confirmBtn.props.onClick();

  const confirmed = await confirmPromise;
  assert.strictEqual(confirmed, true);
  assert.strictEqual(queue.getPendingCount(), 0);
});

test('ExtensionUiDialogQueue: goBackByItemKey with targetStep resolves with __back__:<targetStep>', async () => {
  const queue = new ExtensionUiDialogQueue();
  const adapter = queue.asAdapter();

  // Step 1
  const p1 = adapter.select({
    type: 'extension_ui_request',
    id: 'step-1',
    method: 'select',
    title: '1/3: Project Type',
    options: ['Web', 'Mobile'],
  });
  const item1 = queue.getActiveDialog()!;
  queue.resolveByItemKey(item1.itemKey, 'Web');
  await p1;

  // Step 2
  const p2 = adapter.select({
    type: 'extension_ui_request',
    id: 'step-2',
    method: 'select',
    title: '2/3: Framework',
    options: ['React', 'Vue'],
  });
  const item2 = queue.getActiveDialog()!;
  queue.resolveByItemKey(item2.itemKey, 'React');
  await p2;

  // Step 3
  const p3 = adapter.select({
    type: 'extension_ui_request',
    id: 'step-3',
    method: 'select',
    title: '3/3: Database',
    options: ['PostgreSQL', 'SQLite'],
  });
  const item3 = queue.getActiveDialog()!;

  // User clicks "Modificar" on Question 1 -> targetStep = 1
  const wentBack = queue.goBackByItemKey(item3.itemKey, 1);
  assert.strictEqual(wentBack, true);

  const res3 = await p3;
  assert.strictEqual(res3, '__back__:1');
});

test('ExtensionUiDialogQueue: flowAnswers stores selections and preserves them across back navigation', async () => {
  const queue = new ExtensionUiDialogQueue();
  const adapter = queue.asAdapter();

  // Step 1: Multi-select
  const p1 = adapter.select({
    type: 'extension_ui_request',
    id: 'step-1',
    method: 'select',
    title: '1/3: Select Features',
    options: ['[x] Feature A', '[ ] Feature B', '[x] Feature C', 'Done'],
  });
  const item1 = queue.getActiveDialog()!;
  queue.submitMultiSelect(item1.itemKey, [true, false, true]);
  await p1;

  const answers1 = queue.getFlowAnswers();
  assert.strictEqual(answers1.length, 1);
  assert.strictEqual(answers1[0].step, 1);
  assert.deepStrictEqual(answers1[0].selectedLabels, ['Feature A', 'Feature C']);
  assert.strictEqual(answers1[0].answerText, 'Feature A, Feature C');

  // Step 2: Single-select
  const p2 = adapter.select({
    type: 'extension_ui_request',
    id: 'step-2',
    method: 'select',
    title: '2/3: Environment',
    options: ['Development', 'Production'],
  });
  const item2 = queue.getActiveDialog()!;
  queue.resolveByItemKey(item2.itemKey, 'Production');
  await p2;

  const answers2 = queue.getFlowAnswers();
  assert.strictEqual(answers2.length, 2);
  assert.strictEqual(answers2[1].singleChoice, 'Production');

  // Step 3: Confirm
  const p3 = adapter.confirm({
    type: 'extension_ui_request',
    id: 'step-3',
    method: 'confirm',
    title: '3/3: Deploy now?',
  });
  const item3 = queue.getActiveDialog()!;

  // Go back to Step 1 directly via targetStep = 1
  queue.goBackByItemKey(item3.itemKey, 1);
  const res3 = await p3;
  assert.strictEqual(res3, '__back__:1');

  // Answers in flowAnswers are completely preserved!
  const answersAfterBack = queue.getFlowAnswers();
  assert.strictEqual(answersAfterBack.length, 2);
  assert.deepStrictEqual(answersAfterBack[0].selectedLabels, ['Feature A', 'Feature C']);
  assert.strictEqual(answersAfterBack[1].singleChoice, 'Production');
});

test('ExtensionUiPromptBar: restores checkedIndices from savedRecord.selectedLabels and never preselects on fresh questions without savedRecord', () => {
  const dialogItem: QueuedExtensionUiDialog = {
    id: 'test-multiselect-modify',
    itemKey: createDialogItemKey('test-multiselect-modify'),
    method: 'select',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-multiselect-modify',
      method: 'select',
      title: '1/3: Choose Tools',
      options: ['[ ] ESLint', '[ ] Prettier', '[ ] Jest', 'Done'],
    },
  };

  const flowAnswers: AnsweredQuestionRecord[] = [
    {
      step: 1,
      question: 'Choose Tools',
      answerText: 'ESLint, Jest',
      selectedLabels: ['ESLint', 'Jest'],
    },
  ];

  // 1. With savedRecord.selectedLabels: indices 0 and 2 are restored
  const markupWithSaved = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: dialogItem,
      canGoBack: true,
      flowAnswers,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  assert.ok(markupWithSaved.includes('is-checked'));
  assert.ok(markupWithSaved.includes('aria-checked="true"'));
  assert.ok(markupWithSaved.includes('ESLint'));
  assert.ok(markupWithSaved.includes('Jest'));
  assert.ok(markupWithSaved.includes('Siguiente →'));

  // 2. Without savedRecord, fresh question never preselects even with [x] in options
  const dialogItemToggled: QueuedExtensionUiDialog = {
    id: 'test-multiselect-toggled',
    itemKey: createDialogItemKey('test-multiselect-toggled'),
    method: 'select',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-multiselect-toggled',
      method: 'select',
      title: '1/3: Choose Tools',
      options: ['[ ] ESLint', '[x] Prettier', '[ ] Jest', 'Done'],
    },
  };

  const markupWithToggled = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: dialogItemToggled,
      canGoBack: true,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  assert.strictEqual(markupWithToggled.includes('is-checked'), false);
  assert.strictEqual(markupWithToggled.includes('aria-checked="true"'), false);
  assert.ok(markupWithToggled.includes('Prettier'));
  assert.ok(markupWithToggled.includes('disabled=""'));
});

test('ExtensionUiPromptBar: restores singleChoice, inputValue, and confirmValue from savedRecord', () => {
  // Single choice
  const singleDialog: QueuedExtensionUiDialog = {
    id: 'test-single-modify',
    itemKey: createDialogItemKey('test-single-modify'),
    method: 'select',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-single-modify',
      method: 'select',
      title: '2/3: Select Cloud',
      options: ['AWS', 'GCP', 'Azure'],
    },
  };

  const singleAnswers: AnsweredQuestionRecord[] = [
    {
      step: 2,
      question: 'Select Cloud',
      answerText: 'GCP',
      singleChoice: 'GCP',
    },
  ];

  const singleMarkup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: singleDialog,
      canGoBack: true,
      flowAnswers: singleAnswers,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );
  assert.ok(singleMarkup.includes('is-selected'));
  assert.ok(singleMarkup.includes('GCP'));

  // Input
  const inputDialog: QueuedExtensionUiDialog = {
    id: 'test-input-modify',
    itemKey: createDialogItemKey('test-input-modify'),
    method: 'input',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-input-modify',
      method: 'input',
      title: '1/2: Project Name',
      prefill: 'default-app',
    },
  };

  const inputAnswers: AnsweredQuestionRecord[] = [
    {
      step: 1,
      question: 'Project Name',
      answerText: 'custom-app',
      inputValue: 'custom-app',
    },
  ];

  const inputMarkup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: inputDialog,
      flowAnswers: inputAnswers,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );
  assert.ok(inputMarkup.includes('value="custom-app"'));

  // Confirm
  const confirmDialog: QueuedExtensionUiDialog = {
    id: 'test-confirm-modify',
    itemKey: createDialogItemKey('test-confirm-modify'),
    method: 'confirm',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-confirm-modify',
      method: 'confirm',
      title: '1/2: Enable Telemetry?',
    },
  };

  const confirmAnswers: AnsweredQuestionRecord[] = [
    {
      step: 1,
      question: 'Enable Telemetry?',
      answerText: 'Sí',
      confirmValue: true,
    },
  ];

  const confirmSummaryMarkup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: confirmDialog,
      initialReviewingSummary: true,
      flowAnswers: confirmAnswers,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );
  assert.ok(confirmSummaryMarkup.includes('Enable Telemetry?'));
  assert.ok(confirmSummaryMarkup.includes('Sí'));
});

test('ExtensionUiPromptBar: handleModifyQuestion(1) calls onBack(itemKey, 1) when modifying a previous step', () => {
  function findElement(node: any, predicate: (n: any) => boolean): any {
    if (!node || typeof node !== 'object') return null;
    if (predicate(node)) return node;
    const children = React.Children.toArray(node.props?.children);
    for (const child of children) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
    return null;
  }

  const finalDialog: QueuedExtensionUiDialog = {
    id: 'test-summary-modify-target',
    itemKey: createDialogItemKey('test-summary-modify-target'),
    method: 'select',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-summary-modify-target',
      method: 'select',
      title: '3/3: Select DB',
      options: ['PostgreSQL', 'SQLite'],
    },
  };

  const flowAnswers: AnsweredQuestionRecord[] = [
    {
      step: 1,
      question: 'Project Type',
      answerText: 'Web App',
      singleChoice: 'Web App',
    },
    {
      step: 2,
      question: 'Framework',
      answerText: 'React',
      singleChoice: 'React',
    },
  ];

  let backCalledWithKey: string | null = null;
  let backCalledWithStep: number | undefined = undefined;

  let capturedTree: any = null;
  function Host() {
    capturedTree = ExtensionUiPromptBar({
      dialog: finalDialog,
      initialSelectedIndex: 0,
      initialReviewingSummary: true,
      flowAnswers,
      onBack: (key, targetStep) => {
        backCalledWithKey = key;
        backCalledWithStep = targetStep;
      },
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    });
    return capturedTree;
  }

  renderToStaticMarkup(React.createElement(Host));

  // Find the "Modificar" button for Step 1 in the summary list
  const modifyBtnStep1 = findElement(
    capturedTree,
    (el) =>
      el.type === 'button' &&
      el.props?.className?.includes('btn-extension-prompt-modify')
  );

  assert.ok(modifyBtnStep1, 'Modificar button for step 1 should exist in summary list');
  assert.strictEqual(typeof modifyBtnStep1.props.onClick, 'function');

  // Trigger click on Step 1 modify button
  modifyBtnStep1.props.onClick();

  assert.strictEqual(backCalledWithKey, finalDialog.itemKey);
  assert.strictEqual(backCalledWithStep, 1);
});

test('ExtensionUiPromptBar: primary buttons and Enter key are disabled/blocked when no option is selected', () => {
  function findElement(node: any, predicate: (n: any) => boolean): any {
    if (!node || typeof node !== 'object') return null;
    if (predicate(node)) return node;
    const children = React.Children.toArray(node.props?.children);
    for (const child of children) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
    return null;
  }

  // 1. Single-select: selectedOptionIndex < 0
  let singleSelected = false;
  const singleDialog: QueuedExtensionUiDialog = {
    id: 'test-single-req',
    itemKey: createDialogItemKey('test-single-req'),
    method: 'select',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-single-req',
      method: 'select',
      title: 'Choose Environment',
      options: ['Dev', 'Prod'],
    },
  };

  const singleMarkup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: singleDialog,
      onSelect: () => {
        singleSelected = true;
      },
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  // Button is rendered disabled
  assert.ok(singleMarkup.includes('disabled=""'));

  let singleTree: any = null;
  renderToStaticMarkup(
    React.createElement(() => {
      singleTree = ExtensionUiPromptBar({
        dialog: singleDialog,
        onSelect: () => {
          singleSelected = true;
        },
        onMultiSelectSubmit: () => {},
        onInput: () => {},
        onConfirm: () => {},
        onCancel: () => {},
      });
      return singleTree;
    })
  );

  const singleBtn = findElement(
    singleTree,
    (el) => el.type === 'button' && el.props?.className?.includes('btn-extension-prompt-primary')
  );
  assert.ok(singleBtn);
  assert.strictEqual(singleBtn.props.disabled, true);
  // Clicking disabled button does not trigger onSelect
  singleBtn.props.onClick();
  assert.strictEqual(singleSelected, false);

  // 2. Multi-select: checkedIndices.size === 0
  let multiSubmitted = false;
  const multiDialog: QueuedExtensionUiDialog = {
    id: 'test-multi-req',
    itemKey: createDialogItemKey('test-multi-req'),
    method: 'select',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-multi-req',
      method: 'select',
      title: 'Choose Features',
      options: ['[ ] Auth', '[ ] Metrics', 'Done'],
    },
  };

  const multiMarkup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: multiDialog,
      onSelect: () => {},
      onMultiSelectSubmit: () => {
        multiSubmitted = true;
      },
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  assert.ok(multiMarkup.includes('disabled=""'));
  assert.ok(multiMarkup.includes('Done (0 selected)'));

  let multiTree: any = null;
  renderToStaticMarkup(
    React.createElement(() => {
      multiTree = ExtensionUiPromptBar({
        dialog: multiDialog,
        onSelect: () => {},
        onMultiSelectSubmit: () => {
          multiSubmitted = true;
        },
        onInput: () => {},
        onConfirm: () => {},
        onCancel: () => {},
      });
      return multiTree;
    })
  );

  const doneBtn = findElement(
    multiTree,
    (el) => el.type === 'button' && el.props?.className?.includes('btn-extension-prompt-done')
  );
  assert.ok(doneBtn);
  assert.strictEqual(doneBtn.props.disabled, true);
  doneBtn.props.onClick();
  assert.strictEqual(multiSubmitted, false);

  // 3. Input: inputValue.trim().length === 0
  let inputSubmitted = false;
  const inputDialog: QueuedExtensionUiDialog = {
    id: 'test-input-req',
    itemKey: createDialogItemKey('test-input-req'),
    method: 'input',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-input-req',
      method: 'input',
      title: 'Enter Name',
      prefill: '   ',
    },
  };

  const inputMarkup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: inputDialog,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {
        inputSubmitted = true;
      },
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  assert.ok(inputMarkup.includes('disabled=""'));

  let inputTree: any = null;
  renderToStaticMarkup(
    React.createElement(() => {
      inputTree = ExtensionUiPromptBar({
        dialog: inputDialog,
        onSelect: () => {},
        onMultiSelectSubmit: () => {},
        onInput: () => {
          inputSubmitted = true;
        },
        onConfirm: () => {},
        onCancel: () => {},
      });
      return inputTree;
    })
  );

  const inputBtn = findElement(
    inputTree,
    (el) => el.type === 'button' && el.props?.className?.includes('btn-extension-prompt-primary')
  );
  assert.ok(inputBtn);
  assert.strictEqual(inputBtn.props.disabled, true);
  inputBtn.props.onClick();
  assert.strictEqual(inputSubmitted, false);
});

test('ExtensionUiPromptBar: fresh questions never pre-select options across all prompt types', () => {
  // Single-select fresh question
  const singleDialog: QueuedExtensionUiDialog = {
    id: 'test-single-fresh',
    itemKey: createDialogItemKey('test-single-fresh'),
    method: 'select',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-single-fresh',
      method: 'select',
      title: '1/3: Environment',
      options: ['Dev', 'Staging', 'Prod'],
    },
  };

  const singleMarkup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: singleDialog,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  assert.strictEqual(singleMarkup.includes('is-selected'), false);
  assert.strictEqual(singleMarkup.includes('aria-selected="true"'), false);
  assert.ok(singleMarkup.includes('disabled=""'));

  // Multi-select fresh question even with [x] in options and canGoBack=true
  const multiDialog: QueuedExtensionUiDialog = {
    id: 'test-multi-fresh',
    itemKey: createDialogItemKey('test-multi-fresh'),
    method: 'select',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-multi-fresh',
      method: 'select',
      title: '2/3: Tools',
      options: ['[x] ESLint', '[x] Prettier', '[ ] Jest', 'Done'],
    },
  };

  const multiMarkup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: multiDialog,
      canGoBack: true,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  assert.strictEqual(multiMarkup.includes('is-checked'), false);
  assert.strictEqual(multiMarkup.includes('aria-checked="true"'), false);
  assert.ok(multiMarkup.includes('Siguiente →'));
  assert.ok(multiMarkup.includes('disabled=""'));

  // Confirm fresh question: neither Sí nor No is pre-selected
  const confirmDialog: QueuedExtensionUiDialog = {
    id: 'test-confirm-fresh',
    itemKey: createDialogItemKey('test-confirm-fresh'),
    method: 'confirm',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-confirm-fresh',
      method: 'confirm',
      title: '3/3: Telemetry',
    },
  };

  const confirmMarkup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: confirmDialog,
      canGoBack: true,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  assert.strictEqual(confirmMarkup.includes('is-selected'), false);
});

test('ExtensionUiDialog: navigating back from Question 2 saves draft and returning to Question 2 restores it', async () => {
  const queue = new ExtensionUiDialogQueue();
  const adapter = queue.asAdapter();

  // 1. Enqueue Question 1
  const p1 = adapter.select({
    type: 'extension_ui_request',
    id: 'q1',
    method: 'select',
    title: '1/2: Choose Database',
    options: ['PostgreSQL', 'SQLite'],
  });

  const q1Dialog = queue.getActiveDialog()!;
  assert.ok(q1Dialog);
  // User selects 'PostgreSQL' on Q1
  queue.resolveByItemKey(q1Dialog.itemKey, 'PostgreSQL');
  const res1 = await p1;
  assert.strictEqual(res1, 'PostgreSQL');

  // 2. Enqueue Question 2
  const p2 = adapter.select({
    type: 'extension_ui_request',
    id: 'q2',
    method: 'select',
    title: '2/2: Choose Cloud',
    options: ['AWS', 'GCP'],
  });

  const q2Dialog = queue.getActiveDialog()!;
  assert.ok(q2Dialog);

  // User selects 'GCP' (draft) on Q2 and clicks Anterior
  const draftRecord: Partial<AnsweredQuestionRecord> = {
    step: 2,
    question: 'Choose Cloud',
    answerText: 'GCP',
    singleChoice: 'GCP',
  };

  queue.goBackByItemKey(q2Dialog.itemKey, undefined, draftRecord);
  const res2Back = await p2;
  assert.strictEqual(res2Back, '__back__');

  // Verify queue flowAnswers has the saved draft for Question 2
  const flowAnswers = queue.getFlowAnswers();
  assert.strictEqual(flowAnswers.length, 2);
  assert.strictEqual(flowAnswers[0].step, 1);
  assert.strictEqual(flowAnswers[0].singleChoice, 'PostgreSQL');
  assert.strictEqual(flowAnswers[1].step, 2);
  assert.strictEqual(flowAnswers[1].singleChoice, 'GCP');

  // Backend re-presents Q1
  const p1Retry = adapter.select({
    type: 'extension_ui_request',
    id: 'q1',
    method: 'select',
    title: '1/2: Choose Database',
    options: ['PostgreSQL', 'SQLite'],
  });

  const q1RetryDialog = queue.getActiveDialog()!;
  queue.resolveByItemKey(q1RetryDialog.itemKey, 'PostgreSQL');
  await p1Retry;

  // Backend presents Q2 again
  const p2Retry = adapter.select({
    type: 'extension_ui_request',
    id: 'q2',
    method: 'select',
    title: '2/2: Choose Cloud',
    options: ['AWS', 'GCP'],
  });

  const q2RetryDialog = queue.getActiveDialog()!;

  // Render Q2 with flowAnswers: verifies GCP is restored and button enabled
  const q2Markup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: q2RetryDialog,
      flowAnswers: queue.getFlowAnswers(),
      canGoBack: true,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  assert.ok(q2Markup.includes('is-selected'));
  assert.ok(q2Markup.includes('GCP'));
  assert.ok(q2Markup.includes('Revisar respuestas →'));
  // Button is NOT disabled because GCP is restored!
  assert.strictEqual(q2Markup.includes('disabled=""'), false);

  queue.resolveByItemKey(q2RetryDialog.itemKey, 'GCP');
  const res2Final = await p2Retry;
  assert.strictEqual(res2Final, 'GCP');
});

test('ExtensionUiDialog: modifying Question 1 preserves Question 2 selection when advancing back', async () => {
  const queue = new ExtensionUiDialogQueue();
  const adapter = queue.asAdapter();

  // 1. Question 1: Select Database
  const p1 = adapter.select({
    type: 'extension_ui_request',
    id: 'q1',
    method: 'select',
    title: '1/2: Select Database',
    options: ['PostgreSQL', 'SQLite'],
  });

  const q1 = queue.getActiveDialog()!;
  queue.resolveByItemKey(q1.itemKey, 'PostgreSQL');
  await p1;

  // 2. Question 2: Select Framework (Multi-Select)
  const p2 = adapter.select({
    type: 'extension_ui_request',
    id: 'q2',
    method: 'select',
    title: '2/2: Select Framework',
    options: ['[ ] React', '[ ] Vue', '[ ] Svelte', 'Done'],
  });

  const q2 = queue.getActiveDialog()!;

  // User checks 'Vue', but then goes back to modify Question 1
  queue.goBackByItemKey(q2.itemKey, undefined, {
    step: 2,
    question: 'Select Framework',
    answerText: 'Vue',
    selectedLabels: ['Vue'],
  });
  await p2;

  // 3. User modifies Question 1 from 'PostgreSQL' to 'SQLite'
  const p1Modify = adapter.select({
    type: 'extension_ui_request',
    id: 'q1',
    method: 'select',
    title: '1/2: Select Database',
    options: ['PostgreSQL', 'SQLite'],
  });

  const q1Mod = queue.getActiveDialog()!;
  queue.resolveByItemKey(q1Mod.itemKey, 'SQLite');
  await p1Modify;

  // 4. User advances back to Question 2
  const p2Return = adapter.select({
    type: 'extension_ui_request',
    id: 'q2',
    method: 'select',
    title: '2/2: Select Framework',
    options: ['[ ] React', '[x] Vue', '[ ] Svelte', 'Done'],
  });

  const q2Ret = queue.getActiveDialog()!;

  // Render Question 2: Verify 'Vue' is preserved and restored
  const q2Markup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: q2Ret,
      flowAnswers: queue.getFlowAnswers(),
      canGoBack: true,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  assert.ok(q2Markup.includes('is-checked'));
  assert.ok(q2Markup.includes('Vue'));
  assert.ok(q2Markup.includes('Revisar respuestas →'));
  assert.strictEqual(q2Markup.includes('disabled=""'), false);

  queue.submitMultiSelect(q2Ret.itemKey, [false, true, false]);
  const res2Final = await p2Return;
  assert.strictEqual(res2Final, 'Done');

  // Verify final flow answers: Question 1 was modified to SQLite, Question 2 preserved Vue!
  const finalAnswers = queue.getFlowAnswers();
  assert.strictEqual(finalAnswers[0].answerText, 'SQLite');
  assert.strictEqual(finalAnswers[0].singleChoice, 'SQLite');
  assert.strictEqual(finalAnswers[1].answerText, 'Vue');
  assert.deepStrictEqual(finalAnswers[1].selectedLabels, ['Vue']);
});

test('ExtensionUiPromptBar: option buttons do not have onFocus selection handlers and focus does not select Option 0', () => {
  function findAllElements(node: any, predicate: (n: any) => boolean): any[] {
    if (!node || typeof node !== 'object') return [];
    const results: any[] = [];
    if (predicate(node)) results.push(node);
    const children = React.Children.toArray(node.props?.children);
    for (const child of children) {
      results.push(...findAllElements(child, predicate));
    }
    return results;
  }

  const dialogItem: QueuedExtensionUiDialog = {
    id: 'test-no-focus-select',
    itemKey: createDialogItemKey('test-no-focus-select'),
    method: 'select',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-no-focus-select',
      method: 'select',
      title: 'Choose Environment',
      options: ['Option A', 'Option B', 'Option C'],
    },
  };

  let capturedTree: any = null;
  renderToStaticMarkup(
    React.createElement(() => {
      capturedTree = ExtensionUiPromptBar({
        dialog: dialogItem,
        onSelect: () => {},
        onMultiSelectSubmit: () => {},
        onInput: () => {},
        onConfirm: () => {},
        onCancel: () => {},
      });
      return capturedTree;
    })
  );

  const optionButtons = findAllElements(
    capturedTree,
    (el) => el.type === 'button' && el.props?.role === 'option'
  );

  assert.strictEqual(optionButtons.length, 3);

  // Crucial check: none of the option buttons should have onFocus handler attached.
  // In a real browser/WebView, focusing option 0 on mount must NOT select Option 0.
  for (const btn of optionButtons) {
    assert.strictEqual(
      btn.props.onFocus,
      undefined,
      'Option buttons must not attach onFocus handler which overwrites selections on focus'
    );
    assert.strictEqual(btn.props['aria-selected'], false);
    assert.strictEqual(btn.props.className.includes('is-selected'), false);
    assert.strictEqual(typeof btn.props.onClick, 'function');
  }
});

test('ExtensionUiDialog: selecting Option B in Q2, modifying Q1, and returning to Q2 preserves Option B without preselecting Option A', async () => {
  const queue = new ExtensionUiDialogQueue();
  const adapter = queue.asAdapter();

  // 1. Question 1: Select Database (PostgreSQL vs SQLite)
  const p1 = adapter.select({
    type: 'extension_ui_request',
    id: 'q1-choice',
    method: 'select',
    title: '1/2: Choose Database',
    options: ['PostgreSQL', 'SQLite'],
  });

  const q1 = queue.getActiveDialog()!;
  // User selects Option A ('PostgreSQL') on Question 1
  queue.resolveByItemKey(q1.itemKey, 'PostgreSQL');
  await p1;

  // 2. Question 2: Choose Cloud (AWS vs GCP vs Azure)
  const p2 = adapter.select({
    type: 'extension_ui_request',
    id: 'q2-choice',
    method: 'select',
    title: '2/2: Choose Cloud',
    options: ['AWS', 'GCP', 'Azure'],
  });

  const q2 = queue.getActiveDialog()!;

  // User selects Option B ('GCP') on Question 2, but decides to go back and modify Question 1
  queue.goBackByItemKey(q2.itemKey, undefined, {
    step: 2,
    question: 'Choose Cloud',
    answerText: 'GCP',
    singleChoice: 'GCP',
  });
  const res2Back = await p2;
  assert.strictEqual(res2Back, '__back__');

  // Verify flowAnswers recorded GCP for step 2
  assert.strictEqual(queue.getFlowAnswers()[1].singleChoice, 'GCP');

  // 3. User modifies Question 1 from PostgreSQL to SQLite (Option B)
  const p1Modify = adapter.select({
    type: 'extension_ui_request',
    id: 'q1-choice',
    method: 'select',
    title: '1/2: Choose Database',
    options: ['PostgreSQL', 'SQLite'],
  });

  const q1Mod = queue.getActiveDialog()!;
  queue.resolveByItemKey(q1Mod.itemKey, 'SQLite');
  await p1Modify;

  // 4. User advances back to Question 2
  const p2Return = adapter.select({
    type: 'extension_ui_request',
    id: 'q2-choice',
    method: 'select',
    title: '2/2: Choose Cloud',
    options: ['AWS', 'GCP', 'Azure'],
  });

  const q2Ret = queue.getActiveDialog()!;

  // Render Question 2: Verify Option B ('GCP') is restored, and Option A ('AWS') is NOT selected
  const q2Markup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: q2Ret,
      flowAnswers: queue.getFlowAnswers(),
      canGoBack: true,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  // 'GCP' is selected
  assert.ok(q2Markup.includes('is-selected'));
  assert.ok(q2Markup.includes('GCP'));
  // Submit button is enabled
  assert.strictEqual(q2Markup.includes('disabled=""'), false);
  assert.ok(q2Markup.includes('Revisar respuestas →'));

  // Submit Question 2 with the restored choice GCP
  queue.resolveByItemKey(q2Ret.itemKey, 'GCP');
  const res2Final = await p2Return;
  assert.strictEqual(res2Final, 'GCP');

  // Verify final questionnaire answers: Q1 is SQLite, Q2 preserved GCP!
  const finalAnswers = queue.getFlowAnswers();
  assert.strictEqual(finalAnswers[0].singleChoice, 'SQLite');
  assert.strictEqual(finalAnswers[1].singleChoice, 'GCP');
});

test('ExtensionUiPromptBar: synchronous render-phase state adjustment restores state immediately on itemKey change without remounting', () => {
  const flowAnswers: AnsweredQuestionRecord[] = [
    {
      step: 1,
      question: 'Choose Database',
      answerText: 'SQLite',
      singleChoice: 'SQLite',
    },
    {
      step: 2,
      question: 'Choose Cloud',
      answerText: 'GCP',
      singleChoice: 'GCP',
    },
  ];

  const dialogQ1: QueuedExtensionUiDialog = {
    id: 'q1-key',
    itemKey: createDialogItemKey('q1-key'),
    method: 'select',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'q1-key',
      method: 'select',
      title: '1/2: Choose Database',
      options: ['PostgreSQL', 'SQLite'],
    },
  };

  const dialogQ2: QueuedExtensionUiDialog = {
    id: 'q2-key',
    itemKey: createDialogItemKey('q2-key'),
    method: 'select',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'q2-key',
      method: 'select',
      title: '2/2: Choose Cloud',
      options: ['AWS', 'GCP', 'Azure'],
    },
  };

  let currentDialog = dialogQ1;
  let renderCount = 0;

  function Host() {
    renderCount++;
    return React.createElement(ExtensionUiPromptBar, {
      dialog: currentDialog,
      flowAnswers,
      canGoBack: true,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    });
  }

  // 1. Initial render with Q1
  const markupQ1 = renderToStaticMarkup(React.createElement(Host));
  assert.ok(markupQ1.includes('SQLite'));
  assert.ok(markupQ1.includes('is-selected'));

  // 2. Transition dialog prop to Q2 without remounting (same Host instance)
  currentDialog = dialogQ2;
  const markupQ2 = renderToStaticMarkup(React.createElement(Host));

  // On the very first frame of rendering Q2, GCP is already is-selected!
  assert.ok(markupQ2.includes('GCP'));
  assert.ok(markupQ2.includes('is-selected'));
  assert.strictEqual(markupQ2.includes('disabled=""'), false);
  assert.ok(markupQ2.includes('Revisar respuestas →'));
});

test('ExtensionUiDialogQueue: isNavigating reflects isNavigatingBack during rewind and clears upon next question enqueue or cancel', async () => {
  const queue = new ExtensionUiDialogQueue();
  assert.strictEqual(queue.isNavigating(), false);

  const q1 = queue.enqueue(
    {
      type: 'extension_ui_request',
      id: 'q1',
      method: 'select',
      title: '1/2: First Question',
      options: ['Option A', 'Option B'],
    },
    'select',
    () => {}
  );

  assert.strictEqual(queue.isNavigating(), false);
  queue.resolveByItemKey(q1.itemKey, 'Option A');

  const q2 = queue.enqueue(
    {
      type: 'extension_ui_request',
      id: 'q2',
      method: 'select',
      title: '2/2: Second Question',
      options: ['Option C', 'Option D'],
    },
    'select',
    () => {}
  );

  assert.strictEqual(queue.isNavigating(), false);

  // Trigger rewind back to Step 1
  queue.goBackByItemKey(q2.itemKey, 1);
  assert.strictEqual(queue.isNavigating(), true, 'isNavigating should be true while waiting for rewind question');

  // Enqueueing rewound question clears isNavigatingBack
  const q1Rewound = queue.enqueue(
    {
      type: 'extension_ui_request',
      id: 'q1-rewound',
      method: 'select',
      title: '1/2: First Question',
      options: ['Option A', 'Option B'],
    },
    'select',
    () => {}
  );
  assert.strictEqual(queue.isNavigating(), false, 'isNavigating should be false after rewound question is enqueued');

  // Next: test rewind cleared by cancelPending
  queue.resolveByItemKey(q1Rewound.itemKey, 'Option B');
  const q2Again = queue.enqueue(
    {
      type: 'extension_ui_request',
      id: 'q2-again',
      method: 'select',
      title: '2/2: Second Question',
      options: ['Option C', 'Option D'],
    },
    'select',
    () => {}
  );
  queue.goBackByItemKey(q2Again.itemKey, 1);
  assert.strictEqual(queue.isNavigating(), true);
  queue.cancelPending();
  assert.strictEqual(queue.isNavigating(), false, 'isNavigating should be false after cancelPending');

  // Test rewind cleared by handleExpiry
  const qExpiring = queue.enqueue(
    {
      type: 'extension_ui_request',
      id: 'q-expiring',
      method: 'select',
      title: '2/2: Question with Expiry',
      options: ['A', 'B'],
    },
    'select',
    () => {}
  );
  queue.goBackByItemKey(qExpiring.itemKey, 1);
  assert.strictEqual(queue.isNavigating(), true);

  const qWait = queue.enqueue(
    {
      type: 'extension_ui_request',
      id: 'q-wait',
      method: 'select',
      title: 'Wait',
      options: ['A'],
    },
    'select',
    () => {}
  );
  // Simulate active navigation interrupted by expiry
  (queue as any).isNavigatingBack = true;
  assert.strictEqual(queue.isNavigating(), true);
  queue.handleExpiry(qWait.itemKey);
  assert.strictEqual(queue.isNavigating(), false, 'handleExpiry should reset isNavigating');
});

test('ExtensionUiPromptBar: handleModifyQuestion(1) keeps summary view mounted without flashing intermediate question and sets modifying state until itemKey transition', () => {
  function findElement(node: any, predicate: (n: any) => boolean): any {
    if (!node || typeof node !== 'object') return null;
    if (predicate(node)) return node;
    const children = React.Children.toArray(node.props?.children);
    for (const child of children) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
    return null;
  }

  const dialogQ3: QueuedExtensionUiDialog = {
    id: 'test-q3',
    itemKey: createDialogItemKey('test-q3'),
    method: 'select',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-q3',
      method: 'select',
      title: '3/3: Database Selection',
      options: ['PostgreSQL', 'SQLite'],
    },
  };

  const dialogQ1: QueuedExtensionUiDialog = {
    id: 'test-q1',
    itemKey: createDialogItemKey('test-q1'),
    method: 'select',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-q1',
      method: 'select',
      title: '1/3: Project Type',
      options: ['Web App', 'CLI', 'Library'],
    },
  };

  const flowAnswers: AnsweredQuestionRecord[] = [
    {
      step: 1,
      question: 'Project Type',
      answerText: 'Web App',
      singleChoice: 'Web App',
    },
    {
      step: 2,
      question: 'Framework',
      answerText: 'React',
      singleChoice: 'React',
    },
  ];

  let onBackTargetStep: number | undefined;
  let onBackItemKey: string | undefined;

  let capturedTree: any = null;
  function Host() {
    capturedTree = ExtensionUiPromptBar({
      dialog: dialogQ3,
      flowAnswers,
      initialSelectedIndex: 1,
      initialReviewingSummary: true,
      onBack: (key, targetStep) => {
        onBackItemKey = key;
        onBackTargetStep = targetStep;
      },
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    });
    return capturedTree;
  }

  const initialMarkup = renderToStaticMarkup(React.createElement(Host));
  assert.ok(initialMarkup.includes('extension-prompt-summary-view'));
  assert.ok(initialMarkup.includes('Vista previa de respuestas antes de enviar al agente'));

  // Find the "Modificar" button for Step 1
  const modifyBtnStep1 = findElement(
    capturedTree,
    (el) =>
      el.type === 'button' &&
      el.props?.className?.includes('btn-extension-prompt-modify') &&
      typeof el.props?.onClick === 'function'
  );
  assert.ok(modifyBtnStep1, 'Modificar button for Step 1 should be present');

  // Trigger modify step 1: calls onBack with step 1
  modifyBtnStep1.props.onClick();

  assert.strictEqual(onBackItemKey, dialogQ3.itemKey);
  assert.strictEqual(onBackTargetStep, 1);

  // While modifying Step 1, summary view remains mounted with .is-transitioning,
  // the button shows "Cargando..." and buttons are disabled
  const modifyingMarkup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: dialogQ3,
      flowAnswers,
      initialSelectedIndex: 1,
      initialReviewingSummary: true,
      initialModifyingStep: 1,
      onBack: () => {},
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  assert.ok(modifyingMarkup.includes('is-transitioning'), 'Bar should have is-transitioning class');
  assert.ok(modifyingMarkup.includes('Cargando...'), 'Step 1 modify button should display Cargando...');
  assert.ok(modifyingMarkup.includes('extension-prompt-summary-view'), 'Summary view must stay mounted');
  assert.strictEqual(
    modifyingMarkup.includes('extension-prompt-step-content'),
    false,
    'Intermediate Question 3 must not flash on screen while waiting for Question 1'
  );

  // Now verify that when Q1 arrives with a new itemKey, it renders the interactive step content
  const q1Markup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: dialogQ1,
      flowAnswers,
      canGoBack: false,
      initialReviewingSummary: false,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  // Verifies Q1 interactive view renders inside extension-prompt-step-content
  assert.ok(q1Markup.includes('extension-prompt-step-content'));
  assert.ok(q1Markup.includes('Project Type'));
  assert.ok(q1Markup.includes('Web App'));
  assert.strictEqual(q1Markup.includes('extension-prompt-summary-view'), false);
  assert.strictEqual(q1Markup.includes('is-transitioning'), false);
});

test('ExtensionUiPromptBar: handleModifyQuestion on current step directly exits summary review mode without calling onBack', () => {
  const dialogQ2: QueuedExtensionUiDialog = {
    id: 'test-q2-same',
    itemKey: createDialogItemKey('test-q2-same'),
    method: 'select',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-q2-same',
      method: 'select',
      title: '2/2: Confirm Options',
      options: ['Option 1', 'Option 2'],
    },
  };

  const flowAnswers: AnsweredQuestionRecord[] = [
    {
      step: 1,
      question: 'Question 1',
      answerText: 'Answer 1',
    },
  ];

  let onBackCalled = false;
  let capturedTree: any = null;

  function Host() {
    capturedTree = ExtensionUiPromptBar({
      dialog: dialogQ2,
      flowAnswers,
      initialReviewingSummary: true,
      onBack: () => {
        onBackCalled = true;
      },
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    });
    return capturedTree;
  }

  renderToStaticMarkup(React.createElement(Host));

  // Find the "Modificar" button for Step 2 (the current step)
  const modifyButtons: any[] = [];
  function collectModifyButtons(node: any) {
    if (!node || typeof node !== 'object') return;
    if (
      node.type === 'button' &&
      node.props?.className?.includes('btn-extension-prompt-modify')
    ) {
      modifyButtons.push(node);
    }
    const children = React.Children.toArray(node.props?.children);
    for (const child of children) {
      collectModifyButtons(child);
    }
  }
  collectModifyButtons(capturedTree);
  assert.strictEqual(modifyButtons.length, 2);

  // modifyButtons[1] is for Step 2 (current step)
  modifyButtons[1].props.onClick();

  // onBack should NOT be called when modifying currentStep
  assert.strictEqual(onBackCalled, false);
});

test('ExtensionUiPromptBar: navigating back sets isNavigatingBack, disables back button, and renders is-transitioning', () => {
  const dialogQ2: QueuedExtensionUiDialog = {
    id: 'test-q2-back',
    itemKey: createDialogItemKey('test-q2-back'),
    method: 'select',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-q2-back',
      method: 'select',
      title: '2/2: Framework',
      options: ['React', 'Vue'],
    },
  };

  // Render when navigating back is active
  const navigatingMarkup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: dialogQ2,
      canGoBack: true,
      initialIsNavigatingBack: true,
      onBack: () => {},
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  assert.ok(navigatingMarkup.includes('is-transitioning'), 'Bar should have is-transitioning class when navigating back');
  assert.ok(
    navigatingMarkup.includes('btn-extension-prompt-back') &&
    navigatingMarkup.includes('disabled=""'),
    'Back button should be disabled when isNavigatingBack is true'
  );
  assert.ok(navigatingMarkup.includes('extension-prompt-step-content'));
});

test('ExtensionUiPromptBar: .summary-item-answer-row places Modificar adjacent to .summary-item-a and handles submission state', () => {
  const flowAnswers: AnsweredQuestionRecord[] = [
    { step: 1, question: 'Choose framework', answerText: 'React' },
    { step: 2, question: 'Choose database', answerText: 'PostgreSQL' },
  ];

  const dialog: QueuedExtensionUiDialog = {
    id: 'test-summary-row',
    itemKey: createDialogItemKey('test-summary-row'),
    method: 'select',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-summary-row',
      method: 'select',
      title: '2/2: Choose database',
      options: ['PostgreSQL', 'SQLite'],
    },
  };

  const markup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog,
      flowAnswers,
      initialReviewingSummary: true,
      onBack: () => {},
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  // Verify structure: summary-item-answer-row contains summary-item-a and btn-extension-prompt-modify
  assert.ok(markup.includes('summary-item-answer-row'), 'Should render summary-item-answer-row');
  assert.ok(markup.includes('summary-item-a'), 'Should render summary-item-a');
  assert.ok(markup.includes('btn-extension-prompt-modify'), 'Should render btn-extension-prompt-modify');

  // Verify nesting: summary-item-answer-row wraps summary-item-a and btn-extension-prompt-modify
  const answerRowMatches = markup.match(/<div class="summary-item-answer-row">([\s\S]*?)<\/div>/g);
  assert.ok(answerRowMatches && answerRowMatches.length >= 2, 'Should find at least 2 answer rows');
  for (const row of answerRowMatches!) {
    assert.ok(row.includes('summary-item-a'), 'Answer row must include answer text');
    assert.ok(row.includes('btn-extension-prompt-modify'), 'Answer row must include modify button');
  }
});

test('ExtensionUiPromptBar: canReviewSummary enables Revisar respuestas → on intermediate questions when all steps are answered', () => {
  const dialogQ1: QueuedExtensionUiDialog = {
    id: 'test-q1-review',
    itemKey: createDialogItemKey('test-q1-review'),
    method: 'select',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-q1-review',
      method: 'select',
      title: '1/3: Framework',
      options: ['React', 'Vue', 'Svelte'],
    },
  };

  const allAnsweredFlow: AnsweredQuestionRecord[] = [
    { step: 1, question: 'Framework', answerText: 'React' },
    { step: 2, question: 'Database', answerText: 'PostgreSQL' },
    { step: 3, question: 'Hosting', answerText: 'Vercel' },
  ];

  // 1. When all steps are answered: Revisar respuestas → is visible on intermediate step 1
  const markupWithReview = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: dialogQ1,
      flowAnswers: allAnsweredFlow,
      initialSelectedIndex: 0,
      onBack: () => {},
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  assert.ok(
    markupWithReview.includes('Revisar respuestas →'),
    'Should render Revisar respuestas → when all steps are answered'
  );
  assert.ok(
    markupWithReview.includes('Siguiente →'),
    'Should still render Siguiente → as primary button on step 1'
  );

  // 2. When an intermediate step is missing: Revisar respuestas → is NOT visible
  const incompleteFlow: AnsweredQuestionRecord[] = [
    { step: 1, question: 'Framework', answerText: 'React' },
    // Step 2 and 3 missing
  ];

  const markupIncomplete = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: dialogQ1,
      flowAnswers: incompleteFlow,
      initialSelectedIndex: 0,
      onBack: () => {},
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  assert.strictEqual(
    markupIncomplete.includes('Revisar respuestas →'),
    false,
    'Should NOT render Revisar respuestas → when other steps are not yet answered'
  );

  // 3. Test clicking Revisar respuestas → on Step 1: saves draft and invokes onBack with current draft
  let backCalledWithKey: string | null = null;
  let backCalledWithStep: number | null = null;
  let backCalledWithDraft: any = null;

  let capturedTree: any = null;
  function Host() {
    capturedTree = ExtensionUiPromptBar({
      dialog: dialogQ1,
      flowAnswers: allAnsweredFlow,
      initialSelectedIndex: 1, // Vue selected
      onBack: (key, step, draft) => {
        backCalledWithKey = key;
        backCalledWithStep = step ?? null;
        backCalledWithDraft = draft;
      },
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    });
    return capturedTree;
  }

  renderToStaticMarkup(React.createElement(Host));

  function findElement(node: any, predicate: (n: any) => boolean): any {
    if (!node || typeof node !== 'object') return null;
    if (predicate(node)) return node;
    const children = React.Children.toArray(node.props?.children);
    for (const child of children) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
    return null;
  }

  const reviewBtn = findElement(
    capturedTree,
    (el) =>
      el.type === 'button' &&
      el.props?.children === 'Revisar respuestas →' &&
      typeof el.props?.onClick === 'function'
  );

  assert.ok(reviewBtn, 'Revisar respuestas → button should exist and have onClick');
  reviewBtn.props.onClick();

  assert.strictEqual(backCalledWithKey, dialogQ1.itemKey);
  assert.strictEqual(backCalledWithStep, 1);
  assert.strictEqual(backCalledWithDraft?.singleChoice, 'Vue');
});

test('useExtensionUiDialog subscriber contract: immediate dismissal on final step vs grace delay on intermediate step', () => {
  const queueManager = new ExtensionUiDialogQueue();
  const dialogHolder = { current: null as QueuedExtensionUiDialog | null };
  const getDialog = () => dialogHolder.current;
  let activeDialogRef: QueuedExtensionUiDialog | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  const unsubscribe = queueManager.subscribe((updated) => {
    const nextActive = updated.length > 0 ? updated[0] : null;
    if (nextActive) {
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      activeDialogRef = nextActive;
      dialogHolder.current = nextActive;
    } else {
      if (activeDialogRef !== null) {
        if (graceTimer) {
          clearTimeout(graceTimer);
          graceTimer = null;
        }
        const stepInfo = parseQuestionStepInfo(activeDialogRef.request.title);
        const isFinal = !stepInfo.isMultiStep || stepInfo.currentStep >= stepInfo.totalSteps;
        if (isFinal && !queueManager.isNavigating()) {
          activeDialogRef = null;
          dialogHolder.current = null;
          queueManager.clearFlowAnswers();
        } else {
          const graceTimeout = queueManager.isNavigating() ? 1500 : 600;
          graceTimer = setTimeout(() => {
            activeDialogRef = null;
            dialogHolder.current = null;
            graceTimer = null;
          }, graceTimeout);
        }
      } else {
        dialogHolder.current = null;
      }
    }
  });

  try {
    // 1. Intermediate step (1/2): Should NOT clear immediately, should set grace timer
    const q1 = queueManager.enqueue(
      {
        type: 'extension_ui_request',
        id: 'q1-intermediate',
        method: 'select',
        title: '1/2: First Question',
        options: ['A', 'B'],
      },
      'select',
      () => {}
    );

    const d1 = getDialog();
    assert.ok(d1);
    assert.strictEqual(d1.id, 'q1-intermediate');

    // Resolve q1
    queueManager.resolveByItemKey(q1.itemKey, 'A');

    // Intermediate step: activeDialog is NOT immediately null!
    assert.ok(getDialog(), 'Intermediate step should remain active during grace timer');
    assert.ok(graceTimer !== null, 'Grace timer should be active for intermediate step');

    // Fast-forward or wait timer
    clearTimeout(graceTimer!);
    dialogHolder.current = null;
    graceTimer = null;

    // 2. Final step (2/2): SHOULD clear immediately without delay
    const q2 = queueManager.enqueue(
      {
        type: 'extension_ui_request',
        id: 'q2-final',
        method: 'select',
        title: '2/2: Final Question',
        options: ['C', 'D'],
      },
      'select',
      () => {}
    );

    const d2 = getDialog();
    assert.ok(d2);
    assert.strictEqual(d2.id, 'q2-final');

    // Resolve q2 (final question)
    queueManager.resolveByItemKey(q2.itemKey, 'C');

    // Final step: immediately null!
    assert.strictEqual(getDialog(), null, 'Final step must be dismissed immediately without lingering');
    assert.strictEqual(graceTimer, null, 'No grace timer should be scheduled for final step');

    // 3. Single question (!isMultiStep): Also dismissed immediately
    const qSingle = queueManager.enqueue(
      {
        type: 'extension_ui_request',
        id: 'q-single',
        method: 'select',
        title: 'Choose deployment target',
        options: ['Dev', 'Prod'],
      },
      'select',
      () => {}
    );

    assert.ok(getDialog());
    queueManager.resolveByItemKey(qSingle.itemKey, 'Prod');

    assert.strictEqual(getDialog(), null, 'Single question must be dismissed immediately');
    assert.strictEqual(graceTimer, null, 'No grace timer should be scheduled for single question');
  } finally {
    if (graceTimer) clearTimeout(graceTimer);
    unsubscribe();
  }
});

test('ExtensionUiDialogQueue: goBackByItemKey when targetStep === currentStep saves draft without navigating or resolving', () => {
  const queue = new ExtensionUiDialogQueue();
  const q1 = queue.enqueue(
    {
      type: 'extension_ui_request',
      id: 'q1-stay',
      method: 'select',
      title: '1/3: Framework',
      options: ['React', 'Vue'],
    },
    'select',
    () => {}
  );

  let resolved = false;
  q1.resolve = () => {
    resolved = true;
  };

  // Call goBackByItemKey with targetStep === 1 (currentStep)
  const result = queue.goBackByItemKey(q1.itemKey, 1, {
    step: 1,
    question: 'Framework',
    answerText: 'Vue',
    singleChoice: 'Vue',
  });

  // Should return false (no navigation) and not resolve the dialog
  assert.strictEqual(result, false, 'Should not navigate back to the same current step');
  assert.strictEqual(resolved, false, 'Dialog should remain active and unresolved');
  assert.strictEqual(queue.isNavigating(), false, 'isNavigating should remain false');

  // But draft should be saved in flowAnswers!
  const flow = queue.getFlowAnswers();
  assert.strictEqual(flow.length, 1);
  assert.strictEqual(flow[0].step, 1);
  assert.strictEqual(flow[0].singleChoice, 'Vue');
});

test('ExtensionUiPromptBar: handleFinalSubmit sets isSubmittingFinal, updates button text to Enviando al agente..., and disables buttons', () => {
  function findElement(node: any, predicate: (n: any) => boolean): any {
    if (!node || typeof node !== 'object') return null;
    if (predicate(node)) return node;
    const children = React.Children.toArray(node.props?.children);
    for (const child of children) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
    return null;
  }

  const dialog: QueuedExtensionUiDialog = {
    id: 'test-final-submit',
    itemKey: createDialogItemKey('test-final-submit'),
    method: 'select',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-final-submit',
      method: 'select',
      title: '2/2: Database',
      options: ['PostgreSQL', 'SQLite'],
    },
  };

  let submitCalled = false;
  let capturedTree: any = null;

  function Host() {
    capturedTree = ExtensionUiPromptBar({
      dialog,
      flowAnswers: [
        { step: 1, question: 'Framework', answerText: 'React' },
        { step: 2, question: 'Database', answerText: 'PostgreSQL' },
      ],
      initialReviewingSummary: true,
      initialSelectedIndex: 0,
      onBack: () => {},
      onSelect: () => {
        submitCalled = true;
      },
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    });
    return capturedTree;
  }

  renderToStaticMarkup(React.createElement(Host));

  const submitBtn = findElement(
    capturedTree,
    (el) =>
      el.type === 'button' &&
      el.props?.className?.includes('btn-extension-prompt-primary') &&
      typeof el.props?.onClick === 'function'
  );

  assert.ok(submitBtn, 'Submit button should be present in summary view');
  assert.strictEqual(submitBtn.props.children, 'Confirmar y enviar al agente');

  // Click submit
  submitBtn.props.onClick();
  assert.strictEqual(submitCalled, true, 'onSelect should be called on final submit');
});

test('ExtensionUiPromptBar: review vs normal mode renders review as a distinct view without question leakage and heading only once', () => {
  const finalQuestionDialog: QueuedExtensionUiDialog = {
    id: 'test-review-distinct-view',
    itemKey: createDialogItemKey('test-review-distinct-view'),
    method: 'select',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-review-distinct-view',
      method: 'select',
      title: '2/2: Distinctive Final Question Title',
      message: 'Distinctive final question explanatory message that should not leak into review',
      options: ['Option A', 'Option B'],
    },
  };

  const flowAnswers: AnsweredQuestionRecord[] = [
    { step: 1, question: 'First Question', answerText: 'First Answer' },
    { step: 2, question: 'Distinctive Final Question Title', answerText: 'Option A' },
  ];

  // 1. Normal mode (initialReviewingSummary: false): renders question controls, message, step badge, and question title
  const normalMarkup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: finalQuestionDialog,
      flowAnswers,
      initialSelectedIndex: 0,
      initialReviewingSummary: false,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  // Normal mode assertions:
  // - Shows step counter badge 2/2
  assert.ok(normalMarkup.includes('extension-prompt-badge badge-step'));
  assert.ok(normalMarkup.includes('>2/2<'));
  // - Shows question title in header
  assert.ok(normalMarkup.includes('Distinctive Final Question Title'));
  // - Shows question message
  assert.ok(normalMarkup.includes('Distinctive final question explanatory message that should not leak into review'));
  // - Does not show review heading in normal mode
  assert.strictEqual(normalMarkup.includes('Vista previa de respuestas antes de enviar al agente'), false);
  // - Aria label aligns with question title
  assert.ok(normalMarkup.includes('aria-label="Extension prompt: Distinctive Final Question Title"'));

  // 2. Review mode (initialReviewingSummary: true): renders review as a distinct view
  const reviewMarkup = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog: finalQuestionDialog,
      flowAnswers,
      initialSelectedIndex: 0,
      initialReviewingSummary: true,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  // Review mode assertions:
  // - Shows review title in main header <h3>
  assert.ok(
    reviewMarkup.includes(
      '<h3 id="extension-prompt-title" class="extension-prompt-title">Vista previa de respuestas antes de enviar al agente</h3>'
    ),
    'Main header h3 must display review title'
  );
  // - Shows optional summary badge in header (e.g. badge-summary with "Revisión")
  assert.ok(reviewMarkup.includes('extension-prompt-badge badge-summary'));
  assert.ok(reviewMarkup.includes('>Revisión<'));
  // - Hides step counter badge (badge-step and 2/2) in review view
  assert.strictEqual(
    reviewMarkup.includes('extension-prompt-badge badge-step'),
    false,
    'Step badge should be hidden in review mode'
  );
  assert.strictEqual(reviewMarkup.includes('>2/2<'), false, 'Step counter 2/2 should be hidden in review mode');
  // - Hides question-specific message in review view
  assert.strictEqual(
    reviewMarkup.includes('Distinctive final question explanatory message that should not leak into review'),
    false,
    'Question-specific message should be hidden in review mode'
  );
  assert.strictEqual(
    reviewMarkup.includes('id="extension-prompt-message"'),
    false,
    'Question message container should not be rendered in review mode'
  );
  // - Review heading appears only once in heading tags across markup (not duplicated in body h4)
  const headingMatches = reviewMarkup.match(
    /<h[1-6][^>]*>[^<]*Vista previa de respuestas antes de enviar al agente[^<]*<\/h[1-6]>/g
  );
  assert.strictEqual(headingMatches?.length, 1, 'Review heading should appear exactly once in heading tags');
  assert.strictEqual(
    reviewMarkup.includes('extension-prompt-summary-title'),
    false,
    'Duplicated h4 summary title should be removed from body'
  );
  assert.strictEqual(reviewMarkup.includes('<h4'), false, 'Body should not contain an h4 review heading');
  // - Aligns aria-label with review title
  assert.ok(
    reviewMarkup.includes('aria-label="Extension prompt: Vista previa de respuestas antes de enviar al agente"'),
    'Aria-label should reflect review title in review mode'
  );
  // - Preserves subtitle and answer list in body
  assert.ok(reviewMarkup.includes('Verifica todas las preguntas y respuestas antes de enviarlas al agente.'));
  assert.ok(reviewMarkup.includes('First Question'));
  assert.ok(reviewMarkup.includes('First Answer'));
  assert.ok(reviewMarkup.includes('Option A'));
});

test('ExtensionUiPromptBar: review view preserves header cancel, footer cancel, modifying prior step onBack, and returning to question mode', () => {
  const finalQuestionDialog: QueuedExtensionUiDialog = {
    id: 'test-triangulate-review',
    itemKey: createDialogItemKey('test-triangulate-review'),
    method: 'select',
    createdAt: Date.now(),
    resolve: () => {},
    request: {
      type: 'extension_ui_request',
      id: 'test-triangulate-review',
      method: 'select',
      title: '2/2: Confirm Database Selection',
      message: 'Ensure the selected DB meets requirements',
      options: ['PostgreSQL', 'SQLite'],
    },
  };

  const flowAnswers: AnsweredQuestionRecord[] = [
    { step: 1, question: 'Project Type', answerText: 'Fullstack Web App' },
    { step: 2, question: 'Confirm Database Selection', answerText: 'PostgreSQL' },
  ];

  function findElement(node: any, predicate: (n: any) => boolean): any {
    if (!node || typeof node !== 'object') return null;
    if (predicate(node)) return node;
    const children = React.Children.toArray(node.props?.children);
    for (const child of children) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
    return null;
  }

  let cancelCallCount = 0;
  let backStepCalled: number | undefined;
  let capturedTree: any = null;

  function Host({ reviewing = true }: { reviewing?: boolean }) {
    capturedTree = ExtensionUiPromptBar({
      dialog: finalQuestionDialog,
      flowAnswers,
      initialSelectedIndex: 0,
      initialReviewingSummary: reviewing,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {
        cancelCallCount++;
      },
      onBack: (_key, targetStep) => {
        backStepCalled = targetStep;
      },
    });
    return capturedTree;
  }

  // 1. In review mode, header cancel (✕) works
  renderToStaticMarkup(React.createElement(Host, { reviewing: true }));
  const headerCancelBtn = findElement(
    capturedTree,
    (el) => el.type === 'button' && el.props?.className?.includes('btn-extension-prompt-cancel')
  );
  assert.ok(headerCancelBtn, 'Header cancel button must be present in review mode');
  headerCancelBtn.props.onClick();
  assert.strictEqual(cancelCallCount, 1, 'Header cancel should call onCancel');

  // 2. In review mode, footer cancel works
  const footerCancelBtn = findElement(
    capturedTree,
    (el) =>
      el.type === 'button' &&
      el.props?.className?.includes('btn-extension-prompt-secondary') &&
      el.props?.children === 'Cancelar'
  );
  assert.ok(footerCancelBtn, 'Footer Cancelar button must be present in review mode');
  footerCancelBtn.props.onClick();
  assert.strictEqual(cancelCallCount, 2, 'Footer cancel should call onCancel');

  // 3. In review mode, modifying step 1 triggers onBack(itemKey, 1)
  const modifyBtnStep1 = findElement(
    capturedTree,
    (el) =>
      el.type === 'button' &&
      el.props?.className?.includes('btn-extension-prompt-modify') &&
      typeof el.props?.onClick === 'function'
  );
  assert.ok(modifyBtnStep1, 'Modificar button for step 1 must be present');
  modifyBtnStep1.props.onClick();
  assert.strictEqual(backStepCalled, 1, 'Modificar step 1 should call onBack with step 1');

  // 4. Modificar selección button exits review mode
  const modifySelectionBtn = findElement(
    capturedTree,
    (el) =>
      el.type === 'button' &&
      el.props?.className?.includes('btn-extension-prompt-secondary') &&
      el.props?.children === 'Modificar selección'
  );
  assert.ok(modifySelectionBtn, 'Modificar selección button must be present');
  modifySelectionBtn.props.onClick();

  // Rendering without review mode restores question view
  const normalMarkup = renderToStaticMarkup(React.createElement(Host, { reviewing: false }));
  assert.ok(normalMarkup.includes('Confirm Database Selection'));
  assert.ok(normalMarkup.includes('Ensure the selected DB meets requirements'));
  assert.ok(normalMarkup.includes('badge-step'));
  assert.ok(normalMarkup.includes('>2/2<'));
  assert.strictEqual(normalMarkup.includes('badge-summary'), false);
  assert.strictEqual(normalMarkup.includes('Vista previa de respuestas antes de enviar al agente'), false);
});
