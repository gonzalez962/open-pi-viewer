import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PendingAttachments } from '@features/chat/components/PendingAttachments';
import { AttachmentPreviewModal } from '@features/chat/components/AttachmentPreviewModal';
import { getAttachmentPreviewSrc } from '@features/chat/file-attachments';
import type { AttachedFile } from '@features/chat/types';

const attachment = (type: AttachedFile['type'], mimeType: string): AttachedFile => ({ id: type, name: `${type}.dat`, size: 3, type, mimeType, data: 'YWJj' });
const t = (key: any) => key;

test('media preview sources use the existing image policy and reject malformed data', () => {
  assert.equal(getAttachmentPreviewSrc(attachment('image', 'image/png')), 'data:image/png;base64,YWJj');
  assert.equal(getAttachmentPreviewSrc(attachment('video', 'video/mp4')), 'data:video/mp4;base64,YWJj');
  assert.equal(getAttachmentPreviewSrc(attachment('audio', 'audio/mpeg')), 'data:audio/mpeg;base64,YWJj');
  assert.equal(getAttachmentPreviewSrc(attachment('image', 'image/svg+xml')), 'data:image/svg+xml;base64,YWJj');
  assert.equal(getAttachmentPreviewSrc({ ...attachment('audio', 'audio/mpeg'), data: 'invalid!' }), null);
  assert.equal(getAttachmentPreviewSrc(attachment('file', 'application/pdf')), null);
});

test('pending media have separate preview and remove buttons; other files only remove', () => {
  const files = [attachment('image', 'image/png'), attachment('video', 'video/mp4'), attachment('audio', 'audio/mpeg'), attachment('file', 'application/pdf')];
  const html = renderToStaticMarkup(React.createElement(PendingAttachments, { files, onRemove: () => {}, t, draftKey: 'draft' }));
  assert.equal((html.match(/class="attachment-preview-trigger"/g) ?? []).length, 3);
  assert.equal((html.match(/class="btn-remove-attachment"/g) ?? []).length, 4);
});

test('prepared workspace text joins gallery and renders escaped numbered lines', async () => {
  const { prepareAttachments } = await import('@features/chat/file-attachments');
  const result = await prepareAttachments([new File(['<b>hello</b>\nworld'], '.config', { type: 'application/octet-stream' }), new File([new Uint8Array([0xff])], 'bad.txt'), new File([''], 'empty')], { id: 'test', provider: 'test', input: ['text', 'file'] });
  const html = renderToStaticMarkup(React.createElement(PendingAttachments, { files: result.files, onRemove: () => {}, t, draftKey: 'draft' }));
  assert.equal((html.match(/class="attachment-preview-trigger"/g) ?? []).length, 2);
  const modal = renderToStaticMarkup(React.createElement(AttachmentPreviewModal, { file: result.files[0], onClose: () => {}, t }));
  assert.match(modal, /&lt;b&gt;hello&lt;\/b&gt;/);
  assert.match(modal, /world/);
});

test('text eligibility checks bytes, names and size without changing outgoing fields', async () => {
  const { prepareAttachments, getAttachmentPreviewText } = await import('@features/chat/file-attachments');
  const limit = 2 * 1024 * 1024;
  const inputs = [new File(['ok'], 'README', { type: 'application/octet-stream' }), new File([''], '.empty'), new File(['ok'], 'document.pdf'), new File([new Uint8Array([0])], 'nul'), new File([new Uint8Array([127])], 'control'), new File([new Uint8Array([255])], 'invalid'), new File(['a'.repeat(limit)], 'limit'), new File(['a'.repeat(limit + 1)], 'large')];
  const { files } = await prepareAttachments(inputs, { id: 'test', provider: 'test', input: ['text', 'file'] });
  assert.deepEqual(files.map(f => getAttachmentPreviewText(f) !== null), [true, true, false, false, false, false, true, false]);
  assert.equal(files[0].type, 'file');
  assert.equal(files[0].data, 'b2s=');
  assert.equal(files[1].content, '');
  assert.equal(files[7].content?.length, limit + 1);
});

test('gallery renders position and boundary navigation controls', () => {
  const file = attachment('image', 'image/png');
  const render = (index: number) => renderToStaticMarkup(React.createElement(AttachmentPreviewModal, { file, onClose: () => {}, t, index, count: 3, onNavigate: () => {} } as any));
  const first = render(0);
  assert.match(first, /1 \/ 3/);
  assert.match(first, /aria-label="attachment_preview.previous" disabled=""/);
  assert.match(first, /aria-label="attachment_preview.next"/);
  const last = render(2);
  assert.match(last, /3 \/ 3/);
  assert.match(last, /aria-label="attachment_preview.next" disabled=""/);
});

test('preview dialog uses native media controls without autoplay', () => {
  for (const type of ['audio', 'video'] as const) {
    const file = attachment(type, `${type}/${type === 'audio' ? 'mpeg' : 'mp4'}`);
    const html = renderToStaticMarkup(React.createElement(AttachmentPreviewModal, { file, onClose: () => {}, t }));
    assert.match(html, new RegExp(`<${type}[^>]*controls`));
    assert.doesNotMatch(html, /autoplay/i);
    assert.match(html, /role="dialog"/);
  }
});
