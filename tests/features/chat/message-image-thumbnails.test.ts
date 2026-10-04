import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ImageContent } from '@core/types/messages';
import { MessageImageThumbnails } from '@features/chat/components/MessageImageThumbnails';

test('MessageImageThumbnails: returns null when images array is empty or undefined', () => {
  const markupEmpty = renderToStaticMarkup(
    React.createElement(MessageImageThumbnails, { images: [] })
  );
  assert.strictEqual(markupEmpty, '');

  const markupUndefined = renderToStaticMarkup(
    React.createElement(MessageImageThumbnails, { images: undefined as unknown as ImageContent[] })
  );
  assert.strictEqual(markupUndefined, '');
});

test('MessageImageThumbnails: renders accessible container and responsive thumbnails', () => {
  const images: ImageContent[] = [
    {
      type: 'image',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      mimeType: 'image/png',
    },
    {
      type: 'image',
      data: '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
      mimeType: 'image/jpeg',
    },
  ];

  const markup = renderToStaticMarkup(
    React.createElement(MessageImageThumbnails, { images })
  );

  assert.ok(markup.includes('message-image-thumbnails'));
  assert.ok(markup.includes('role="group"'));
  assert.ok(markup.includes('aria-label="Attached images"'));
  assert.ok(markup.includes('src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="'));
  assert.ok(markup.includes('src="data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA="'));
  assert.ok(markup.includes('alt="Attached image 1"'));
  assert.ok(markup.includes('alt="Attached image 2"'));
  assert.ok(markup.includes('loading="lazy"'));
});

test('MessageImageThumbnails: avoids double-prefixing when data already has data: prefix', () => {
  const images: ImageContent[] = [
    {
      type: 'image',
      data: 'data:image/webp;base64,UklGRkAAAABXRUJQVlA4IDQAAADwAQCdASoBAAEAAQAcJaACdLoAAP7/2AAA',
      mimeType: 'image/webp',
    },
  ];

  const markup = renderToStaticMarkup(
    React.createElement(MessageImageThumbnails, { images })
  );

  assert.ok(markup.includes('src="data:image/webp;base64,UklGRkAAAABXRUJQVlA4IDQAAADwAQCdASoBAAEAAQAcJaACdLoAAP7/2AAA"'));
  assert.ok(!markup.includes('data:image/webp;base64,data:image/webp;base64,'));
});

test('MessageImageThumbnails: skips malformed preview data without rendering broken placeholder tags', () => {
  const validPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const images: ImageContent[] = [
    // Malformed: data:text/html prefix
    { type: 'image', data: `data:text/html;base64,${validPng}`, mimeType: 'image/png' },
    // Malformed: invalid base64 string
    { type: 'image', data: 'not valid base64!@#$', mimeType: 'image/png' },
    // Valid image
    { type: 'image', data: validPng, mimeType: 'image/png' },
  ];

  const markup = renderToStaticMarkup(
    React.createElement(MessageImageThumbnails, { images })
  );

  // Must only render 1 valid image thumbnail, skipping the 2 malformed ones without placeholders
  assert.ok(markup.includes('src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="'));
  assert.ok(!markup.includes('text/html'));
  assert.ok(!markup.includes('not valid'));
  const imgCount = (markup.match(/<img /g) || []).length;
  assert.strictEqual(imgCount, 1);
});
