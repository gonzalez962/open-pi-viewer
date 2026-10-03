import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

export interface BridgeConfig {
  baseWorkspace: string;
  nodeExecutable: string;
  piCliPath: string | null;
  engramBinary: string;
  engramServerUrl: string;
  allowUnconfinedNavigation: boolean;
  driveMappings?: Record<string, string>;
  uncMappings?: Record<string, string>;
  customShortcuts?: Array<{ name: string; path: string }>;
}

export function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

export function discoverNodeExecutable(configured?: string): string {
  if (configured && configured.trim() && fs.existsSync(configured.trim())) {
    return path.resolve(configured.trim());
  }
  if (process.env.PI_VIEWER_NODE_PATH && fs.existsSync(process.env.PI_VIEWER_NODE_PATH)) {
    return path.resolve(process.env.PI_VIEWER_NODE_PATH);
  }
  return process.execPath;
}

export function discoverPiCli(configured?: string | null): string | null {
  if (configured && configured.trim() && fs.existsSync(configured.trim())) {
    return path.resolve(configured.trim());
  }
  if (process.env.PI_VIEWER_PI_CLI && fs.existsSync(process.env.PI_VIEWER_PI_CLI)) {
    return path.resolve(process.env.PI_VIEWER_PI_CLI);
  }

  // 1. Try local require.resolve
  try {
    const req = createRequire(import.meta.url);
    const resolved = req.resolve('@earendil-works/pi-coding-agent/dist/bundle/cli.js');
    if (fs.existsSync(resolved)) return path.resolve(resolved);
  } catch {}

  // 2. Try which/where pi
  try {
    const cmd = process.platform === 'win32' ? 'where pi' : 'which pi';
    const out = execSync(cmd, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.endsWith('cli.js') && fs.existsSync(line)) {
        return path.resolve(line);
      }
      // Inspect Windows wrapper scripts (.cmd)
      if (line.endsWith('.cmd')) {
        try {
          const content = fs.readFileSync(line, 'utf8');
          const match = content.match(/["']([^"']*cli\.js)["']/i);
          if (match) {
            const dir = path.dirname(line);
            const resolved = path.resolve(match[1].replace(/%~dp0\\?/g, dir + path.sep));
            if (fs.existsSync(resolved)) return resolved;
          }
        } catch {}
      }
      // Symlink or script resolution on Unix
      try {
        const real = fs.realpathSync(line);
        if (real.endsWith('cli.js') && fs.existsSync(real)) {
          return real;
        }
      } catch {}
    }
  } catch {}

  // 3. Common global locations
  const home = getHomeDir();
  const candidates: string[] = [
    // Windows global pnpm/npm
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js'),
    path.join(process.env.LOCALAPPDATA || '', 'pnpm', 'global', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js'),
    // POSIX global locations
    path.join(home, '.local', 'share', 'pnpm', 'global', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js'),
    '/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
    '/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
  ];

  for (const cand of candidates) {
    if (cand && fs.existsSync(cand)) {
      return path.resolve(cand);
    }
  }

  return null;
}

export function discoverEngramBinary(configured?: string): string {
  if (configured && configured.trim()) {
    const trimmed = configured.trim();
    if (fs.existsSync(trimmed)) return path.resolve(trimmed);
    return trimmed;
  }
  if (process.env.PI_VIEWER_ENGRAM_BIN) {
    const envBin = process.env.PI_VIEWER_ENGRAM_BIN.trim();
    if (fs.existsSync(envBin)) return path.resolve(envBin);
    return envBin;
  }

  const isWin = process.platform === 'win32';
  const binName = isWin ? 'engram.exe' : 'engram';
  const home = getHomeDir();

  const candidates: string[] = [
    path.join(home, 'go', 'bin', binName),
    path.join(home, '.cargo', 'bin', binName),
    path.join(home, '.local', 'bin', binName),
    path.join(home, 'bin', binName),
  ];

  if (!isWin) {
    candidates.push('/usr/local/bin/engram', '/usr/bin/engram');
  }

  for (const cand of candidates) {
    if (fs.existsSync(cand)) {
      return path.resolve(cand);
    }
  }

  // Check PATH via which/where
  try {
    const cmd = isWin ? 'where engram' : 'which engram';
    const out = execSync(cmd, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    const firstLine = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
    if (firstLine && fs.existsSync(firstLine)) {
      return path.resolve(firstLine);
    }
  } catch {}

  return binName;
}

export function getAgnosticExecEnv(): NodeJS.ProcessEnv {
  const home = getHomeDir();
  const isWin = process.platform === 'win32';

  const userBinDirs: string[] = [
    path.join(home, '.local', 'bin'),
    path.join(home, 'go', 'bin'),
    path.join(home, '.cargo', 'bin'),
  ];

  if (isWin) {
    if (process.env.LOCALAPPDATA) {
      userBinDirs.push(path.join(process.env.LOCALAPPDATA, 'pnpm'));
    }
    if (process.env.APPDATA) {
      userBinDirs.push(path.join(process.env.APPDATA, 'npm'));
    }
  } else {
    userBinDirs.push(path.join(home, '.local', 'share', 'pnpm', 'bin'));
  }

  const existingExtraDirs = userBinDirs.filter((d) => fs.existsSync(d));
  const currentPath = process.env.PATH || '';
  const mergedPath = [...existingExtraDirs, currentPath].filter(Boolean).join(path.delimiter);

  return {
    ...process.env,
    PATH: mergedPath,
  };
}

export function loadBridgeConfig(customConfigPath?: string): BridgeConfig {
  const configPath = customConfigPath || path.resolve(process.cwd(), 'server', 'config.json');
  let raw: Partial<BridgeConfig> = {};

  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf8');
      raw = JSON.parse(content);
    } catch (err) {
      console.warn(`[BridgeConfig] Failed to parse config file at ${configPath}:`, err);
    }
  }

  const baseWorkspace =
    raw.baseWorkspace?.trim() ||
    process.env.PI_VIEWER_BASE_WORKSPACE?.trim() ||
    process.cwd();

  const nodeExecutable = discoverNodeExecutable(raw.nodeExecutable);
  const piCliPath = discoverPiCli(raw.piCliPath);
  const engramBinary = discoverEngramBinary(raw.engramBinary);
  const engramServerUrl =
    raw.engramServerUrl?.trim() ||
    process.env.PI_VIEWER_ENGRAM_SERVER_URL?.trim() ||
    'https://engram.example.com';

  const allowUnconfinedNavigation =
    raw.allowUnconfinedNavigation !== undefined ? Boolean(raw.allowUnconfinedNavigation) : true;

  cachedConfig = {
    baseWorkspace: path.resolve(baseWorkspace),
    nodeExecutable,
    piCliPath,
    engramBinary,
    engramServerUrl,
    allowUnconfinedNavigation,
    driveMappings: raw.driveMappings,
    uncMappings: raw.uncMappings,
    customShortcuts: raw.customShortcuts,
  };

  return cachedConfig;
}

let cachedConfig: BridgeConfig | null = null;

export function getBridgeConfig(): BridgeConfig {
  if (!cachedConfig) {
    cachedConfig = loadBridgeConfig();
  }
  return cachedConfig;
}

export function setBridgeConfig(config: BridgeConfig | null): void {
  cachedConfig = config;
}

