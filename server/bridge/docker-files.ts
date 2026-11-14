import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { DockerRequestError, type DockerRunner } from './docker';

const LIMIT = 256 * 1024;
const saving = new Set<string>();
type FileInfo = { path: string; kind: 'yaml' | 'env'; identity: string };
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function snapshot(name: string) {
  if ((await fs.lstat(name)).isSymbolicLink()) throw new DockerRequestError('Symbolic link configuration files are unavailable');
  const handle = await fs.open(name, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > LIMIT) throw new DockerRequestError('Configuration file unavailable or too large');
    const data = await handle.readFile();
    if (data.length > LIMIT) throw new DockerRequestError('Configuration file too large');
    const identity = digest(`${stat.dev}:${stat.ino}`);
    const version = digest(Buffer.concat([Buffer.from(`${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.size}:`), data]));
    return { data, identity, version, mode: stat.mode };
  } finally { await handle.close(); }
}

export async function manageDockerFiles(input: any, runner: DockerRunner, authorized: () => boolean) {
  const check = () => { if (!authorized()) throw new DockerRequestError('Web session expired'); };
  check();
  const result = await runner(['inspect', '--format', '{{json .Config.Labels}}', input.containerId]);
  check();
  if (result.code !== 0) throw new DockerRequestError('Compose metadata unavailable');
  let labels: any;
  try { labels = JSON.parse(result.stdout); } catch { throw new DockerRequestError('Compose metadata unavailable'); }
  const working = labels?.['com.docker.compose.project.working_dir'];
  const config = labels?.['com.docker.compose.project.config_files'];
  if (typeof working !== 'string' || !path.isAbsolute(working) || typeof config !== 'string' || !config) throw new DockerRequestError('Compose metadata unavailable');
  const yaml = config.split(',').map((name: string) => path.resolve(working, name));
  if (!yaml.length || yaml.length > 32 || yaml.some((name: string) => !/\.ya?ml$/i.test(name))) throw new DockerRequestError('Compose metadata unavailable');
  const files: FileInfo[] = [];
  try {
    for (const name of yaml) {
      const state = await snapshot(name);
      files.push({ path: name, kind: 'yaml', identity: state.identity });
    }
    for (const dir of new Set(yaml.map((name: string) => path.dirname(name)))) {
      const name = path.join(dir as string, '.env');
      try {
        const state = await snapshot(name);
        files.push({ path: name, kind: 'env', identity: state.identity });
      } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
    }
  } catch { throw new DockerRequestError('Compose files unavailable'); }
  check();
  if (input.action === 'files') return { files };
  const file = files.find(f => f.path === input.file?.path && f.kind === input.file?.kind && f.identity === input.file?.identity);
  if (!file) throw new DockerRequestError('Discovered file identity changed or unavailable');
  const lockKey = process.platform === 'win32' ? file.path.toLowerCase() : file.path;
  const locked = input.action === 'saveFile';
  if (locked && saving.has(lockKey)) throw new DockerRequestError('Configuration save already in progress');
  if (locked) saving.add(lockKey);
  try {
  let current;
  try { current = await snapshot(file.path); } catch { throw new DockerRequestError('Configuration file unavailable'); }
  if (current.identity !== file.identity) throw new DockerRequestError('Discovered file identity changed');
  if (input.action === 'readFile') { check(); return { content: current.data.toString('utf8'), version: current.version }; }
  if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > LIMIT || typeof input.version !== 'string') throw new DockerRequestError('Invalid configuration content');
  if (current.version !== input.version) throw new DockerRequestError('Configuration file changed concurrently');
  const names = yaml.map((name: string) => path.basename(name).toLowerCase());
  if (new Set(names).size !== names.length) throw new DockerRequestError('Compose validation unavailable: duplicate filenames');
  const envs = files.filter(f => f.kind === 'env');
  if (envs.length > 1) throw new DockerRequestError('Compose validation unavailable: multiple sibling .env files');
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'viewer-compose-'));
  let replacement = '';
  try {
    for (const original of yaml) {
      const content = original === file.path ? Buffer.from(input.content) : (await snapshot(original)).data;
      await fs.writeFile(path.join(stage, path.basename(original)), content, { mode: 0o600 });
    }
    const args = ['compose', '--project-directory', stage];
    for (const original of yaml) args.push('-f', path.join(stage, path.basename(original)));
    if (envs.length) {
      const env = envs[0];
      await fs.writeFile(path.join(stage, '.env'), env.path === file.path ? input.content : (await snapshot(env.path)).data, { mode: 0o600 });
      args.push('--env-file', path.join(stage, '.env'));
    }
    args.push('config', '--quiet');
    check();
    const validation = await runner(args);
    check();
    if (validation.code !== 0) {
      const diagnostic = validation.stderr.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').trim().slice(0, 4096);
      throw new DockerRequestError(`Compose validation failed: ${diagnostic || 'invalid configuration'}`);
    }
    const latest = await snapshot(file.path);
    if (latest.version !== input.version || latest.identity !== file.identity) throw new DockerRequestError('Configuration file changed concurrently');
    replacement = path.join(path.dirname(file.path), `.viewer-${randomUUID()}.tmp`);
    await fs.writeFile(replacement, input.content, { flag: 'wx', mode: current.mode & 0o777 });
    check();
    const final = await snapshot(file.path);
    if (final.version !== input.version || final.identity !== file.identity) throw new DockerRequestError('Configuration file changed concurrently');
    await fs.rename(replacement, file.path);
    replacement = '';
    return { ok: true };
  } finally {
    if (replacement) await fs.unlink(replacement).catch(() => {});
    await fs.rm(stage, { recursive: true, force: true });
  }
  } finally {
    if (locked) saving.delete(lockKey);
  }
}
