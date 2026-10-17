import fs from 'node:fs';
import path from 'node:path';
import {
  PI_AGENT_DIR,
  getPiAgentDir,
  getActiveCwd,
  setActiveModel,
  setActiveThinkingLevel,
} from './state';
import { piRpc } from './rpc';
import {
  loadResourceActivationPolicy,
  loadProjectResourceActivation,
  isAlwaysActiveMcp,
  isAlwaysActiveExtension,
  getEffectiveMcpActivation,
  setResourceActivation,
  normalizeProjectCwd,
  extensionIdentitiesMatch,
  getNativeProjectMcpPath,
  resolveExtensionRuntimePath,
  KNOWN_BUILTIN_EXTENSIONS,
} from './resource-activation';

export function readMcpServersFromFile(filePath: string, scope: 'global' | 'project'): any[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const sMap = data.mcpServers || data.servers || {};
    return Object.entries<any>(sMap).map(([name, cfg]) => {
      const isNativeEnabled = cfg.enabled !== false;
      return {
        name,
        command: cfg.command || '',
        args: cfg.args || [],
        url: cfg.url || undefined,
        serverType: cfg.url ? 'sse' : 'stdio',
        envKeys: cfg.env ? Object.keys(cfg.env) : [],
        disabled: !isNativeEnabled,
        enabled: isNativeEnabled,
        scope,
        configPath: filePath,
        env: cfg.env || {},
        headers: cfg.headers || {},
      };
    });
  } catch (err: any) {
    throw new Error(`Failed to parse MCP configuration file at ${filePath}: ${err.message}`);
  }
}

export function getMcpServersImpl(cwd?: string) {
  const mcpGlobalFile = path.join(getPiAgentDir(), 'mcp.json');
  const serverMap = new Map<string, any>();

  const globalServers = readMcpServersFromFile(mcpGlobalFile, 'global');
  for (const s of globalServers) {
    serverMap.set(s.name, { ...s, scope: 'global', hasProjectOverride: false });
  }

  if (cwd) {
    const projectMcpFile = getNativeProjectMcpPath(cwd);
    if (fs.existsSync(projectMcpFile)) {
      const pServers = readMcpServersFromFile(projectMcpFile, 'project');
      for (const p of pServers) {
        if (serverMap.has(p.name)) {
          const existing = serverMap.get(p.name)!;
          const isPartial = !p.command && !p.url;
          serverMap.set(p.name, {
            ...existing,
            name: existing.name,
            command: isPartial ? existing.command : p.command,
            args: isPartial ? existing.args : p.args,
            url: isPartial ? existing.url : p.url,
            env: isPartial ? existing.env : p.env,
            headers: isPartial ? existing.headers : p.headers,
            serverType: isPartial ? existing.serverType : p.serverType,
            disabled: p.disabled,
            enabled: p.enabled,
            scope: isPartial ? 'global' : 'project',
            hasProjectOverride: true,
            configPath: projectMcpFile,
          });
        } else {
          serverMap.set(p.name, {
            ...p,
            scope: 'project',
            hasProjectOverride: false,
          });
        }
      }
    }
  }

  const policy = loadResourceActivationPolicy();
  const local = cwd ? loadProjectResourceActivation(cwd) : null;
  const normCwd = cwd ? normalizeProjectCwd(cwd) : null;

  const servers = Array.from(serverMap.values()).map((s) => {
    const alwaysActive = isAlwaysActiveMcp(policy, s.name);
    const nativeDefault = s.enabled !== false;
    if (cwd) {
      let hasPolicyOverride = false;
      if (local !== null) {
        hasPolicyOverride = typeof local.mcpServers?.[s.name] === 'boolean';
      } else if (normCwd) {
        hasPolicyOverride = typeof policy.projects?.[normCwd]?.mcpServers?.[s.name] === 'boolean';
      }
      const effective = getEffectiveMcpActivation(policy, cwd, s.name, nativeDefault);
      return {
        ...s,
        alwaysActive,
        enabled: effective,
        disabled: !effective,
        hasProjectOverride: Boolean(s.hasProjectOverride || hasPolicyOverride),
      };
    } else {
      const effective = alwaysActive ? true : nativeDefault;
      return {
        ...s,
        alwaysActive,
        enabled: effective,
        disabled: !effective,
      };
    }
  });

  return { servers };
}

