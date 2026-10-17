import fs from 'node:fs';
import path from 'node:path';
import { resolveCrossPlatformCwd } from './paths';
import { getPiAgentDir, setPiAgentDirForTest } from './state';
import { readMcpServersFromFile } from './models';

export { getPiAgentDir, setPiAgentDirForTest };

export interface ProjectResourceActivation {
  extensions?: Record<string, boolean>;
  mcpServers?: Record<string, boolean>;
}

export interface ProjectResourceActivationFile {
  version: 1;
  extensions?: Record<string, boolean>;
  mcpServers?: Record<string, boolean>;
}

export interface ViewerResourceActivationPolicy {
  version: 1;
  alwaysExtensions: string[];
  alwaysMcpServers: string[];
  projects: Record<string, ProjectResourceActivation>;
}

export interface SetResourceActivationPayload {
  kind: 'extension' | 'mcp';
  identity: string;
  enabled: boolean;
  cwd?: string;
}

export interface SetResourceActivationResult {
  success: boolean;
}

export const KNOWN_BUILTIN_EXTENSIONS = new Set([
  'builtin:mcp',
  'builtin:llama.cpp',
  'builtin:codemode',
  'builtin:tool-search',
]);

export function normalizeProjectCwd(cwd?: string | null): string {
  const resolved = resolveCrossPlatformCwd(cwd);
  let canonicalPath: string;
  try {
    canonicalPath = fs.realpathSync.native(resolved);
  } catch {
    canonicalPath = path.isAbsolute(resolved) ? resolved : path.resolve(resolved);
  }
  if (process.platform === 'win32') {
    if (canonicalPath.startsWith('\\\\?\\UNC\\')) {
      canonicalPath = '\\\\' + canonicalPath.slice(8);
    } else if (canonicalPath.startsWith('\\\\?\\')) {
      canonicalPath = canonicalPath.slice(4);
    }
    return canonicalPath.toLowerCase();
  }
  return canonicalPath;
}

export function normalizeExtensionIdentity(source: string): string {
  let s = (source || '').trim();
  while (s.startsWith('!') || s.startsWith('+') || s.startsWith('-')) {
    s = s.slice(1).trim();
  }
  let norm = s.replace(/\\/g, '/');
  if (norm.startsWith('./')) {
    norm = norm.slice(2);
  }
  if (norm.startsWith('extensions/')) {
    norm = norm.slice('extensions/'.length);
  }
  return norm.replace(/\/+$/, '');
}

export function extensionIdentitiesMatch(sourceA: string, sourceB: string): boolean {
  if (sourceA === sourceB) return true;
  const a = normalizeExtensionIdentity(sourceA);
  const b = normalizeExtensionIdentity(sourceB);
  if (!a || !b) return false;
  if (a === b) return true;
  for (const idx of ['index.ts', 'index.js', 'index.mjs']) {
    if (a === `${b}/${idx}` || b === `${a}/${idx}`) return true;
  }
  return false;
}

export function getProjectResourceActivationPath(cwd: string): string {
  const normCwd = resolveCrossPlatformCwd(cwd);
  return path.join(normCwd, '.pi', 'resource-activation.json');
}

export function loadProjectResourceActivation(cwd: string): ProjectResourceActivationFile | null {
  const filePath = getProjectResourceActivationPath(cwd);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) {
      throw new Error(`Invalid project resource activation schema or version at ${filePath}`);
    }
    if (Array.isArray(parsed.extensions) || Array.isArray(parsed.mcpServers)) {
      throw new Error(`Invalid project resource activation schema at ${filePath}: extensions and mcpServers must not be arrays`);
    }
    return {
      version: 1,
      extensions: parsed.extensions && typeof parsed.extensions === 'object'
        ? parsed.extensions
        : {},
      mcpServers: parsed.mcpServers && typeof parsed.mcpServers === 'object'
        ? parsed.mcpServers
        : {},
    };
  } catch (err: any) {
    throw new Error(
      `Failed to read project resource activation at ${filePath}: ${err.message}`
    );
  }
}

