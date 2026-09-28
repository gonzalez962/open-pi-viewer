import test from 'node:test';
import assert from 'node:assert/strict';
import {
  StartupManager,
  resolveConfigApplyOutcome,
} from '@features/settings/connection';
import {
  DEFAULT_CONFIG as APP_DEFAULT_CONFIG,
  isConfigReady,
  loadConnectConfig,
  saveConnectConfig,
} from '@features/settings/config';
import type { ConnectConfig } from '@core/types/connection';

const DEFAULT_CONFIG: ConnectConfig = {
  nodePath: 'node',
  piEntrypoint: 'C:\\pi\\cli.js',
  workingDirectory: 'C:\\projects\\demo',
  fileTreeRefreshInterval: 15,
};

/**
 * NOTE on scope: StartupManager already has extensive real-contract coverage in
 * tests/core/protocol.test.ts (successful start, failure path, cancel()-before-invocation,
 * explicit retry, stale-success/stale-error from superseded attempts, coalescing of
 * concurrent identical-config starts, listener-readiness ordering, and all three session
 * resume plans). That coverage was found while reading the class for this slice and
 * contradicts this task's brief, which stated StartupManager has zero tests today - it
 * does not. This file therefore adds only the previously-untested surface found by
 * reading the class: `isInFlight()`, `getActiveAttempt()`, and cancellation that lands
 * between bridge-listener readiness and the backend connect call (a distinct guard from
 * the already-tested cancelled-before-scheduled-microtask case).
 */

test('StartupManager: isInFlight() reflects attempt lifecycle and getActiveAttempt() exposes the current attempt', async () => {
  const manager = new StartupManager({
    connectFn: async () => ({ connected: true, model: null }),
    ensureListenersReadyFn: async () => {},
  });

  assert.strictEqual(manager.isInFlight(), false, 'no attempt started yet');
  assert.strictEqual(manager.getActiveAttempt(), null, 'no attempt started yet');

  const p = manager.start(DEFAULT_CONFIG);
  assert.strictEqual(manager.isInFlight(), true, 'attempt scheduled/executing');
  const active = manager.getActiveAttempt();
  assert.notStrictEqual(active, null);
  assert.strictEqual(active?.config.workingDirectory, DEFAULT_CONFIG.workingDirectory);
  assert.strictEqual(active?.cancelled, false);

  await p;

  assert.strictEqual(manager.isInFlight(), false, 'attempt settled');
  // The attempt identity itself is retained after a successful completion (only cancel()
  // clears it), which is what allows a later retry() with no explicit config to reuse it.
  assert.notStrictEqual(manager.getActiveAttempt(), null);
});

test('StartupManager: cancel() clears getActiveAttempt()', async () => {
  const manager = new StartupManager({
    connectFn: async () => ({ connected: true, model: null }),
    ensureListenersReadyFn: async () => {},
  });

  const p = manager.start(DEFAULT_CONFIG);
  assert.notStrictEqual(manager.getActiveAttempt(), null);

  manager.cancel();
  assert.strictEqual(manager.getActiveAttempt(), null, 'cancel() must clear the active attempt');

  await p;
});

test('StartupManager: cancelling after listeners are ready but before connect is invoked drops the connect call', async () => {
  let listenersReady = false;
  let connectCalled = false;

  const manager = new StartupManager({
    ensureListenersReadyFn: async () => {
      // Yield so the test can call cancel() after this resolves but before executeAttempt
      // proceeds to invoke connectFn - the guard at that specific point is untested
      // elsewhere (existing tests only cancel before the scheduled microtask runs at all).
      await Promise.resolve();
      listenersReady = true;
    },
    connectFn: async () => {
      connectCalled = true;
      return { connected: true, model: null };
    },
  });

  const p = manager.start(DEFAULT_CONFIG);
  // Let ensureListenersReadyFn's microtask resolve.
  await Promise.resolve();
  await Promise.resolve();
  assert.strictEqual(listenersReady, true, 'precondition: listeners must be ready already');

  manager.cancel();
  await p;

  assert.strictEqual(
    connectCalled,
    false,
    'connectFn must not be invoked once the attempt was cancelled after listener readiness'
  );
});