export function getPiResourcesImpl(cwd?: string) {
  const resources: any[] = [];
  const local = cwd ? loadProjectResourceActivation(cwd) : null;

  function resolveExtensionMeta(
    rawItem: any,
    source: string,
    owningDir: string,
    configPath: string
  ) {
    const declaredName =
      typeof rawItem === 'object' && rawItem?.name && typeof rawItem.name === 'string' && rawItem.name.trim()
        ? rawItem.name.trim()
        : null;
    const extPath = resolveExtensionRuntimePath(source, owningDir);
    const extDir = path.dirname(extPath);
    const entryBase = path.basename(source);
    const isIndexTrio = ['index.ts', 'index.js', 'index.mjs'].includes(entryBase);

    let name: string;
    if (declaredName) {
      name = declaredName;
    } else if (isIndexTrio) {
      name = path.basename(extDir) || source.replace(/\.(ts|js|mjs)$/, '').split(/[\/\\]/).pop() || source;
    } else {
      name = source.replace(/\.(ts|js|mjs)$/, '').split(/[\/\\]/).pop() || source;
    }

    return {
      name,
      extensionPath: extPath,
      extensionDir: extDir,
      configPath,
    };
  }

  function addOrMergeResource(r: any) {
    const existingIndex = resources.findIndex((item) => {
      if (item.kind !== r.kind) return false;
      if (r.kind === 'extension') {
        return extensionIdentitiesMatch(item.source, r.source);
      }
      return item.source === r.source;
    });

    if (existingIndex >= 0) {
      const existing = resources[existingIndex];
      if (r.scope === 'project') {
        resources[existingIndex] = {
          ...existing,
          ...r,
          id: existing.id,
          name: (r.raw && typeof r.raw === 'object' && r.raw.name) ? r.name : (existing.name || r.name),
          hasProjectOverride: true,
          extensionPath: r.extensionPath || existing.extensionPath,
          extensionDir: r.extensionDir || existing.extensionDir,
        };
      }
    } else {
      resources.push(r);
    }
  }

  // 1. Global settings.json (packages and extensions)
  const globalSettingsFile = path.join(getPiAgentDir(), 'settings.json');
  if (fs.existsSync(globalSettingsFile)) {
    try {
      const settings = JSON.parse(fs.readFileSync(globalSettingsFile, 'utf8'));
      if (Array.isArray(settings.packages)) {
        for (const pkg of settings.packages) {
          const pkgStr = typeof pkg === 'string' ? pkg : pkg.source || String(pkg);
          let cleanName = pkgStr.replace(/^(npm:|https:\/\/github\.com\/)/, '');
          const lastAt = cleanName.lastIndexOf('@');
          if (lastAt > 0) {
            cleanName = cleanName.slice(0, lastAt);
          }
          const safeId = `pkg-${cleanName.replace(/[\/@:]/g, '-')}`;
          addOrMergeResource({
            id: safeId,
            name: cleanName,
            kind: 'package',
            source: pkgStr,
            scope: 'global',
            enabled: true,
            alwaysActive: false,
            configPath: globalSettingsFile,
          });
        }
      }
      if (Array.isArray(settings.extensions)) {
        for (const item of settings.extensions) {
          const raw = typeof item === 'string' ? item : item?.source || item?.path || '';
          if (!raw) continue;
          const trimmed = raw.trim();
          if (trimmed.includes('*')) continue;
          const cleanSource = trimmed.replace(/^[!+-]/, '').trim();
          if (!cleanSource) continue;

          if (cleanSource.startsWith('builtin:')) {
            const enabled = typeof item === 'object'
              ? !item.disabled && item.enabled !== false
              : !trimmed.startsWith('!') && !trimmed.startsWith('-');
            addOrMergeResource({
              id: `ext-${cleanSource.replace(/[\/@:]/g, '-')}`,
              name: cleanSource,
              kind: 'extension',
              source: cleanSource,
              scope: 'global',
              enabled,
              configPath: globalSettingsFile,
              raw: item,
            });
            continue;
          }

          const meta = resolveExtensionMeta(item, cleanSource, getPiAgentDir(), globalSettingsFile);
          const enabled = typeof item === 'object'
            ? !item.disabled && item.enabled !== false
            : !trimmed.startsWith('!') && !trimmed.startsWith('-');
          addOrMergeResource({
            id: `ext-${meta.name.replace(/[\/@:]/g, '-')}`,
            name: meta.name,
            kind: 'extension',
            source: cleanSource,
            scope: 'global',
            enabled,
            configPath: globalSettingsFile,
            extensionPath: meta.extensionPath,
            extensionDir: meta.extensionDir,
            raw: item,
          });
        } else if (e.isDirectory()) {
          const subPkg = path.join(globalExtensionsDir, e.name, 'package.json');
          let handled = false;
          if (fs.existsSync(subPkg)) {
            try {
              const pData = JSON.parse(fs.readFileSync(subPkg, 'utf8'));
              if (Array.isArray(pData.pi?.extensions)) {
                for (const rel of pData.pi.extensions) {
                  const relNorm = rel.replace(/^[./\\]+/, '').replace(/\\/g, '/');
                  const fullExt = path.resolve(globalExtensionsDir, e.name, relNorm);
                  addOrMergeResource({
                    id: `ext-${e.name}-${relNorm.replace(/[\/@:]/g, '-')}`,
                    name: pData.name || e.name,
                    kind: 'extension',
                    source: `extensions/${e.name}/${relNorm}`,
                    scope: 'global',
                    enabled: true,
                    configPath: fullExt,
                    extensionPath: fullExt,
                    extensionDir: path.resolve(globalExtensionsDir, e.name),
                  });
                  handled = true;
                }
              }
            } catch {}
          }
          if (!handled) {
            for (const idx of ['index.ts', 'index.js', 'index.mjs']) {
              const fullIdx = path.join(globalExtensionsDir, e.name, idx);
              if (fs.existsSync(fullIdx)) {
                const resolvedIdx = path.resolve(fullIdx);
                addOrMergeResource({
                  id: `ext-${e.name}`,
                  name: e.name,
                  kind: 'extension',
                  source: `extensions/${e.name}/${idx}`,
                  scope: 'global',
                  enabled: true,
                  configPath: resolvedIdx,
                  extensionPath: resolvedIdx,
                  extensionDir: path.resolve(globalExtensionsDir, e.name),
                });
                break;
              }
            }
          }
        }
      }
    } catch {}
  }

  // 2. Global extensions directory: top-level files and folders as ONE root without manifest traversal
  const globalExtensionsDir = path.join(getPiAgentDir(), 'extensions');
  if (fs.existsSync(globalExtensionsDir)) {
    try {
      const entries = fs.readdirSync(globalExtensionsDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        if (e.isFile() && (e.name.endsWith('.ts') || e.name.endsWith('.js') || e.name.endsWith('.mjs')) && !e.name.endsWith('.d.ts')) {
          const isIndexTrio = ['index.ts', 'index.js', 'index.mjs'].includes(e.name);
          const cleanName = isIndexTrio ? path.basename(globalExtensionsDir) : e.name.replace(/\.(ts|js|mjs)$/, '');
          const fullPath = path.resolve(globalExtensionsDir, e.name);
          addOrMergeResource({
            id: `ext-${cleanName}`,
            name: cleanName,
            kind: 'extension',
            source: `extensions/${e.name}`,
            scope: 'global',
            enabled: true,
            configPath: fullPath,
            extensionPath: fullPath,
            extensionDir: path.resolve(globalExtensionsDir),
            autoload: true,
          });
        } else if (e.isDirectory()) {
          const fullPath = path.resolve(globalExtensionsDir, e.name);
          addOrMergeResource({
            id: `ext-${e.name}`,
            name: e.name,
            kind: 'extension',
            source: `extensions/${e.name}`,
            scope: 'global',
            enabled: true,
            configPath: fullPath,
            extensionPath: fullPath,
            extensionDir: fullPath,
            autoload: true,
          });
        }
      }
    } catch {}
  }

  // 3. Project settings and extensions directory
  if (cwd) {
    const pSettingsFile = path.join(cwd, '.pi', 'settings.json');
    if (fs.existsSync(pSettingsFile)) {
      try {
        const pSettings = JSON.parse(fs.readFileSync(pSettingsFile, 'utf8'));
        if (Array.isArray(pSettings.packages)) {
          for (const pkg of pSettings.packages) {
            const pkgStr = typeof pkg === 'string' ? pkg : pkg.source || String(pkg);
            let cleanName = pkgStr.replace(/^(npm:|https:\/\/github\.com\/)/, '');
            const lastAt = cleanName.lastIndexOf('@');
            if (lastAt > 0) cleanName = cleanName.slice(0, lastAt);
            addOrMergeResource({
              id: `pkg-${cleanName.replace(/[\/@:]/g, '-')}`,
              name: cleanName,
              kind: 'package',
              source: pkgStr,
              scope: 'project',
              enabled: true,
              alwaysActive: false,
              configPath: pSettingsFile,
            });
          }
        }
        if (Array.isArray(pSettings.extensions)) {
          for (const item of pSettings.extensions) {
            const raw = typeof item === 'string' ? item : item?.source || item?.path || '';
            if (!raw) continue;
            const trimmed = raw.trim();
            if (trimmed.includes('*')) continue;
            const cleanSource = trimmed.replace(/^[!+-]/, '').trim();
            if (!cleanSource) continue;

            if (cleanSource.startsWith('builtin:')) {
              const enabled = typeof item === 'object'
                ? !item.disabled && item.enabled !== false
                : !trimmed.startsWith('!') && !trimmed.startsWith('-');
              addOrMergeResource({
                id: `ext-${cleanSource.replace(/[\/@:]/g, '-')}`,
                name: cleanSource,
                kind: 'extension',
                source: cleanSource,
                scope: 'project',
                enabled,
                configPath: pSettingsFile,
                raw: item,
                hasProjectOverride: true,
              });
              continue;
            }

            const meta = resolveExtensionMeta(item, cleanSource, path.dirname(pSettingsFile), pSettingsFile);
            const enabled = typeof item === 'object'
              ? !item.disabled && item.enabled !== false
              : !trimmed.startsWith('!') && !trimmed.startsWith('-');
            addOrMergeResource({
              id: `ext-${meta.name.replace(/[\/@:]/g, '-')}`,
              name: meta.name,
              kind: 'extension',
              source: cleanSource,
              scope: 'project',
              enabled,
              configPath: pSettingsFile,
              extensionPath: meta.extensionPath,
              extensionDir: meta.extensionDir,
              raw: item,
              hasProjectOverride: true,
            });
          }
        }
      } catch {}
    }

    const projectExtDir = path.join(cwd, '.pi', 'extensions');
    if (fs.existsSync(projectExtDir)) {
      try {
        const entries = fs.readdirSync(projectExtDir, { withFileTypes: true });
        for (const e of entries) {
          if (e.name.startsWith('.')) continue;
          if (e.isFile() && (e.name.endsWith('.ts') || e.name.endsWith('.js') || e.name.endsWith('.mjs')) && !e.name.endsWith('.d.ts')) {
            const isIndexTrio = ['index.ts', 'index.js', 'index.mjs'].includes(e.name);
            const cleanName = isIndexTrio ? path.basename(projectExtDir) : e.name.replace(/\.(ts|js|mjs)$/, '');
            const fullPath = path.resolve(projectExtDir, e.name);
            addOrMergeResource({
              id: `ext-${cleanName}`,
              name: cleanName,
              kind: 'extension',
              source: `extensions/${e.name}`,
              scope: 'project',
              enabled: true,
              configPath: fullPath,
              extensionPath: fullPath,
              extensionDir: path.resolve(projectExtDir),
              hasProjectOverride: true,
            });
          } else if (e.isDirectory()) {
            const fullPath = path.resolve(projectExtDir, e.name);
            addOrMergeResource({
              id: `ext-${e.name}`,
              name: e.name,
              kind: 'extension',
              source: `extensions/${e.name}`,
              scope: 'project',
              enabled: true,
              configPath: fullPath,
              extensionPath: fullPath,
              extensionDir: fullPath,
              hasProjectOverride: true,
            });
          }
        }
      } catch {}
    }
  }

  // 4. Apply viewer resource activation policy and native settings exclusions
  const policy = loadResourceActivationPolicy();
  const normCwd = cwd ? normalizeProjectCwd(cwd) : null;

  let globalExtList: string[] = [];
  if (fs.existsSync(globalSettingsFile)) {
    try {
      const s = JSON.parse(fs.readFileSync(globalSettingsFile, 'utf8'));
      if (Array.isArray(s.extensions)) {
        globalExtList = s.extensions.map((x: any) => (typeof x === 'string' ? x : x?.source || x?.path || ''));
      }
    } catch {}
  }

  let projectExtList: string[] = [];
  if (cwd) {
    const pSettingsFile = path.join(cwd, '.pi', 'settings.json');
    if (fs.existsSync(pSettingsFile)) {
      try {
        const s = JSON.parse(fs.readFileSync(pSettingsFile, 'utf8'));
        if (Array.isArray(s.extensions)) {
          projectExtList = s.extensions.map((x: any) => (typeof x === 'string' ? x : x?.source || x?.path || ''));
        }
      } catch {}
    }
  }

  for (const r of resources) {
    if (r.kind === 'extension') {
      if (!r.extensionPath && !r.source.startsWith('builtin:')) {
        const owning = r.configPath ? path.dirname(r.configPath) : (cwd || getPiAgentDir());
        r.extensionPath = resolveExtensionRuntimePath(r.source, owning);
      }
      if (!r.extensionDir && r.extensionPath) {
        r.extensionDir = path.dirname(r.extensionPath);
      }

      const applyPatternsToExtension = (initialEnabled: boolean, patterns: string[]): boolean => {
        let state = initialEnabled;
        const clean = r.source.replace(/^[!+-]/, '').trim();
        const posixPath = r.extensionPath ? r.extensionPath.replace(/\\/g, '/') : '';
        const posixDir = r.extensionDir ? r.extensionDir.replace(/\\/g, '/') : '';
        for (const p of patterns) {
          const pTrimmed = p.trim();
          if (pTrimmed.startsWith('-')) {
            const target = pTrimmed.slice(1).trim();
            if (target === clean || (posixPath && (target === posixPath || posixPath.endsWith(`/${target}`)))) {
              state = false;
            }
          } else if (pTrimmed.startsWith('+')) {
            const target = pTrimmed.slice(1).trim();
            if (target === clean || (posixPath && (target === posixPath || posixPath.endsWith(`/${target}`)))) {
              state = true;
            }
          } else if (pTrimmed.startsWith('!') && pTrimmed.endsWith('/**')) {
            const folderMask = pTrimmed.slice(1, -3);
            if (posixDir && (posixDir === folderMask || posixDir.startsWith(`${folderMask}/`))) {
              state = false;
            }
          }
        }
        return state;
      };

      let nativeEnabled = r.enabled !== false;
      nativeEnabled = applyPatternsToExtension(nativeEnabled, globalExtList);
      if (cwd) {
        nativeEnabled = applyPatternsToExtension(nativeEnabled, projectExtList);
      }

      const alwaysActive = isAlwaysActiveExtension(policy, r.source);
      r.alwaysActive = alwaysActive;
      if (cwd) {
        let hasPolicyOverride = false;
        if (local !== null) {
          if (local.extensions) {
            for (const [key, val] of Object.entries(local.extensions)) {
              if (typeof val === 'boolean' && extensionIdentitiesMatch(key, r.source)) {
                hasPolicyOverride = true;
                r.enabled = val;
                break;
              }
            }
          }
        } else if (normCwd) {
          const projectExts = policy.projects?.[normCwd]?.extensions;
          if (projectExts) {
            for (const [key, val] of Object.entries(projectExts)) {
              if (typeof val === 'boolean' && extensionIdentitiesMatch(key, r.source)) {
                hasPolicyOverride = true;
                r.enabled = val;
                break;
              }
            }
          }
        }
        if (!hasPolicyOverride) {
          r.enabled = alwaysActive ? true : nativeEnabled;
          r.hasProjectOverride = Boolean(r.hasProjectOverride);
        } else {
          r.hasProjectOverride = true;
        }
      } else {
        r.enabled = alwaysActive ? true : nativeEnabled;
        r.hasProjectOverride = false;
      }
    } else {
      r.alwaysActive = false;
    }
  }

  return { resources };
}

