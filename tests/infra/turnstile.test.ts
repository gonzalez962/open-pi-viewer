import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TURNSTILE_SCRIPT_URL,
  isTurnstileAvailable,
  getTurnstileApi,
  loadTurnstileScript,
  renderTurnstileWidget,
  resetTurnstileWidget,
  removeTurnstileWidget,
  type TurnstileApi,
  type TurnstileRenderOptions,
} from '@infra/turnstile';

test('TURNSTILE_SCRIPT_URL matches Cloudflare official explicit rendering endpoint', () => {
  assert.equal(
    TURNSTILE_SCRIPT_URL,
    'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
  );
});

test('isTurnstileAvailable and getTurnstileApi detect window.turnstile', () => {
  const originalWindow = (globalThis as any).window;
  try {
    (globalThis as any).window = {};
    assert.equal(isTurnstileAvailable(), false);
    assert.equal(getTurnstileApi(), undefined);

    const mockApi: TurnstileApi = {
      render: () => 'widget-1',
      reset: () => {},
      remove: () => {},
    };
    (globalThis as any).window.turnstile = mockApi;
    assert.equal(isTurnstileAvailable(), true);
    assert.equal(getTurnstileApi(), mockApi);
  } finally {
    (globalThis as any).window = originalWindow;
  }
});

test('loadTurnstileScript resolves immediately if window.turnstile is already present', async () => {
  const originalWindow = (globalThis as any).window;
  try {
    const mockApi: TurnstileApi = {
      render: () => 'widget-mock',
      reset: () => {},
      remove: () => {},
    };
    (globalThis as any).window = { turnstile: mockApi };

    const api = await loadTurnstileScript();
    assert.equal(api, mockApi);
  } finally {
    (globalThis as any).window = originalWindow;
  }
});

test('loadTurnstileScript creates script element and resolves on load', async () => {
  const originalWindow = (globalThis as any).window;
  const originalDocument = (globalThis as any).document;

  try {
    let appendedScript: any = null;
    const mockHead = {
      appendChild: (node: any) => {
        appendedScript = node;
        // Simulate Turnstile defining window.turnstile and script triggering onload
        setTimeout(() => {
          (globalThis as any).window.turnstile = {
            render: () => 'w-1',
            reset: () => {},
            remove: () => {},
          };
          if (typeof node.onload === 'function') {
            node.onload();
          }
        }, 10);
      },
    };

    const mockDoc = {
      head: mockHead,
      createElement: (tag: string) => {
        return {
          tagName: tag.toUpperCase(),
          src: '',
          async: false,
          defer: false,
          onload: null as any,
          onerror: null as any,
        };
      },
      querySelector: () => null,
    };

    (globalThis as any).window = {};
    (globalThis as any).document = mockDoc;

    const api = await loadTurnstileScript({ documentRef: mockDoc as any });
    assert.ok(api);
    assert.equal(appendedScript.src, TURNSTILE_SCRIPT_URL);
    assert.equal(appendedScript.async, true);
    assert.equal(appendedScript.defer, true);
  } finally {
    (globalThis as any).window = originalWindow;
    (globalThis as any).document = originalDocument;
  }
});

test('loadTurnstileScript rejects and allows clean retry when script fails to load', async () => {
  const originalWindow = (globalThis as any).window;
  const originalDocument = (globalThis as any).document;

  try {
    let scriptInstance: any = null;
    let removeCalled = false;

    const mockHead = {
      appendChild: (node: any) => {
        scriptInstance = node;
        setTimeout(() => {
          if (typeof node.onerror === 'function') {
            node.onerror(new Error('Network error loading Turnstile script'));
          }
        }, 10);
      },
      removeChild: (node: any) => {
        if (node === scriptInstance) {
          removeCalled = true;
        }
      },
    };

    const mockDoc = {
      head: mockHead,
      createElement: (tag: string) => ({
        tagName: tag.toUpperCase(),
        src: '',
        async: false,
        defer: false,
        onload: null as any,
        onerror: null as any,
        remove: () => {
          removeCalled = true;
        },
      }),
      querySelector: () => scriptInstance,
    };

    (globalThis as any).window = {};
    (globalThis as any).document = mockDoc;

    await assert.rejects(
      async () => loadTurnstileScript({ documentRef: mockDoc as any }),
      /Failed to load Turnstile script/
    );
    assert.ok(removeCalled, 'Failed script element should be cleaned up on error to allow retry');
  } finally {
    (globalThis as any).window = originalWindow;
    (globalThis as any).document = originalDocument;
  }
});

