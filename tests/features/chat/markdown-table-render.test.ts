import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownContent } from '@features/chat/MarkdownContent';

const dummyT = (key: string) => key;

test('MarkdownContent: formatted plain URL does not produce duplicate copy buttons', () => {
  const html = renderToStaticMarkup(
    React.createElement(MarkdownContent, {
      content: '[https://example.com](https://example.com)',
      t: dummyT,
    })
  );

  // Match all occurrences of copy button class
  const matches = html.match(/markdown-link-copy-btn/g) || [];
  assert.equal(matches.length, 1, 'must contain exactly 1 copy button, not duplicated');

  const htmlBare = renderToStaticMarkup(
    React.createElement(MarkdownContent, {
      content: 'https://example.com',
      t: dummyT,
    })
  );
  const bareMatches = htmlBare.match(/markdown-link-copy-btn/g) || [];
  assert.equal(bareMatches.length, 1, 'bare URL must contain exactly 1 copy button');
});

test('MarkdownContent: renders GFM table with wrapper, header, alignments, and rows', () => {
  const tableMd = `
| Feature | Status | Notes |
| :--- | :---: | ---: |
| Autolinks | Ready | In \`markdown.ts\` |
| Tables | Active | **Full** support |
`;

  const html = renderToStaticMarkup(
    React.createElement(MarkdownContent, {
      content: tableMd,
      t: dummyT,
    })
  );

  assert.ok(html.includes('markdown-table-wrapper'));
  assert.ok(html.includes('markdown-table'));
  assert.ok(html.includes('markdown-thead'));
  assert.ok(html.includes('markdown-th'));
  assert.ok(html.includes('text-align:left'));
  assert.ok(html.includes('text-align:center'));
  assert.ok(html.includes('text-align:right'));
  assert.ok(html.includes('Feature'));
  assert.ok(html.includes('Status'));
  assert.ok(html.includes('Notes'));
  assert.ok(html.includes('Autolinks'));
  assert.ok(html.includes('Ready'));
  assert.ok(html.includes('markdown-inline-code'));
  assert.ok(html.includes('markdown.ts'));
  assert.ok(html.includes('<strong>Full</strong>'));
});