export function getAvailableModelsImpl() {
  const modelsFile = path.join(PI_AGENT_DIR, 'models.json');
  const list: any[] = [];

  if (fs.existsSync(modelsFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
      if (parsed.providers) {
        for (const [providerId, p] of Object.entries<any>(parsed.providers)) {
          if (Array.isArray(p.models)) {
            for (const m of p.models) {
              list.push({
                id: m.id,
                name: m.name || m.id,
                provider: providerId,
                contextWindow: m.contextWindow || 1048576,
                maxTokens: m.maxTokens || 65536,
                reasoning: m.reasoning !== false,
                reasoningEfforts: ['off', 'low', 'medium', 'high'],
                input: m.input ?? m.input_modalities ?? ['text', 'image'],
                input_modalities: m.input_modalities ?? m.input ?? ['text', 'image'],
              });
            }
          }
        }
      }
    } catch {}
  }

  list.push(
    {
      id: 'gpt-5.5',
      name: 'GPT-5.5',
      provider: 'openai-codex',
      contextWindow: 128000,
      maxTokens: 4096,
      reasoning: true,
      reasoningEfforts: ['low', 'medium', 'high'],
      input: ['text', 'image'],
      input_modalities: ['text', 'image'],
    },
    {
      id: 'gpt-5',
      name: 'GPT-5',
      provider: 'openai-codex',
      contextWindow: 128000,
      maxTokens: 4096,
      reasoning: true,
      reasoningEfforts: ['low', 'medium', 'high'],
      input: ['text', 'image'],
      input_modalities: ['text', 'image'],
    }
  );

  return list;
}

