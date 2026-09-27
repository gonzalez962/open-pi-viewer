import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const SRC_DIR = join(process.cwd(), 'src');

test('theme palettes define the elevated surface and hover aliases', () => {
  const tokens = readFileSync(join(SRC_DIR, 'shared/styles/tokens.css'), 'utf8');
  for (const theme of ['dark', 'light']) {
    const block = tokens.split(`[data-theme="${theme}"]`)[1]?.split('}')[0] ?? '';
    assert.match(block, /--bg-surface-elevated:\s*var\(--bg-elevated\)/, theme);
    assert.match(block, /--bg-hover:\s*var\(--bg-subtle-hover\)/, theme);
  }
});
