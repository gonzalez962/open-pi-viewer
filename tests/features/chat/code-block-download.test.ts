import assert from 'node:assert/strict';
import test from 'node:test';
import { codeBlockDownloadPayload } from '@features/chat/code-block-download';

test('payload contains only raw code and chooses safe filenames', () => {
  const code = '  # hi\n\n  text\n';
  for (const [language, filename, expected] of [
    ['markdown', undefined, 'code.md'], ['md', undefined, 'code.md'],
    ['python', undefined, 'code.py'], ['js', undefined, 'code.js'],
    ['unknown', undefined, 'code.txt'], [undefined, undefined, 'code.txt'],
    ['python', '../src/example.py', 'example.py'], ['js', 'C:\\src\\app.js', 'app.js'],
    ['python', '../..', 'code.py'],
  ] as const) {
    assert.deepEqual(codeBlockDownloadPayload(code, language, filename), { content: code, filename: expected, mimeType: 'text/plain;charset=utf-8' });
  }
});
