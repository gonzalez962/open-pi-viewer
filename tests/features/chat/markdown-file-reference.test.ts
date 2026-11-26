import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownContent } from '@features/chat/MarkdownContent';
import en from '@shared/locales/en.json';
import es from '@shared/locales/es.json';

const render = (content: string, locale = en) => renderToStaticMarkup(React.createElement(MarkdownContent, { content, t: (key: string) => (locale as Record<string, string>)[key] ?? key }));

const assertPlainInlineCode = (html: string, values: string[]) => {
  for (const value of values) assert.ok(html.includes('<code class="markdown-inline-code">' + value + '</code>'), value);
  assert.doesNotMatch(html, /markdown-file-reference|markdown-file-download-btn|<button/);
};

test('desktop keeps absolute file references and ordinary inline code plain', () => {
  const previous = globalThis.window;
  const previousIsTauri = (globalThis as any).isTauri;
  (globalThis as any).isTauri = true;
  (globalThis as any).window = { isTauri: true, __TAURI_INTERNALS__: { ipc() {} } };
  try {
    for (const locale of [en, es]) {
      const paths = ['/home/a file', 'C:\\Users\\name\\file', '/extensionless', 'inline'];
      const html = render(paths.map(path => "`" + path + "`").join(' '), locale);
      assertPlainInlineCode(html, paths);
    }
  } finally {
    (globalThis as any).window = previous;
    if (previousIsTauri === undefined) delete (globalThis as any).isTauri;
    else (globalThis as any).isTauri = previousIsTauri;
  }
});

test('web keeps project file candidates, routes, URIs and ordinary inline code plain', () => {
  const paths = [
    '/frontend/src/components/menu.ts', 'frontend/src/components/menu.ts', '/frontend/.gitignore', '/frontend/Makefile',
    '/admin/settings', 'https://example.com/file', 'file:///tmp/a', 'inline',
  ];
  const html = render(paths.map(path => "`" + path + "`").join(' '));
  assertPlainInlineCode(html, paths);
});

test('non-paths, link labels and fenced code do not get file actions', () => {
  const content = '`https://example.com/file` `file:///tmp/a` `relative/file` `/` `C:\\` `//server/share` `/tmp/` `x /tmp/a` `/tmp/a + b` `/tmp/a\u0001b` [`/tmp/a`](https://example.com)\n\n```text\n/tmp/file\n```';
  const html = render(content);
  assert.doesNotMatch(html, /markdown-file-download-btn/);
  assert.match(html, /markdown-code-download-btn/);
  assert.match(html, /markdown-code-copy-btn/);
});
