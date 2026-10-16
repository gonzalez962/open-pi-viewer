import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  normalizeResourceId,
  normalizeTargetSource,
  resourceIdentitiesMatch,
  type PiResourceKind,
} from '../../src/core/types/extensions';
import { getPiAgentDir } from './state';
import { resolveCrossPlatformCwd } from './paths';
import { getSupportedProjectMcpPaths } from './resource-activation';

type Config = Record<string, any>;

function readConfig(file: string): Config {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Configuration root must be an object: ${file}`);
  }
  return value;
}

function writeConfig(file: string, value: Config): void {
  const temporary = `${file}.tmp.${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {
      flag: 'wx', mode: fs.statSync(file).mode & 0o777,
    });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function parseScope(args: any) {
  const scope = args.scope;
  if (scope !== undefined && scope !== 'global' && scope !== 'project') {
    throw new Error(`Invalid resource scope '${scope}'`);
  }
  if (args.cwd !== undefined && (typeof args.cwd !== 'string' || !args.cwd.trim())) {
    throw new Error('Invalid project cwd');
  }
  if (scope === 'project' && !args.cwd) {
    throw new Error('Project scope requested, but no valid cwd provided');
  }
  return { scope, cwd: args.cwd ? resolveCrossPlatformCwd(args.cwd) : undefined };
}

function selectConfig(
  scope: string | undefined,
  global: string,
  projects: string[],
  contains: (config: Config) => boolean,
) {
  if (scope === 'global') return { file: global, scope: 'global' as const };
  for (const file of projects) {
    if (fs.existsSync(file) && contains(readConfig(file))) {
      return { file, scope: 'project' as const };
    }
  }
  if (scope === 'project') throw new Error('Resource not found in project configuration');
  return { file: global, scope: 'global' as const };
}

function mcpMap(config: Config): Config {
  const map = config.mcpServers ?? config.servers;
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    throw new Error('MCP servers map not found in configuration');
  }
  return map;
}

export function handleDeleteMcpServer(args: any) {
  if (typeof args.name !== 'string' || !args.name.trim()) throw new Error('Server name must not be empty');
  const name = args.name.trim();
  const { scope, cwd } = parseScope(args);
  const { file } = selectConfig(scope, path.join(getPiAgentDir(), 'mcp.json'),
    cwd ? getSupportedProjectMcpPaths(cwd) : [],
    config => Object.prototype.hasOwnProperty.call(mcpMap(config), name));
  const config = readConfig(file);
  const map = mcpMap(config);
  if (!Object.prototype.hasOwnProperty.call(map, name)) throw new Error(`MCP server '${name}' not found`);
  delete map[name];
  writeConfig(file, config);
  return { success: true, name, path: file };
}

export function handleDeletePiResource(args: any) {
  if (args.kind !== 'extension' && args.kind !== 'package') throw new Error('Invalid resource kind');
  if (typeof args.source !== 'string' || !args.source.trim()) throw new Error('Resource source must not be empty');
  const kind: PiResourceKind = args.kind;
  const source = normalizeTargetSource(kind, args.source);
  const key = kind === 'extension' ? 'extensions' : 'packages';
  const matches = (entry: any) => {
    const candidate = typeof entry === 'string' ? entry : entry?.source ?? entry?.path;
    return typeof candidate === 'string' && resourceIdentitiesMatch(kind, candidate, source);
  };
  const { scope, cwd } = parseScope(args);
  const target = selectConfig(scope, path.join(getPiAgentDir(), 'settings.json'),
    cwd ? [path.join(cwd, '.pi', 'settings.json'), path.join(cwd, '.pi.json')] : [],
    config => Array.isArray(config[key]) && config[key].some(matches));
  const config = readConfig(target.file);
  if (!Array.isArray(config[key])) throw new Error(`'${key}' array not found in settings`);
  const index = config[key].findIndex(matches);
  if (index < 0) throw new Error(`Resource '${source}' not found in '${key}'`);
  config[key].splice(index, 1);
  writeConfig(target.file, config);
  return { success: true, id: normalizeResourceId(target.scope, kind, source), kind, source,
    scope: target.scope, configPath: target.file, requiresReload: true };
}
