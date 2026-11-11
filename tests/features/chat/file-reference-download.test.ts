import assert from 'node:assert/strict';
import test from 'node:test';
import { fileReferenceDownloadSource } from '../../../src/features/chat/file-reference-download';

test('routes only unambiguous project descendants on web, preserving native and fallback', () => {
  const source = 'C:/Projects/Demo/sub/File.md';
  assert.deepEqual(fileReferenceDownloadSource(source, 'c:\\Projects\\Demo', false), { workingDirectory: 'c:\\Projects\\Demo', relativePath: 'sub/File.md' });
  for (const [path, cwd] of [[source, undefined], [source, 'C:/Projects/Dem'], ['C:/Projects/Demo/../secret', 'C:/Projects/Demo'], ['/project/./file', '/project'], ['/project2/file', '/project'], ['C:/Projects/Demo/file', '/Projects/Demo']]) {
    assert.deepEqual(fileReferenceDownloadSource(path!, cwd, false), { sourcePath: path });
  }
  assert.deepEqual(fileReferenceDownloadSource(source, 'C:/Projects/Demo', true), { sourcePath: source });
  assert.deepEqual(fileReferenceDownloadSource('/project/a.txt', '/project', false), { workingDirectory: '/project', relativePath: 'a.txt' });
});
