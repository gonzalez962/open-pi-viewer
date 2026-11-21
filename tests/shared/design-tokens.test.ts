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

function requiresInlineProperty(css: string, referenceIndex: number, property: string): boolean {
  const blockStart = css.lastIndexOf('{', referenceIndex);
  if (blockStart < 0) return false;
  const selectorStart = Math.max(css.lastIndexOf('}', blockStart), css.lastIndexOf('{', blockStart - 1)) + 1;
  const selector = css.slice(selectorStart, blockStart).trim();
  // A single selector can require the property on the element (or its pseudo-element).
  // Match the declaration, not just a substring of another custom property's name.
  const guard = `[style*="${property}:"]`;
  const guardIndex = selector.indexOf(guard);
  return guardIndex >= 0
    && /^(?:[.#][\w-]+)+$/.test(selector.slice(0, guardIndex))
    && /^(?:::[\w-]+)?$/.test(selector.slice(guardIndex + guard.length));
}

test('inline properties must be required on the same element', () => {
  const guard = '[style*="--dynamic:"]';
  for (const [selector, expected] of [
    [`.row${guard}::after`, true],
    ['.row', false],
    [`.row${guard}, .other`, false],
    [`.row${guard} .child`, false],
    ['.row[style*="--dynamic-other:"]', false],
  ] as const) {
    const css = `${selector} { color: var(--dynamic); }`;
    assert.equal(requiresInlineProperty(css, css.indexOf('var('), '--dynamic'), expected, selector);
  }
});

test('every var() without a fallback is declared in CSS or required by its selector', () => {
  const cssFiles = listCssFiles(SRC_DIR).map((path) => ({
    path,
    css: readFileSync(path, 'utf8'),
  }));
  const defined = new Set(
    cssFiles.flatMap(({ css }) => [...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]))
  );
  const undefinedRefs = cssFiles.flatMap(({ path, css }) =>
    [...css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)]
      .filter((m) => !defined.has(m[1]) && !requiresInlineProperty(css, m.index!, m[1]))
      .map((m) => `${path.slice(SRC_DIR.length + 1)}: ${m[1]}`)
  );
  assert.deepEqual([...new Set(undefinedRefs)], []);
});
