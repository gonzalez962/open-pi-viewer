import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { getHomeDir, getBridgeConfig } from '../config';
import { HOME_DIR, getActiveCwd } from './state';
import type {
  WorkspaceGitStatus,
  WorkspaceFileDiff,
  WorkspaceEntry,
  DeleteWorkspaceDirResult,
  WorkspaceBranch,
  WorkspaceBranchList,
  BranchOperationResult,
  WorkspaceBranchCommit,
  WorkspaceBranchCommitsResult,
} from '../../src/core/types/workspace';
import {
  MAX_TEXT_FILE_BYTES,
  MAX_MEDIA_FILE_BYTES,
  getImageMimeType,
  getVideoMimeType,
  isDeterministicBinary,
  isBinaryBuffer,
} from '../../src/core/workspace/file-kind';

export function resolveCrossPlatformCwd(cwd?: string | null): string {
  const cfg = getBridgeConfig();
  if (!cwd || !cwd.trim()) {
    return cfg.baseWorkspace || process.cwd();
  }
  let trimmed = cwd.trim();

  // Expand ~ or ~/ or ~\
  const home = getHomeDir();
  if (trimmed === '~') {
    return home;
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    trimmed = path.join(home, trimmed.slice(2));
  }

  // Windows Git Bash / MSYS format: /c/Users/... -> C:\Users\...
  if (process.platform === 'win32' && /^\/[a-zA-Z]\//.test(trimmed)) {
    const drive = trimmed[1].toUpperCase();
    const rest = trimmed.slice(2).replace(/\//g, '\\');
    trimmed = `${drive}:${rest}`;
  }

  // If path is a Windows-style path on POSIX host (e.g. C:\... or Z:\...)
  if (process.platform !== 'win32' && /^[a-zA-Z]:[\\\/]?/i.test(trimmed)) {
    const drive = trimmed[0].toUpperCase();
    const relPart = trimmed.slice(2).replace(/^[\\\/]+/, '').replace(/\\/g, '/');

    if (cfg.driveMappings && cfg.driveMappings[drive]) {
      const mapped = relPart ? path.join(cfg.driveMappings[drive], relPart) : cfg.driveMappings[drive];
      if (fs.existsSync(mapped)) return mapped;
    }
    // Fallback: check under home directory if folder exists
    const homeCandidate = relPart ? path.join(home, relPart) : home;
    if (fs.existsSync(homeCandidate)) return homeCandidate;
  }

  // UNC path check on POSIX host
  if (process.platform !== 'win32' && /^([\\\/]{2})[^\/\\\s]+[\\\/]([^\\\/]+)[\\\/]?(.*)/.test(trimmed)) {
    const m = trimmed.match(/^([\\\/]{2})[^\/\\\s]+[\\\/]([^\\\/]+)[\\\/]?(.*)/);
    if (m && cfg.uncMappings) {
      const shareName = m[2].toLowerCase();
      if (cfg.uncMappings[shareName]) {
        const subPath = m[3] ? m[3].replace(/\\/g, '/') : '';
        const mapped = subPath ? path.join(cfg.uncMappings[shareName], subPath) : cfg.uncMappings[shareName];
        if (fs.existsSync(mapped)) return mapped;
      }
    }
  }

  try {
    return path.resolve(trimmed);
  } catch {
    return trimmed;
  }
}

export function getAvailableDrives(): Array<{ name: string; path: string }> {
  if (process.platform !== 'win32') return [];
  const drives: Array<{ name: string; path: string }> = [];
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZAB';
  for (const l of letters) {
    const root = `${l}:\\`;
    try {
      if (fs.existsSync(root)) {
        drives.push({ name: `Drive (${root})`, path: root });
      }
    } catch {}
  }
  return drives;
}

export function getFilesystemShortcuts(baseWorkspace: string): Array<{ name: string; path: string; windowsPath?: string }> {
  const shortcuts: Array<{ name: string; path: string; windowsPath?: string }> = [];
  const home = getHomeDir();
  const cfg = getBridgeConfig();

  // 1. Custom shortcuts from config
  if (cfg.customShortcuts && Array.isArray(cfg.customShortcuts)) {
    for (const sc of cfg.customShortcuts) {
      if (sc.name && sc.path && fs.existsSync(sc.path)) {
        shortcuts.push({
          name: sc.name,
          path: path.resolve(sc.path),
          ...(process.platform === 'win32' ? { windowsPath: path.resolve(sc.path) } : {}),
        });
      }
    }
  }

  // 2. Base workspace
  if (baseWorkspace && fs.existsSync(baseWorkspace)) {
    const baseName = path.basename(baseWorkspace) || 'Workspace';
    shortcuts.push({
      name: `Workspace (${baseName})`,
      path: path.resolve(baseWorkspace),
      ...(process.platform === 'win32' ? { windowsPath: path.resolve(baseWorkspace) } : {}),
    });
  }

  // 3. User Home
  if (fs.existsSync(home)) {
    shortcuts.push({
      name: `Home (${path.basename(home) || '~'})`,
      path: home,
      ...(process.platform === 'win32' ? { windowsPath: home } : {}),
    });
  }

  // 4. Platform specific: Drives on Windows, Root and standard dirs on POSIX
  if (process.platform === 'win32') {
    const drives = getAvailableDrives();
    for (const d of drives) {
      shortcuts.push({
        name: d.name,
        path: d.path,
        windowsPath: d.path,
      });
    }
  } else {
    shortcuts.push({
      name: 'Root (/)',
      path: '/',
    });
    const commonDirs = ['Projects', 'Development', 'Documents', 'workspace'];
    for (const dirName of commonDirs) {
      const p = path.join(home, dirName);
      if (fs.existsSync(p)) {
        shortcuts.push({
          name: dirName,
          path: p,
        });
      }
    }
  }

  return shortcuts;
}

export function handlePickDirectory(args: any = {}) {
  const cfg = getBridgeConfig();
  return args.defaultPath || getActiveCwd() || cfg.baseWorkspace || getHomeDir();
}

export function handleBrowseFilesystem(args: any = {}) {
  const payload = args.payload || args || {};
  const cfg = getBridgeConfig();
  let requestedDir = payload.path ? resolveCrossPlatformCwd(payload.path) : (getActiveCwd() || cfg.baseWorkspace || getHomeDir());
  if (!fs.existsSync(requestedDir)) {
    requestedDir = fs.existsSync(cfg.baseWorkspace) ? cfg.baseWorkspace : getHomeDir();
  }

  try {
    const st = fs.statSync(requestedDir);
    if (!st.isDirectory()) {
      requestedDir = path.dirname(requestedDir);
    }
  } catch {
    requestedDir = getHomeDir();
  }

  const canonicalDir = path.resolve(requestedDir);
  const parentDir = path.dirname(canonicalDir) !== canonicalDir ? path.dirname(canonicalDir) : null;

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(canonicalDir, { withFileTypes: true });
  } catch {}

  const folders: { name: string; fullPath: string; windowsPath?: string }[] = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name.startsWith('.') && e.name !== '.gentle-ai') continue;
      if (e.name === 'node_modules' || e.name === 'target' || e.name === 'dist' || e.name === '.git') continue;
      const full = path.join(canonicalDir, e.name);
      folders.push({
        name: e.name,
        fullPath: full,
        ...(process.platform === 'win32' ? { windowsPath: full } : {}),
      });
    }
  }

  folders.sort((a, b) => a.name.localeCompare(b.name));

  const windowsPath = process.platform === 'win32' ? canonicalDir : null;

  return {
    currentPath: canonicalDir,
    windowsPath,
    parentPath: parentDir,
    folders,
    shortcuts: getFilesystemShortcuts(cfg.baseWorkspace),
  };
}