export function saveProjectResourceActivation(
  cwd: string,
  data: ProjectResourceActivationFile
): void {
  if (Array.isArray(data.extensions) || Array.isArray(data.mcpServers)) {
    throw new Error('Invalid project resource activation schema: extensions and mcpServers must not be arrays');
  }

  const filePath = getProjectResourceActivationPath(cwd);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const payload: ProjectResourceActivationFile = {
    version: 1,
    extensions: data.extensions && typeof data.extensions === 'object' ? data.extensions : {},
    mcpServers: data.mcpServers && typeof data.mcpServers === 'object' ? data.mcpServers : {},
  };

  const content = JSON.stringify(payload, null, 2) + '\n';
  const tmpPath = `${filePath}.tmp.${Date.now()}.${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
}

export function getResourceActivationPolicyPath(): string {
  return path.join(getPiAgentDir(), 'viewer-resource-activation.json');
}

export function loadResourceActivationPolicy(): ViewerResourceActivationPolicy {
  const filePath = getResourceActivationPolicyPath();
  const defaultPolicy: ViewerResourceActivationPolicy = {
    version: 1,
    alwaysExtensions: [],
    alwaysMcpServers: [],
    projects: {},
  };

  if (!fs.existsSync(filePath)) {
    return defaultPolicy;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      version: 1,
      alwaysExtensions: Array.isArray(parsed.alwaysExtensions) ? parsed.alwaysExtensions : [],
      alwaysMcpServers: Array.isArray(parsed.alwaysMcpServers) ? parsed.alwaysMcpServers : [],
      projects: parsed.projects && typeof parsed.projects === 'object' ? parsed.projects : {},
    };
  } catch (err: any) {
    throw new Error(
      `Failed to read viewer resource activation policy at ${filePath}: ${err.message}`
    );
  }
}

export function saveResourceActivationPolicy(policy: ViewerResourceActivationPolicy): void {
  const filePath = getResourceActivationPolicyPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const payload: ViewerResourceActivationPolicy = {
    version: 1,
    alwaysExtensions: Array.isArray(policy.alwaysExtensions) ? policy.alwaysExtensions : [],
    alwaysMcpServers: Array.isArray(policy.alwaysMcpServers) ? policy.alwaysMcpServers : [],
    projects: policy.projects && typeof policy.projects === 'object' ? policy.projects : {},
  };

  const content = JSON.stringify(payload, null, 2) + '\n';
  const tmpPath = `${filePath}.tmp.${Date.now()}.${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
}

export function isAlwaysActiveExtension(
  policy: ViewerResourceActivationPolicy,
  identity: string
): boolean {
  if (!Array.isArray(policy.alwaysExtensions)) return false;
  return policy.alwaysExtensions.some((ext) => extensionIdentitiesMatch(ext, identity));
}

export function isAlwaysActiveMcp(
  policy: ViewerResourceActivationPolicy,
  name: string
): boolean {
  if (!Array.isArray(policy.alwaysMcpServers)) return false;
  const trimmed = (name || '').trim();
  return policy.alwaysMcpServers.includes(trimmed);
}

export function getEffectiveExtensionActivation(
  policy: ViewerResourceActivationPolicy,
  cwd?: string | null,
  identity: string = '',
  nativeDefaultEnabled: boolean = true
): boolean {
  if (cwd) {
    const local = loadProjectResourceActivation(cwd);
    if (local !== null) {
      if (local.extensions) {
        if (typeof local.extensions[identity] === 'boolean') {
          return local.extensions[identity];
        }
        for (const [key, val] of Object.entries(local.extensions)) {
          if (typeof val === 'boolean' && extensionIdentitiesMatch(key, identity)) {
            return val;
          }
        }
      }
      if (isAlwaysActiveExtension(policy, identity)) {
        return true;
      }
      return nativeDefaultEnabled;
    }

    const normCwd = normalizeProjectCwd(cwd);
    const project = policy.projects?.[normCwd];
    if (project?.extensions) {
      if (typeof project.extensions[identity] === 'boolean') {
        return project.extensions[identity];
      }
      for (const [key, val] of Object.entries(project.extensions)) {
        if (typeof val === 'boolean' && extensionIdentitiesMatch(key, identity)) {
          return val;
        }
      }
    }
  }

  if (isAlwaysActiveExtension(policy, identity)) {
    return true;
  }

  return nativeDefaultEnabled;
}

export function getEffectiveMcpActivation(
  policy: ViewerResourceActivationPolicy,
  cwd?: string | null,
  name: string = '',
  nativeDefaultEnabled: boolean = true
): boolean {
  const trimmed = (name || '').trim();

  if (cwd) {
    const local = loadProjectResourceActivation(cwd);
    if (local !== null) {
      if (local.mcpServers && typeof local.mcpServers[trimmed] === 'boolean') {
        return local.mcpServers[trimmed];
      }
      if (isAlwaysActiveMcp(policy, trimmed)) {
        return true;
      }
      return nativeDefaultEnabled;
    }

    const normCwd = normalizeProjectCwd(cwd);
    const project = policy.projects?.[normCwd];
    if (project?.mcpServers) {
      if (typeof project.mcpServers[trimmed] === 'boolean') {
        return project.mcpServers[trimmed];
      }
    }
  }

  if (isAlwaysActiveMcp(policy, trimmed)) {
    return true;
  }

  return nativeDefaultEnabled;
}

export function getNativeProjectMcpPath(cwd: string): string {
  const normCwd = resolveCrossPlatformCwd(cwd);
  return path.join(normCwd, '.pi', 'mcp.json');
}

export function getSupportedProjectMcpPaths(cwd: string): string[] {
  const normCwd = resolveCrossPlatformCwd(cwd);
  return [
    path.join(normCwd, '.pi', 'mcp.json'),
    path.join(normCwd, '.mcp.json'),
    path.join(normCwd, 'mcp-adapter.json'),
    path.join(normCwd, '.agents', 'mcp.json'),
  ];
}

export async function setResourceActivation(
  payload: SetResourceActivationPayload
): Promise<SetResourceActivationResult> {
  if (!payload || (payload.kind !== 'extension' && payload.kind !== 'mcp')) {
    throw new Error(`Invalid resource kind '${payload?.kind}'. Expected 'extension' or 'mcp'`);
  }
  if (!payload.identity || typeof payload.identity !== 'string' || !payload.identity.trim()) {
    throw new Error('Identity is required and must be a non-empty string');
  }
  if (typeof payload.enabled !== 'boolean') {
    throw new Error('Enabled must be a boolean');
  }

  const identity = payload.identity.trim();
  const isClearingGlobalException = !payload.cwd && !payload.enabled;

  if (!isClearingGlobalException) {
    if (payload.kind === 'mcp') {
      const globalMcpFile = path.join(getPiAgentDir(), 'mcp.json');
      const globalServers = readMcpServersFromFile(globalMcpFile, 'global');
      let knownMcp = globalServers.some((s) => s.name === identity);
      if (!knownMcp && payload.cwd) {
        const projectMcpFile = getNativeProjectMcpPath(payload.cwd);
        const projectServers = readMcpServersFromFile(projectMcpFile, 'project');
        knownMcp = projectServers.some((s) => s.name === identity);
      }
      if (!knownMcp) {
        throw new Error(`Unknown MCP server '${identity}'`);
      }
    } else {
      let knownExt = KNOWN_BUILTIN_EXTENSIONS.has(identity);
      if (!knownExt) {
        const exts = discoverAllExtensions(payload.cwd);
        knownExt = exts.some((e) => extensionIdentitiesMatch(e.source, identity));
      }
      if (!knownExt) {
        throw new Error(`Unknown extension identity '${identity}'`);
      }
    }
  }

  if (payload.cwd && payload.cwd.trim()) {
    const local = loadProjectResourceActivation(payload.cwd);

    if (local === null) {
      const policy = loadResourceActivationPolicy();
      const normCwd = normalizeProjectCwd(payload.cwd);
      const legacy = policy.projects?.[normCwd];
      const seededExtensions: Record<string, boolean> = legacy?.extensions ? { ...legacy.extensions } : {};
      const seededMcpServers: Record<string, boolean> = legacy?.mcpServers ? { ...legacy.mcpServers } : {};

      if (payload.kind === 'extension') {
        for (const k of Object.keys(seededExtensions)) {
          if (extensionIdentitiesMatch(k, identity) && k !== identity) {
            delete seededExtensions[k];
          }
        }
        seededExtensions[identity] = payload.enabled;
      } else {
        seededMcpServers[identity] = payload.enabled;
      }

      saveProjectResourceActivation(payload.cwd, {
        version: 1,
        extensions: seededExtensions,
        mcpServers: seededMcpServers,
      });
    } else {
      if (payload.kind === 'extension') {
        if (!local.extensions) local.extensions = {};
        for (const k of Object.keys(local.extensions)) {
          if (extensionIdentitiesMatch(k, identity) && k !== identity) {
            delete local.extensions[k];
          }
        }
        local.extensions[identity] = payload.enabled;
      } else {
        if (!local.mcpServers) local.mcpServers = {};
        local.mcpServers[identity] = payload.enabled;
      }

      saveProjectResourceActivation(payload.cwd, local);
    }
    return { success: true };
  }

  const policy = loadResourceActivationPolicy();
  if (payload.kind === 'extension') {
    if (payload.enabled) {
      if (!policy.alwaysExtensions.some((ext) => extensionIdentitiesMatch(ext, identity))) {
        policy.alwaysExtensions.push(identity);
      }
    } else {
      policy.alwaysExtensions = policy.alwaysExtensions.filter(
        (ext) => !extensionIdentitiesMatch(ext, identity)
      );
    }
  } else {
    if (payload.enabled) {
      if (!policy.alwaysMcpServers.includes(identity)) {
        policy.alwaysMcpServers.push(identity);
      }
    } else {
      policy.alwaysMcpServers = policy.alwaysMcpServers.filter((s) => s !== identity);
    }
  }

  saveResourceActivationPolicy(policy);
  return { success: true };
}

export async function materializeProjectMcpEnforcement(cwd: string): Promise<void> {
  const normCwd = resolveCrossPlatformCwd(cwd);
  // Fail closed immediately if project resource activation exists but is malformed
  const local = loadProjectResourceActivation(normCwd);
  const piDir = path.join(normCwd, '.pi');
  const targetMcpFile = getNativeProjectMcpPath(normCwd);

  const policy = loadResourceActivationPolicy();
  const globalMcpFile = path.join(getPiAgentDir(), 'mcp.json');
  if (fs.existsSync(globalMcpFile)) {
    try {
      JSON.parse(fs.readFileSync(globalMcpFile, 'utf8'));
    } catch (e: any) {
      throw new Error(
        `Failed to enforce MCP resource activation: Cannot parse global ${globalMcpFile}: ${e.message}`
      );
    }
  }
  const globalServers = readMcpServersFromFile(globalMcpFile, 'global');

  // Shallow MCP enforcement: only native .pi/mcp.json, ignore alternate files
  let nativeData: any = {};

  if (fs.existsSync(targetMcpFile)) {
    try {
      nativeData = JSON.parse(fs.readFileSync(targetMcpFile, 'utf8'));
    } catch (e: any) {
      throw new Error(
        `Failed to enforce MCP resource activation: Cannot parse ${targetMcpFile}: ${e.message}`
      );
    }
  }

  const normCwdKey = normalizeProjectCwd(normCwd);
  const localOverrides = local?.mcpServers ?? policy.projects?.[normCwdKey]?.mcpServers ?? {};

  const sMap = nativeData.mcpServers || nativeData.servers || {};
  let hasChanges = false;
  const updatedServers: Record<string, any> = {};

  // Preserve raw local definitions without synthetic enabled additions
  for (const [name, def] of Object.entries<any>(sMap)) {
    updatedServers[name] = { ...def };
  }

  // Only modify explicit overrides
  for (const [name, overrideEnabled] of Object.entries(localOverrides)) {
    if (typeof overrideEnabled === 'boolean') {
      const existing = updatedServers[name];
      if (existing) {
        if (existing.enabled !== overrideEnabled) {
          updatedServers[name] = { ...existing, enabled: overrideEnabled };
          delete updatedServers[name].disabled;
          hasChanges = true;
        }
      } else {
        const isGlobal = globalServers.some((g) => g.name === name);
        if (isGlobal) {
          updatedServers[name] = { enabled: overrideEnabled };
          hasChanges = true;
        }
      }
    }
  }

  // Also check always positives from policy for existing or global servers if not already set
  for (const alwaysName of policy.alwaysMcpServers) {
    if (localOverrides[alwaysName] === undefined) {
      const existing = updatedServers[alwaysName];
      if (existing && existing.enabled === false) {
        updatedServers[alwaysName] = { ...existing, enabled: true };
        delete updatedServers[alwaysName].disabled;
        hasChanges = true;
      }
    }
  }

  // If no changes occurred (or no native file and no explicit overrides): return without writing
  if (!hasChanges) {
    return;
  }

  const materializedData = {
    ...nativeData,
    mcpServers: updatedServers,
  };
  if (nativeData.servers && !nativeData.mcpServers) {
    materializedData.servers = updatedServers;
    delete materializedData.mcpServers;
  }

  try {
    if (!fs.existsSync(piDir)) {
      fs.mkdirSync(piDir, { recursive: true });
    }
  } catch (err: any) {
    throw new Error(
      `Failed to enforce MCP resource activation: cannot create directory ${piDir}: ${err.message}`
    );
  }

  const tmpFile = path.join(piDir, `mcp.json.tmp.${Date.now()}.${process.pid}`);
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(materializedData, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpFile, targetMcpFile);
  } catch (err: any) {
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch {}
    throw new Error(
      `Failed to enforce MCP resource activation: cannot write ${targetMcpFile}: ${err.message}`
    );
  }
}

