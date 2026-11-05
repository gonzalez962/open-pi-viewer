import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownContent } from '@features/chat/MarkdownContent';

const dummyT = (key: string) => key;

function renderMarkdown(content: string): string {
  return renderToStaticMarkup(React.createElement(MarkdownContent, { content, t: dummyT }));
}

test('S2.1: list continuation remains visible after its item', () => {
  const html = renderMarkdown('- Primera\n  detalle importante');
  assert.match(html, /Primera[\s\S]*detalle importante/);
});

test('S2.1: nested list continuation remains visible in order', () => {
  const html = renderMarkdown('- Padre\n  - Hijo\n    detalle anidado\n  - Otro');
  assert.match(html, /Padre[\s\S]*Hijo[\s\S]*detalle anidado[\s\S]*Otro/);
});

test('S2.2: intraword underscores remain literal alongside emphasis and code', () => {
  const html = renderMarkdown('archivo_con_nombre *énfasis* `codigo_con_guiones`');
  assert.ok(html.includes('archivo_con_nombre'));
  assert.ok(html.includes('<em>énfasis</em>'));
  assert.match(html, /<code[^>]*>codigo_con_guiones<\/code>/);
});

test('S2 preservation: supported list and inline formatting still renders', () => {
  const html = renderMarkdown('- **Padre**\n  - _Hijo_ y `código`\n- Otro');
  assert.match(html, /<strong>Padre<\/strong>[\s\S]*<em>Hijo<\/em>[\s\S]*<code[^>]*>código<\/code>[\s\S]*Otro/);
  assert.equal((html.match(/<ul/g) || []).length, 2);
});

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
