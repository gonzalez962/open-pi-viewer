import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { handleReadWorkspaceFile } from '@server/bridge/paths';
import {
  MAX_TEXT_FILE_BYTES,
  MAX_MEDIA_FILE_BYTES,
} from '@core/workspace/file-kind';

test('server bridge: path containment prevents directory traversal escape', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ws-test-'));
  try {
    const secretFile = path.join(os.tmpdir(), 'outside-secret.txt');
    fs.writeFileSync(secretFile, 'secret content');

    // 1. Traversal attempt with ..
    assert.throws(
      () => {
        handleReadWorkspaceFile({
          payload: {
            workingDirectory: tempDir,
            relativePath: '../outside-secret.txt',
          },
        });
      },
      /traversal|outside|denied/i,
      'Should reject traversal with ..'
    );

    // 2. Traversal embedded in path
    assert.throws(
      () => {
        handleReadWorkspaceFile({
          payload: {
            workingDirectory: tempDir,
            relativePath: 'sub/../../outside-secret.txt',
          },
        });
      },
      /traversal|outside|denied/i,
      'Should reject embedded .. traversal'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('server bridge: reads text files within 2 MB and decodes UTF-8', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ws-text-'));
  try {
    const textPath = path.join(tempDir, 'README.md');
    fs.writeFileSync(textPath, '# Hello World\nWelcome to open-pi-viewer!', 'utf8');

    const result = handleReadWorkspaceFile({
      payload: {
        workingDirectory: tempDir,
        relativePath: 'README.md',
      },
    });

    assert.strictEqual(result.relativePath, 'README.md');
    assert.strictEqual(result.name, 'README.md');
    assert.strictEqual(result.content, '# Hello World\nWelcome to open-pi-viewer!');
    assert.strictEqual(result.isBinary, false);
    assert.strictEqual(result.kind, 'text');
    assert.strictEqual(result.extension, 'md');
    assert.strictEqual(result.mediaDataUrl, null);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('server bridge: rejects text files over 2 MB before full read', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ws-overtext-'));
  try {
    const bigTextPath = path.join(tempDir, 'huge.txt');
    // Allocate > 2 MB file (2 MB + 10 bytes)
    const fd = fs.openSync(bigTextPath, 'w');
    fs.writeSync(fd, Buffer.alloc(10), 0, 10, MAX_TEXT_FILE_BYTES);
    fs.closeSync(fd);

    assert.throws(
      () => {
        handleReadWorkspaceFile({
          payload: {
            workingDirectory: tempDir,
            relativePath: 'huge.txt',
          },
        });
      },
      /too large to preview/i,
      'Should reject text file > 2 MB'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('server bridge: reads media files within 25 MB as base64 data URI and empty content', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ws-media-'));
  try {
    // 1. PNG Image
    const pngPath = path.join(tempDir, 'sample.png');
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    fs.writeFileSync(pngPath, fakePng);

    const imgResult = handleReadWorkspaceFile({
      payload: {
        workingDirectory: tempDir,
        relativePath: 'sample.png',
      },
    });

    assert.strictEqual(imgResult.kind, 'image');
    assert.strictEqual(imgResult.isBinary, true);
    assert.strictEqual(imgResult.content, '', 'Media content must be empty, never data URL');
    assert.strictEqual(imgResult.mimeType, 'image/png');
    assert.ok(imgResult.mediaDataUrl?.startsWith('data:image/png;base64,'));

    // 2. MP4 Video
    const mp4Path = path.join(tempDir, 'sample.mp4');
    const fakeMp4 = Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]);
    fs.writeFileSync(mp4Path, fakeMp4);

    const vidResult = handleReadWorkspaceFile({
      payload: {
        workingDirectory: tempDir,
        relativePath: 'sample.mp4',
      },
    });

    assert.strictEqual(vidResult.kind, 'video');
    assert.strictEqual(vidResult.isBinary, true);
    assert.strictEqual(vidResult.content, '');
    assert.strictEqual(vidResult.mimeType, 'video/mp4');
    assert.ok(vidResult.mediaDataUrl?.startsWith('data:video/mp4;base64,'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('server bridge: rejects media files over 25 MB before full read', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ws-overmedia-'));
  try {
    const bigMediaPath = path.join(tempDir, 'huge.mp4');
    const fd = fs.openSync(bigMediaPath, 'w');
    fs.writeSync(fd, Buffer.alloc(10), 0, 10, MAX_MEDIA_FILE_BYTES);
    fs.closeSync(fd);

    assert.throws(
      () => {
        handleReadWorkspaceFile({
          payload: {
            workingDirectory: tempDir,
            relativePath: 'huge.mp4',
          },
        });
      },
      /too large to preview/i,
      'Should reject media file > 25 MB'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('server bridge: returns empty binary metadata for deterministic binary files (.so, .db-wal)', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ws-bin-'));
  try {
    // 1. .so.1
    const soPath = path.join(tempDir, 'libcrypto.so.1');
    fs.writeFileSync(soPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));

    const soResult = handleReadWorkspaceFile({
      payload: {
        workingDirectory: tempDir,
        relativePath: 'libcrypto.so.1',
      },
    });

    assert.strictEqual(soResult.kind, 'binary');
    assert.strictEqual(soResult.isBinary, true);
    assert.strictEqual(soResult.content, '');
    assert.strictEqual(soResult.mediaDataUrl, null);

    // 2. .db-wal
    const walPath = path.join(tempDir, 'app.db-wal');
    fs.writeFileSync(walPath, Buffer.from([0x37, 0x7f, 0x06, 0x82]));

    const walResult = handleReadWorkspaceFile({
      payload: {
        workingDirectory: tempDir,
        relativePath: 'app.db-wal',
      },
    });

    assert.strictEqual(walResult.kind, 'binary');
    assert.strictEqual(walResult.isBinary, true);
    assert.strictEqual(walResult.content, '');
    assert.strictEqual(walResult.mediaDataUrl, null);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