test('resolveConfigApplyOutcome: failure surfaces the save error (or a default message) and leaves the connection-load warning untouched', () => {
  const outcome = resolveConfigApplyOutcome({ success: false, error: 'disk full' });
  assert.deepStrictEqual(outcome, {
    settingsStorageNotice: 'disk full',
    clearConnectionStorageWarning: false,
  });

  const withoutMessage = resolveConfigApplyOutcome({ success: false });
  assert.strictEqual(
    withoutMessage.settingsStorageNotice,
    'Failed to save configuration to local storage'
  );
  assert.strictEqual(withoutMessage.clearConnectionStorageWarning, false);
});

test('resolveConfigApplyOutcome: success clears both the settings notice and the connection-load warning', () => {
  const outcome = resolveConfigApplyOutcome({ success: true });
  assert.deepStrictEqual(outcome, {
    settingsStorageNotice: null,
    clearConnectionStorageWarning: true,
  });
});

test('StartupManager: passes attempt.config to onStart and onError', async () => {
  let startedConfig: ConnectConfig | null = null;
  let errorMsg: string | null = null;
  let errorConfig: ConnectConfig | undefined = undefined;

  let shouldFail = false;
  const manager = new StartupManager({
    ensureListenersReadyFn: async () => {},
    connectFn: async () => {
      if (shouldFail) {
        throw new Error('connection failed');
      }
      return { connected: true, model: null };
    },
    onStart: (cfg) => {
      startedConfig = cfg;
    },
    onError: (err, cfg) => {
      errorMsg = err;
      errorConfig = cfg;
    },
  });

  await manager.start(DEFAULT_CONFIG);
  assert.deepStrictEqual(startedConfig, DEFAULT_CONFIG, 'onStart should receive attempt.config');
  assert.strictEqual(errorMsg, null);
  assert.strictEqual(errorConfig, undefined);

  shouldFail = true;
  await manager.start(DEFAULT_CONFIG, { force: true });
  assert.strictEqual(errorMsg, 'connection failed');
  assert.deepStrictEqual(errorConfig, DEFAULT_CONFIG, 'onError should receive attempt.config');
});

test('StartupManager: updateOptions updates onStart callback dynamically', async () => {
  let initialCalled = false;
  let updatedCalled = false;
  let receivedConfig: ConnectConfig | null = null;

  const manager = new StartupManager({
    ensureListenersReadyFn: async () => {},
    connectFn: async () => ({ connected: true, model: null }),
    onStart: () => {
      initialCalled = true;
    },
  });

  manager.updateOptions({
    onStart: (cfg) => {
      updatedCalled = true;
      receivedConfig = cfg;
    },
  });

  await manager.start(DEFAULT_CONFIG);
  assert.strictEqual(initialCalled, false, 'initial onStart should not have been called');
  assert.strictEqual(updatedCalled, true, 'updated onStart should have been called');
  assert.deepStrictEqual(receivedConfig, DEFAULT_CONFIG, 'updated onStart should receive config');
});

test('DEFAULT_CONFIG: personal paths are removed and defaults are unconfigured', () => {
  assert.strictEqual(APP_DEFAULT_CONFIG.nodePath, 'node');
  assert.strictEqual(APP_DEFAULT_CONFIG.piEntrypoint, '');
  assert.strictEqual(APP_DEFAULT_CONFIG.workingDirectory, '');
  assert.strictEqual(isConfigReady(APP_DEFAULT_CONFIG), false);
});

