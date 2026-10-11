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
  getEffectiveExtensionActivation,
  setResourceActivation,
  normalizeProjectCwd,
  extensionIdentitiesMatch,
  getSupportedProjectMcpPaths,
  resolveExtensionRuntimePath,
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
    const projectCandidates = getSupportedProjectMcpPaths(cwd);
    for (const pFile of projectCandidates) {
      const pServers = readMcpServersFromFile(pFile, 'project');
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
            configPath: pFile,
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
    if (cwd) {
      const effective = getEffectiveMcpActivation(policy, cwd, s.name);
      let hasPolicyOverride = false;
      if (local !== null) {
        hasPolicyOverride = typeof local.mcpServers?.[s.name] === 'boolean';
      } else if (normCwd) {
        hasPolicyOverride = typeof policy.projects?.[normCwd]?.mcpServers?.[s.name] === 'boolean';
      }
      return {
        ...s,
        alwaysActive,
        enabled: effective,
        disabled: !effective,
        hasProjectOverride: Boolean(s.hasProjectOverride || hasPolicyOverride),
      };
    } else {
      return {
        ...s,
        alwaysActive,
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
          const cleanSource = raw.replace(/^[!+]/, '').trim();
          const meta = resolveExtensionMeta(item, cleanSource, getPiAgentDir(), globalSettingsFile);
          const enabled = typeof item === 'object'
            ? !item.disabled && item.enabled !== false
            : !raw.startsWith('!');
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
        }
      }
    } catch {}
  }

  // 2. Global extensions directory
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

  // 3. Project settings and extensions directory
  if (cwd) {
    const projectCandidates = [
      path.join(cwd, '.pi', 'settings.json'),
      path.join(cwd, '.pi.json'),
    ];
    for (const pFile of projectCandidates) {
      if (fs.existsSync(pFile)) {
        try {
          const pSettings = JSON.parse(fs.readFileSync(pFile, 'utf8'));
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
                configPath: pFile,
              });
            }
          }
          if (Array.isArray(pSettings.extensions)) {
            for (const item of pSettings.extensions) {
              const raw = typeof item === 'string' ? item : item?.source || item?.path || '';
              if (!raw) continue;
              const cleanSource = raw.replace(/^[!+]/, '').trim();
              const meta = resolveExtensionMeta(item, cleanSource, path.dirname(pFile), pFile);
              const enabled = typeof item === 'object'
                ? !item.disabled && item.enabled !== false
                : !raw.startsWith('!');
              addOrMergeResource({
                id: `ext-${meta.name.replace(/[\/@:]/g, '-')}`,
                name: meta.name,
                kind: 'extension',
                source: cleanSource,
                scope: 'project',
                enabled,
                configPath: pFile,
                extensionPath: meta.extensionPath,
                extensionDir: meta.extensionDir,
                raw: item,
                hasProjectOverride: true,
              });
            }
          }
        } catch {}
      }
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
            const subPkg = path.join(projectExtDir, e.name, 'package.json');
            let handled = false;
            if (fs.existsSync(subPkg)) {
              try {
                const pData = JSON.parse(fs.readFileSync(subPkg, 'utf8'));
                if (Array.isArray(pData.pi?.extensions)) {
                  for (const rel of pData.pi.extensions) {
                    const relNorm = rel.replace(/^[./\\]+/, '').replace(/\\/g, '/');
                    const fullExt = path.resolve(projectExtDir, e.name, relNorm);
                    addOrMergeResource({
                      id: `ext-${e.name}-${relNorm.replace(/[\/@:]/g, '-')}`,
                      name: pData.name || e.name,
                      kind: 'extension',
                      source: `extensions/${e.name}/${relNorm}`,
                      scope: 'project',
                      enabled: true,
                      configPath: fullExt,
                      extensionPath: fullExt,
                      extensionDir: path.resolve(projectExtDir, e.name),
                      hasProjectOverride: true,
                    });
                    handled = true;
                  }
                }
              } catch {}
            }
            if (!handled) {
              for (const idx of ['index.ts', 'index.js', 'index.mjs']) {
                const fullIdx = path.join(projectExtDir, e.name, idx);
                if (fs.existsSync(fullIdx)) {
                  const resolvedIdx = path.resolve(fullIdx);
                  addOrMergeResource({
                    id: `ext-${e.name}`,
                    name: e.name,
                    kind: 'extension',
                    source: `extensions/${e.name}/${idx}`,
                    scope: 'project',
                    enabled: true,
                    configPath: resolvedIdx,
                    extensionPath: resolvedIdx,
                    extensionDir: path.resolve(projectExtDir, e.name),
                    hasProjectOverride: true,
                  });
                  break;
                }
              }
            }
          }
        }
      } catch {}
    }
  }

  // 4. Apply viewer resource activation policy
  const policy = loadResourceActivationPolicy();
  const normCwd = cwd ? normalizeProjectCwd(cwd) : null;

  for (const r of resources) {
    if (r.kind === 'extension') {
      if (!r.extensionPath) {
        const owning = r.configPath ? path.dirname(r.configPath) : (cwd || getPiAgentDir());
        r.extensionPath = resolveExtensionRuntimePath(r.source, owning);
      }
      if (!r.extensionDir && r.extensionPath) {
        r.extensionDir = path.dirname(r.extensionPath);
      }

      const alwaysActive = isAlwaysActiveExtension(policy, r.source);
      r.alwaysActive = alwaysActive;
      if (cwd) {
        r.enabled = getEffectiveExtensionActivation(policy, cwd, r.source);
        let hasPolicyOverride = false;
        if (local !== null) {
          if (local.extensions) {
            for (const [key, val] of Object.entries(local.extensions)) {
              if (typeof val === 'boolean' && extensionIdentitiesMatch(key, r.source)) {
                hasPolicyOverride = true;
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
                break;
              }
            }
          }
        }
        if (hasPolicyOverride) {
          r.hasProjectOverride = true;
        }
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
  const { name, enabled, cwd, configPath } = args;
  if (!name) throw new Error('Server name is required');

  if (cwd) {
    await setResourceActivation({
      kind: 'mcp',
      identity: name,
      enabled: Boolean(enabled),
      cwd,
    });
    return {
      success: true,
      name,
      enabled: Boolean(enabled),
      path: configPath || path.join(cwd, '.pi', 'mcp.json'),
    };
  }

  let mcpFile = configPath;
  if (!mcpFile || !fs.existsSync(mcpFile)) {
    mcpFile = path.join(getPiAgentDir(), 'mcp.json');
  }
  if (mcpFile && fs.existsSync(mcpFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
      const targetMap = data.mcpServers || data.servers;
      if (targetMap && targetMap[name]) {
        targetMap[name].enabled = Boolean(enabled);
        delete targetMap[name].disabled;
        fs.writeFileSync(mcpFile, JSON.stringify(data, null, 2) + '\n', 'utf8');
      }
    } catch {}
  }
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

  const targetScope = scope || (cwd ? 'project' : 'global');
  if (kind === 'extension' && (targetScope === 'project' || cwd)) {
    await setResourceActivation({
      kind: 'extension',
      identity: source,
      enabled: Boolean(enabled),
      cwd,
    });
    return {
      success: true,
      kind,
      source,
      scope: 'project',
      enabled: Boolean(enabled),
    };
  }

  const settingsFile = targetScope === 'project' && cwd
    ? path.join(cwd, '.pi', 'settings.json')
    : path.join(getPiAgentDir(), 'settings.json');

  let settings: any = {};
  if (fs.existsSync(settingsFile)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    } catch {}
  }

  if (kind === 'extension') {
    if (!Array.isArray(settings.extensions)) settings.extensions = [];
    const idx = settings.extensions.findIndex((e: any) => {
      const eSrc = typeof e === 'string' ? e : e?.source || e?.path || '';
      return extensionIdentitiesMatch(eSrc, source);
    });
    const cleanSource = source.replace(/^[!+]/, '').trim();
    const entryStr = enabled ? cleanSource : `!${cleanSource}`;
    if (idx >= 0) {
      if (typeof settings.extensions[idx] === 'object') {
        settings.extensions[idx].enabled = Boolean(enabled);
        settings.extensions[idx].disabled = !enabled;
      } else {
        settings.extensions[idx] = entryStr;
      }
    } else {
      settings.extensions.push(entryStr);
    }
  } else if (kind === 'package') {
    if (!Array.isArray(settings.packages)) settings.packages = [];
    const idx = settings.packages.findIndex((p: any) => {
      const pSrc = typeof p === 'string' ? p : p?.source || '';
      return pSrc === source;
    });
    if (idx >= 0) {
      if (typeof settings.packages[idx] === 'object') {
        settings.packages[idx].enabled = Boolean(enabled);
      }
    } else if (enabled) {
      settings.packages.push(source);
    }
  }

  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf8');

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
