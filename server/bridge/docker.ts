import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { manageDockerFiles } from './docker-files';

export type DockerOutput = (stream: 'stdout' | 'stderr', text: string) => void;
export type DockerRunner = (args: string[], onOutput?: DockerOutput) => Promise<{ stdout: string; stderr: string; code: number }>;
export const DOCKER_OUTPUT_LIMIT = 256 * 1024;

// Limit both streams together, including stderr, before buffering more data.
export function runDocker(args: string[], spawnFn: typeof spawn = spawn, onOutput?: DockerOutput): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawnFn('docker', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { reject(new Error('Docker unavailable')); return; }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let done = false;
    const finish = (error: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const isPull = args[0] === 'compose' && (args[args.length - 2] === 'pull' || (args[args.length - 5] === 'up' && args.slice(-4, -1).join(' ') === '-d --no-deps --force-recreate'));
    const timer = setTimeout(() => finish(new Error('Docker command timed out')), isPull ? 15 * 60_000 : 30_000);
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    const collect = (target: Buffer[], stream: 'stdout' | 'stderr', decoder: StringDecoder) => (chunk: Buffer) => {
      if (done) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (isPull) {
        const text = decoder.write(data);
        if (text) onOutput?.(stream, text);
        const remaining = Math.max(0, DOCKER_OUTPUT_LIMIT - bytes);
        if (remaining) target.push(data.subarray(0, remaining));
        bytes += Math.min(data.length, remaining);
        return;
      }
      bytes += data.length;
      if (bytes > DOCKER_OUTPUT_LIMIT) { finish(new Error('Docker output limit exceeded')); return; }
      target.push(data);
    };
    child.stdout?.on('data', collect(stdout, 'stdout', outDecoder));
    child.stderr?.on('data', collect(stderr, 'stderr', errDecoder));
    child.on('error', () => finish(new Error('Docker unavailable')));
    child.on('close', code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const out = outDecoder.end(); const err = errDecoder.end();
      if (out) onOutput?.('stdout', out); if (err) onOutput?.('stderr', err);
      resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), code: code ?? 1 });
    });
  });
}

export class DockerRequestError extends Error {}

export async function manageDocker(input: any, runner: DockerRunner = (args, output) => runDocker(args, spawn, output), authorized: () => boolean = () => true, emit?: (event: any) => void): Promise<unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DockerRequestError('Invalid Docker request');
  const { action, containerId, confirmed } = input;
  if (!['list', 'start', 'stop', 'restart', 'remove', 'logs', 'updateImage', 'files', 'readFile', 'saveFile'].includes(action)) throw new DockerRequestError('Unsupported Docker action');
  if (action !== 'list' && (typeof containerId !== 'string' || !/^[a-f0-9]{12,64}$/.test(containerId))) throw new DockerRequestError('Invalid container ID');
  if (['files', 'readFile', 'saveFile'].includes(action)) return manageDockerFiles(input, runner, authorized);
  if (action === 'remove' && confirmed !== true) throw new DockerRequestError('Removal requires confirmation');
  if (action === 'updateImage' && confirmed !== true) throw new DockerRequestError('Update requires confirmation');
  const execute = async (args: string[], output?: DockerOutput) => {
    if (!authorized()) throw new DockerRequestError('Web session expired');
    const result = await runner(args, output);
    if (result.code !== 0) throw new Error(result.stderr.trim() || `Docker command failed (${result.code})`);
    return result;
  };
  if (action === 'list') {
    const result = await execute(['ps', '-a', '--no-trunc', '--format', '{{json .}}']);
    const containers = result.stdout.trim() ? result.stdout.trim().split('\n').map(line => {
      const item = JSON.parse(line);
      return { id: item.ID, name: item.Names, state: item.State, status: item.Status };
    }) : [];
    return { containers };
  }
  if (action === 'remove') {
    const state = await execute(['inspect', '--format', '{{.State.Status}}', containerId]);
    if (!['exited', 'created', 'dead'].includes(state.stdout.trim())) throw new DockerRequestError('Container must be stopped');
    await execute(['rm', containerId]);
    return { ok: true };
  }
  if (action === 'updateImage') {
    const inspected = await execute(['inspect', '--format', '{{json .Config.Labels}}', containerId]);
    let labels: any;
    try { labels = JSON.parse(inspected.stdout); } catch { throw new DockerRequestError('Compose metadata unavailable'); }
    const project = labels?.['com.docker.compose.project'];
    const service = labels?.['com.docker.compose.service'];
    const working = labels?.['com.docker.compose.project.working_dir'];
    const config = labels?.['com.docker.compose.project.config_files'];
    if (typeof project !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(project) || typeof service !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(service) || typeof working !== 'string' || !path.isAbsolute(working) || typeof config !== 'string' || !config) throw new DockerRequestError('Compose metadata unavailable');
    const names = config.split(',');
    if (names.length > 32 || names.some((name: string) => !name || !/\.ya?ml$/i.test(name))) throw new DockerRequestError('Compose metadata unavailable');
    const files = names.map((name: string) => path.resolve(working, name));
    try {
      if (!(await fs.stat(working)).isDirectory()) throw new Error();
      for (const file of files) {
        const handle = await fs.open(file, 'r');
        try { if (!(await handle.stat()).isFile()) throw new Error(); } finally { await handle.close(); }
      }
    } catch { throw new DockerRequestError('Compose configuration unavailable'); }
    const args = ['compose', '-p', project, '--project-directory', working];
    for (const file of files) args.push('-f', file);
    const phase = (name: string) => { if (!authorized()) throw new DockerRequestError('Web session expired'); emit?.({ type: 'phase', phase: name }); };
    const output: DockerOutput = (stream, text) => { if (authorized()) emit?.({ type: 'output', stream, text }); };
    phase('pull');
    await execute([...args, 'pull', service], output);
    phase('recreate');
    try { await execute([...args, 'up', '-d', '--no-deps', '--force-recreate', service], output); }
    catch (error) { throw new Error(`Image downloaded; recreation failed: ${error instanceof Error ? error.message : String(error)}`); }
    return { ok: true };
  }
  if (action === 'logs') {
    const result = await execute(['logs', '--tail', '500', containerId]);
    return { stdout: result.stdout, stderr: result.stderr };
  }
  await execute([action, containerId]);
  return { ok: true };
}
