import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownContent } from '@features/chat/MarkdownContent';

const render = (content: string) => renderToStaticMarkup(React.createElement(MarkdownContent, {
  content, t: (key: string) => key, onInsertCode: () => {}, workingDirectory: '/workspace',
}));

const reported = 'Listo, el archivo fue creado:\n\n- **Archivo:** `test.md`\n- **Ruta absoluta:** `C:/projects/example/test.md`\n- **Contenido:**\n  ```text\n  hola\n  ```';

test('S1.1 reported list renders its code card without empty inline code', () => {
  const html = render(reported);
  assert.match(html, /Listo, el archivo fue creado:/);
  assert.match(html, /<strong>Archivo:<\/strong> <code class="markdown-inline-code">test\.md<\/code>/);
  assert.match(html, /<strong>Ruta absoluta:<\/strong>.*C:\/projects\/example\/test\.md/);
  assert.match(html, /markdown-file-download-btn/);
  assert.match(html, /<li class="markdown-li"><strong>Contenido:<\/strong>[\s\S]*markdown-code-block[\s\S]*markdown-code-language">text<\/span>[\s\S]*hola[\s\S]*<\/li>/);
  assert.doesNotMatch(html, /<code class="markdown-inline-code"><\/code>/);
  assert.match(html, /markdown-code-copy-btn/);
  assert.match(html, /markdown-code-download-btn/);
  assert.match(html, /markdown-code-insert-btn/);
});

test('S2.1 ordered and nested list fences stay inside their items before following siblings', () => {
  const html = render('1. Parent\n   - Child\n     ```text\n     first\n       indented\n     ```\n   - Next child\n2. Next parent');
  assert.match(html, /<ol class="markdown-ol" start="1">/);
  assert.match(html, /<li class="markdown-li">Parent<ul class="markdown-ul"><li class="markdown-li">Child[\s\S]*markdown-code-block[\s\S]*first[\s\S]*  indented[\s\S]*<\/li><li class="markdown-li">Next child<\/li><\/ul><\/li><li class="markdown-li">Next parent<\/li>/);
  assert.doesNotMatch(html, /<code class="markdown-inline-code"><\/code>/);
});

test('S2.2 unclosed streaming list fence renders a code card', () => {
  const html = render('- Streaming\n  ```text\n  first\n    indented');
  assert.match(html, /<li class="markdown-li">Streaming[\s\S]*markdown-code-block[\s\S]*markdown-code-language">text<\/span>[\s\S]*first[\s\S]*  indented[\s\S]*<\/li>/);
  assert.doesNotMatch(html, /<code class="markdown-inline-code"><\/code>/);
});

test('S3.1 ordinary inline and root fence rendering keeps controls', () => {
  const html = render('- Item `inline`\n- Next\n\n```text\nroot\n```');
  assert.match(html, /<li class="markdown-li">Item <code class="markdown-inline-code">inline<\/code><\/li><li class="markdown-li">Next<\/li>/);
  assert.match(html, /markdown-code-language">text<\/span>/);
  assert.match(html, /markdown-code-copy-btn/);
  assert.match(html, /markdown-code-download-btn/);
  assert.match(html, /markdown-code-insert-btn/);
  assert.match(html, />root<\/span>/);
});
