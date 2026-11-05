import test from 'node:test';
import assert from 'node:assert/strict';
import type { SaveWorkspaceFilePayload, WorkspaceFileContent } from '@core/types/workspace';
import { createFileEditor } from '@features/workspace/file-editor-state';

// Proposed controller contract: the viewer owns this controller and renders its
// snapshot; the injected save function is the public workspace save bridge.
const file: WorkspaceFileContent = {
  relativePath: 'src/example.txt', name: 'example.txt', content: 'before\n',
  size: 7, isBinary: false, kind: 'text',
};
const workingDirectory = '/isolated/workspace';

function setup(content = file.content, save: (payload: SaveWorkspaceFilePayload) => Promise<void> = async () => {}) {
  return createFileEditor({ file: { ...file, content }, workingDirectory, save });
}

test('S2.1 edit and explicit save sends the draft and original, then updates displayed content', async () => {
  const calls: SaveWorkspaceFilePayload[] = [];
  const editor = setup('before\n', async payload => { calls.push(payload); });
  assert.equal(editor.snapshot().editing, false);
  editor.edit();
  editor.setDraft('after Ω\n');
  assert.equal(calls.length, 0, 'editing must not autosave');
  await editor.save();
  assert.deepEqual(calls, [{ workingDirectory, relativePath: file.relativePath, originalContent: 'before\n', content: 'after Ω\n' }]);
  assert.equal(editor.snapshot().content, 'after Ω\n');
  assert.equal(editor.snapshot().dirty, false);
});

test('S2.2 rejected close and cancel confirmations retain the draft', () => {
  for (const action of ['close', 'cancel'] as const) {
    const editor = setup();
    editor.edit();
    editor.setDraft('unsaved');
    let confirmations = 0;
    assert.equal(editor[action](() => { confirmations++; return false; }), false);
    assert.equal(confirmations, 1);
    assert.equal(editor.snapshot().editing, true);
    assert.equal(editor.snapshot().draft, 'unsaved');
    assert.equal(editor.snapshot().content, 'before\n');
    assert.equal(editor.snapshot().dirty, true);
  }
});

test('S2.2 failed save retains the draft and exposes the error', async () => {
  const calls: SaveWorkspaceFilePayload[] = [];
  const editor = setup('before\n', async payload => { calls.push(payload); throw new Error('conflict'); });
  editor.edit();
  editor.setDraft('unsaved');
  await editor.save();
  assert.deepEqual(calls, [{ workingDirectory, relativePath: file.relativePath, originalContent: 'before\n', content: 'unsaved' }]);
  assert.equal(editor.snapshot().draft, 'unsaved');
  assert.equal(editor.snapshot().content, 'before\n');
  assert.equal(editor.snapshot().dirty, true);
  assert.equal(editor.snapshot().editing, true);
  assert.match(String(editor.snapshot().error), /conflict/);
});

test('S2.3 edits made during a save remain dirty and use the saved revision on the next save', async () => {
  const calls: SaveWorkspaceFilePayload[] = [];
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const editor = setup('before\n', async payload => { calls.push(payload); if (calls.length === 1) await pending; });
  editor.edit();
  editor.setDraft('first');
  const saving = editor.save();
  editor.setDraft('second');
  finish();
  await saving;
  assert.equal(editor.snapshot().content, 'first');
  assert.equal(editor.snapshot().draft, 'second');
  assert.equal(editor.snapshot().dirty, true);
  assert.equal(editor.snapshot().editing, true);
  await editor.save();
  assert.deepEqual(calls, [
    { workingDirectory, relativePath: file.relativePath, originalContent: 'before\n', content: 'first' },
    { workingDirectory, relativePath: file.relativePath, originalContent: 'first', content: 'second' },
  ]);
  assert.equal(editor.snapshot().content, 'second');
  assert.equal(editor.snapshot().dirty, false);
});

test('S2.4 textarea-normalized CRLF saves with CRLF and no final newline', async () => {
  const calls: SaveWorkspaceFilePayload[] = [];
  const editor = setup('one\r\ntwo', async payload => { calls.push(payload); });
  editor.edit();
  editor.setDraft('one\nchanged\nthree');
  await editor.save();
  assert.deepEqual(calls, [{ workingDirectory, relativePath: file.relativePath, originalContent: 'one\r\ntwo', content: 'one\r\nchanged\r\nthree' }]);
  assert.equal(editor.snapshot().content, 'one\r\nchanged\r\nthree');
  assert.equal(editor.snapshot().dirty, false);
});
