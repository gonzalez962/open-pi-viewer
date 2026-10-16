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
    return {
      version: 1,
      extensions: parsed.extensions && typeof parsed.extensions === 'object' && !Array.isArray(parsed.extensions)
        ? parsed.extensions
        : {},
      mcpServers: parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)
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
  identity: string = ''
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
      return isAlwaysActiveExtension(policy, identity);
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

  return false;
}

export function getEffectiveMcpActivation(
  policy: ViewerResourceActivationPolicy,
  cwd?: string | null,
  name: string = ''
): boolean {
  const trimmed = (name || '').trim();

  if (cwd) {
    const local = loadProjectResourceActivation(cwd);
    if (local !== null) {
      if (local.mcpServers && typeof local.mcpServers[trimmed] === 'boolean') {
        return local.mcpServers[trimmed];
      }
      return isAlwaysActiveMcp(policy, trimmed);
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

  return false;
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
  loadProjectResourceActivation(normCwd);
  const piDir = path.join(normCwd, '.pi');
  const targetMcpFile = path.join(piDir, 'mcp.json');

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

  // Supported project candidates in priority order:
  // 1. Native .pi/mcp.json
  // 2. Alternate .mcp.json
  // 3. Alternate .agents/mcp.json
  // 4. Alternate mcp-adapter.json
  const projectCandidates = getSupportedProjectMcpPaths(normCwd);

  let nativeData: any = {};
  let hadNativeFile = false;
  let alternateMetadata: any = {};

  const localProjectDefinitions = new Map<string, any>();

  for (const pFile of projectCandidates) {
    if (fs.existsSync(pFile)) {
      let content: any = {};
      try {
        const raw = fs.readFileSync(pFile, 'utf8');
        content = JSON.parse(raw);
      } catch (e: any) {
        throw new Error(
          `Failed to enforce MCP resource activation: Cannot parse ${pFile}: ${e.message}`
        );
      }

      if (pFile === targetMcpFile) {
        nativeData = content;
        hadNativeFile = true;
      } else {
        for (const [k, v] of Object.entries(content)) {
          if (k !== 'mcpServers' && k !== 'servers' && alternateMetadata[k] === undefined) {
            alternateMetadata[k] = v;
          }
        }
      }

      const sMap = content.mcpServers || content.servers || {};
      for (const [name, def] of Object.entries<any>(sMap)) {
        if (!localProjectDefinitions.has(name)) {
          localProjectDefinitions.set(name, { ...def });
        } else {
          const existing = localProjectDefinitions.get(name)!;
          if (!existing.command && !existing.url && (def.command || def.url)) {
            localProjectDefinitions.set(name, { ...def, ...existing });
          }
        }
      }
    }
  }

  const allServerNames = new Set([
    ...Array.from(localProjectDefinitions.keys()),
    ...globalServers.map((s) => s.name),
  ]);

  if (allServerNames.size === 0 && !hadNativeFile) {
    return;
  }

  const updatedServers: Record<string, any> = {};

  // For all local definitions (from native or alternate candidate files):
  for (const [name, def] of localProjectDefinitions.entries()) {
    const isEffective = getEffectiveMcpActivation(policy, normCwd, name);
    const isGlobal = globalServers.some((g) => g.name === name);

    if (isGlobal && !def.command && !def.url) {
      // Partial override of a global server
      updatedServers[name] = {
        ...def,
        enabled: isEffective,
      };
      delete updatedServers[name].disabled;
    } else {
      // Complete local server definition:
      // Preserved in native file with native enabled
      updatedServers[name] = {
        ...def,
        enabled: isEffective,
      };
      delete updatedServers[name].disabled;
    }
  }

  // For global servers not present in local definitions:
  for (const g of globalServers) {
    if (!localProjectDefinitions.has(g.name)) {
      const isEffective = getEffectiveMcpActivation(policy, normCwd, g.name);
      updatedServers[g.name] = {
        enabled: isEffective,
      };
    }
  }

  const baseData = { ...alternateMetadata, ...nativeData };
  const materializedData = {
    ...baseData,
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
            const clean = src.replace(/^[!+]/, '').trim();
            if (!clean.startsWith('builtin:')) {
              addExt(clean, getPiAgentDir(), globalSettings);
            }
          }
        }
      }
    } catch (e: any) {
      throw new Error(`Failed to discover extensions: Cannot parse settings at ${globalSettings}: ${e.message}`);
    }
  }

  // 2. Global extensions directory
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
          const subPackage = path.join(globalExtDir, e.name, 'package.json');
          let foundManifest = false;
          if (fs.existsSync(subPackage)) {
            try {
              const pkgData = JSON.parse(fs.readFileSync(subPackage, 'utf8'));
              if (Array.isArray(pkgData.pi?.extensions)) {
                for (const rel of pkgData.pi.extensions) {
                  const cleanRel = rel.replace(/^[./\\]+/, '').replace(/\\/g, '/');
                  const fullExt = path.join(globalExtDir, e.name, cleanRel);
                  addExt(
                    `extensions/${e.name}/${cleanRel}`,
                    getPiAgentDir(),
                    fullExt,
                    fullExt,
                    path.join(globalExtDir, e.name)
                  );
                  foundManifest = true;
                }
              }
            } catch {}
          }
          if (!foundManifest) {
            for (const idx of ['index.ts', 'index.js', 'index.mjs']) {
              const fullIdx = path.join(globalExtDir, e.name, idx);
              if (fs.existsSync(fullIdx)) {
                addExt(`extensions/${e.name}/${idx}`, getPiAgentDir(), fullIdx, fullIdx, path.join(globalExtDir, e.name));
                break;
              }
            }
          }
        }
      }
    } catch {}
  }

  // 3. Project settings and extensions (if cwd provided)
  if (cwd) {
    const normCwd = resolveCrossPlatformCwd(cwd);
    const projectCandidates = [
      path.join(normCwd, '.pi', 'settings.json'),
      path.join(normCwd, '.pi.json'),
    ];
    for (const pFile of projectCandidates) {
      if (fs.existsSync(pFile)) {
        try {
          const s = JSON.parse(fs.readFileSync(pFile, 'utf8'));
          if (Array.isArray(s.extensions)) {
            for (const item of s.extensions) {
              const src = typeof item === 'string' ? item : item?.source || item?.path;
              if (src) {
                const clean = src.replace(/^[!+]/, '').trim();
                if (!clean.startsWith('builtin:')) {
                  addExt(clean, path.dirname(pFile), pFile);
                }
              }
            }
          }
        } catch (e: any) {
          throw new Error(`Failed to discover extensions: Cannot parse settings at ${pFile}: ${e.message}`);
        }
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
            const subPackage = path.join(projectExtDir, e.name, 'package.json');
            let foundManifest = false;
            if (fs.existsSync(subPackage)) {
              try {
                const pkgData = JSON.parse(fs.readFileSync(subPackage, 'utf8'));
                if (Array.isArray(pkgData.pi?.extensions)) {
                  for (const rel of pkgData.pi.extensions) {
                    const cleanRel = rel.replace(/^[./\\]+/, '').replace(/\\/g, '/');
                    const fullExt = path.join(projectExtDir, e.name, cleanRel);
                    addExt(
                      `extensions/${e.name}/${cleanRel}`,
                      path.join(normCwd, '.pi'),
                      fullExt,
                      fullExt,
                      path.join(projectExtDir, e.name)
                    );
                    foundManifest = true;
                  }
                }
              } catch {}
            }
            if (!foundManifest) {
              for (const idx of ['index.ts', 'index.js', 'index.mjs']) {
                const fullIdx = path.join(projectExtDir, e.name, idx);
                if (fs.existsSync(fullIdx)) {
                  addExt(`extensions/${e.name}/${idx}`, path.join(normCwd, '.pi'), fullIdx, fullIdx, path.join(projectExtDir, e.name));
                  break;
                }
              }
            }
          }
        }
      } catch {}
    }
  }

  // 4. Policy entries (in case extension is stored in policy but not yet on disk or in settings)
  const policy = loadResourceActivationPolicy();
  const allPolicyExts = [...policy.alwaysExtensions];
  if (cwd) {
    const local = loadProjectResourceActivation(cwd);
    if (local !== null) {
      if (local.extensions) {
        allPolicyExts.push(...Object.keys(local.extensions));
      }
    } else {
      const normCwdKey = normalizeProjectCwd(cwd);
      const projExts = policy.projects?.[normCwdKey]?.extensions;
      if (projExts) {
        allPolicyExts.push(...Object.keys(projExts));
      }
    }
  }
  for (const polExt of allPolicyExts) {
    const norm = normalizeExtensionIdentity(polExt);
    if (!norm) continue;
    if (!seenIdentities.has(norm)) {
      const owningDir = cwd && fs.existsSync(path.join(cwd, polExt))
        ? cwd
        : getPiAgentDir();
      addExt(polExt, owningDir, path.resolve(owningDir, polExt));
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

export async function computeRpcStartupArgs(cwd: string): Promise<string[]> {
  const normCwd = resolveCrossPlatformCwd(cwd);
  // Fail closed immediately if project resource activation exists but is malformed
  const local = loadProjectResourceActivation(normCwd);
  const policy = loadResourceActivationPolicy();
  const args: string[] = ['--no-extensions'];

  // Discover all extensions and filter by effective activation
  const allExtensions = discoverAllExtensions(normCwd);
  const authorizedExtPaths = new Set<string>();

  for (const ext of allExtensions) {
    if (getEffectiveExtensionActivation(policy, normCwd, ext.source)) {
      const runtimePath = ext.extensionPath || resolveExtensionRuntimePath(ext.source, ext.owningDir);
      authorizedExtPaths.add(runtimePath);
    }
  }

  for (const p of authorizedExtPaths) {
    args.push('--extension', p);
  }

  // Check MCP servers
  const globalMcpFile = path.join(getPiAgentDir(), 'mcp.json');
  const globalServers = readMcpServersFromFile(globalMcpFile, 'global');
  const projectCandidates = getSupportedProjectMcpPaths(normCwd);

  const allServerNames = new Set<string>(globalServers.map((s) => s.name));
  for (const pFile of projectCandidates) {
    const pServers = readMcpServersFromFile(pFile, 'project');
    for (const s of pServers) {
      allServerNames.add(s.name);
    }
  }

  // Also include any servers explicitly referenced in policy or local activation
  for (const s of policy.alwaysMcpServers) {
    allServerNames.add(s);
  }
  if (local !== null) {
    if (local.mcpServers) {
      for (const s of Object.keys(local.mcpServers)) {
        allServerNames.add(s);
      }
    }
  } else {
    const normCwdKey = normalizeProjectCwd(normCwd);
    const projMcp = policy.projects?.[normCwdKey]?.mcpServers;
    if (projMcp) {
      for (const s of Object.keys(projMcp)) {
        allServerNames.add(s);
      }
    }
  }

  const hasAuthorizedMcp = Array.from(allServerNames).some((name) =>
    getEffectiveMcpActivation(policy, normCwd, name)
  );

  if (hasAuthorizedMcp) {
    args.push('--extension', 'builtin:mcp');
  } else {
    args.push('--no-mcp');
  }

  return args;
}