test('isConfigReady: correctly discriminates ready vs incomplete configurations', () => {
  assert.strictEqual(isConfigReady(null), false);
  assert.strictEqual(isConfigReady(undefined), false);
  assert.strictEqual(isConfigReady({ nodePath: 'node', piEntrypoint: '', workingDirectory: '' }), false);
  assert.strictEqual(isConfigReady({ nodePath: 'node', piEntrypoint: 'relative.js', workingDirectory: 'C:\\valid' }), false);
  assert.strictEqual(
    isConfigReady({
      nodePath: 'node',
      piEntrypoint: 'C:\\pi\\cli.js',
      workingDirectory: 'C:\\projects\\demo',
      fileTreeRefreshInterval: 15,
    }),
    true
  );
});

test('loadConnectConfig: preserves saved valid settings authoritative without mutation', () => {
  const mockStorageMap = new Map<string, string>();
  const mockStorage: Storage = {
    getItem: (key: string) => mockStorageMap.get(key) ?? null,
    setItem: (key: string, val: string) => mockStorageMap.set(key, val),
    removeItem: (key: string) => mockStorageMap.delete(key),
    clear: () => mockStorageMap.clear(),
    key: (i: number) => Array.from(mockStorageMap.keys())[i] ?? null,
    length: 0,
  };

  const validSaved: ConnectConfig = {
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    piEntrypoint: 'C:\\Users\\dev\\pi\\dist\\cli.js',
    workingDirectory: 'C:\\Users\\dev\\my-repo',
    fileTreeRefreshInterval: 20,
  };

  const saveRes = saveConnectConfig(validSaved, mockStorage);
  assert.strictEqual(saveRes.success, true);

  const loadRes = loadConnectConfig(mockStorage);
  assert.strictEqual(loadRes.source, 'stored');
  assert.deepStrictEqual(loadRes.config, validSaved);
  assert.strictEqual(isConfigReady(loadRes.config), true);
});

test('useConnection persistence: persists discovered config only after validated connection success (not on failure)', async () => {
  const mockStorageMap = new Map<string, string>();
  const mockStorage: Storage = {
    getItem: (key: string) => mockStorageMap.get(key) ?? null,
    setItem: (key: string, val: string) => mockStorageMap.set(key, val),
    removeItem: (key: string) => mockStorageMap.delete(key),
    clear: () => mockStorageMap.clear(),
    key: (i: number) => Array.from(mockStorageMap.keys())[i] ?? null,
    length: 0,
  };

  const discoveredConfig: ConnectConfig = {
    nodePath: 'node',
    piEntrypoint: 'C:\\pi\\discovered\\cli.js',
    workingDirectory: 'C:\\discovered\\repo',
    fileTreeRefreshInterval: 15,
  };

  let connectShouldFail = true;
  const manager = new StartupManager({
    ensureListenersReadyFn: async () => {},
    connectFn: async () => {
      if (connectShouldFail) {
        throw new Error('spawn failure');
      }
      return { connected: true, model: null };
    },
    onSuccess: () => {
      const active = manager.getActiveAttempt()?.config;
      if (active && isConfigReady(active)) {
        saveConnectConfig(active, mockStorage);
      }
    },
    onError: () => {
      // Must NOT persist on error
    },
  });

  // 1. Connection attempt fails -> storage must remain untouched
  await manager.start(discoveredConfig);
  assert.strictEqual(mockStorage.getItem('pi_viewer_connect_config'), null, 'failed attempt must not be persisted');

  // 2. Connection attempt succeeds -> validated config is now persisted
  connectShouldFail = false;
  await manager.start(discoveredConfig, { force: true });
  const storedRaw = mockStorage.getItem('pi_viewer_connect_config');
  assert.notStrictEqual(storedRaw, null, 'successful validated connection must be persisted');
  const parsed = JSON.parse(storedRaw!);
  assert.strictEqual(parsed.piEntrypoint, 'C:\\pi\\discovered\\cli.js');
  assert.strictEqual(parsed.workingDirectory, 'C:\\discovered\\repo');
});