test('loadTurnstileScript times out after timeoutMs, cleans up script, and enables retry', async () => {
  const originalWindow = (globalThis as any).window;
  const originalDocument = (globalThis as any).document;

  try {
    let scriptInstance: any = null;
    let removeCalled = false;

    const mockHead = {
      appendChild: (node: any) => {
        scriptInstance = node;
        // Do not trigger onload or onerror; simulate hanging network request
      },
      removeChild: (node: any) => {
        if (node === scriptInstance) {
          removeCalled = true;
        }
      },
    };

    const mockDoc = {
      head: mockHead,
      createElement: (tag: string) => ({
        tagName: tag.toUpperCase(),
        src: '',
        async: false,
        defer: false,
        onload: null as any,
        onerror: null as any,
        remove: () => {
          removeCalled = true;
        },
      }),
      querySelector: () => scriptInstance,
    };

    (globalThis as any).window = {};
    (globalThis as any).document = mockDoc;

    await assert.rejects(
      async () =>
        loadTurnstileScript({
          documentRef: mockDoc as any,
          timeoutMs: 30,
        }),
      /timed out/
    );
    assert.ok(removeCalled, 'Script must be removed on timeout so user retry can succeed');
  } finally {
    (globalThis as any).window = originalWindow;
    (globalThis as any).document = originalDocument;
  }
});

test('loadTurnstileScript resolves on load without incompatible api.ready and cleans up if API missing', async () => {
  const originalWindow = (globalThis as any).window;
  const originalDocument = (globalThis as any).document;

  try {
    let removeCalled = false;
    let loadListener: (() => void) | null = null;

    const mockExistingScript = {
      tagName: 'SCRIPT',
      src: TURNSTILE_SCRIPT_URL,
      addEventListener: (evt: string, fn: any) => {
        if (evt === 'load') loadListener = fn;
      },
      removeEventListener: () => {},
      remove: () => {
        removeCalled = true;
      },
    };

    const mockDoc = {
      head: {},
      querySelector: () => mockExistingScript,
    };

    (globalThis as any).window = {};
    (globalThis as any).document = mockDoc;

    // Test case 1: load fires but API missing -> should reject and remove script
    const promise1 = loadTurnstileScript({ documentRef: mockDoc as any });
    assert.ok(loadListener);
    if (typeof loadListener === 'function') {
      (loadListener as () => void)();
    }
    await assert.rejects(promise1, /Turnstile API unavailable after script load/);
    assert.ok(removeCalled, 'Existing script should be removed if API is missing on load');

    // Real Cloudflare rejects ready() when the script uses async/defer.
    removeCalled = false;
    let readyCalled = false;

    const mockApi: TurnstileApi = {
      render: () => 'w1',
      reset: () => {},
      remove: () => {},
      ready: () => {
        readyCalled = true;
        throw new Error('Remove async/defer before using turnstile.ready()');
      },
    };

    const promise2 = loadTurnstileScript({ documentRef: mockDoc as any });
    (globalThis as any).window.turnstile = mockApi;
    if (typeof loadListener === 'function') {
      (loadListener as () => void)();
    }
    assert.equal(readyCalled, false, 'load event already guarantees API availability');
    const resolvedApi = await promise2;
    assert.equal(resolvedApi, mockApi);
  } finally {
    (globalThis as any).window = originalWindow;
    (globalThis as any).document = originalDocument;
  }
});

test('renderTurnstileWidget delegates to api.render with action=login and callbacks', () => {
  const captured: { options?: TurnstileRenderOptions; container?: any } = {};

  const mockApi: TurnstileApi = {
    render: (container, options) => {
      captured.container = container;
      captured.options = options;
      return 'rendered-id-123';
    },
    reset: () => {},
    remove: () => {},
  };

  const fakeElement = {} as HTMLElement;
  let tokenReceived = '';
  let errorReceived: any = null;
  let expiredCalled = false;
  let timeoutCalled = false;

  const widgetId = renderTurnstileWidget(
    fakeElement,
    {
      sitekey: '0x4AAAAAAAbcdef123456789',
      action: 'login',
      callback: (t) => {
        tokenReceived = t;
      },
      'error-callback': (code) => {
        errorReceived = code;
      },
      'expired-callback': () => {
        expiredCalled = true;
      },
      'timeout-callback': () => {
        timeoutCalled = true;
      },
    },
    mockApi
  );

  assert.equal(widgetId, 'rendered-id-123');
  assert.equal(captured.container, fakeElement);
  assert.ok(captured.options);
  const opts = captured.options as TurnstileRenderOptions;
  assert.equal(opts.sitekey, '0x4AAAAAAAbcdef123456789');
  assert.equal(opts.action, 'login');

  opts.callback?.('token-sample');
  assert.equal(tokenReceived, 'token-sample');

  opts['error-callback']?.('1000');
  assert.equal(errorReceived, '1000');

  opts['expired-callback']?.();
  assert.equal(expiredCalled, true);

  opts['timeout-callback']?.();
  assert.equal(timeoutCalled, true);
});

test('resetTurnstileWidget and removeTurnstileWidget delegate to api methods safely', () => {
  let resetId: string | undefined;
  let removeId: string | undefined;

  const mockApi: TurnstileApi = {
    render: () => 'id',
    reset: (id) => {
      resetId = id;
    },
    remove: (id) => {
      removeId = id;
    },
  };

  resetTurnstileWidget('widget-123', mockApi);
  assert.equal(resetId, 'widget-123');

  removeTurnstileWidget('widget-123', mockApi);
  assert.equal(removeId, 'widget-123');

  // Does not throw when api is absent
  assert.doesNotThrow(() => resetTurnstileWidget('widget-123', undefined));
  assert.doesNotThrow(() => removeTurnstileWidget('widget-123', undefined));
});
