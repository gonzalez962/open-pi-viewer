import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareAttachments, getTransferFiles } from '@features/chat/file-attachments';

const model = (input: string[]) => ({ id: 'test', provider: 'test', input });
const file = (name: string, type: string, content = 'hello') => new File([content], name, { type });

test('drop files are filtered by model capabilities before reading', async () => {
  const result = await prepareAttachments([file('photo.png', 'image/png'), file('clip.mp4', 'video/mp4'), file('note.txt', 'text/plain')], model(['text', 'image']));
  assert.deepEqual(result.files.map(f => f.type), ['image', 'text']);
  assert.deepEqual(result.rejected, ['clip.mp4']);
  assert.equal(result.files[0].data, Buffer.from('hello').toString('base64'));
  assert.equal(result.files[1].content, 'hello');
});

test('paste retrieves clipboard file items when files list is empty, without treating text as a file', () => {
  const image = file('paste.png', 'image/png');
  assert.deepEqual(getTransferFiles({ files: [], items: [{ kind: 'string', getAsFile: () => null }, { kind: 'file', getAsFile: () => image }] } as any), [image]);
  assert.deepEqual(getTransferFiles({ files: [], items: [{ kind: 'string', getAsFile: () => null }] } as any), []);
  assert.deepEqual(getTransferFiles({ files: [image], items: [{ kind: 'file', getAsFile: () => image }] } as any), [image]);
});

test('picker processing preserves text and media encoding and rejects unsupported binary files', async () => {
  const inputs = [file('source.ts', '', 'const x = 1;'), file('audio.mp3', ''), file('video.mp4', ''), file('document.pdf', 'application/pdf', '\0binary')];
  const result = await prepareAttachments(inputs, model(['text', 'audio', 'video']));
  assert.deepEqual(result.files.map(f => f.type), ['text', 'audio', 'video']);
  assert.equal(result.files[0].content, 'const x = 1;');
  assert.deepEqual(result.rejected, ['document.pdf']);
  const binary = await prepareAttachments([inputs[3]], model(['file']));
  assert.equal(binary.files[0].type, 'file');
  assert.equal(binary.files[0].data, Buffer.from('\0binary').toString('base64'));
});

test('unknown models reject files and text-only models accept documents but not images', async () => {
  const inputs = [file('note.txt', 'text/plain'), file('photo.png', 'image/png')];
  assert.deepEqual((await prepareAttachments(inputs, null)).rejected, ['note.txt', 'photo.png']);
  assert.deepEqual((await prepareAttachments(inputs, model(['text']))).files.map(f => f.name), ['note.txt']);
});
