import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const SRC_DIR = join(process.cwd(), 'src');

function listCssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listCssFiles(path);
    return entry.name.endsWith('.css') ? [path] : [];
  });
}

test('theme palettes define the elevated surface and hover aliases', () => {
  const tokens = readFileSync(join(SRC_DIR, 'shared/styles/tokens.css'), 'utf8');
  for (const theme of ['dark', 'light']) {
    const block = tokens.split(`[data-theme="${theme}"]`)[1]?.split('}')[0] ?? '';
    assert.match(block, /--bg-surface-elevated:\s*var\(--bg-elevated\)/, theme);
    assert.match(block, /--bg-hover:\s*var\(--bg-subtle-hover\)/, theme);
  }
});

test('every var() without a fallback references a defined custom property', () => {
  const cssFiles = listCssFiles(SRC_DIR).map((path) => ({
    path,
    css: readFileSync(path, 'utf8'),
  }));
  const defined = new Set(
    cssFiles.flatMap(({ css }) => [...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]))
  );
  const undefinedRefs = cssFiles.flatMap(({ path, css }) =>
    [...css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)]
      .filter((m) => !defined.has(m[1]))
      .map((m) => `${path.slice(SRC_DIR.length + 1)}: ${m[1]}`)
  );
  assert.deepEqual([...new Set(undefinedRefs)], []);
});