export function handleListWorkspaceDir(args: any = {}) {
  const payload = args.payload || {};
  const targetCwd = resolveCrossPlatformCwd(payload.workingDirectory || getActiveCwd());
  const rel = payload.relativePath || '';

  const normalizedRel = typeof rel === 'string' ? rel.replace(/\\/g, '/') : '';
  if (normalizedRel.split('/').includes('..')) {
    throw new Error(`Access denied: path traversal attempt detected ('..'): ${rel}`);
  }

  const resolvedRoot = path.resolve(targetCwd);
  if (!fs.existsSync(resolvedRoot)) return [];
  const canonicalRoot = fs.realpathSync(resolvedRoot);

  const fullDir = path.resolve(canonicalRoot, rel);
  if (!fs.existsSync(fullDir)) return [];

  const canonicalTarget = fs.realpathSync(fullDir);

  const rootPrefix = canonicalRoot.endsWith(path.sep) ? canonicalRoot : canonicalRoot + path.sep;
  const isContained =
    canonicalTarget === canonicalRoot ||
    canonicalTarget.startsWith(rootPrefix) ||
    (process.platform === 'win32' &&
      (canonicalTarget.toLowerCase() === canonicalRoot.toLowerCase() ||
        canonicalTarget.toLowerCase().startsWith(rootPrefix.toLowerCase())));

  if (!isContained) {
    throw new Error(`Access denied: path is outside workspace root: ${rel}`);
  }

  const entries = fs.readdirSync(canonicalTarget, { withFileTypes: true });
  const results: any[] = [];

  const normRel = typeof rel === 'string'
    ? (process.platform === 'win32' ? rel.replace(/\\/g, '/') : rel).replace(/^\/+|\/+$/g, '')
    : '';

  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name === 'target' || e.name === 'dist') {
      continue;
    }
    const isDir = e.isDirectory();
    const eRel = normRel ? `${normRel}/${e.name}` : e.name;
    let size: number | null = null;
    let ext: string | null = null;

    if (!isDir) {
      try {
        const st = fs.statSync(path.join(canonicalTarget, e.name));
        size = st.size;
        ext = path.extname(e.name).slice(1) || null;
      } catch {}
    }

    results.push({
      name: e.name,
      relativePath: eRel,
      isDir,
      size,
      extension: ext,
    });
  }

  results.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return results;
}

/**
 * Creates a directory directly in the active workspace root.
 * Enforces containment, path safety, and prevents overwriting existing paths.
 */
export function handleCreateWorkspaceDir(args: any = {}): WorkspaceEntry {
  const payload = args.payload || {};
  const targetCwd = resolveCrossPlatformCwd(payload.workingDirectory || getActiveCwd());
  const name = payload.name;

  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('Folder name must be a non-empty string');
  }

  const trimmedName = name.trim();

  // Validate folder name: reject path separators and traversal segments
  if (trimmedName.includes('/') || trimmedName.includes('\\')) {
    throw new Error(`Invalid folder name: path separators are not permitted: ${name}`);
  }

  if (trimmedName === '.' || trimmedName === '..' || trimmedName.includes('..')) {
    throw new Error(`Path traversal attempt detected in folder name: ${name}`);
  }

  // Windows invalid filename characters: < > : " / \ | ? * and null bytes
  if (/[\x00-\x1f<>:"/\\|?*]/.test(trimmedName)) {
    throw new Error(`Invalid characters in folder name: ${name}`);
  }

  const resolvedRoot = path.resolve(targetCwd);
  if (!fs.existsSync(resolvedRoot)) {
    throw new Error(`Workspace root does not exist: ${targetCwd}`);
  }
  const canonicalRoot = fs.realpathSync(resolvedRoot);

  const fullDir = path.resolve(canonicalRoot, trimmedName);

  // Containment check
  const rootPrefix = canonicalRoot.endsWith(path.sep) ? canonicalRoot : canonicalRoot + path.sep;
  const isContained =
    fullDir.startsWith(rootPrefix) ||
    (process.platform === 'win32' && fullDir.toLowerCase().startsWith(rootPrefix.toLowerCase()));

  if (!isContained) {
    throw new Error(`Access denied: path is outside workspace root: ${name}`);
  }

  if (fs.existsSync(fullDir)) {
    throw new Error(`Destination already exists: ${trimmedName}`);
  }

  fs.mkdirSync(fullDir);

  return {
    name: trimmedName,
    relativePath: trimmedName,
    isDir: true,
    size: null,
    extension: null,
  };
}