export interface DiscoveredExtension {
  source: string;
  owningDir: string;
  configPath: string;
  extensionPath?: string;
  extensionDir?: string;
}

export function discoverAllExtensions(cwd?: string): DiscoveredExtension[] {
  const result: DiscoveredExtension[] = [];
  const seenIdentities = new Set<string>();

  function addExt(
    source: string,
    owningDir: string,
    configPath: string,
    extensionPath?: string,
    extensionDir?: string
  ) {
    const norm = normalizeExtensionIdentity(source);
    if (!norm) return;
    if (seenIdentities.has(norm)) return;
    seenIdentities.add(norm);
    const resolvedPath = extensionPath || resolveExtensionRuntimePath(source, owningDir);
    const resolvedDir = extensionDir || path.dirname(resolvedPath);
    result.push({
      source,
      owningDir,
      configPath,
      extensionPath: resolvedPath,
      extensionDir: resolvedDir,
    });
  }

  // 1. Global settings.json
  const globalSettings = path.join(getPiAgentDir(), 'settings.json');
  if (fs.existsSync(globalSettings)) {
    try {
      const s = JSON.parse(fs.readFileSync(globalSettings, 'utf8'));
      if (Array.isArray(s.extensions)) {
        for (const item of s.extensions) {
          const src = typeof item === 'string' ? item : item?.source || item?.path;
          if (src) {
            const trimmed = src.trim();
            if (trimmed.includes('*')) continue;
            const clean = trimmed.replace(/^[!+-]/, '').trim();
            if (!clean) continue;
            if (clean.startsWith('builtin:')) {
              addExt(clean, getPiAgentDir(), globalSettings, undefined, undefined);
            } else {
              addExt(clean, getPiAgentDir(), globalSettings);
            }
          }
        }
      }
    } catch (e: any) {
      throw new Error(`Failed to discover extensions: Cannot parse settings at ${globalSettings}: ${e.message}`);
    }
  }

  // 2. Global extensions directory: top-level files and folders as ONE root, no manifest traversal
  const globalExtDir = path.join(getPiAgentDir(), 'extensions');
  if (fs.existsSync(globalExtDir)) {
    try {
      const entries = fs.readdirSync(globalExtDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        if (e.isFile() && (e.name.endsWith('.ts') || e.name.endsWith('.js') || e.name.endsWith('.mjs')) && !e.name.endsWith('.d.ts')) {
          const fullPath = path.join(globalExtDir, e.name);
          addExt(`extensions/${e.name}`, getPiAgentDir(), fullPath, fullPath, globalExtDir);
        } else if (e.isDirectory()) {
          const fullPath = path.join(globalExtDir, e.name);
          addExt(`extensions/${e.name}`, getPiAgentDir(), fullPath, fullPath, fullPath);
        }
      }
    } catch {}
  }

  // 3. Project settings and extensions (if cwd provided)
  if (cwd) {
    const normCwd = resolveCrossPlatformCwd(cwd);
    const projectSettings = path.join(normCwd, '.pi', 'settings.json');
    if (fs.existsSync(projectSettings)) {
      try {
        const s = JSON.parse(fs.readFileSync(projectSettings, 'utf8'));
        if (Array.isArray(s.extensions)) {
          for (const item of s.extensions) {
            const src = typeof item === 'string' ? item : item?.source || item?.path;
            if (src) {
              const trimmed = src.trim();
              if (trimmed.includes('*')) continue;
              const clean = trimmed.replace(/^[!+-]/, '').trim();
              if (!clean) continue;
              if (clean.startsWith('builtin:')) {
                addExt(clean, path.dirname(projectSettings), projectSettings, undefined, undefined);
              } else {
                addExt(clean, path.dirname(projectSettings), projectSettings);
              }
            }
          }
        }
      } catch (e: any) {
        throw new Error(`Failed to discover extensions: Cannot parse settings at ${projectSettings}: ${e.message}`);
      }
    }

    const projectExtDir = path.join(normCwd, '.pi', 'extensions');
    if (fs.existsSync(projectExtDir)) {
      try {
        const entries = fs.readdirSync(projectExtDir, { withFileTypes: true });
        for (const e of entries) {
          if (e.name.startsWith('.')) continue;
          if (e.isFile() && (e.name.endsWith('.ts') || e.name.endsWith('.js') || e.name.endsWith('.mjs')) && !e.name.endsWith('.d.ts')) {
            const fullPath = path.join(projectExtDir, e.name);
            addExt(`extensions/${e.name}`, path.join(normCwd, '.pi'), fullPath, fullPath, projectExtDir);
          } else if (e.isDirectory()) {
            const fullPath = path.join(projectExtDir, e.name);
            addExt(`extensions/${e.name}`, path.join(normCwd, '.pi'), fullPath, fullPath, fullPath);
          }
        }
      } catch {}
    }
  }

  return result;
}

