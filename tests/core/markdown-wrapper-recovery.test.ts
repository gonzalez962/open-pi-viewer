import assert from 'node:assert/strict';
import test from 'node:test';
import { extractCodeBlocks, parseMarkdown } from '@core/markdown';

const guide = ['# Guía de Go', '', '## Preparación en Windows', '```powershell', 'go version', '```', '', '## Preparación en Linux', '```bash', 'go version', '```', '', '## Programa', '```go', 'package main', '', 'import "fmt"', '', 'func main() {', '    fmt.Println("hola")', '}', '```'].join('\n');
const trailing = 'Si querés que te deje esto guardado directamente en un archivo `.md` en este directorio (o en otra ruta), avisame y lo creo de una.';
const wrapped = '```markdown\n' + guide + '\n```\n\n' + trailing;

test('S4.1 recovers the complete guide as one extracted download payload and leaves assistant prose outside', () => {
  const ast = parseMarkdown(wrapped);
  assert.deepEqual(ast.children, [
    { type: 'code_block', language: 'markdown', code: guide },
    { type: 'paragraph', children: [
      { type: 'text', value: 'Si querés que te deje esto guardado directamente en un archivo ' },
      { type: 'code_inline', value: '.md' },
      { type: 'text', value: ' en este directorio (o en otra ruta), avisame y lo creo de una.' },
    ] },
  ]);
  assert.deepEqual(extractCodeBlocks(wrapped), [{ language: 'markdown', filename: undefined, code: guide, isDiff: false }]);
});

test('S5.1 standard four-backtick wrapper retains internal fences', () => {
  const input = '````markdown\n' + guide + '\n````\n\nDespués.';
  assert.deepEqual(parseMarkdown(input).children, [
    { type: 'code_block', language: 'markdown', code: guide },
    { type: 'paragraph', children: [{ type: 'text', value: 'Después.' }] },
  ]);
});

test('S5.1 separate root blocks and prose keep their standard interpretation', () => {
  const input = '```markdown\n# Notas\n```\n\nProsa intermedia.\n\n```go\npackage main\n```\n\nFinal.';
  assert.deepEqual(parseMarkdown(input).children, [
    { type: 'code_block', language: 'markdown', code: '# Notas' },
    { type: 'paragraph', children: [{ type: 'text', value: 'Prosa intermedia.' }] },
    { type: 'code_block', language: 'go', code: 'package main' },
    { type: 'paragraph', children: [{ type: 'text', value: 'Final.' }] },
  ]);
});

test('S5.1 incomplete ambiguous wrapper without adjacent closes retains standard interpretation', () => {
  const input = '```markdown\n# Guía\n```bash\ngo version\n```\n\nTexto final.';
  assert.deepEqual(parseMarkdown(input).children, [
    { type: 'code_block', language: 'markdown', code: '# Guía\n```bash\ngo version' },
    { type: 'paragraph', children: [{ type: 'text', value: 'Texto final.' }] },
  ]);
});
