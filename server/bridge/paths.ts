import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { getHomeDir, getBridgeConfig } from '../config';
import { HOME_DIR, getActiveCwd } from './state';

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
  const fullDir = path.join(targetCwd, rel);

  if (!fs.existsSync(fullDir)) return [];

  const entries = fs.readdirSync(fullDir, { withFileTypes: true });
  const results: any[] = [];

  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name === 'target' || e.name === 'dist') {
      continue;
    }
    const isDir = e.isDirectory();
    const eRel = rel ? path.join(rel, e.name) : e.name;
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
  const fullPath = path.join(targetCwd, rel);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`File not found: ${rel}`);
  }

  const stat = fs.statSync(fullPath);
  const content = fs.readFileSync(fullPath, 'utf8');

  return {
    relativePath: rel,
    name: path.basename(rel),
    content,
    size: stat.size,
    isBinary: false,
    extension: path.extname(rel).slice(1) || null,
  };
}

export function handleGetWorkspaceGitStatus(args: any = {}) {
  const payload = args.payload || {};
  const targetCwd = resolveCrossPlatformCwd(payload.workingDirectory || getActiveCwd());
  try {
    if (!fs.existsSync(targetCwd)) {
      return { isRepo: false, modifiedFiles: [], addedFiles: [], untrackedFiles: [] };
    }

    const toplevel = execSync('git rev-parse --show-toplevel', {
      cwd: targetCwd,
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    // Avoid treating the entire user HOME folder as a git repository for sub-projects
    if (toplevel === HOME_DIR && targetCwd !== HOME_DIR) {
      return {
        isRepo: false,
        repoName: path.basename(targetCwd),
        branch: 'main',
        modifiedFiles: [],
        addedFiles: [],
        untrackedFiles: [],
      };
    }

    const out = execSync('git status --porcelain', {
      cwd: targetCwd,
      encoding: 'utf8',
      timeout: 2500,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    let branchOut = 'main';
    try {
      branchOut = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: targetCwd,
        encoding: 'utf8',
        timeout: 1000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {}

    const modifiedFiles: string[] = [];
    const addedFiles: string[] = [];
    const untrackedFiles: string[] = [];

    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const status = line.slice(0, 2);
      const file = line.slice(3).trim();
      if (status.includes('M')) modifiedFiles.push(file);
      else if (status.includes('A')) addedFiles.push(file);
      else if (status.includes('?')) untrackedFiles.push(file);
      else modifiedFiles.push(file);
    }

    return {
      isRepo: true,
      repoName: path.basename(toplevel || targetCwd),
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
