import { spawn } from 'node:child_process';

export type DockerRunner = (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;
export const DOCKER_OUTPUT_LIMIT = 256 * 1024;

// Limit both streams together, including stderr, before buffering more data.
export function runDocker(args: string[], spawnFn: typeof spawn = spawn): Promise<{ stdout: string; stderr: string; code: number }> {
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
    const timer = setTimeout(() => finish(new Error('Docker command timed out')), 30_000);
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      if (done) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += data.length;
      if (bytes > DOCKER_OUTPUT_LIMIT) { finish(new Error('Docker output limit exceeded')); return; }
      target.push(data);
    };
    child.stdout?.on('data', collect(stdout));
    child.stderr?.on('data', collect(stderr));
    child.on('error', () => finish(new Error('Docker unavailable')));
    child.on('close', code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), code: code ?? 1 });
    });
  });
}

export class DockerRequestError extends Error {}

export async function manageDocker(input: any, runner: DockerRunner = runDocker, authorized: () => boolean = () => true): Promise<unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DockerRequestError('Invalid Docker request');
  const { action, containerId, confirmed } = input;
  if (!['list', 'start', 'stop', 'restart', 'remove', 'logs'].includes(action)) throw new DockerRequestError('Unsupported Docker action');
  if (action !== 'list' && (typeof containerId !== 'string' || !/^[a-f0-9]{12,64}$/.test(containerId))) throw new DockerRequestError('Invalid container ID');
  if (action === 'remove' && confirmed !== true) throw new DockerRequestError('Removal requires confirmation');
  const execute = async (args: string[]) => {
    if (!authorized()) throw new DockerRequestError('Web session expired');
    const result = await runner(args);
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
  if (action === 'logs') {
    const result = await execute(['logs', '--tail', '500', containerId]);
    return { stdout: result.stdout, stderr: result.stderr };
  }
  await execute([action, containerId]);
  return { ok: true };
}
