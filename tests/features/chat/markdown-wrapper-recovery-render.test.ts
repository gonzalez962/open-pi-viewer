import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownContent } from '@features/chat/MarkdownContent';

const render = (content: string) => renderToStaticMarkup(React.createElement(MarkdownContent, {
  content, t: (key: string) => key, onInsertCode: () => {}, workingDirectory: '/workspace',
}));

const guide = ['# Guía de Go', '', '## Preparación en Windows', '```powershell', 'go version', '```', '', '## Preparación en Linux', '```bash', 'go version', '```', '', '## Programa', '```go', 'package main', '', 'import "fmt"', '', 'func main() {', '    fmt.Println("hola")', '}', '```'].join('\n');
const trailing = 'Si querés que te deje esto guardado directamente en un archivo `.md` en este directorio (o en otra ruta), avisame y lo creo de una.';

test('S4.1 renders one downloadable guide card followed by the assistant paragraph', () => {
  const html = render('```markdown\n' + guide + '\n```\n\n' + trailing);
  assert.equal((html.match(/class="markdown-code-block"/g) ?? []).length, 1);
  assert.equal((html.match(/markdown-code-download-btn/g) ?? []).length, 1);
  assert.match(html, /markdown-code-language">markdown<\/span>/);
  assert.match(html, /```powershell/);
  assert.match(html, /```bash/);
  assert.match(html, /```go/);
  assert.match(html, /<p class="markdown-paragraph">Si querés que te deje esto guardado directamente en un archivo <code class="markdown-inline-code">\.md<\/code> en este directorio \(o en otra ruta\), avisame y lo creo de una\.<\/p>/);
});
