import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getHomeDir, getBridgeConfig } from '../config';
import { HOME_DIR, getActiveCwd } from './state';
import type { WorkspaceGitStatus } from '../../src/core/types/workspace';
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
  const fullDir = path.resolve(targetCwd, rel);

  if (!fs.existsSync(fullDir)) return [];

  const entries = fs.readdirSync(fullDir, { withFileTypes: true });
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
        const st = fs.statSync(path.join(fullDir, e.name));
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
    try {
      branchOut = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: targetCwd,
        encoding: 'utf8',
        timeout: 1000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
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