export function handleGetAvailableModels() {
  return getAvailableModelsImpl();
}

export async function handleSetModel(args: any = {}) {
  const { provider, modelId } = args;
  const all = getAvailableModelsImpl();
  const found = all.find((m) => m.provider === provider && m.id === modelId);
  let activeModel: any;
  if (found) {
    activeModel = found;
  } else {
    activeModel = { provider, id: modelId, name: modelId };
  }
  setActiveModel(activeModel);
  if (piRpc.isAlive()) {
    try {
      await piRpc.sendCommand({ id: `model-${Date.now()}`, type: 'set_model', provider, modelId });
    } catch {}
  }
  return activeModel;
}

export function handleGetAvailableThinkingLevels() {
  return ['off', 'low', 'medium', 'high', 'max'];
}

export async function handleSetThinkingLevel(args: any = {}) {
  const level = args.level || 'high';
  setActiveThinkingLevel(level);
  if (piRpc.isAlive()) {
    try {
      await piRpc.sendCommand({ id: `thinking-${Date.now()}`, type: 'set_thinking_level', level });
    } catch {}
  }
  return null;
}

export function handleGetCustomProviders() {
  const modelsFile = path.join(PI_AGENT_DIR, 'models.json');
  if (fs.existsSync(modelsFile)) {
    try {
      return JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
    } catch {}
  }
  return { providers: {} };
}