/**
 * Recursively deletes entries without following symbolic links or junctions into external directories.
 */
function safeRemoveDirAll(targetPath: string): void {
  const stat = fs.lstatSync(targetPath);
  if (stat.isSymbolicLink()) {
    if (process.platform === 'win32' && stat.isDirectory()) {
      fs.rmdirSync(targetPath);
    } else {
      fs.unlinkSync(targetPath);
    }
    return;
  }

  if (stat.isDirectory()) {
    const entries = fs.readdirSync(targetPath);
    for (const entry of entries) {
      const entryPath = path.join(targetPath, entry);
      const entryStat = fs.lstatSync(entryPath);
      if (entryStat.isSymbolicLink()) {
        if (process.platform === 'win32' && entryStat.isDirectory()) {
          fs.rmdirSync(entryPath);
        } else {
          fs.unlinkSync(entryPath);
        }
      } else if (entryStat.isDirectory()) {
        safeRemoveDirAll(entryPath);
      } else {
        fs.unlinkSync(entryPath);
      }
    }
    fs.rmdirSync(targetPath);
  } else {
    fs.unlinkSync(targetPath);
  }
}

/**
 * Recursively deletes a directory directly within an explicit parent directory.
 * Enforces explicit parent directory, single child name, backend confirmation match,
 * rejects symlink/junction targets, and preserves external symlink targets.
 */
export function handleDeleteWorkspaceDir(args: any = {}): DeleteWorkspaceDirResult {
  const payload = args.payload || {};
  const workingDirectory = payload.workingDirectory;
  const name = payload.name;
  const confirmationName = payload.confirmationName;

  if (!workingDirectory || typeof workingDirectory !== 'string' || !workingDirectory.trim()) {
    throw new Error('Explicit parent workingDirectory is required');
  }

  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('Folder name must be a non-empty string');
  }

  const trimmedName = name.trim();

  // Validate folder name: reject path separators and traversal segments
  if (trimmedName.includes('/') || trimmedName.includes('\\')) {
    throw new Error(`Invalid folder name: path separators are not permitted: ${name}`);
  }

  if (trimmedName === '.' || trimmedName === '..' || trimmedName.includes('..')) {
    throw new Error(`Path traversal attempt detected in folder name: ${name}`);
  }

  // Windows invalid filename characters: < > : " / \ | ? * and null bytes
  if (/[\x00-\x1f<>:"/\\|?*]/.test(trimmedName)) {
    throw new Error(`Invalid characters in folder name: ${name}`);
  }

  // Backend confirmation name validation
  if (typeof confirmationName !== 'string' || confirmationName.trim() !== trimmedName) {
    throw new Error(`Confirmation name does not match the target folder name: expected "${trimmedName}", got "${confirmationName}"`);
  }

  const resolvedCrossParent = resolveCrossPlatformCwd(workingDirectory.trim());
  const resolvedParent = path.resolve(resolvedCrossParent);
  if (!fs.existsSync(resolvedParent)) {
    throw new Error(`Parent directory does not exist: ${workingDirectory}`);
  }

  const parentStat = fs.statSync(resolvedParent);
  if (!parentStat.isDirectory()) {
    throw new Error(`Parent path is not a directory: ${workingDirectory}`);
  }

  const canonicalParent = fs.realpathSync(resolvedParent);
  const targetDir = path.resolve(canonicalParent, trimmedName);

  // Containment check
  if (targetDir === canonicalParent || path.dirname(targetDir) !== canonicalParent) {
    throw new Error(`Access denied: invalid target path: ${name}`);
  }

  const parentPrefix = canonicalParent.endsWith(path.sep) ? canonicalParent : canonicalParent + path.sep;
  const isContained =
    targetDir.startsWith(parentPrefix) ||
    (process.platform === 'win32' && targetDir.toLowerCase().startsWith(parentPrefix.toLowerCase()));

  if (!isContained) {
    throw new Error(`Access denied: path is outside parent directory: ${name}`);
  }

  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(targetDir);
  } catch (err: any) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      throw new Error(`Target folder does not exist: ${trimmedName}`);
    }
    throw err;
  }

  if (lstat.isSymbolicLink()) {
    throw new Error(`Deletion rejected: target is a symbolic link or junction`);
  }

  if (!lstat.isDirectory()) {
    throw new Error(`Target path is not a directory: ${trimmedName}`);
  }

  safeRemoveDirAll(targetDir);

  return {
    success: true,
    name: trimmedName,
    relativePath: trimmedName,
  };
}