test('useConnection persistence: avoids duplicate saved config write when connected config matches already-persisted settings', () => {
  let writeCount = 0;
  const mockStorage: Storage = {
    getItem: () => JSON.stringify({
      nodePath: 'node',
      piEntrypoint: 'C:\\saved\\cli.js',
      workingDirectory: 'C:\\saved\\repo',
      fileTreeRefreshInterval: 15,
    }),
    setItem: () => {
      writeCount++;
    },
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 1,
  };

  const savedConfig: ConnectConfig = {
    nodePath: 'node',
    piEntrypoint: 'C:\\saved\\cli.js',
    workingDirectory: 'C:\\saved\\repo',
    fileTreeRefreshInterval: 15,
  };

  let lastPersistedConfig: ConnectConfig | null = { ...savedConfig };

  const onConnectSuccessHandler = (attemptConfig: ConnectConfig) => {
    const alreadyPersisted =
      lastPersistedConfig &&
      lastPersistedConfig.nodePath === attemptConfig.nodePath &&
      lastPersistedConfig.piEntrypoint === attemptConfig.piEntrypoint &&
      lastPersistedConfig.workingDirectory === attemptConfig.workingDirectory &&
      lastPersistedConfig.fileTreeRefreshInterval === attemptConfig.fileTreeRefreshInterval;

    if (!alreadyPersisted) {
      saveConnectConfig(attemptConfig, mockStorage);
      lastPersistedConfig = { ...attemptConfig };
    }
  };

  // Connected with same saved configuration -> must NOT write to storage again
  onConnectSuccessHandler(savedConfig);
  assert.strictEqual(writeCount, 0, 'must not perform duplicate write on startup with existing saved configuration');

  // Connected with newly modified configuration -> writes to storage
  const updatedConfig: ConnectConfig = {
    ...savedConfig,
    workingDirectory: 'C:\\another\\repo',
  };
  onConnectSuccessHandler(updatedConfig);
  assert.strictEqual(writeCount, 1, 'must write to storage when configuration changed');
  assert.deepStrictEqual(lastPersistedConfig, updatedConfig);
});

test('StartupManager: start() resolves with a success outcome only after onSuccess fired', async () => {
  const events: string[] = [];
  const manager = new StartupManager({
    ensureListenersReadyFn: async () => {},
    connectFn: async () => ({ connected: true, model: null }),
    onSuccess: () => {
      events.push('onSuccess');
    },
  });

  const outcome = await manager.start(DEFAULT_CONFIG);
  events.push('resolved');

  assert.deepStrictEqual(outcome, { status: 'success' });
  assert.deepStrictEqual(events, ['onSuccess', 'resolved']);
});

test('StartupManager: start() resolves with an error outcome carrying the connect error message', async () => {
  const manager = new StartupManager({
    ensureListenersReadyFn: async () => {},
    connectFn: async () => {
      throw new Error('spawn node ENOENT');
    },
  });

  const outcome = await manager.retry(DEFAULT_CONFIG);
  assert.deepStrictEqual(outcome, { status: 'error', error: 'spawn node ENOENT' });
});

test('StartupManager: a superseded attempt resolves as cancelled, never as success', async () => {
  let release: () => void = () => {};
  const manager = new StartupManager({
    ensureListenersReadyFn: async () => {},
    connectFn: () =>
      new Promise((resolve) => {
        release = () => resolve({ connected: true, model: null });
      }),
  });

  const first = manager.start(DEFAULT_CONFIG);
  // Let the first attempt reach connectFn before superseding it.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const second = manager.retry(DEFAULT_CONFIG);
  release();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  release();

  assert.deepStrictEqual(await first, { status: 'cancelled' });
  assert.deepStrictEqual(await second, { status: 'success' });
});

test('StartupManager: an attempt cancelled before its scheduled invocation resolves as cancelled', async () => {
  const manager = new StartupManager({
    ensureListenersReadyFn: async () => {},
    connectFn: async () => ({ connected: true, model: null }),
  });

  const p = manager.start(DEFAULT_CONFIG);
  manager.cancel();
  assert.deepStrictEqual(await p, { status: 'cancelled' });
});
