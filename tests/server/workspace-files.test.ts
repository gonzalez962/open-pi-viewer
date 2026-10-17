import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  handleReadWorkspaceFile,
  handleListWorkspaceDir,
  handleGetWorkspaceGitStatus,
  handleCreateWorkspaceDir,
} from '@server/bridge/paths';
import { execSync } from 'node:child_process';
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

/* ========================================================================= */
/* Regression tests: Git Status & Directory Enumeration                      */
/* ========================================================================= */

test('server bridge: handleListWorkspaceDir returns POSIX forward slash relative paths for nested folders', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ws-enum-'));
  try {
    const nestedDir = path.join(tempDir, 'nested', 'deep');
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(nestedDir, 'file.txt'), 'hello');

    // 1. Listing root
    const rootEntries = handleListWorkspaceDir({
      payload: { workingDirectory: tempDir, relativePath: '' },
    });
    const nestedEntry = rootEntries.find((e: any) => e.name === 'nested');
    assert.ok(nestedEntry);
    assert.strictEqual(nestedEntry.relativePath, 'nested');

    // 2. Listing nested
    const nestedEntries = handleListWorkspaceDir({
      payload: { workingDirectory: tempDir, relativePath: 'nested' },
    });
    const deepEntry = nestedEntries.find((e: any) => e.name === 'deep');
    assert.ok(deepEntry);
    assert.strictEqual(deepEntry.relativePath, 'nested/deep');

    // 3. Listing deep
    const deepEntries = handleListWorkspaceDir({
      payload: { workingDirectory: tempDir, relativePath: 'nested/deep' },
    });
    const fileEntry = deepEntries.find((e: any) => e.name === 'file.txt');
    assert.ok(fileEntry);
    assert.strictEqual(fileEntry.relativePath, 'nested/deep/file.txt');

    // 4. Listing using backslash relativePath on Windows normalizes cleanly
    if (process.platform === 'win32') {
      const winEntries = handleListWorkspaceDir({
        payload: { workingDirectory: tempDir, relativePath: 'nested\\deep' },
      });
      const winFileEntry = winEntries.find((e: any) => e.name === 'file.txt');
      assert.ok(winFileEntry);
      assert.strictEqual(winFileEntry.relativePath, 'nested/deep/file.txt');
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('server bridge: handleGetWorkspaceGitStatus handles nested modified, staged, and untracked files', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ws-git-status-'));
  try {
    execSync('git init', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: tempDir, stdio: 'ignore' });

    const subDir = path.join(tempDir, 'sub');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'initial.txt'), 'version 1');
    execSync('git add .', { cwd: tempDir, stdio: 'ignore' });
    execSync('git commit -m "init"', { cwd: tempDir, stdio: 'ignore' });

    // 1. Nested modified
    fs.writeFileSync(path.join(subDir, 'initial.txt'), 'version 2');

    // 2. Nested staged
    fs.writeFileSync(path.join(subDir, 'staged.txt'), 'staged content');
    execSync('git add sub/staged.txt', { cwd: tempDir, stdio: 'ignore' });

    // 3. Nested untracked
    fs.writeFileSync(path.join(subDir, 'untracked.txt'), 'untracked content');

    const status = handleGetWorkspaceGitStatus({
      payload: { workingDirectory: tempDir },
    });

    assert.strictEqual(status.isRepo, true);
    assert.ok(status.modifiedFiles.includes('sub/initial.txt'), 'modifiedFiles should include sub/initial.txt');
    assert.ok(status.addedFiles.includes('sub/staged.txt'), 'addedFiles should include sub/staged.txt');
    assert.ok(status.untrackedFiles.includes('sub/untracked.txt'), 'untrackedFiles should include sub/untracked.txt');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('server bridge: handleGetWorkspaceGitStatus enumerates newly untracked dir grandchildren as individual files', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ws-git-grandchild-'));
  try {
    execSync('git init', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: tempDir, stdio: 'ignore' });

    fs.writeFileSync(path.join(tempDir, 'root.txt'), 'committed');
    execSync('git add root.txt', { cwd: tempDir, stdio: 'ignore' });
    execSync('git commit -m "init"', { cwd: tempDir, stdio: 'ignore' });

    // Create untracked nested directory with grandchild
    const deepDir = path.join(tempDir, 'parent', 'child');
    fs.mkdirSync(deepDir, { recursive: true });
    fs.writeFileSync(path.join(deepDir, 'grandchild.txt'), 'untracked nested file');

    const status = handleGetWorkspaceGitStatus({
      payload: { workingDirectory: tempDir },
    });

    assert.strictEqual(status.isRepo, true);
    assert.ok(
      status.untrackedFiles.includes('parent/child/grandchild.txt'),
      'Should include grandchild file directly rather than parent/ directory'
    );
    assert.strictEqual(
      status.untrackedFiles.includes('parent/'),
      false,
      'Should not include parent/ directory token'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('server bridge: handleGetWorkspaceGitStatus consumes extra rename token, keeps destination, and parses following entry', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ws-git-rename-'));
  try {
    execSync('git init', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: tempDir, stdio: 'ignore' });

    fs.writeFileSync(path.join(tempDir, 'a_orig.txt'), 'orig a');
    fs.writeFileSync(path.join(tempDir, 'z_follower.txt'), 'follower z');
    execSync('git add .', { cwd: tempDir, stdio: 'ignore' });
    execSync('git commit -m "init"', { cwd: tempDir, stdio: 'ignore' });

    // Git rename
    execSync('git mv a_orig.txt a_renamed.txt', { cwd: tempDir, stdio: 'ignore' });
    // Modify follower
    fs.writeFileSync(path.join(tempDir, 'z_follower.txt'), 'follower modified');

    const status = handleGetWorkspaceGitStatus({
      payload: { workingDirectory: tempDir },
    });

    assert.strictEqual(status.isRepo, true);
    // Destination kept in modifiedFiles
    assert.ok(status.modifiedFiles.includes('a_renamed.txt'), 'modifiedFiles should include rename destination');
    // Original path consumed and not present
    assert.strictEqual(status.modifiedFiles.includes('a_orig.txt'), false, 'Source path should not be in modifiedFiles');
    assert.strictEqual(status.addedFiles.includes('a_orig.txt'), false, 'Source path should not be in addedFiles');
    assert.strictEqual(status.untrackedFiles.includes('a_orig.txt'), false, 'Source path should not be in untrackedFiles');
    // Following entry correctly parsed
    assert.ok(status.modifiedFiles.includes('z_follower.txt'), 'Following entry should be parsed cleanly');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('server bridge: handleGetWorkspaceGitStatus preserves leading/trailing whitespace and Unicode', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ws-git-unicode-'));
  try {
    execSync('git init', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: tempDir, stdio: 'ignore' });

    const spacedName = '  spaced file  .txt';
    const unicodeName = 'sub/日本語 unicode.txt';
    fs.mkdirSync(path.join(tempDir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, spacedName), 'spaced');
    fs.writeFileSync(path.join(tempDir, unicodeName), 'unicode');

    const status = handleGetWorkspaceGitStatus({
      payload: { workingDirectory: tempDir },
    });

    assert.strictEqual(status.isRepo, true);
    assert.ok(
      status.untrackedFiles.includes(spacedName),
      `untrackedFiles should include '${spacedName}' with exact whitespace`
    );
    assert.ok(
      status.untrackedFiles.includes('sub/日本語 unicode.txt'),
      'untrackedFiles should include Unicode path without octal escaping'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('server bridge: handleGetWorkspaceGitStatus nested workspace rebases paths and excludes siblings', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ws-git-nested-'));
  try {
    execSync('git init', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: tempDir, stdio: 'ignore' });

    const wsDir = path.join(tempDir, 'app_sub');
    const siblingDir = path.join(tempDir, 'sibling_sub');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.mkdirSync(siblingDir, { recursive: true });

    // File in root
    fs.writeFileSync(path.join(tempDir, 'repo_root.txt'), 'root');
    // File in sibling
    fs.writeFileSync(path.join(siblingDir, 'sibling.txt'), 'sibling');
    // File inside workspace
    fs.writeFileSync(path.join(wsDir, 'inside.txt'), 'inside');
    // Nested file inside workspace
    const nestedInWs = path.join(wsDir, 'nested');
    fs.mkdirSync(nestedInWs, { recursive: true });
    fs.writeFileSync(path.join(nestedInWs, 'deep.txt'), 'deep inside');

    // Query status with targetCwd = wsDir
    const status = handleGetWorkspaceGitStatus({
      payload: { workingDirectory: wsDir },
    });

    assert.strictEqual(status.isRepo, true);
    // Inside workspace paths rebased relative to wsDir
    assert.ok(status.untrackedFiles.includes('inside.txt'), 'Should include inside.txt relative to wsDir');
    assert.ok(status.untrackedFiles.includes('nested/deep.txt'), 'Should include nested/deep.txt relative to wsDir');
    // Outside paths excluded
    assert.strictEqual(
      status.untrackedFiles.some((f) => f.includes('sibling') || f.includes('repo_root')),
      false,
      'Sibling and root paths outside workspace must be excluded'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('server bridge: handleGetWorkspaceGitStatus classifies merge conflicts in modifiedFiles', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ws-git-conflict-'));
  try {
    execSync('git init', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: tempDir, stdio: 'ignore' });

    fs.writeFileSync(path.join(tempDir, 'conflict.txt'), 'base\n');
    execSync('git add conflict.txt', { cwd: tempDir, stdio: 'ignore' });
    execSync('git commit -m "base"', { cwd: tempDir, stdio: 'ignore' });

    execSync('git checkout -b branch1', { cwd: tempDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(tempDir, 'conflict.txt'), 'branch1 change\n');
    execSync('git commit -am "b1"', { cwd: tempDir, stdio: 'ignore' });

    execSync('git checkout master || git checkout main', { cwd: tempDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(tempDir, 'conflict.txt'), 'main change\n');
    execSync('git commit -am "main"', { cwd: tempDir, stdio: 'ignore' });

    try {
      execSync('git merge branch1', { cwd: tempDir, stdio: 'ignore' });
    } catch {}

    const status = handleGetWorkspaceGitStatus({
      payload: { workingDirectory: tempDir },
    });

    assert.strictEqual(status.isRepo, true);
    assert.ok(
      status.modifiedFiles.includes('conflict.txt'),
      'Merge conflict (UU) must be classified in modifiedFiles'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('server bridge: handleCreateWorkspaceDir creates a folder in workspace root', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ws-mkdir-'));
  try {
    const entry = handleCreateWorkspaceDir({
      payload: {
        workingDirectory: tempDir,
        name: 'test-folder',
      },
    });

    assert.strictEqual(entry.name, 'test-folder');
    assert.strictEqual(entry.relativePath, 'test-folder');
    assert.strictEqual(entry.isDir, true);
    assert.strictEqual(fs.existsSync(path.join(tempDir, 'test-folder')), true);
    assert.strictEqual(fs.statSync(path.join(tempDir, 'test-folder')).isDirectory(), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('server bridge: handleCreateWorkspaceDir rejects empty or whitespace name', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ws-mkdir-err-'));
  try {
    assert.throws(
      () => handleCreateWorkspaceDir({ payload: { workingDirectory: tempDir, name: '' } }),
      /Folder name must be a non-empty string/i
    );
    assert.throws(
      () => handleCreateWorkspaceDir({ payload: { workingDirectory: tempDir, name: '   ' } }),
      /Folder name must be a non-empty string/i
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('server bridge: handleCreateWorkspaceDir rejects traversal segments and path separators', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ws-mkdir-trav-'));
  try {
    // 1. .. traversal
    assert.throws(
      () => handleCreateWorkspaceDir({ payload: { workingDirectory: tempDir, name: '..' } }),
      /traversal|separator|invalid/i
    );
    // 2. nested slash / traversal
    assert.throws(
      () => handleCreateWorkspaceDir({ payload: { workingDirectory: tempDir, name: '../escaped' } }),
      /traversal|separator|invalid/i
    );
    // 3. forward slash
    assert.throws(
      () => handleCreateWorkspaceDir({ payload: { workingDirectory: tempDir, name: 'sub/dir' } }),
      /separator|invalid/i
    );
    // 4. backslash
    assert.throws(
      () => handleCreateWorkspaceDir({ payload: { workingDirectory: tempDir, name: 'sub\\dir' } }),
      /separator|invalid/i
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('server bridge: handleCreateWorkspaceDir rejects existing destinations without corrupting data', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ws-mkdir-exist-'));
  try {
    const existingFolder = path.join(tempDir, 'existing-folder');
    fs.mkdirSync(existingFolder);
    const existingFileInFolder = path.join(existingFolder, 'file.txt');
    fs.writeFileSync(existingFileInFolder, 'untouched data');

    assert.throws(
      () => handleCreateWorkspaceDir({ payload: { workingDirectory: tempDir, name: 'existing-folder' } }),
      /already exists/i
    );

    // Existing data must remain untouched
    assert.strictEqual(fs.existsSync(existingFileInFolder), true);
    assert.strictEqual(fs.readFileSync(existingFileInFolder, 'utf8'), 'untouched data');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