/** Return a unified patch for the web file viewer without changing Git state. */
export function handleGetWorkspaceFileDiff(args: any = {}): WorkspaceFileDiff {
  const payload = args.payload || {};
  const rel = payload.relativePath;
  if (!rel || typeof rel !== 'string') {
    throw new Error('Relative path must be a non-empty string');
  }
  const normalizedRel = rel.replace(/\\/g, '/');
  if (normalizedRel.split('/').includes('..')) {
    throw new Error(`Path traversal attempt detected ('..'): ${rel}`);
  }
  const root = fs.realpathSync(resolveCrossPlatformCwd(payload.workingDirectory || getActiveCwd()));
  const target = fs.realpathSync(path.resolve(root, normalizedRel));
  const relative = path.relative(root, target);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`Access denied: path is outside workspace root: ${rel}`);
  }
  if (!fs.statSync(target).isFile()) {
    throw new Error(`Target path is a directory, not a file: ${rel}`);
  }
  const relativePath = relative.split(path.sep).join('/');
  const empty = { relativePath, hasDiff: false, diff: '' };
  const git = (...gitArgs: string[]) => spawnSync('git', gitArgs, {
    cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  if (git('rev-parse', '--show-toplevel').status !== 0) return empty;
  const tracked = git('ls-files', '--error-unmatch', '--', `:(literal)${relativePath}`);
  if (tracked.error) throw tracked.error;
  let result;
  if (tracked.status === 0) {
    const hasHead = git('rev-parse', '--verify', 'HEAD').status === 0;
    result = git('--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-color',
      ...(hasHead ? ['HEAD'] : ['--cached']), '--', relativePath);
  } else if (tracked.status === 1) {
    // --no-index returns 1 when it successfully finds differences.
    result = git('diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color',
      '--', '/dev/null', relativePath);
  } else {
    throw new Error(tracked.stderr.trim() || 'Unable to inspect tracked file');
  }
  if (result.error) throw result.error;
  if (result.status !== 0 && !(tracked.status === 1 && result.status === 1)) {
    throw new Error(result.stderr.trim() || 'Unable to read workspace diff');
  }
  const diff = result.stdout;
  return { relativePath, hasDiff: Boolean(diff.trim()), diff };
}

export function handleReadWorkspaceFile(args: any = {}) {
  const payload = args.payload || {};
  const targetCwd = resolveCrossPlatformCwd(payload.workingDirectory || getActiveCwd());
  const rel = payload.relativePath;

  if (!rel || typeof rel !== 'string') {
    throw new Error('Relative path must be a non-empty string');
  }

  // Check for path traversal components
  const normalizedRel = rel.replace(/\\/g, '/');
  const segments = normalizedRel.split('/');
  if (segments.some((seg) => seg === '..')) {
    throw new Error(`Path traversal attempt detected ('..'): ${rel}`);
  }

  const resolvedRoot = path.resolve(targetCwd);
  if (!fs.existsSync(resolvedRoot)) {
    throw new Error(`Workspace root does not exist: ${targetCwd}`);
  }
  const canonicalRoot = fs.realpathSync(resolvedRoot);

  const fullPath = path.resolve(canonicalRoot, rel);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`File not found: ${rel}`);
  }

  const canonicalTarget = fs.realpathSync(fullPath);

  // Security containment check (prevent symlink / traversal escape)
  const rootPrefix = canonicalRoot.endsWith(path.sep) ? canonicalRoot : canonicalRoot + path.sep;
  const isContained =
    canonicalTarget === canonicalRoot ||
    canonicalTarget.startsWith(rootPrefix) ||
    (process.platform === 'win32' &&
      (canonicalTarget.toLowerCase() === canonicalRoot.toLowerCase() ||
        canonicalTarget.toLowerCase().startsWith(rootPrefix.toLowerCase())));

  if (!isContained) {
    throw new Error(`Access denied: path is outside workspace root: ${rel}`);
  }

  const stat = fs.statSync(canonicalTarget);
  if (stat.isDirectory()) {
    throw new Error(`Target path is a directory, not a file: ${rel}`);
  }

  const fileName = path.basename(canonicalTarget);
  const ext = path.extname(fileName).slice(1).toLowerCase() || null;

  // 1. Deterministic binary files (e.g. .so versions, .db-wal) - return metadata without reading bytes
  if (isDeterministicBinary(fileName)) {
    return {
      relativePath: rel,
      name: fileName,
      content: '',
      size: stat.size,
      isBinary: true,
      extension: ext,
      kind: 'binary' as const,
      mimeType: null,
      mediaDataUrl: null,
    };
  }

  // 2. Media files (images and videos) with 25 MB limit
  const imageMime = getImageMimeType(fileName);
  const videoMime = getVideoMimeType(fileName);

  if (imageMime || videoMime) {
    if (stat.size > MAX_MEDIA_FILE_BYTES) {
      throw new Error(
        `File is too large to preview (size: ${stat.size} bytes, maximum allowed: ${MAX_MEDIA_FILE_BYTES} bytes)`
      );
    }

    const buffer = fs.readFileSync(canonicalTarget);
    const mime = (imageMime || videoMime)!;
    const kind = imageMime ? ('image' as const) : ('video' as const);
    const mediaDataUrl = `data:${mime};base64,${buffer.toString('base64')}`;

    return {
      relativePath: rel,
      name: fileName,
      content: '',
      size: stat.size,
      isBinary: true,
      extension: ext,
      kind,
      mimeType: mime,
      mediaDataUrl,
    };
  }

  // 3. Text and unknown binary files with 2 MB limit
  if (stat.size > MAX_TEXT_FILE_BYTES) {
    throw new Error(
      `File is too large to preview (size: ${stat.size} bytes, maximum allowed: ${MAX_TEXT_FILE_BYTES} bytes)`
    );
  }

  const buffer = fs.readFileSync(canonicalTarget);
  if (isBinaryBuffer(buffer)) {
    return {
      relativePath: rel,
      name: fileName,
      content: '',
      size: stat.size,
      isBinary: true,
      extension: ext,
      kind: 'binary' as const,
      mimeType: null,
      mediaDataUrl: null,
    };
  }

  const content = buffer.toString('utf8');
  return {
    relativePath: rel,
    name: fileName,
    content,
    size: stat.size,
    isBinary: false,
    extension: ext,
    kind: 'text' as const,
    mimeType: null,
    mediaDataUrl: null,
  };
}

