import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_TEXT_FILE_BYTES,
  MAX_MEDIA_FILE_BYTES,
  getImageMimeType,
  getVideoMimeType,
  isDeterministicBinary,
  isBinaryBuffer,
  classifyWorkspaceFile,
} from '@core/workspace/file-kind';

test('file-kind: constants enforce separate 25 MB media limit and 2 MB text limit', () => {
  assert.strictEqual(MAX_TEXT_FILE_BYTES, 2 * 1024 * 1024);
  assert.strictEqual(MAX_MEDIA_FILE_BYTES, 25 * 1024 * 1024);
});

test('file-kind: classifies common image formats with allowlisted MIME types', () => {
  const imageCases: [string, string][] = [
    ['avatar.png', 'image/png'],
    ['photo.PNG', 'image/png'],
    ['image.jpg', 'image/jpeg'],
    ['image.jpeg', 'image/jpeg'],
    ['animation.gif', 'image/gif'],
    ['picture.webp', 'image/webp'],
    ['diagram.svg', 'image/svg+xml'],
    ['bitmap.bmp', 'image/bmp'],
    ['favicon.ico', 'image/x-icon'],
    ['modern.avif', 'image/avif'],
  ];

  for (const [filename, expectedMime] of imageCases) {
    const mime = getImageMimeType(filename);
    assert.strictEqual(mime, expectedMime, `Failed image mime for ${filename}`);
  }

  assert.strictEqual(getImageMimeType('movie.mp4'), null);
  assert.strictEqual(getImageMimeType('script.js'), null);
});

test('file-kind: classifies common video formats with allowlisted MIME types', () => {
  const videoCases: [string, string][] = [
    ['video.mp4', 'video/mp4'],
    ['video.MP4', 'video/mp4'],
    ['clip.webm', 'video/webm'],
    ['stream.ogg', 'video/ogg'],
    ['stream.ogv', 'video/ogg'],
    ['quicktime.mov', 'video/quicktime'],
    ['movie.m4v', 'video/mp4'],
    ['recording.mkv', 'video/x-matroska'],
  ];

  for (const [filename, expectedMime] of videoCases) {
    const mime = getVideoMimeType(filename);
    assert.strictEqual(mime, expectedMime, `Failed video mime for ${filename}`);
  }

  assert.strictEqual(getVideoMimeType('photo.png'), null);
  assert.strictEqual(getVideoMimeType('document.pdf'), null);
});

test('file-kind: deterministically identifies binary files including .so versions and db-wal', () => {
  const binaryFiles = [
    'libssl.so',
    'libcrypto.so.1',
    'libc.so.6',
    'libengine.so.1.0.0',
    'app.db-wal',
    'app.db-shm',
    'database.db',
    'database.sqlite',
    'database.sqlite3',
    'dump.rdb',
    'program.exe',
    'library.dll',
    'library.dylib',
    'firmware.bin',
    'object.o',
    'compiled.obj',
    'static.a',
    'native.lib',
    'bytecode.class',
    'cached.pyc',
    'module.wasm',
    'archive.zip',
    'bundle.tar',
    'compressed.gz',
    'archive.tgz',
    'archive.7z',
    'manual.pdf',
    'document.docx',
    'font.woff2',
    'font.ttf',
  ];

  for (const file of binaryFiles) {
    assert.strictEqual(
      isDeterministicBinary(file),
      true,
      `Expected ${file} to be recognized as deterministic binary`
    );
  }
});

test('file-kind: does not forbid normal text, config, log, or README files', () => {
  const textFiles = [
    'README',
    'README.md',
    'LICENSE',
    'Makefile',
    'Dockerfile',
    '.gitignore',
    '.env',
    'config.json',
    'settings.toml',
    'manifest.yaml',
    'manifest.yml',
    'app.log',
    'server.log.1',
    'index.ts',
    'index.js',
    'styles.css',
    'main.rs',
    'data.csv',
    'query.sql',
    'notes.txt',
  ];

  for (const file of textFiles) {
    assert.strictEqual(
      isDeterministicBinary(file),
      false,
      `File ${file} should NOT be recognized as deterministic binary`
    );
  }
});

test('file-kind: byte inspection detects NUL bytes, malformed UTF-8, and binary control bytes', () => {
  // 1. NUL byte
  const withNul = new Uint8Array([0x48, 0x65, 0x00, 0x6c, 0x6f]);
  assert.strictEqual(isBinaryBuffer(withNul), true);

  // 2. Malformed UTF-8
  const invalidUtf8 = new Uint8Array([0xff, 0xfe, 0x80, 0x81]);
  assert.strictEqual(isBinaryBuffer(invalidUtf8), true);

  // 3. Binary control characters (e.g. SOH, BEL, ETX)
  const withControl = new Uint8Array([0x48, 0x65, 0x01, 0x6c, 0x6f]);
  assert.strictEqual(isBinaryBuffer(withControl), true);

  // 4. Valid UTF-8 with standard whitespace (\t, \n, \r)
  const validText = new TextEncoder().encode("Hello world!\n\tTabbed line\r\nSpecial chars: ñ, é, 🚀");
  assert.strictEqual(isBinaryBuffer(validText), false);
});

test('file-kind: classifyWorkspaceFile produces correct kind, mimeType, and isBinary', () => {
  // Image
  const img = classifyWorkspaceFile('photo.png');
  assert.strictEqual(img.kind, 'image');
  assert.strictEqual(img.mimeType, 'image/png');
  assert.strictEqual(img.isBinary, true);

  // Video
  const vid = classifyWorkspaceFile('movie.mp4');
  assert.strictEqual(vid.kind, 'video');
  assert.strictEqual(vid.mimeType, 'video/mp4');
  assert.strictEqual(vid.isBinary, true);

  // Deterministic binary
  const bin = classifyWorkspaceFile('libssl.so.1');
  assert.strictEqual(bin.kind, 'binary');
  assert.strictEqual(bin.mimeType, null);
  assert.strictEqual(bin.isBinary, true);

  // Text file with valid buffer
  const textBuf = new TextEncoder().encode('export const x = 42;\n');
  const txt = classifyWorkspaceFile('index.ts', textBuf);
  assert.strictEqual(txt.kind, 'text');
  assert.strictEqual(txt.mimeType, null);
  assert.strictEqual(txt.isBinary, false);

  // Unknown extension with binary buffer
  const unknownBinBuf = new Uint8Array([0x00, 0x01, 0x02]);
  const unk = classifyWorkspaceFile('unknown.dat', unknownBinBuf);
  assert.strictEqual(unk.kind, 'binary');
  assert.strictEqual(unk.mimeType, null);
  assert.strictEqual(unk.isBinary, true);
});