export function resolveExtensionRuntimePath(source: string, owningDir: string): string {
  if (path.isAbsolute(source)) {
    return path.resolve(source);
  }
  return path.resolve(owningDir, source);
}

export async function materializeProjectExtensionEnforcement(cwd: string): Promise<void> {
  const normCwd = resolveCrossPlatformCwd(cwd);
  const local = loadProjectResourceActivation(normCwd);
  const policy = loadResourceActivationPolicy();
  const normCwdKey = normalizeProjectCwd(normCwd);
  const localOverrides = local?.extensions ?? policy.projects?.[normCwdKey]?.extensions ?? {};

  // Merge applicable global always positives into overrides fallback true
  const mergedOverrides: Record<string, boolean> = { ...localOverrides };
  for (const alwaysExt of policy.alwaysExtensions) {
    if (mergedOverrides[alwaysExt] === undefined) {
      mergedOverrides[alwaysExt] = true;
    }
  }

  const projectSettingsPath = path.join(normCwd, '.pi', 'settings.json');
  let settings: any = {};
  if (fs.existsSync(projectSettingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(projectSettingsPath, 'utf8'));
    } catch (e: any) {
      throw new Error(`Failed to enforce extension activation: Cannot parse ${projectSettingsPath}: ${e.message}`);
    }
  }

  const allExtensions = discoverAllExtensions(normCwd);
  if (!Array.isArray(settings.extensions)) {
    settings.extensions = [];
  }
  let hasChanges = false;

  for (const [key, enabled] of Object.entries(mergedOverrides)) {
    if (typeof enabled !== 'boolean') continue;

    // Built-in handling: builtin:mcp, etc.
    const cleanKey = key.replace(/^[!+-]/, '').trim();
    if (cleanKey.startsWith('builtin:') && KNOWN_BUILTIN_EXTENSIONS.has(cleanKey)) {
      const minus = `-${cleanKey}`;
      const plus = `+${cleanKey}`;
      if (!enabled) {
        if (!settings.extensions.includes(minus)) {
          settings.extensions = settings.extensions.filter((e: any) => e !== plus && e !== cleanKey);
          settings.extensions.push(minus);
          hasChanges = true;
        }
      } else {
        if (!settings.extensions.includes(plus) && !settings.extensions.includes(cleanKey)) {
          settings.extensions = settings.extensions.filter((e: any) => e !== minus);
          settings.extensions.push(plus);
          hasChanges = true;
        }
      }
      continue;
    }

    // Skip hidden child paths and unknown policies: only match current top-level roots
    const root = allExtensions.find((ext) => extensionIdentitiesMatch(ext.source, key));
    if (!root) continue;

    const runtimePath = root.extensionPath || resolveExtensionRuntimePath(root.source, root.owningDir);
    let isFolder = false;
    try {
      isFolder = fs.existsSync(runtimePath) && fs.statSync(runtimePath).isDirectory();
    } catch {}

    if (isFolder) {
      const posixDir = runtimePath.replace(/\\/g, '/');
      const folderGlob = `!${posixDir}/**`;
      if (!enabled) {
        settings.extensions = settings.extensions.filter((e: any) => e !== folderGlob);
        if (!settings.extensions.includes(posixDir)) settings.extensions.push(posixDir);
        if (!settings.extensions.includes(folderGlob)) settings.extensions.push(folderGlob);
        hasChanges = true;
      } else {
        const hadGlob = settings.extensions.includes(folderGlob);
        settings.extensions = settings.extensions.filter((e: any) => e !== folderGlob);
        if (!settings.extensions.includes(posixDir)) {
          settings.extensions.push(posixDir);
          hasChanges = true;
        } else if (hadGlob) {
          hasChanges = true;
        }
      }
    } else {
      const posixPath = runtimePath.replace(/\\/g, '/');
      const minus = `-${posixPath}`;
      const cleanRel = root.source.replace(/^[!+-]/, '').trim().replace(/\\/g, '/');

      if (!enabled) {
        settings.extensions = settings.extensions.filter((e: any) => e !== `+${posixPath}` && e !== `+${cleanRel}`);
        if (!settings.extensions.includes(posixPath)) settings.extensions.push(posixPath);
        if (!settings.extensions.includes(minus)) settings.extensions.push(minus);
        hasChanges = true;
      } else {
        const hadMinus = settings.extensions.some((e: any) => e === minus || e === `-${cleanRel}`);
        settings.extensions = settings.extensions.filter((e: any) => e !== minus && e !== `-${cleanRel}`);
        if (!settings.extensions.includes(posixPath)) {
          settings.extensions.push(posixPath);
          hasChanges = true;
        } else if (hadMinus) {
          hasChanges = true;
        }
      }
    }
  }

  if (!hasChanges) {
    return;
  }

  const piDir = path.join(normCwd, '.pi');
  if (!fs.existsSync(piDir)) {
    fs.mkdirSync(piDir, { recursive: true });
  }

  const tmpPath = `${projectSettingsPath}.tmp.${Date.now()}.${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, projectSettingsPath);
  } catch (err: any) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    throw new Error(`Failed to write ${projectSettingsPath}: ${err.message}`);
  }
}

export async function computeRpcStartupArgs(cwd: string): Promise<string[]> {
  const normCwd = resolveCrossPlatformCwd(cwd);
  // Fail closed immediately if project resource activation exists but is malformed
  loadProjectResourceActivation(normCwd);
  loadResourceActivationPolicy();
  await materializeProjectExtensionEnforcement(normCwd);
  return [];
}