export function handleGetWorkspaceGitStatus(args: any = {}): WorkspaceGitStatus {
  const payload = args.payload || {};
  const targetCwd = resolveCrossPlatformCwd(payload.workingDirectory || getActiveCwd());
  try {
    if (!fs.existsSync(targetCwd)) {
      return { isRepo: false, modifiedFiles: [], addedFiles: [], untrackedFiles: [] };
    }

    let toplevel: string;
    try {
      toplevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: targetCwd,
        encoding: 'utf8',
        timeout: 1500,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return { isRepo: false, modifiedFiles: [], addedFiles: [], untrackedFiles: [] };
    }

    let canonicalTop: string;
    try {
      canonicalTop = fs.realpathSync(toplevel);
    } catch {
      canonicalTop = path.resolve(toplevel);
    }

    let canonicalCwd: string;
    try {
      canonicalCwd = fs.realpathSync(targetCwd);
    } catch {
      canonicalCwd = path.resolve(targetCwd);
    }

    // Avoid treating the entire user HOME folder as a git repository for sub-projects
    const resolvedHome = path.resolve(HOME_DIR);
    const isHome =
      canonicalTop === resolvedHome ||
      (process.platform === 'win32' && canonicalTop.toLowerCase() === resolvedHome.toLowerCase());

    const repoName = (canonicalTop || canonicalCwd).split(/[\\/]/).filter(Boolean).pop() || 'workspace';

    if (isHome && canonicalCwd !== canonicalTop) {
      return {
        isRepo: false,
        repoName,
        branch: 'main',
        modifiedFiles: [],
        addedFiles: [],
        untrackedFiles: [],
      };
    }

    let branchOut = 'main';
    let upstreamBranch: string | null = null;
    try {
      branchOut = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: targetCwd,
        encoding: 'utf8',
        timeout: 1000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();

      if (branchOut && branchOut !== 'HEAD') {
        const up = execFileSync(
          'git',
          ['for-each-ref', '--format=%(upstream:short)', `refs/heads/${branchOut}`],
          { cwd: targetCwd, encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }
        ).trim();
        upstreamBranch = up || null;
      }
    } catch {}

    const out = execFileSync(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      {
        cwd: targetCwd,
        encoding: 'utf8',
        timeout: 2500,
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    );

    const modifiedFiles: string[] = [];
    const addedFiles: string[] = [];
    const untrackedFiles: string[] = [];

    const tokens = out.split('\0');

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (!token || token.length < 3) continue;

      const x = token[0];
      const y = token[1];
      // Git porcelain delimiter is index 2 (a space ' ').
      // Slicing at index 3 preserves leading/trailing spaces and Unicode in filename.
      const rawPath = token.slice(3);

      // Git status -z rename/copy format:
      // Token 0: XY DESTINATION
      // Token 1: SOURCE (must be consumed, but keep DESTINATION)
      if (x === 'R' || y === 'R' || x === 'C' || y === 'C') {
        if (i + 1 < tokens.length) {
          i++;
        }
      }

      if (!rawPath) continue;

      // Git porcelain v1 paths are repository-root relative regardless of status.relativePaths.
      // Rebase against targetCwd and exclude files outside the active workspace.
      const fullFilePath = path.resolve(canonicalTop, rawPath);
      const relToWorkspace = path.relative(canonicalCwd, fullFilePath);

      if (relToWorkspace.startsWith('..') || path.isAbsolute(relToWorkspace) || !relToWorkspace) {
        continue;
      }

      const workspacePath = process.platform === 'win32'
        ? relToWorkspace.replace(/\\/g, '/')
        : relToWorkspace;

      // Handle staged/worktree classifications:
      // - ?? : untracked files
      // - !! : ignored files (skip)
      // - U in X/Y or AA or DD : conflicts
      // - T in X/Y : type changes
      // - A in X (without unstaged modification) : added
      // - All others (M, R, C, D, AM, etc.) : modified
      if (x === '?' && y === '?') {
        untrackedFiles.push(workspacePath);
      } else if (x === '!' && y === '!') {
        continue;
      } else if (
        x === 'U' ||
        y === 'U' ||
        (x === 'A' && y === 'A') ||
        (x === 'D' && y === 'D') ||
        x === 'T' ||
        y === 'T'
      ) {
        modifiedFiles.push(workspacePath);
      } else if (x === 'A' && y !== 'M') {
        addedFiles.push(workspacePath);
      } else {
        modifiedFiles.push(workspacePath);
      }
    }

    return {
      isRepo: true,
      repoName,
      branch: branchOut || 'main',
      upstreamBranch,
      modifiedFiles,
      addedFiles,
      untrackedFiles,
    };
  } catch {
    return {
      isRepo: false,
      modifiedFiles: [],
      addedFiles: [],
      untrackedFiles: [],
    };
  }
}

/**
 * Sanitizes a candidate git branch name:
 * - Replaces whitespace with hyphens (-).
 * - Removes hyphens adjacent to slashes (e.g. '-/' or '/-' becomes '/').
 * - Collapses consecutive slashes and strips leading/trailing hyphens, slashes, and dots.
 */
