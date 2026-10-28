import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getDockerContainerName,
  buildDockerRunArgs,
  getDockerContainerInfo,
  manageDockerSpeechService,
} from '@server/bridge/docker-speech';
import { DEFAULT_SPEECH_PREFERENCES } from '@core/types/speech';

describe('Docker Speech Service Management', () => {
  it('getDockerContainerName returns correct container names', () => {
    assert.equal(getDockerContainerName('piper'), 'wyoming-piper');
    assert.equal(getDockerContainerName('whisper'), 'wyoming-whisper');
  });

  it('buildDockerRunArgs constructs correct docker run command for Piper', () => {
    const args = buildDockerRunArgs('piper', {
      ...DEFAULT_SPEECH_PREFERENCES,
      wyomingTtsUrl: 'tcp://127.0.0.1:10200',
      wyomingTtsVoice: 'es_MX-claude-high',
    });

    assert.equal(args[0], 'run');
    assert.ok(args.includes('wyoming-piper'));
    assert.ok(args.includes('127.0.0.1:10200:10200'));
    assert.ok(args.includes('rhasspy/wyoming-piper:latest'));
    assert.ok(args.includes('es_MX-claude-high'));
  });

  it('buildDockerRunArgs constructs correct docker run command for Whisper', () => {
    const args = buildDockerRunArgs('whisper', {
      ...DEFAULT_SPEECH_PREFERENCES,
      wyomingSttUrl: 'tcp://127.0.0.1:10300',
      wyomingSttModel: 'tiny',
      wyomingSttLanguage: 'es',
    });

    assert.equal(args[0], 'run');
    assert.ok(args.includes('wyoming-whisper'));
    assert.ok(args.includes('127.0.0.1:10300:10300'));
    assert.ok(args.includes('rhasspy/wyoming-whisper:latest'));
    assert.ok(args.includes('tiny'));
    assert.ok(args.includes('es'));
  });

  it('getDockerContainerInfo parses running state from docker ps output', async () => {
    const mockExec = async (_args: string[]) => {
      return {
        stdout: 'c12345\trunning\tUp 2 hours',
        stderr: '',
        code: 0,
      };
    };

    const info = await getDockerContainerInfo('piper', mockExec as any);
    assert.equal(info.exists, true);
    assert.equal(info.state, 'running');
    assert.equal(info.containerId, 'c12345');
    assert.equal(info.statusText, 'Up 2 hours');
  });

  it('getDockerContainerInfo returns not_found when container does not exist', async () => {
    const mockExec = async () => {
      return {
        stdout: '',
        stderr: '',
        code: 0,
      };
    };

    const info = await getDockerContainerInfo('whisper', mockExec as any);
    assert.equal(info.exists, false);
    assert.equal(info.state, 'not_found');
  });

  it('manageDockerSpeechService executes start for existing stopped container', async () => {
    const history: string[][] = [];
    let state = 'exited';

    const mockExec = async (args: string[]) => {
      history.push(args);
      if (args[0] === 'ps') {
        return {
          stdout: `cid-1\t${state}\tExited (0)`,
          stderr: '',
          code: 0,
        };
      }
      if (args[0] === 'start') {
        state = 'running';
        return { stdout: 'wyoming-piper', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    };

    const result = await manageDockerSpeechService(
      'piper',
      'start',
      DEFAULT_SPEECH_PREFERENCES,
      mockExec as any
    );

    assert.equal(result.success, true);
    assert.equal(result.action, 'start');
    assert.ok(history.some((h) => h[0] === 'start' && h[1] === 'wyoming-piper'));
  });

  it('manageDockerSpeechService executes stop for running container', async () => {
    const history: string[][] = [];
    let state = 'running';

    const mockExec = async (args: string[]) => {
      history.push(args);
      if (args[0] === 'ps') {
        return {
          stdout: `cid-2\t${state}\tUp 10m`,
          stderr: '',
          code: 0,
        };
      }
      if (args[0] === 'stop') {
        state = 'exited';
        return { stdout: 'wyoming-piper', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    };

    const result = await manageDockerSpeechService(
      'piper',
      'stop',
      DEFAULT_SPEECH_PREFERENCES,
      mockExec as any
    );

    assert.equal(result.success, true);
    assert.equal(result.action, 'stop');
    assert.ok(history.some((h) => h[0] === 'stop' && h[1] === 'wyoming-piper'));
  });

  it('manageDockerSpeechService executes remove for existing container', async () => {
    const history: string[][] = [];
    let exists = true;

    const mockExec = async (args: string[]) => {
      history.push(args);
      if (args[0] === 'ps') {
        return {
          stdout: exists ? 'cid-3\trunning\tUp 10m' : '',
          stderr: '',
          code: 0,
        };
      }
      if (args[0] === 'rm') {
        exists = false;
        return { stdout: 'wyoming-piper', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    };

    const result = await manageDockerSpeechService(
      'piper',
      'remove',
      DEFAULT_SPEECH_PREFERENCES,
      mockExec as any
    );

    assert.equal(result.success, true);
    assert.equal(result.action, 'remove');
    assert.ok(history.some((h) => h[0] === 'rm' && h[2] === 'wyoming-piper'));
  });
});
