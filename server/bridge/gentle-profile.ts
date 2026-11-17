import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { replaceStagedFileSync } from '../atomic-file';
import { getAgnosticExecEnv, getHomeDir } from '../config';

const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const levels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

function configHome(): string {
  const env = getAgnosticExecEnv();
  // The server cannot prove which gentle-pi package the child Pi loads.
  // Never let an explicit home override a possibly bundled consumer.
  if (env.GENTLE_SHELL_PREFIX) throw new Error('Cannot verify bundled Gentle runtime and config destination for GENTLE_SHELL_PREFIX');
  if (env.GENTLE_PI_CONFIG_HOME) return env.GENTLE_PI_CONFIG_HOME;
  if (env.GENTLE_SHELL_CONFIG_HOME && path.isAbsolute(env.GENTLE_SHELL_CONFIG_HOME)) return env.GENTLE_SHELL_CONFIG_HOME;
  return path.join(getHomeDir(), '.pi', 'gentle-ai');
}

function projectRoot(cwd: string): string {
  const directory = fs.realpathSync(cwd);
  if (!fs.statSync(directory).isDirectory()) throw new Error('Project cwd must be a directory');
  const env = Object.fromEntries(Object.entries(getAgnosticExecEnv()).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  try {
    const root = execFileSync('git', ['--no-optional-locks', '-C', directory, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'], env, windowsHide: true }).replace(/\r?\n$/, '');
    return fs.realpathSync(root);
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr || '');
    if (/not a git repository/i.test(stderr)) return directory;
    throw new Error(`Cannot resolve project worktree: ${stderr || String(error)}`);
  }
}

export function writeGentleJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    replaceStagedFileSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

// Match gentle-pi's normalizers while refusing entries they would silently drop.
const validProfileName = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) && !['__proto__', 'constructor', 'prototype'].includes(name);
const validAgent = (name: string) => /^[A-Za-z0-9._:@/+%-]+$/.test(name);
const validModel = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9._~:@/+%-]+$/.test(value.trim());

function validStoredEntry(value: unknown): boolean {
  if (typeof value === 'string') return validModel(value);
  if (!record(value)) return false;
  if (Object.keys(value).length === 0) return true;
  return validModel(value.model) || levels.has(value.thinking) || levels.has(value.effort) || value.tier === 'fast' || value.tier === 'standard';
}

function validateStore(store: unknown): asserts store is Record<string, any> {
  if (!record(store) || store.kind !== 'gentle-pi.agent_model_profiles' || store.version !== 1 || !record(store.profiles)) throw new Error('Invalid Gentle profile store or version');
  for (const [name, config] of Object.entries(store.profiles)) {
    if (!validProfileName(name) || !record(config)) throw new Error(`Invalid Gentle profile: ${name}`);
    for (const [agent, entry] of Object.entries(config)) {
      if (!validAgent(agent) || !validStoredEntry(entry)) throw new Error(`Invalid Gentle routing: ${name}/${agent}`);
    }
  }
  if (store.active !== undefined && (typeof store.active !== 'string' || !validProfileName(store.active) || !Object.prototype.hasOwnProperty.call(store.profiles, store.active))) throw new Error('Invalid Gentle active profile');
}

function routing(raw: unknown): Record<string, { model?: string; thinking?: string }> {
  if (!record(raw)) throw new Error('Invalid profile routing');
  const result: Record<string, { model?: string; thinking?: string }> = Object.create(null);
  for (const [agent, entry] of Object.entries(raw)) {
    if (!validAgent(agent) || !record(entry)) throw new Error(`Invalid routing for ${agent}`);
    if (!validModel(entry.model)) throw new Error(`Invalid routing model for ${agent}`);
    if (entry.effort !== undefined && !levels.has(entry.effort)) throw new Error(`Invalid routing effort for ${agent}`);
    result[agent] = { model: entry.model.trim(), ...(entry.effort === undefined ? {} : { thinking: entry.effort }) };
  }
  return result;
}

