import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { FileViewerModal } from '@features/workspace/FileViewerModal';
import type { WorkspaceFileContent } from '@core/types/workspace';

test('FileViewerModal: renders image with img tag, never inline SVG/object/iframe, and hides wrap/copy/diff', () => {
  const imageFile: WorkspaceFileContent = {
    relativePath: 'assets/logo.png',
    name: 'logo.png',
    content: '',
    size: 2048,
    isBinary: true,
    kind: 'image',
    mimeType: 'image/png',
    mediaDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    extension: 'png',
  };

  const html = renderToStaticMarkup(
    React.createElement(FileViewerModal, {
      file: imageFile,
      onClose: () => {},
      locale: 'en',
    })
  );

  // 1. Must use <img tag
  assert.ok(html.includes('<img'), 'Image file preview must render an <img> tag');
  assert.ok(html.includes('src="data:image/png;base64,'), '<img> must have data URL src');
  assert.ok(html.includes('alt="logo.png"'), '<img> must have proper alt text');

  // 2. Must NEVER use inline SVG, object, or iframe for image preview
  assert.ok(!html.includes('<object'), 'Must never render <object> tag for media preview');
  assert.ok(!html.includes('<iframe'), 'Must never render <iframe> tag for media preview');

  // 3. Media controls must NOT expose text wrap, copy, or diff tabs
  assert.ok(!html.includes('btn-file-toggle-wrap'), 'Must not render wrap button for media');
  assert.ok(!html.includes('btn-file-copy'), 'Must not render copy button for media');
  assert.ok(!html.includes('file-viewer-tabs'), 'Must not render diff/content tabs for media');
  assert.ok(!html.includes('file-viewer-code'), 'Must not render code block for media');
});

test('FileViewerModal: renders video with controls and fallback text, no autoplay, and hides wrap/copy/diff', () => {
  const videoFile: WorkspaceFileContent = {
    relativePath: 'assets/demo.mp4',
    name: 'demo.mp4',
    content: '',
    size: 1048576,
    isBinary: true,
    kind: 'video',
    mimeType: 'video/mp4',
    mediaDataUrl: 'data:video/mp4;base64,AAAAHGZ0eXBtcDQyAAAAAG1wNDJpc29t',
    extension: 'mp4',
  };

  const html = renderToStaticMarkup(
    React.createElement(FileViewerModal, {
      file: videoFile,
      onClose: () => {},
      locale: 'en',
    })
  );

  // 1. Must render <video> with controls attribute
  assert.ok(html.includes('<video'), 'Must render <video> tag');
  assert.ok(html.includes('controls'), '<video> tag must include controls attribute');

  // 2. Must NOT include autoplay
  assert.ok(!html.includes('autoplay'), '<video> must not have autoplay attribute');

  // 3. Must render <source> with type and media data URL
  assert.ok(html.includes('<source'), '<video> must contain <source> tag');
  assert.ok(html.includes('type="video/mp4"'), '<source> must specify video/mp4 MIME type');

  // 4. Media controls must NOT expose text wrap, copy, or diff tabs
  assert.ok(!html.includes('btn-file-toggle-wrap'), 'Must not render wrap button for video');
  assert.ok(!html.includes('btn-file-copy'), 'Must not render copy button for video');
  assert.ok(!html.includes('file-viewer-tabs'), 'Must not render diff/content tabs for video');
  assert.ok(!html.includes('file-viewer-code'), 'Must not render code block for video');
});

test('FileViewerModal: non-code binary renders explanatory notice, never code, copy, or diff tabs', () => {
  const binaryFile: WorkspaceFileContent = {
    relativePath: 'libcrypto.so.1',
    name: 'libcrypto.so.1',
    content: '',
    size: 4096,
    isBinary: true,
    kind: 'binary',
    extension: '1',
  };

  const html = renderToStaticMarkup(
    React.createElement(FileViewerModal, {
      file: binaryFile,
      onClose: () => {},
      locale: 'en',
    })
  );

  // 1. Must render binary notice
  assert.ok(html.includes('file-viewer-binary'), 'Must render binary notice container');
  assert.ok(html.includes('binary-notice-title'), 'Must render binary notice title');
  assert.ok(html.includes('binary-notice-desc'), 'Must render binary notice description');

  // 2. Must never render code, wrap, copy, or diff
  assert.ok(!html.includes('file-viewer-code'), 'Must not render code block for binary');
  assert.ok(!html.includes('file-viewer-tabs'), 'Must not render tabs for binary');
  assert.ok(!html.includes('btn-file-copy'), 'Must not render copy button for binary');
  assert.ok(!html.includes('btn-file-toggle-wrap'), 'Must not render wrap button for binary');
});
