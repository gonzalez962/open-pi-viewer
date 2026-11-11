import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCopyAllCodeText, extractCodeBlocks, parseMarkdown } from '@core/markdown';

test('S2.1 nested list fences are extracted in document order with indentation', () => {
  const markdown = '```text\nroot before\n```\n\n1. Parent\n   - Child\n     ```text\n     first\n       indented\n     ```\n   - Next child\n2. Next parent\n\n```text\nroot after\n```';
  const blocks = extractCodeBlocks(markdown);
  assert.deepEqual(blocks.map(({ language, code }) => ({ language, code })), [
    { language: 'text', code: 'root before' },
    { language: 'text', code: 'first\n  indented' },
    { language: 'text', code: 'root after' },
  ]);
  assert.equal(buildCopyAllCodeText(blocks), 'root before\n\nfirst\n  indented\n\nroot after');
});

test('S2.3 ordinary list inline code and root fences retain parser output', () => {
  const ast = parseMarkdown('- Item `inline`\n- Next\n\n```text\nroot\n```');
  const list = ast.children[0];
  assert.equal(list.type, 'list');
  if (list.type !== 'list') return;
  assert.deepEqual(list.items.map(item => item.children), [
    [{ type: 'text', value: 'Item ' }, { type: 'code_inline', value: 'inline' }],
    [{ type: 'text', value: 'Next' }],
  ]);
  assert.deepEqual(ast.children[1], { type: 'code_block', language: 'text', code: 'root' });
});
