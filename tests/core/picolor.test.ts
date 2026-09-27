import assert from 'node:assert/strict';
import test from 'node:test';
import { highlightCode, type HighlightedLine } from '@core/picolor';

/** Reconstructs the original source text from highlightCode's output for round-trip checks. */
function reconstruct(lines: HighlightedLine[]): string {
  return lines.map((line) => line.tokens.map((t) => t.text).join('')).join('\n');
}

test('highlightCode: round-trips exactly for a known language (no lost/duplicated characters)', () => {
  const code = 'function add(a: number, b: number): number {\n  return a + b;\n}';
  const lines = highlightCode(code, 'typescript');
  assert.equal(reconstruct(lines), code);
});

test('highlightCode: round-trips exactly for an unknown language (plain fallback)', () => {
  const code = 'some <weird> & "quoted" text\nsecond line';
  const lines = highlightCode(code, 'not-a-real-language');
  assert.equal(reconstruct(lines), code);
  for (const line of lines) {
    for (const token of line.tokens) {
      assert.equal(token.className, '');
    }
  }
});

test('highlightCode: unknown language produces one plain line per source line', () => {
  const code = 'a\nb\nc';
  const lines = highlightCode(code, 'totally-unknown');
  assert.equal(lines.length, 3);
  assert.deepEqual(
    lines.map((l) => l.tokens.map((t) => t.text).join('')),
    ['a', 'b', 'c']
  );
});

test('highlightCode: no language given falls back to plain tokens', () => {
  const code = 'plain text here';
  const lines = highlightCode(code, undefined);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].tokens[0].text, code);
  assert.equal(lines[0].tokens[0].className, '');
});

test('highlightCode: recognizes TypeScript keywords, strings, comments, and numbers', () => {
  const code = 'const x = 42; // a comment\nconst s = "hello";';
  const lines = highlightCode(code, 'typescript');
  const allTokens = lines.flatMap((l) => l.tokens);

  const classesFor = (text: string) =>
    allTokens.filter((t) => t.text.includes(text)).map((t) => t.className);

  assert.ok(classesFor('const').includes('pi-token-keyword'));
  assert.ok(classesFor('42').includes('pi-token-number'));
  assert.ok(classesFor('a comment').some((c) => c === 'pi-token-comment'));
  assert.ok(allTokens.some((t) => t.className === 'pi-token-string' && t.text.includes('hello')));
});

test('highlightCode: detects method/function calls in otherwise-plain identifier text', () => {
  const code = 'result.findUnique()';
  const lines = highlightCode(code, 'typescript');
  const allTokens = lines.flatMap((l) => l.tokens);
  const call = allTokens.find((t) => t.text === 'findUnique');
  assert.ok(call, 'expected a findUnique token');
  assert.equal(call!.className, 'pi-token-function');
});

test('highlightCode: detects PascalCase type names in plain identifier text', () => {
  // A registered language whose grammar leaves a bare, non-keyword identifier unclassified,
  // so the plain-text enrichment pass (applied only to hljs-unclassified chunks) is exercised.
  const code = 'let instance = UserService;';
  const lines = highlightCode(code, 'typescript');
  const allTokens = lines.flatMap((l) => l.tokens);
  const typeToken = allTokens.find((t) => t.text === 'UserService');
  assert.ok(typeToken, 'expected a UserService token');
  assert.equal(typeToken!.className, 'pi-token-type');
});

test('highlightCode: detects universal operators in plain text', () => {
  const code = 'let c = a => a + 1;\nconst same = x === y;\nconst d = e && f;';
  const lines = highlightCode(code, 'typescript');
  const allTokens = lines.flatMap((l) => l.tokens);
  const ops = allTokens.filter((t) => t.className === 'pi-token-operator').map((t) => t.text);
  assert.ok(ops.includes('=>'));
  assert.ok(ops.includes('==='));
  assert.ok(ops.includes('&&'));
});

test('highlightCode: unknown language never applies semantic enrichment (plain tokens only)', () => {
  const code = 'UserService.findUnique() := a && b';
  const lines = highlightCode(code, 'not-a-real-language');
  for (const line of lines) {
    for (const token of line.tokens) {
      assert.equal(token.className, '');
    }
  }
});

test('highlightCode: diff language colors added/removed/hunk lines and round-trips exactly', () => {
  const code = [
    '@@ -1,2 +1,2 @@',
    '-old line',
    '+new line',
    ' unchanged line',
    '--- a/file',
    '+++ b/file',
  ].join('\n');
  const lines = highlightCode(code, 'diff');
  assert.equal(reconstruct(lines), code);
  assert.equal(lines[0].lineClassName, 'pi-diff-line-hunk');
  assert.equal(lines[1].lineClassName, 'pi-diff-line-remove');
  assert.equal(lines[2].lineClassName, 'pi-diff-line-add');
  assert.equal(lines[3].lineClassName, undefined);
  // '---'/'+++' file markers are not treated as remove/add lines.
  assert.equal(lines[4].lineClassName, undefined);
  assert.equal(lines[5].lineClassName, undefined);
});

test('highlightCode: patch/gitcommit/gitrebase languages also use diff line coloring', () => {
  for (const lang of ['patch', 'gitcommit', 'gitrebase']) {
    const lines = highlightCode('+added\n-removed', lang);
    assert.equal(lines[0].lineClassName, 'pi-diff-line-add');
    assert.equal(lines[1].lineClassName, 'pi-diff-line-remove');
  }
});

test('highlightCode: language aliases resolve to registered highlight.js languages', () => {
  const tsAlias = highlightCode('const x = 1;', 'ts');
  const jsAlias = highlightCode('const x = 1;', 'js');
  const tsCanonical = highlightCode('const x = 1;', 'typescript');
  assert.deepEqual(
    tsAlias.flatMap((l) => l.tokens.map((t) => t.className)),
    tsCanonical.flatMap((l) => l.tokens.map((t) => t.className))
  );
  assert.ok(jsAlias.flatMap((l) => l.tokens).some((t) => t.className === 'pi-token-keyword'));
});

test('highlightCode: round-trips exactly across a variety of languages', () => {
  const samples: Array<[string, string]> = [
    ['python', 'def add(a, b):\n    return a + b\n'],
    ['rust', 'fn main() {\n    println!("hi");\n}'],
    ['go', 'package main\n\nfunc main() {}\n'],
    ['json', '{"a": 1, "b": [1, 2, 3]}'],
    ['bash', 'echo "hello world" && exit 0'],
  ];
  for (const [lang, code] of samples) {
    const lines = highlightCode(code, lang);
    assert.equal(reconstruct(lines), code, `round-trip failed for language: ${lang}`);
  }
});
