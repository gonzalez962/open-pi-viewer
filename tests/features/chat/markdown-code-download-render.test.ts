import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownContent } from '@features/chat/MarkdownContent';

const t = (key: string) => key;
test('each block has download outside code; copy and non-diff insert remain', () => {
  const content = 'prose\n\n```python\nprint(1)\n```\n\n```diff\n+line\n```';
  const html = renderToStaticMarkup(React.createElement(MarkdownContent, { content, t, onInsertCode: () => {} }));
  assert.equal((html.match(/markdown-code-download-btn/g) ?? []).length, 2);
  assert.equal((html.match(/markdown-code-copy-btn/g) ?? []).length, 2);
  assert.equal((html.match(/markdown-code-insert-btn/g) ?? []).length, 1);
  for (const block of html.split('<div class="markdown-code-block">').slice(1)) {
    assert.ok(block.indexOf('markdown-code-download-btn') < block.indexOf('<pre'));
  }
  assert.match(html, /pi-diff-line-add/);
});

test('code pre wraps whitespace and unbroken tokens', () => {
  const css = readFileSync('src/features/chat/chat.css', 'utf8');
  const rule = css.match(/\.markdown-code-pre\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(rule, /white-space:\s*pre-wrap/);
  assert.match(rule, /overflow-wrap:\s*anywhere/);
});