export function handleSaveCustomProviders(args: any = {}) {
  const modelsFile = path.join(PI_AGENT_DIR, 'models.json');
  let rootObj: any = {};
  if (fs.existsSync(modelsFile)) {
    try {
      rootObj = JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
    } catch {}
  }
  rootObj.providers = args.providers;
  fs.writeFileSync(modelsFile, JSON.stringify(rootObj, null, 2) + '\n', 'utf8');
  return rootObj;
}

export function handleGetModelThinkingLevels() {
  const settingsFile = path.join(PI_AGENT_DIR, 'settings.json');
  if (fs.existsSync(settingsFile)) {
    try {
      const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      return s.modelThinkingLevels || {};
    } catch {}
  }
  return {};
}

export function handleSaveModelThinkingLevels(args: any = {}) {
  const settingsFile = path.join(PI_AGENT_DIR, 'settings.json');
  let settings: any = {};
  if (fs.existsSync(settingsFile)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    } catch {}
  }
  settings.modelThinkingLevels = args.levels;
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return settings.modelThinkingLevels;
}

export function handleGetMcpServers(args: any = {}) {
  return getMcpServersImpl(args.cwd || getActiveCwd());
}

export async function handleToggleMcpServer(args: any = {}) {
  const { name, enabled, cwd, scope } = args;
  if (!name || typeof name !== 'string') throw new Error('Server name is required');
  if (typeof enabled !== 'boolean') throw new Error('Enabled must be a boolean');

  const targetScope =
    scope === 'global' ? 'global' : scope === 'project' ? 'project' : cwd ? 'project' : 'global';

  // Pre-validate schemas before making any writes
  loadResourceActivationPolicy();
  if (targetScope === 'project' && cwd) {
    loadProjectResourceActivation(cwd);
  }

  const currentServers = getMcpServersImpl(cwd);
  const exists = currentServers.servers.some((s) => s.name === name);
  if (!exists) {
    throw new Error(`Unknown MCP server '${name}'`);
  }

  if (targetScope === 'project' && cwd) {
    const projectMcpFile = getNativeProjectMcpPath(cwd);
    let data: any = {};
    if (fs.existsSync(projectMcpFile)) {
      try {
        data = JSON.parse(fs.readFileSync(projectMcpFile, 'utf8'));
      } catch (e: any) {
        throw new Error(`Failed to parse MCP configuration file at ${projectMcpFile}: ${e.message}`);
      }
    }
    if (!data.mcpServers && !data.servers) {
      data.mcpServers = {};
    }
    const targetMap = data.mcpServers || data.servers;
    if (targetMap[name]) {
      targetMap[name] = { ...targetMap[name], enabled: Boolean(enabled) };
      delete targetMap[name].disabled;
    } else {
      targetMap[name] = { enabled: Boolean(enabled) };
    }

    // Set resource activation first (validates local/policy and updates activation)
    await setResourceActivation({
      kind: 'mcp',
      identity: name,
      enabled: Boolean(enabled),
      cwd,
    });

    const piDir = path.dirname(projectMcpFile);
    if (!fs.existsSync(piDir)) {
      fs.mkdirSync(piDir, { recursive: true });
    }
    const tmpPath = `${projectMcpFile}.tmp.${Date.now()}.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, projectMcpFile);

    return {
      success: true,
      name,
      enabled: Boolean(enabled),
      path: projectMcpFile,
    };
  }

  // Global scope
  const mcpFile = path.join(getPiAgentDir(), 'mcp.json');
  let data: any = {};
  if (fs.existsSync(mcpFile)) {
    try {
      data = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
    } catch (e: any) {
      throw new Error(`Failed to parse MCP configuration file at ${mcpFile}: ${e.message}`);
    }
  }
  if (!data.mcpServers && !data.servers) {
    data.mcpServers = {};
  }
  const targetMap = data.mcpServers || data.servers;
  if (targetMap[name]) {
    targetMap[name] = { ...targetMap[name], enabled: Boolean(enabled) };
    delete targetMap[name].disabled;
  } else {
    targetMap[name] = { enabled: Boolean(enabled) };
  }

  fs.mkdirSync(path.dirname(mcpFile), { recursive: true });
  const tmpPath = `${mcpFile}.tmp.${Date.now()}.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, mcpFile);

  return { success: true, name, enabled: Boolean(enabled), path: mcpFile };
}

