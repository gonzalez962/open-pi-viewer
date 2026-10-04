import fs from 'node:fs';
import path from 'node:path';
import {
  PI_AGENT_DIR,
  getActiveCwd,
  setActiveModel,
  setActiveThinkingLevel,
} from './state';
import { piRpc } from './rpc';

export function readMcpServersFromFile(filePath: string, scope: 'global' | 'project'): any[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const sMap = data.mcpServers || data.servers || {};
    return Object.entries<any>(sMap).map(([name, cfg]) => ({
      name,
      command: cfg.command || '',
      args: cfg.args || [],
      url: cfg.url || undefined,
      serverType: cfg.url ? 'sse' : 'stdio',
      envKeys: cfg.env ? Object.keys(cfg.env) : [],
      disabled: Boolean(cfg.disabled),
      enabled: !cfg.disabled,
      scope,
      configPath: filePath,
      env: cfg.env || {},
      headers: cfg.headers || {},
    }));
  } catch {
    return [];
  }
}

export function getMcpServersImpl(cwd?: string) {
  const mcpGlobalFile = path.join(PI_AGENT_DIR, 'mcp.json');
  const servers: any[] = [];
  const seen = new Set<string>();

  const globalServers = readMcpServersFromFile(mcpGlobalFile, 'global');
  for (const s of globalServers) {
    servers.push(s);
    seen.add(s.name);
  }

  if (cwd) {
    const projectCandidates = [
      path.join(cwd, '.pi', 'mcp.json'),
      path.join(cwd, '.mcp.json'),
      path.join(cwd, 'mcp-adapter.json'),
    ];
    for (const pFile of projectCandidates) {
      const pServers = readMcpServersFromFile(pFile, 'project');
      for (const s of pServers) {
        if (!seen.has(s.name)) {
          servers.push(s);
          seen.add(s.name);
        }
      }
    }
  }

  return { servers };
}

export function getPiResourcesImpl(_cwd?: string) {
  const resources: any[] = [];
  const settingsFile = path.join(PI_AGENT_DIR, 'settings.json');

  if (fs.existsSync(settingsFile)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      if (Array.isArray(settings.packages)) {
        for (const pkg of settings.packages) {
          const pkgStr = typeof pkg === 'string' ? pkg : pkg.source || String(pkg);
          let cleanName = pkgStr.replace(/^(npm:|https:\/\/github\.com\/)/, '');
          const lastAt = cleanName.lastIndexOf('@');
          if (lastAt > 0) {
            cleanName = cleanName.slice(0, lastAt);
          }
          const safeId = `pkg-${cleanName.replace(/[\/@:]/g, '-')}`;
          resources.push({
            id: safeId,
            name: cleanName,
            kind: 'package',
            source: pkgStr,
            scope: 'global',
            enabled: true,
            configPath: settingsFile,
          });
        }
      }
    } catch {}
  }

  const extensionsDir = path.join(PI_AGENT_DIR, 'extensions');
  if (fs.existsSync(extensionsDir)) {
    const entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const cleanName = e.name.replace(/\.(ts|js|mjs)$/, '');
      resources.push({
        id: `ext-${cleanName}`,
        name: cleanName,
        kind: 'extension',
        source: e.name,
        scope: 'global',
        enabled: true,
        configPath: path.join(extensionsDir, e.name),
        autoload: true,
      });
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
                input: m.input || ['text', 'image'],
                input_modalities: m.input || ['text', 'image'],
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

export function handleToggleMcpServer(args: any = {}) {
  const { name, enabled, cwd, configPath } = args;
  let mcpFile = configPath;
  if (!mcpFile || !fs.existsSync(mcpFile)) {
    if (cwd) {
      const candidates = [
        path.join(cwd, '.pi', 'mcp.json'),
        path.join(cwd, '.mcp.json'),
        path.join(cwd, 'mcp-adapter.json'),
      ];
      for (const c of candidates) {
        if (fs.existsSync(c)) {
          try {
            const d = JSON.parse(fs.readFileSync(c, 'utf8'));
            if (d.mcpServers?.[name] || d.servers?.[name]) {
              mcpFile = c;
              break;
            }
          } catch {}
        }
      }
      if (!mcpFile) mcpFile = path.join(cwd, '.pi', 'mcp.json');
    } else {
      mcpFile = path.join(PI_AGENT_DIR, 'mcp.json');
    }
  }
  if (mcpFile && fs.existsSync(mcpFile)) {
    const data = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
    const targetMap = data.mcpServers || data.servers;
    if (targetMap && targetMap[name]) {
      targetMap[name].disabled = !enabled;
      fs.writeFileSync(mcpFile, JSON.stringify(data, null, 2) + '\n', 'utf8');
    }
  }
  return { success: true, name, enabled, path: mcpFile };
}

export function handleGetPiResources(args: any = {}) {
  return getPiResourcesImpl(args.cwd || getActiveCwd());
}

export function handleGetBuiltinOAuthProviders() {
  return [
    {
      id: 'openai-codex',
      name: 'OpenAI Codex',
      status: 'authenticated',
      isLoggedIn: true,
    },
  ];
}
