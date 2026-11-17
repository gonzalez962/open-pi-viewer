import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownContent } from '@features/chat/MarkdownContent';
import en from '@shared/locales/en.json';
import es from '@shared/locales/es.json';

const render = (content: string, locale = en) => renderToStaticMarkup(React.createElement(MarkdownContent, { content, t: (key: string) => (locale as Record<string, string>)[key] ?? key }));

test('S2.1 native inline file references retain localized icon actions without a web request', () => {
  const previous = globalThis.window;
  let requests = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { requests++; throw new Error('unexpected web request'); };
  (globalThis as any).window = { __TAURI_INTERNALS__: { ipc() {} } };
  try {
  for (const locale of [en, es]) {
    const html = render('`/home/a file` `C:\\Users\\name\\file` `/extensionless`', locale);
    assert.equal((html.match(/markdown-file-download-btn/g) ?? []).length, 3);
    assert.match(html, /\/home\/a file/);
    assert.match(html, /C:\\Users\\name\\file/);
    assert.match(html, new RegExp(`aria-label="${locale['markdown.download_file_aria']}"`));
    const icons = [...html.matchAll(/<svg\b[^>]*aria-hidden="true"[^>]*stroke="currentColor"[^>]*>(.*?)<\/svg>/g)];
    assert.equal(icons.length, 3);
    for (const icon of icons) assert.equal((icon[1].match(/<path\b/g) ?? []).length, 3);
    assert.doesNotMatch(html, /<button[^>]*>[^<]+/);
  }
  assert.equal(requests, 0);
  } finally {
    (globalThis as any).window = previous;
    globalThis.fetch = previousFetch;
  }
});

test('S1.4 web references retain text without an action before availability confirmation', () => {
  const html = render('`/tmp/pending-file`');
  assert.match(html, /\/tmp\/pending-file/);
  assert.doesNotMatch(html, /markdown-file-download-btn/);
});

test('non-paths, link labels and fenced code do not get file actions', () => {
  const content = '`https://example.com/file` `file:///tmp/a` `relative/file` `/` `C:\\` `//server/share` `/tmp/` `x /tmp/a` `/tmp/a + b` `/tmp/a\u0001b` [`/tmp/a`](https://example.com)\n\n```text\n/tmp/file\n```';
  const html = render(content);
  assert.doesNotMatch(html, /markdown-file-download-btn/);
  assert.match(html, /markdown-code-download-btn/);
  assert.match(html, /markdown-code-copy-btn/);
});