export async function handleTogglePiResource(args: any = {}) {
  const { kind, source, enabled, cwd, scope } = args;
  if (!kind || (kind !== 'extension' && kind !== 'package')) {
    throw new Error(`Invalid resource kind '${kind}'. Expected 'extension' or 'package'`);
  }
  if (!source || typeof source !== 'string') {
    throw new Error('Source is required');
  }
  if (typeof enabled !== 'boolean') {
    throw new Error('Enabled must be a boolean');
  }

  const targetScope =
    scope === 'global' ? 'global' : scope === 'project' ? 'project' : cwd ? 'project' : 'global';

  // Pre-validate schemas before making any writes
  loadResourceActivationPolicy();
  if (targetScope === 'project' && cwd) {
    loadProjectResourceActivation(cwd);
  }

  const settingsFile =
    targetScope === 'project' && cwd
      ? path.join(cwd, '.pi', 'settings.json')
      : path.join(getPiAgentDir(), 'settings.json');

  let settings: any = {};
  if (fs.existsSync(settingsFile)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    } catch (e: any) {
      throw new Error(`Failed to parse settings file at ${settingsFile}: ${e.message}`);
    }
  }

  if (kind === 'package') {
    if (!enabled) {
      throw new Error(
        'Disabling individual packages is not supported. Remove the package or configure package filters directly.'
      );
    }
    if (!Array.isArray(settings.packages)) settings.packages = [];
    const idx = settings.packages.findIndex((p: any) => {
      const pSrc = typeof p === 'string' ? p : p?.source || '';
      return pSrc === source;
    });
    if (idx < 0) {
      settings.packages.push(source);
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
      fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    }
    return {
      success: true,
      kind,
      source,
      scope: targetScope,
      enabled: true,
      configPath: settingsFile,
    };
  }

  // kind === 'extension'
  const currentResources = getPiResourcesImpl(cwd);
  const matched = currentResources.resources.find(
    (r) => r.kind === 'extension' && extensionIdentitiesMatch(r.source, source)
  );
  const cleanSource = source.replace(/^[!+-]/, '').trim();
  const isBuiltin = KNOWN_BUILTIN_EXTENSIONS.has(cleanSource);

  if (!matched && !isBuiltin) {
    throw new Error(`Unknown extension identity '${source}'`);
  }

  if (!Array.isArray(settings.extensions)) settings.extensions = [];

  if (isBuiltin) {
    const minusEntry = `-${cleanSource}`;
    const plusEntry = `+${cleanSource}`;
    if (targetScope === 'project' && cwd) {
      await setResourceActivation({
        kind: 'extension',
        identity: source,
        enabled: Boolean(enabled),
        cwd,
      });
      if (!enabled) {
        settings.extensions = settings.extensions.filter((e: any) => {
          const str = typeof e === 'string' ? e : e?.source || '';
          return str !== plusEntry && str !== cleanSource;
        });
        if (!settings.extensions.includes(minusEntry)) {
          settings.extensions.push(minusEntry);
        }
      } else {
        settings.extensions = settings.extensions.filter((e: any) => {
          const str = typeof e === 'string' ? e : e?.source || '';
          return str !== minusEntry;
        });
        if (!settings.extensions.includes(plusEntry) && !settings.extensions.includes(cleanSource)) {
          settings.extensions.push(plusEntry);
        }
      }
    } else {
      if (!enabled) {
        settings.extensions = settings.extensions.filter((e: any) => {
          const str = typeof e === 'string' ? e : e?.source || '';
          return str !== plusEntry && str !== cleanSource;
        });
        if (!settings.extensions.includes(minusEntry)) {
          settings.extensions.push(minusEntry);
        }
      } else {
        settings.extensions = settings.extensions.filter((e: any) => {
          const str = typeof e === 'string' ? e : e?.source || '';
          return str !== minusEntry && str !== plusEntry;
        });
        if (!settings.extensions.includes(cleanSource)) {
          settings.extensions.push(cleanSource);
        }
      }
    }

    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    const tmpPath = `${settingsFile}.tmp.${Date.now()}.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, settingsFile);

    return {
      success: true,
      kind,
      source,
      scope: targetScope,
      enabled: Boolean(enabled),
      configPath: settingsFile,
    };
  }

  const runtimePath =
    matched?.extensionPath || (cwd ? path.resolve(cwd, source) : path.resolve(getPiAgentDir(), source));
  let isFolder = false;
  try {
    isFolder =
      fs.existsSync(runtimePath) &&
      fs.statSync(runtimePath).isDirectory() &&
      !runtimePath.endsWith('.ts') &&
      !runtimePath.endsWith('.js') &&
      !runtimePath.endsWith('.mjs');
  } catch {}

  const posixPath = runtimePath.replace(/\\/g, '/');

  if (targetScope === 'project' && cwd) {
    // Validate and update project activation first
    await setResourceActivation({
      kind: 'extension',
      identity: source,
      enabled: Boolean(enabled),
      cwd,
    });

    if (isFolder) {
      const folderGlob = `!${posixPath}/**`;
      if (!enabled) {
        settings.extensions = settings.extensions.filter((e: any) => e !== posixPath && e !== folderGlob);
        settings.extensions.push(posixPath, folderGlob);
      } else {
        settings.extensions = settings.extensions.filter((e: any) => e !== folderGlob && e !== posixPath);
      }
    } else {
      const minusEntry = `-${posixPath}`;
      const plusEntry = `+${posixPath}`;
      const isGlobalDisabled =
        matched?.globalEnabled === false || (matched && matched.scope === 'global' && !matched.enabled);
      if (!enabled) {
        settings.extensions = settings.extensions.filter(
          (e: any) => e !== plusEntry && e !== `+${cleanSource}` && e !== posixPath && e !== cleanSource
        );
        settings.extensions.push(posixPath, minusEntry);
      } else {
        settings.extensions = settings.extensions.filter(
          (e: any) => e !== minusEntry && e !== `-${cleanSource}`
        );
        if (isGlobalDisabled && !settings.extensions.includes(plusEntry)) {
          settings.extensions.push(plusEntry);
        }
      }
    }
  } else {
    // Global scope
    if (isFolder) {
      const folderGlob = `!${posixPath}/**`;
      if (!enabled) {
        if (!settings.extensions.includes(folderGlob)) {
          settings.extensions.push(folderGlob);
        }
      } else {
        settings.extensions = settings.extensions.filter((e: any) => {
          const str = typeof e === 'string' ? e : e?.source || '';
          return str !== folderGlob;
        });
      }
    } else {
      const minusEntry = `-${cleanSource}`;
      if (!enabled) {
        settings.extensions = settings.extensions.filter((e: any) => {
          const str = typeof e === 'string' ? e : e?.source || '';
          return str !== `+${cleanSource}`;
        });
        if (!settings.extensions.some((e: any) => {
          const str = typeof e === 'string' ? e : e?.source || '';
          return extensionIdentitiesMatch(str, cleanSource) && !str.startsWith('-') && !str.startsWith('!');
        })) {
          settings.extensions.push(cleanSource);
        }
        if (!settings.extensions.includes(minusEntry)) {
          settings.extensions.push(minusEntry);
        }
      } else {
        settings.extensions = settings.extensions.filter((e: any) => {
          const str = typeof e === 'string' ? e : e?.source || '';
          return str !== minusEntry && str !== `!${cleanSource}`;
        });
        if (
          matched &&
          matched.configPath === settingsFile &&
          !settings.extensions.some((e: any) =>
            extensionIdentitiesMatch(typeof e === 'string' ? e : e?.source || '', cleanSource)
          )
        ) {
          settings.extensions.push(cleanSource);
        }
      }
    }
  }

  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const tmpPath = `${settingsFile}.tmp.${Date.now()}.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, settingsFile);

  return {
    success: true,
    kind,
    source,
    scope: targetScope,
    enabled: Boolean(enabled),
    configPath: settingsFile,
  };
}

export function handleGetPiResources(args: any = {}) {
  return getPiResourcesImpl(args.cwd || getActiveCwd());
}
