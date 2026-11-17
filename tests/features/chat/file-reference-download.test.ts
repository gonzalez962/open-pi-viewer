import assert from 'node:assert/strict';
import test from 'node:test';
import { fileReferenceDownloadSource } from '../../../src/features/chat/file-reference-download';

test('routes only unambiguous project descendants on web, preserving native and fallback', () => {
  const source = 'C:/Projects/Demo/sub/File.md';
  assert.deepEqual(fileReferenceDownloadSource(source, 'c:\\Projects\\Demo', false), { workingDirectory: 'c:\\Projects\\Demo', relativePath: 'sub/File.md' });
  for (const [path, cwd] of [[source, undefined], [source, 'C:/Projects/Dem'], ['C:/Projects/Demo/../secret', 'C:/Projects/Demo'], ['/project/./file', '/project'], ['C:/Projects/Demo/file', '/Projects/Demo']]) {
    assert.deepEqual(fileReferenceDownloadSource(path!, cwd, false), { sourcePath: path });
  }
  assert.deepEqual(fileReferenceDownloadSource(source, 'C:/Projects/Demo', true), { sourcePath: source });
  assert.deepEqual(fileReferenceDownloadSource('/project/a.txt', '/project', false), { workingDirectory: '/project', relativePath: 'a.txt' });
});

test('S1.1 resolves leading-slash and relative project paths', () => {
  for (const path of ['/frontend/src/components/menu.ts', 'frontend/src/components/menu.ts']) {
    assert.deepEqual(fileReferenceDownloadSource(path, '/home/user/app', false), { workingDirectory: '/home/user/app', relativePath: 'frontend/src/components/menu.ts' });
  }
});

test('S4.1 preserves explicit home and drive roots outside the project', () => {
  for (const path of ['/home/user/report.pdf', 'C:\\files\\report.pdf']) {
    assert.deepEqual(fileReferenceDownloadSource(path, '/home/user/app', false), { sourcePath: path });
  }
});

test('S4.2 does not route traversal, URI or malformed paths into the project', () => {
  for (const path of ['../secret.txt', '/frontend/../secret.txt', 'https://example.com/file.txt', '/frontend//file.txt']) {
    assert.deepEqual(fileReferenceDownloadSource(path, '/home/user/app', false), { sourcePath: path });
  }
});

test('S3.1 preserves native routing and absolute project descendants outside home', () => {
  assert.deepEqual(fileReferenceDownloadSource('/extensionless', '/opt/app', true), { sourcePath: '/extensionless' });
  assert.deepEqual(fileReferenceDownloadSource('/opt/app/src/menu.ts', '/opt/app', false), { workingDirectory: '/opt/app', relativePath: 'src/menu.ts' });
});
