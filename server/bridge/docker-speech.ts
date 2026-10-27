import { spawn } from 'node:child_process';
import type { SpeechPreferences } from '../../src/core/types/speech';

export type DockerSpeechService = 'piper' | 'whisper';
export type DockerSpeechAction = 'status' | 'start' | 'stop' | 'restart' | 'remove' | 'create';

export interface DockerContainerInfo {
  exists: boolean;
  state: 'running' | 'exited' | 'paused' | 'restarting' | 'dead' | 'not_found';
  statusText?: string;
  containerId?: string;
}

export interface DockerServiceActionResult {
  success: boolean;
  service: DockerSpeechService;
  action: DockerSpeechAction;
  containerInfo: DockerContainerInfo;
  output?: string;
  error?: string;
}

/**
 * Maps service name to Docker container name.
 */
export function getDockerContainerName(service: DockerSpeechService): string {
  return service === 'piper' ? 'wyoming-piper' : 'wyoming-whisper';
}

/**
 * Runs a docker command asynchronously and safely.
 */
export function execDockerCommand(
  args: string[],
  timeoutMs = 30000,
  spawnFn: typeof spawn = spawn
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    let child: any;
    try {
      child = spawnFn('docker', args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      return reject(new Error(`No se pudo ejecutar docker: ${err.message}`));
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {}
      reject(new Error(`Comando de Docker excedió el tiempo límite de ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });

    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });

    child.on('error', (err: any) => {
      clearTimeout(timer);
      if (!timedOut) {
        reject(new Error(`Error iniciando docker: ${err.message}`));
      }
    });

    child.on('close', (code: number) => {
      clearTimeout(timer);
      if (!timedOut) {
        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          code: code ?? 0,
        });
      }
    });
  });
}

/**
 * Inspects whether the container exists and its current running state.
 */
export async function getDockerContainerInfo(
  service: DockerSpeechService,
  execFn = execDockerCommand
): Promise<DockerContainerInfo> {
  const containerName = getDockerContainerName(service);
  try {
    const res = await execFn([
      'ps',
      '-a',
      '--filter',
      `name=^/${containerName}$`,
      '--format',
      '{{.ID}}\t{{.State}}\t{{.Status}}',
    ]);

    if (res.code !== 0 || !res.stdout) {
      return { exists: false, state: 'not_found' };
    }

    const firstLine = res.stdout.split('\n')[0].trim();
    if (!firstLine) {
      return { exists: false, state: 'not_found' };
    }

    const [id, state, status] = firstLine.split('\t');
    const normalizedState =
      state === 'running'
        ? 'running'
        : state === 'exited'
          ? 'exited'
          : state === 'paused'
            ? 'paused'
            : state === 'restarting'
              ? 'restarting'
              : 'not_found';

    return {
      exists: true,
      containerId: id,
      state: normalizedState,
      statusText: status || state,
    };
  } catch {
    return { exists: false, state: 'not_found' };
  }
}

/**
 * Builds the arguments for `docker run` based on user speech preferences.
 */
export function buildDockerRunArgs(
  service: DockerSpeechService,
  preferences: SpeechPreferences
): string[] {
  const containerName = getDockerContainerName(service);

  const parsePort = (urlStr: string | undefined, defaultPort: number) => {
    if (!urlStr) return defaultPort;
    const parts = urlStr.replace(/^tcp:\/\//i, '').split(':');
    const port = parseInt(parts[1] || String(defaultPort), 10);
    return Number.isFinite(port) && port > 0 ? port : defaultPort;
  };

  if (service === 'piper') {
    const port = parsePort(preferences.wyomingTtsUrl, 10200);
    const voice = preferences.wyomingTtsVoice || preferences.selectedTtsPackId || 'es_MX-claude-high';

    return [
      'run',
      '-d',
      '--name',
      containerName,
      '--restart',
      'unless-stopped',
      '-p',
      `127.0.0.1:${port}:10200`,
      '-v',
      'wyoming_piper_data:/data',
      'rhasspy/wyoming-piper:latest',
      '--voice',
      voice,
      '--data-dir',
      '/data',
    ];
  } else {
    const port = parsePort(preferences.wyomingSttUrl, 10300);
    const model = preferences.wyomingSttModel || 'tiny';
    const lang = preferences.wyomingSttLanguage || 'es';

    return [
      'run',
      '-d',
      '--name',
      containerName,
      '--restart',
      'unless-stopped',
      '-p',
      `127.0.0.1:${port}:10300`,
      '-v',
      'wyoming_whisper_data:/data',
      'rhasspy/wyoming-whisper:latest',
      '--model',
      model,
      '--language',
      lang,
      '--data-dir',
      '/data',
    ];
  }
}

/**
 * Dispatches lifecycle management actions for speech Docker containers.
 */
export async function manageDockerSpeechService(
  service: DockerSpeechService,
  action: DockerSpeechAction,
  preferences: SpeechPreferences,
  execFn = execDockerCommand
): Promise<DockerServiceActionResult> {
  const containerName = getDockerContainerName(service);
  let initialInfo = await getDockerContainerInfo(service, execFn);

  try {
    switch (action) {
      case 'status': {
        return {
          success: true,
          service,
          action,
          containerInfo: initialInfo,
        };
      }

      case 'start': {
        if (!initialInfo.exists) {
          // If container doesn't exist, create and run it
          const runArgs = buildDockerRunArgs(service, preferences);
          const res = await execFn(runArgs);
          if (res.code !== 0) {
            throw new Error(res.stderr || `docker run falló con código ${res.code}`);
          }
        } else if (initialInfo.state !== 'running') {
          const res = await execFn(['start', containerName]);
          if (res.code !== 0) {
            throw new Error(res.stderr || `docker start falló con código ${res.code}`);
          }
        }
        break;
      }

      case 'stop': {
        if (initialInfo.exists && initialInfo.state === 'running') {
          const res = await execFn(['stop', containerName]);
          if (res.code !== 0) {
            throw new Error(res.stderr || `docker stop falló con código ${res.code}`);
          }
        }
        break;
      }

      case 'restart': {
        if (initialInfo.exists) {
          const res = await execFn(['restart', containerName]);
          if (res.code !== 0) {
            throw new Error(res.stderr || `docker restart falló con código ${res.code}`);
          }
        } else {
          // If it doesn't exist, run it
          const runArgs = buildDockerRunArgs(service, preferences);
          const res = await execFn(runArgs);
          if (res.code !== 0) {
            throw new Error(res.stderr || `docker run falló con código ${res.code}`);
          }
        }
        break;
      }

      case 'remove': {
        if (initialInfo.exists) {
          // Stop if running, then remove
          if (initialInfo.state === 'running') {
            await execFn(['stop', containerName]);
          }
          const res = await execFn(['rm', '-f', containerName]);
          if (res.code !== 0) {
            throw new Error(res.stderr || `docker rm falló con código ${res.code}`);
          }
        }
        break;
      }

      case 'create': {
        // Remove existing first if any, then recreate
        if (initialInfo.exists) {
          await execFn(['rm', '-f', containerName]);
        }
        const runArgs = buildDockerRunArgs(service, preferences);
        const res = await execFn(runArgs);
        if (res.code !== 0) {
          throw new Error(res.stderr || `docker run falló con código ${res.code}`);
        }
        break;
      }
    }

    const updatedInfo = await getDockerContainerInfo(service, execFn);
    return {
      success: true,
      service,
      action,
      containerInfo: updatedInfo,
    };
  } catch (err: any) {
    const updatedInfo = await getDockerContainerInfo(service, execFn);
    return {
      success: false,
      service,
      action,
      containerInfo: updatedInfo,
      error: err.message || String(err),
    };
  }
}