export function sanitizeBranchName(name: string): string {
  if (!name || typeof name !== 'string') return '';
  let sanitized = name.trim();
  // 1. Replace all whitespace with hyphens
  sanitized = sanitized.replace(/\s+/g, '-');
  // 2. Remove hyphens adjacent to slashes
  sanitized = sanitized.replace(/-+\/+/g, '/');
  sanitized = sanitized.replace(/\/+-+/g, '/');
  // 3. Collapse multiple consecutive slashes
  sanitized = sanitized.replace(/\/+/g, '/');
  // 4. Strip leading or trailing hyphens, slashes, or dots
  sanitized = sanitized.replace(/^[-/.]+|[-/.]+$/g, '');
  return sanitized;
}

/**
 * Validates a git branch name for safety and git conventions.
 */
export function isValidGitBranchName(name: string): boolean {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (!trimmed || trimmed !== name) return false;
  if (trimmed.startsWith('-') || trimmed.startsWith('.') || trimmed.endsWith('.') || trimmed.endsWith('/')) return false;
  if (trimmed.endsWith('.lock')) return false;
  if (/[\s~^:?*\[\\\]\x00-\x1f\x7f;|&$<>'"{}]/.test(trimmed)) return false;
  if (trimmed.includes('..') || trimmed.includes('//') || trimmed.includes('@{')) return false;
  return true;
}

/**
 * Deduplicates base branch options:
 * - Prioritizes local branch names.
 * - Filters out bare remote names (e.g. 'origin', 'upstream') and '/HEAD'.
 * - If a local branch exists (e.g. 'main'), suppresses redundant remote counterparts (e.g. 'origin/main').
 */
export function deduplicateBaseBranches(localBranches: string[], remoteRefs: string[]): string[] {
  const result: string[] = [];
  const localSet = new Set(localBranches.map((b) => b.trim()).filter(Boolean));

  for (const b of localBranches) {
    const trimmed = b.trim();
    if (trimmed && !result.includes(trimmed)) {
      result.push(trimmed);
    }
  }

  for (const remote of remoteRefs) {
    const trimmed = remote.trim();
    if (!trimmed) continue;
    // Skip bare remote names (like 'origin') and HEAD pointers
    if (!trimmed.includes('/') || trimmed.endsWith('/HEAD')) continue;

    const slashIdx = trimmed.indexOf('/');
    const branchPart = trimmed.slice(slashIdx + 1);

    // If local branch already covers this (e.g. 'main' vs 'origin/main'), skip
    if (localSet.has(branchPart)) {
      continue;
    }

    if (!result.includes(trimmed)) {
      result.push(trimmed);
    }
  }

  return result;
}

/**
 * Lists all local workspace branches, their upstream tracking branches, the active branch,
 * and available base branches (including remotes) for branching off.
 */
export function handleListWorkspaceBranches(args: any = {}): WorkspaceBranchList {
  const payload = args.payload || args || {};
  const targetCwd = resolveCrossPlatformCwd(payload.workingDirectory || getActiveCwd());

  try {
    if (!fs.existsSync(targetCwd)) {
      return { current: null, branches: [], allBases: [] };
    }

    const out = execFileSync(
      'git',
      ['for-each-ref', '--format=%(refname:short)|%(upstream:short)|%(HEAD)', 'refs/heads'],
      { cwd: targetCwd, encoding: 'utf8', timeout: 2500, stdio: ['ignore', 'pipe', 'ignore'] }
    );

    let current: string | null = null;
    const branches: WorkspaceBranch[] = [];

    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [name, upstream, head] = trimmed.split('|');
      if (!name) continue;
      const isCurrent = (head || '').trim() === '*';
      if (isCurrent) {
        current = name;
      }
      branches.push({
        name,
        isCurrent,
        upstream: upstream && upstream.trim() ? upstream.trim() : null,
      });
    }

    const localNames = branches.map((b) => b.name);
    const remoteRefs: string[] = [];
    try {
      const remotesOut = execFileSync(
        'git',
        ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'],
        { cwd: targetCwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }
      );
      for (const line of remotesOut.split('\n')) {
        const b = line.trim();
        if (b) {
          remoteRefs.push(b);
        }
      }
    } catch {}

    const allBases = deduplicateBaseBranches(localNames, remoteRefs);

    let defaultBranch: string | null = null;
    try {
      const symRef = execFileSync(
        'git',
        ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
        { cwd: targetCwd, encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      if (symRef && symRef.includes('/')) {
        defaultBranch = symRef.slice(symRef.indexOf('/') + 1);
      }
    } catch {}

    if (!defaultBranch) {
      if (localNames.includes('main')) {
        defaultBranch = 'main';
      } else if (localNames.includes('master')) {
        defaultBranch = 'master';
      }
    }

    return {
      current,
      defaultBranch,
      branches,
      allBases,
    };
  } catch {
    return {
      current: null,
      defaultBranch: null,
      branches: [],
      allBases: [],
    };
  }
}

/**
 * Switches the active git branch via `git checkout <branch>`.
 * Automatically isolates uncommitted changes per-branch:
 * - Stashes uncommitted working changes of the departure branch so they don't leak into other branches.
 * - Restores any stashed working changes previously saved for the destination branch.
 */
export function handleSwitchWorkspaceBranch(args: any = {}): BranchOperationResult {
  const payload = args.payload || args || {};
  const targetCwd = resolveCrossPlatformCwd(payload.workingDirectory || getActiveCwd());
  const branch = (payload.branch || '').trim();

  if (!isValidGitBranchName(branch)) {
    throw new Error(`Invalid branch name: "${branch}"`);
  }

  // 1. Identify current branch before switching
  let currentBranch = '';
  try {
    currentBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: targetCwd,
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {}

  if (currentBranch && currentBranch === branch) {
    return {
      success: true,
      branch,
      message: 'Already on branch',
    };
  }

  // 2. If departure branch has uncommitted changes, auto-stash them to preserve them on that branch
  let stashedCurrent = false;
  if (currentBranch) {
    try {
      const statusOut = execFileSync('git', ['status', '--porcelain=v1'], {
        cwd: targetCwd,
        encoding: 'utf8',
        timeout: 2500,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (statusOut.trim()) {
        const stashRes = spawnSync('git', ['stash', 'push', '-u', '-m', `Auto-stash on ${currentBranch}`], {
          cwd: targetCwd,
          encoding: 'utf8',
          timeout: 10000,
        });
        if (stashRes.status === 0) {
          stashedCurrent = true;
        }
      }
    } catch {}
  }

  // 3. Perform git checkout to destination branch
  const res = spawnSync('git', ['checkout', branch], {
    cwd: targetCwd,
    encoding: 'utf8',
    timeout: 10000,
  });

  if (res.status !== 0) {
    if (stashedCurrent) {
      try {
        spawnSync('git', ['stash', 'pop'], { cwd: targetCwd, timeout: 5000 });
      } catch {}
    }
    const err = (res.stderr || res.stdout || 'Failed to switch branch').trim();
    throw new Error(err);
  }

  // 4. After checkout, restore any stash saved for destination branch
  try {
    const stashListOut = execFileSync('git', ['stash', 'list'], {
      cwd: targetCwd,
      encoding: 'utf8',
      timeout: 2500,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const lines = stashListOut.split('\n');
    let targetStashRef: string | null = null;

    for (const line of lines) {
      const match = line.match(/^stash@\{(\d+)\}:\s*(?:On|WIP on)\s+([^:]+):\s*(.*)$/);
      if (match) {
        const stashIndex = match[1];
        const stashBranch = match[2].trim();
        if (stashBranch === branch) {
          targetStashRef = `stash@{${stashIndex}}`;
          break;
        }
      }
    }

    if (targetStashRef) {
      spawnSync('git', ['stash', 'pop', targetStashRef], {
        cwd: targetCwd,
        encoding: 'utf8',
        timeout: 10000,
      });
    }
  } catch {}

  return {
    success: true,
    branch,
    message: (res.stderr || res.stdout || '').trim(),
  };
}

/**
 * Creates and switches to a new git branch from an optional base branch via `git checkout -b <name> [baseBranch]`.
 * If `leaveChangesInBase` is true, any uncommitted working changes are stashed prior to checkout,
 * ensuring the new branch starts clean and changes remain in the base branch's stash.
 */
export function handleCreateWorkspaceBranch(args: any = {}): BranchOperationResult {
  const payload = args.payload || args || {};
  const targetCwd = resolveCrossPlatformCwd(payload.workingDirectory || getActiveCwd());
  const rawName = (payload.name || '').trim();
  const name = sanitizeBranchName(rawName);
  const baseBranch = (payload.baseBranch || '').trim();
  const leaveChangesInBase = Boolean(payload.leaveChangesInBase);

  if (!name || !isValidGitBranchName(name)) {
    throw new Error(`Invalid branch name: "${rawName}"`);
  }

  if (baseBranch && !isValidGitBranchName(baseBranch)) {
    throw new Error(`Invalid base branch name: "${baseBranch}"`);
  }

  let stashed = false;
  if (leaveChangesInBase) {
    try {
      const statusOut = execFileSync('git', ['status', '--porcelain=v1'], {
        cwd: targetCwd,
        encoding: 'utf8',
        timeout: 2500,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (statusOut.trim()) {
        const stashRes = spawnSync('git', ['stash', 'push', '-u', '-m', `Auto-stash before branch ${name}`], {
          cwd: targetCwd,
          encoding: 'utf8',
          timeout: 10000,
        });
        if (stashRes.status === 0) {
          stashed = true;
        }
      }
    } catch {}
  }

  const gitArgs = baseBranch
    ? ['checkout', '-b', name, baseBranch]
    : ['checkout', '-b', name];

  const res = spawnSync('git', gitArgs, {
    cwd: targetCwd,
    encoding: 'utf8',
    timeout: 10000,
  });

  if (res.status !== 0) {
    if (stashed) {
      try {
        spawnSync('git', ['stash', 'pop'], { cwd: targetCwd, timeout: 5000 });
      } catch {}
    }
    const err = (res.stderr || res.stdout || 'Failed to create branch').trim();
    throw new Error(err);
  }

  return {
    success: true,
    branch: name,
    message: (res.stderr || res.stdout || '').trim(),
  };
}

/**
 * Deletes a local git branch via `git branch -D <branch>`.
 * Refuses to delete the current branch or the repository default branch.
 */
export function handleDeleteWorkspaceBranch(args: any = {}): BranchOperationResult {
  const payload = args.payload || args || {};
  const targetCwd = resolveCrossPlatformCwd(payload.workingDirectory || getActiveCwd());
  const branch = (payload.branch || '').trim();

  if (!isValidGitBranchName(branch)) {
    throw new Error(`Invalid branch name: "${branch}"`);
  }

  const branchList = handleListWorkspaceBranches({ workingDirectory: targetCwd });
  if (branchList.current === branch) {
    throw new Error(`Cannot delete currently active branch: "${branch}"`);
  }
  if (branchList.defaultBranch && branchList.defaultBranch === branch) {
    throw new Error(`Cannot delete repository default branch: "${branch}"`);
  }
  if (branch === 'main' || branch === 'master') {
    if (branchList.defaultBranch === branch || !branchList.defaultBranch) {
      throw new Error(`Cannot delete repository default branch: "${branch}"`);
    }
  }

  const res = spawnSync('git', ['branch', '-D', branch], {
    cwd: targetCwd,
    encoding: 'utf8',
    timeout: 10000,
  });

  if (res.status !== 0) {
    const err = (res.stderr || res.stdout || 'Failed to delete branch').trim();
    throw new Error(err);
  }

  return {
    success: true,
    branch,
    message: (res.stderr || res.stdout || '').trim(),
  };
}

/**
 * Publishes a local branch to the remote repository and sets up tracking via `git push -u <remote> <branch>`.
 */
export function handlePublishWorkspaceBranch(args: any = {}): BranchOperationResult {
  const payload = args.payload || args || {};
  const targetCwd = resolveCrossPlatformCwd(payload.workingDirectory || getActiveCwd());
  const branch = (payload.branch || '').trim();

  if (!isValidGitBranchName(branch)) {
    throw new Error(`Invalid branch name: "${branch}"`);
  }

  let remote = (payload.remote || '').trim();
  if (!remote) {
    try {
      const remotesOut = execFileSync('git', ['remote'], {
        cwd: targetCwd,
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const remoteList = remotesOut.split('\n').map((r) => r.trim()).filter(Boolean);
      if (remoteList.includes('origin')) {
        remote = 'origin';
      } else if (remoteList.length > 0) {
        remote = remoteList[0];
      } else {
        throw new Error('No git remotes configured in this repository');
      }
    } catch (err: any) {
      throw new Error(err.message || 'Failed to detect git remotes');
    }
  }

  const res = spawnSync('git', ['push', '-u', remote, branch], {
    cwd: targetCwd,
    encoding: 'utf8',
    timeout: 30000,
  });

  if (res.status !== 0) {
    const err = (res.stderr || res.stdout || 'Failed to publish branch').trim();
    throw new Error(err);
  }

  return {
    success: true,
    branch,
    message: (res.stderr || res.stdout || '').trim(),
  };
}

/**
 * Lists paginated commits for a specific git branch and marks unpushed commits.
 */
export function handleListWorkspaceBranchCommits(args: any = {}): WorkspaceBranchCommitsResult {
  const payload = args.payload || args || {};
  const targetCwd = resolveCrossPlatformCwd(payload.workingDirectory || getActiveCwd());
  const branch = (payload.branch || '').trim();

  if (!isValidGitBranchName(branch)) {
    throw new Error(`Invalid branch name: ${branch}`);
  }

  if (!fs.existsSync(targetCwd)) {
    throw new Error(`Workspace path does not exist: ${targetCwd}`);
  }

  const limit = Math.max(1, Math.min(100, Number(payload.limit) || 10));
  const offset = Math.max(0, Number(payload.offset) || 0);

  // 1. Determine unpushed commits for this branch
  const unpushedSet = new Set<string>();
  let checkedUpstream = false;

  // Try branch@{upstream}..branch first
  try {
    const upstreamCommits = execFileSync(
      'git',
      ['rev-list', `${branch}@{upstream}..${branch}`],
      { cwd: targetCwd, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    checkedUpstream = true;
    for (const h of upstreamCommits.split('\n')) {
      const trimmed = h.trim();
      if (trimmed) {
        unpushedSet.add(trimmed);
      }
    }
  } catch {
    // Upstream not configured, or tracking branch gone/invalid
  }

  // Fallback if upstream wasn't checked: check against all remotes
  if (!checkedUpstream) {
    try {
      const remotesCheck = execFileSync(
        'git',
        ['remote'],
        { cwd: targetCwd, encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      if (remotesCheck) {
        const notRemotes = execFileSync(
          'git',
          ['rev-list', branch, '--not', '--remotes'],
          { cwd: targetCwd, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }
        );
        for (const h of notRemotes.split('\n')) {
          const trimmed = h.trim();
          if (trimmed) {
            unpushedSet.add(trimmed);
          }
        }
      } else {
        // No remotes exist at all, all commits are considered local / unpushed
        const allLocal = execFileSync(
          'git',
          ['rev-list', branch],
          { cwd: targetCwd, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }
        );
        for (const h of allLocal.split('\n')) {
          const trimmed = h.trim();
          if (trimmed) {
            unpushedSet.add(trimmed);
          }
        }
      }
    } catch {
      // Ignore rev-list failures on unpushed detection
    }
  }

  // 2. Fetch limit + 1 commits with git log to determine hasMore
  const fetchCount = limit + 1;
  const logArgs = [
    'log',
    `-n`,
    String(fetchCount),
    `--skip=${offset}`,
    branch,
    '--format=%H%x1f%h%x1f%s%x1f%an%x1f%cI',
  ];

  let rawLog = '';
  try {
    rawLog = execFileSync('git', logArgs, {
      cwd: targetCwd,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err: any) {
    throw new Error(err.message || `Failed to read commits for branch ${branch}`);
  }

  const rawLines = rawLog.split('\n').filter((l) => l.trim().length > 0);
  const hasMore = rawLines.length > limit;
  const targetLines = hasMore ? rawLines.slice(0, limit) : rawLines;

  const commits: WorkspaceBranchCommit[] = [];
  for (const line of targetLines) {
    const parts = line.split('\x1f');
    if (parts.length >= 2) {
      const hash = parts[0]?.trim() || '';
      const shortHash = parts[1]?.trim() || hash.slice(0, 7);
      const subject = parts[2]?.trim() || '';
      const author = parts[3]?.trim() || '';
      const date = parts[4]?.trim() || '';

      commits.push({
        hash,
        shortHash,
        subject,
        author,
        date,
        isUnpushed: unpushedSet.has(hash),
      });
    }
  }

  return {
    branch,
    commits,
    hasMore,
  };
}