function readStore(storePath: string): Record<string, any> {
  let store: Record<string, any> = { kind: 'gentle-pi.agent_model_profiles', version: 1, profiles: {} };
  try {
    store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Invalid Gentle profile store: ${String(error)}`);
  }
  validateStore(store);
  return store;
}

// Ownership is stored in the same atomic replacement as the routing entry.
const ownershipKey = 'openPiProfileOwnership';
function updateStore(id: string, profile: { model_profiles?: unknown }, create: boolean): string | undefined {
  const storePath = path.join(configHome(), 'profiles.json');
  const store = readStore(storePath);
  const name = `openpi-${createHash('sha256').update(id).digest('hex').slice(0, 56)}`;
  const metadata = store[ownershipKey];
  if (metadata !== undefined && (!record(metadata) || metadata.version !== 1 || !record(metadata.profiles))) throw new Error('Invalid Open Pi profile ownership metadata');
  const owners = metadata?.profiles ?? {};
  const exists = Object.prototype.hasOwnProperty.call(store.profiles, name);
  const owned = Object.prototype.hasOwnProperty.call(owners, name) && owners[name] === id;
  if ((exists && !owned) || (Object.prototype.hasOwnProperty.call(owners, name) && !owned) || (owned && !exists)) throw new Error('Gentle profile ownership collision');
  if (!exists && !create) return undefined;
  const config = routing(profile.model_profiles === undefined ? {} : profile.model_profiles);
  store.profiles[name] = config;
  store[ownershipKey] = { ...(metadata ?? {}), version: 1, profiles: { ...owners, [name]: id } };
  try { writeGentleJsonAtomic(storePath, store); } catch (error) { throw new Error(`Gentle profile publication failed: ${String(error)}`); }
  return name;
}

/** Verify a pre-marker publication against the previous profile before migrating it. */
export function verifyHistoricalGentlePublication(cwd: string, previous: { model_profiles?: unknown }): void {
  const root = projectRoot(cwd);
  let pin: any;
  try {
    pin = JSON.parse(fs.readFileSync(path.join(root, '.pi', 'gentle-ai', 'profile.json'), 'utf8'));
  } catch (error) {
    // An explicitly selected project can publish for the first time during save.
    // The caller still validates ownership before creating the stable entry.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const config = routing(previous.model_profiles === undefined ? {} : previous.model_profiles);
  const hash = createHash('sha256').update(JSON.stringify([process.platform === 'win32' ? root.toLowerCase() : root, config])).digest('hex');
  const expected = `openpi-${hash.slice(0, 56)}`;
  const store = readStore(path.join(configHome(), 'profiles.json'));
  if (pin.kind !== 'gentle-pi.agent_model_profile_pin' || pin.version !== 1 || pin.profile !== expected || JSON.stringify(store.profiles[expected]) !== JSON.stringify(config)) {
    throw new Error('Cannot verify historical Gentle publication; declaration or routing does not match the previous profile');
  }
}

/** Synchronous read/merge/write serializes calls within this server process only. */
export function publishGentleCatalogProfile(id: string, profile: { model_profiles?: unknown }, previouslyPublished: boolean): void {
  if (!updateStore(id, profile, !previouslyPublished)) throw new Error('Published Gentle profile is missing');
}

export function publishGentleProfile(cwd: string, id: string, profile: { model_profiles?: unknown }, markPublished: () => void): void {
  const root = projectRoot(cwd);
  const name = updateStore(id, profile, true)!;
  try {
    markPublished();
    writeGentleJsonAtomic(path.join(root, '.pi', 'gentle-ai', 'profile.json'), { kind: 'gentle-pi.agent_model_profile_pin', version: 1, profile: name });
  } catch (error) {
    throw new Error(`Gentle profile published but declaration failed; partial publication: ${String(error)}`);
  }
}
