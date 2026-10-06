import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDownloadAdapter,
  isDownloadSupported,
  triggerDownload,
  type DownloadDocumentHost,
  type DownloadHost,
  type DownloadPayload,
  type DownloadResult,
} from '@infra/download';

interface MockAnchor {
  href: string;
  download: string;
  rel: string;
  style: { display?: string };
  clickCalls: number;
  click: () => void;
}

interface MockHostContext {
  host: DownloadHost;
  createdBlobs: { parts: BlobPart[]; options?: BlobPropertyBag }[];
  createdUrls: string[];
  revokedUrls: string[];
  createdAnchors: MockAnchor[];
  appendedNodes: unknown[];
  removedNodes: unknown[];
  scheduledTimers: { handler: () => void; timeout?: number }[];
}

function createMockHost(overrides: {
  createBlobError?: Error;
  createUrlError?: Error;
  createElementError?: Error;
  appendChildError?: Error;
  clickError?: Error;
  documentMissing?: boolean;
  createUrlMissing?: boolean;
  blobMissing?: boolean;
} = {}): MockHostContext {
  const createdBlobs: { parts: BlobPart[]; options?: BlobPropertyBag }[] = [];
  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];
  const createdAnchors: MockAnchor[] = [];
  const appendedNodes: unknown[] = [];
  const removedNodes: unknown[] = [];
  const scheduledTimers: { handler: () => void; timeout?: number }[] = [];

  let urlCounter = 0;

  const mockBlob = class FakeBlob {
    parts: BlobPart[];
    options?: BlobPropertyBag;
    constructor(parts: BlobPart[], options?: BlobPropertyBag) {
      if (overrides.createBlobError) {
        throw overrides.createBlobError;
      }
      this.parts = parts;
      this.options = options;
      createdBlobs.push({ parts, options });
    }
  } as unknown as typeof Blob;

  const host: DownloadHost = {
    Blob: overrides.blobMissing ? undefined : mockBlob,
    createObjectURL: overrides.createUrlMissing
      ? undefined
      : (_blob: Blob) => {
          if (overrides.createUrlError) {
            throw overrides.createUrlError;
          }
          const url = `blob:mock-export://${++urlCounter}`;
          createdUrls.push(url);
          return url;
        },
    revokeObjectURL: (url: string) => {
      revokedUrls.push(url);
    },
    setTimeout: (handler: () => void, timeout?: number) => {
      scheduledTimers.push({ handler, timeout });
      return scheduledTimers.length;
    },
    document: overrides.documentMissing
      ? undefined
      : {
          createElement: (tagName: string) => {
            if (overrides.createElementError) {
              throw overrides.createElementError;
            }
            if (tagName !== 'a') {
              throw new Error(`Unexpected element created: ${tagName}`);
            }
            const anchor: MockAnchor = {
              href: '',
              download: '',
              rel: '',
              style: {},
              clickCalls: 0,
              click() {
                this.clickCalls += 1;
                if (overrides.clickError) {
                  throw overrides.clickError;
                }
              },
            };
            createdAnchors.push(anchor);
            return anchor;
          },
          body: {
            appendChild: (node: unknown) => {
              if (overrides.appendChildError) {
                throw overrides.appendChildError;
              }
              appendedNodes.push(node);
              return node;
            },
            removeChild: (node: unknown) => {
              removedNodes.push(node);
              return node;
            },
          },
        },
  };

  return {
    host,
    createdBlobs,
    createdUrls,
    revokedUrls,
    createdAnchors,
    appendedNodes,
    removedNodes,
    scheduledTimers,
  };
}

test('download: successfully initiates download via Blob and anchor click', () => {
  const ctx = createMockHost();
  const payload: DownloadPayload = {
    content: '# Test Markdown',
    filename: 'conversation-2026-03-30.md',
    mimeType: 'text/markdown;charset=utf-8',
  };

  const result: DownloadResult = triggerDownload(payload, { host: ctx.host });

  assert.equal(result.success, true);
  assert.equal(result.initiated, true);
  assert.equal(result.filename, 'conversation-2026-03-30.md');
  assert.equal(result.error, undefined);

  // Blob creation verified
  assert.equal(ctx.createdBlobs.length, 1);
  assert.deepEqual(ctx.createdBlobs[0].parts, ['# Test Markdown']);
  assert.equal(ctx.createdBlobs[0].options?.type, 'text/markdown;charset=utf-8');

  // Object URL created
  assert.equal(ctx.createdUrls.length, 1);
  const createdUrl = ctx.createdUrls[0];

  // Anchor created and configured
  assert.equal(ctx.createdAnchors.length, 1);
  const anchor = ctx.createdAnchors[0];
  assert.equal(anchor.href, createdUrl);
  assert.equal(anchor.download, 'conversation-2026-03-30.md');
  assert.equal(anchor.rel, 'noopener');
  assert.equal(anchor.style.display, 'none');

  // DOM attachment and click initiated
  assert.equal(ctx.appendedNodes.length, 1);
  assert.equal(ctx.appendedNodes[0], anchor);
  assert.equal(anchor.clickCalls, 1);

  // DOM anchor cleaned up immediately after click
  assert.equal(ctx.removedNodes.length, 1);
  assert.equal(ctx.removedNodes[0], anchor);

  // URL revocation is deferred to avoid race with browser download manager
  assert.equal(ctx.revokedUrls.length, 0);
  assert.equal(ctx.scheduledTimers.length, 1);

  // When deferred timer fires, object URL is revoked
  ctx.scheduledTimers[0].handler();
  assert.deepEqual(ctx.revokedUrls, [createdUrl]);
});

test('download: supports immediate URL revocation when revokeDelayMs is 0', () => {
  const ctx = createMockHost();
  const payload: DownloadPayload = {
    content: '{"messages":[]}',
    filename: 'export.json',
    mimeType: 'application/json;charset=utf-8',
  };

  const result = triggerDownload(payload, { host: ctx.host, revokeDelayMs: 0 });

  assert.equal(result.success, true);
  assert.equal(result.initiated, true);
  assert.equal(ctx.scheduledTimers.length, 0);
  assert.equal(ctx.revokedUrls.length, 1);
  assert.equal(ctx.revokedUrls[0], ctx.createdUrls[0]);
});

test('download: cleans up object URL immediately when createElement throws', () => {
  const ctx = createMockHost({ createElementError: new Error('DOM allocation failed') });
  const payload: DownloadPayload = {
    content: 'data',
    filename: 'test.md',
  };

  const result = triggerDownload(payload, { host: ctx.host });

  assert.equal(result.success, false);
  assert.equal(result.initiated, false);
  assert.ok(result.error?.includes('DOM allocation failed'));
  // URL created was revoked immediately on error to avoid leak
  assert.equal(ctx.createdUrls.length, 1);
  assert.deepEqual(ctx.revokedUrls, [ctx.createdUrls[0]]);
  assert.equal(ctx.appendedNodes.length, 0);
});

test('download: cleans up DOM node and URL when appendChild throws', () => {
  const ctx = createMockHost({ appendChildError: new Error('Failed to attach node') });
  const payload: DownloadPayload = {
    content: 'data',
    filename: 'test.md',
  };

  const result = triggerDownload(payload, { host: ctx.host });

  assert.equal(result.success, false);
  assert.equal(result.initiated, false);
  assert.ok(result.error?.includes('Failed to attach node'));
  assert.deepEqual(ctx.revokedUrls, [ctx.createdUrls[0]]);
});

test('download: cleans up DOM node and URL when click throws', () => {
  const ctx = createMockHost({ clickError: new Error('User gesture required') });
  const payload: DownloadPayload = {
    content: 'data',
    filename: 'test.md',
  };

  const result = triggerDownload(payload, { host: ctx.host });

  assert.equal(result.success, false);
  assert.equal(result.initiated, false);
  assert.ok(result.error?.includes('User gesture required'));
  // Node must be removed from DOM
  assert.equal(ctx.removedNodes.length, 1);
  // URL must be revoked
  assert.deepEqual(ctx.revokedUrls, [ctx.createdUrls[0]]);
});

test('download: reports appropriate error when document is missing', () => {
  const ctx = createMockHost({ documentMissing: true });
  const payload: DownloadPayload = {
    content: 'data',
    filename: 'test.md',
  };

  const result = triggerDownload(payload, { host: ctx.host });

  assert.equal(result.success, false);
  assert.equal(result.initiated, false);
  assert.ok(result.error?.includes('document is not available'));
});

test('download: reports appropriate error when createObjectURL is missing', () => {
  const ctx = createMockHost({ createUrlMissing: true });
  const payload: DownloadPayload = {
    content: 'data',
    filename: 'test.md',
  };

  const result = triggerDownload(payload, { host: ctx.host });

  assert.equal(result.success, false);
  assert.equal(result.initiated, false);
  assert.ok(result.error?.includes('createObjectURL is not available'));
});

test('download: reports appropriate error when Blob is missing', () => {
  const ctx = createMockHost({ blobMissing: true });
  const payload: DownloadPayload = {
    content: 'data',
    filename: 'test.md',
  };

  const result = triggerDownload(payload, { host: ctx.host });

  assert.equal(result.success, false);
  assert.equal(result.initiated, false);
  assert.ok(result.error?.includes('Blob API is not available'));
});

test('download: validates filename and content input', () => {
  const ctx = createMockHost();

  const emptyFilename = triggerDownload(
    { content: 'some text', filename: '   ' },
    { host: ctx.host }
  );
  assert.equal(emptyFilename.success, false);
  assert.ok(emptyFilename.error?.includes('Filename is required'));

  const invalidContent = triggerDownload(
    { content: null as unknown as string, filename: 'test.md' },
    { host: ctx.host }
  );
  assert.equal(invalidContent.success, false);
  assert.ok(invalidContent.error?.includes('Content must be a string'));
});

test('download: adapter factory and capability check work as expected', () => {
  const ctx = createMockHost();
  const adapter = createDownloadAdapter({ host: ctx.host });

  assert.equal(adapter.isSupported(), true);
  assert.equal(isDownloadSupported(ctx.host), true);

  const missingCtx = createMockHost({ documentMissing: true });
  const unsupportedAdapter = createDownloadAdapter({ host: missingCtx.host });
  assert.equal(unsupportedAdapter.isSupported(), false);
  assert.equal(isDownloadSupported(missingCtx.host), false);

  const res = adapter.download({
    content: 'test',
    filename: 'adapter-test.md',
  });
  assert.equal(res.success, true);
  assert.equal(res.initiated, true);
});

test('download: allows empty string content and applies default MIME type', () => {
  const ctx = createMockHost();
  const result = triggerDownload(
    { content: '', filename: 'empty.md' },
    { host: ctx.host }
  );

  assert.equal(result.success, true);
  assert.equal(result.initiated, true);
  assert.equal(ctx.createdBlobs.length, 1);
  assert.deepEqual(ctx.createdBlobs[0].parts, ['']);
  assert.equal(ctx.createdBlobs[0].options?.type, 'text/plain;charset=utf-8');
});

test('download: when setTimeout throws, aborts before click, cleans up URL immediately, and reports initiated: false', () => {
  const ctx = createMockHost();
  ctx.host.setTimeout = () => {
    throw new Error('Timer scheduler failed');
  };

  const payload: DownloadPayload = {
    content: 'test content',
    filename: 'test.md',
  };

  const result = triggerDownload(payload, { host: ctx.host });

  assert.equal(result.initiated, false);
  assert.equal(result.success, false);
  assert.ok(result.error?.includes('Timer scheduler failed'));

  // Aborts before click: must not click anchor
  assert.equal(ctx.createdAnchors.length, 1);
  assert.equal(ctx.createdAnchors[0].clickCalls, 0);

  // Cleans up URL immediately on abort without leak
  assert.equal(ctx.revokedUrls.length, 1);
  assert.equal(ctx.revokedUrls[0], ctx.createdUrls[0]);

  // Cleans up attached DOM node
  assert.equal(ctx.removedNodes.length, 1);
  assert.equal(ctx.removedNodes[0], ctx.createdAnchors[0]);
});

test('download: rejects before creating URL or clicking when revokeObjectURL is missing', () => {
  const ctx = createMockHost();
  delete (ctx.host as Partial<DownloadHost>).revokeObjectURL;

  // isDownloadSupported and triggerDownload must agree
  assert.equal(isDownloadSupported(ctx.host), false);

  const payload: DownloadPayload = {
    content: 'test content',
    filename: 'test.md',
  };

  const result = triggerDownload(payload, { host: ctx.host });

  assert.equal(result.success, false);
  assert.equal(result.initiated, false);
  assert.ok(result.error?.includes('revokeObjectURL is not available'));
  // Must NOT create URL or click anchor
  assert.equal(ctx.createdUrls.length, 0);
  assert.equal(ctx.createdAnchors.length, 0);
});

test('download: rejects and reports unsupported when document createElement or body.appendChild is missing', () => {
  const ctx = createMockHost();
  // Document without appendChild
  const invalidDocHost: DownloadHost = {
    ...ctx.host,
    document: {
      createElement: () => ({ click: () => {} }),
      body: {} as unknown as DownloadDocumentHost['body'],
    },
  };

  assert.equal(isDownloadSupported(invalidDocHost), false);

  const result = triggerDownload(
    { content: 'test', filename: 'test.md' },
    { host: invalidDocHost }
  );
  assert.equal(result.success, false);
  assert.equal(result.initiated, false);
  assert.ok(result.error?.includes('DOM document is not available'));
  assert.equal(ctx.createdUrls.length, 0);
});

test('download: injected host does not silently fall back to ambient properties when explicitly absent', () => {
  const partialHost: DownloadHost = {
    Blob: Blob,
  };

  assert.equal(isDownloadSupported(partialHost), false);

  const result = triggerDownload(
    { content: 'test', filename: 'test.md' },
    { host: partialHost }
  );

  assert.equal(result.success, false);
  assert.equal(result.initiated, false);
  // Must fail because createObjectURL is absent from injected host, NOT fall back to global URL.createObjectURL
  assert.ok(result.error?.includes('createObjectURL is not available'));
});

test('download: reports unsupported and rejects when setTimeout scheduler is missing', () => {
  const ctx = createMockHost();
  delete (ctx.host as Partial<DownloadHost>).setTimeout;

  // Scheduler is a mandatory capability
  assert.equal(isDownloadSupported(ctx.host), false);

  const payload: DownloadPayload = {
    content: 'test content',
    filename: 'test.md',
  };

  const result = triggerDownload(payload, { host: ctx.host });

  assert.equal(result.success, false);
  assert.equal(result.initiated, false);
  assert.ok(result.error?.includes('setTimeout') || result.error?.includes('scheduler'));
  assert.equal(ctx.createdUrls.length, 0);
  assert.equal(ctx.createdAnchors.length, 0);
});

test('download: when click throws after scheduling, revokes URL immediately and idempotent guard prevents double revoke error', () => {
  const ctx = createMockHost({ clickError: new Error('User gesture required') });
  const payload: DownloadPayload = {
    content: 'test content',
    filename: 'test.md',
  };

  const result = triggerDownload(payload, { host: ctx.host });

  assert.equal(result.success, false);
  assert.equal(result.initiated, false);
  assert.ok(result.error?.includes('User gesture required'));
  assert.equal(ctx.removedNodes.length, 1);
  assert.equal(ctx.revokedUrls.length, 1);

  // When scheduled timer callback fires later, idempotent guard prevents double revoke or crash
  assert.equal(ctx.scheduledTimers.length, 1);
  assert.doesNotThrow(() => {
    ctx.scheduledTimers[0].handler();
  });
  // URL should only have been revoked once
  assert.equal(ctx.revokedUrls.length, 1);
});

test('download: when removeChild throws after click, does not throw and honestly reports initiation', () => {
  const ctx = createMockHost();
  if (ctx.host.document?.body) {
    ctx.host.document.body.removeChild = () => {
      throw new Error('Detach error');
    };
  }

  const payload: DownloadPayload = {
    content: 'test content',
    filename: 'test.md',
  };

  const result = triggerDownload(payload, { host: ctx.host });
  assert.equal(result.initiated, true);
  assert.equal(result.success, true);
});

test('download: ambient resolution binds setTimeout to global receiver preventing Illegal invocation in browser/webview', () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalDocument = (globalThis as unknown as { document?: unknown }).document;

  let timerScheduled = false;
  let clicked = false;

  try {
    let scheduledDelay: number | undefined;
    let scheduledCallback: (() => void) | undefined;

    // Simulate browser WebIDL binding that rejects invocation without global receiver
    const receiverSensitiveSetTimeout = function (
      this: unknown,
      handler: () => void,
      timeout?: number
    ) {
      if (this !== globalThis) {
        throw new TypeError('Illegal invocation');
      }
      timerScheduled = true;
      scheduledDelay = timeout;
      scheduledCallback = handler;
      return 1;
    };

    globalThis.setTimeout = receiverSensitiveSetTimeout as unknown as typeof setTimeout;

    (globalThis as unknown as { document: DownloadDocumentHost }).document = {
      createElement: (tagName: string) => {
        if (tagName !== 'a') throw new Error(`Unexpected tag: ${tagName}`);
        return {
          href: '',
          download: '',
          rel: '',
          style: {},
          click: () => {
            clicked = true;
          },
        };
      },
      body: {
        appendChild: (node: unknown) => node,
        removeChild: (node: unknown) => node,
      },
    };

    const result = triggerDownload({
      content: 'ambient receiver test',
      filename: 'ambient-export.txt',
    });

    assert.equal(result.error, undefined);
    assert.equal(result.success, true);
    assert.equal(result.initiated, true);
    assert.equal(timerScheduled, true);
    assert.equal(scheduledDelay, 60_000);
    assert.equal(typeof scheduledCallback, 'function');
    assert.doesNotThrow(() => {
      scheduledCallback!();
    });
    assert.equal(clicked, true);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    if (originalDocument === undefined) {
      delete (globalThis as unknown as { document?: unknown }).document;
    } else {
      (globalThis as unknown as { document: unknown }).document = originalDocument;
    }
  }
});

test('download: injected host methods preserve host receiver for setTimeout and URL methods', () => {
  let timerScheduled = false;
  let clicked = false;
  let urlCreated = false;
  let urlRevoked = false;

  const host: DownloadHost = {
    Blob: Blob,
    createObjectURL(this: unknown, _blob: Blob) {
      if (this !== host) {
        throw new TypeError('Illegal invocation on createObjectURL: expected host receiver');
      }
      urlCreated = true;
      return 'blob:receiver-test://1';
    },
    revokeObjectURL(this: unknown, _url: string) {
      if (this !== host) {
        throw new TypeError('Illegal invocation on revokeObjectURL: expected host receiver');
      }
      urlRevoked = true;
    },
    setTimeout(this: unknown, handler: () => void, _timeout?: number) {
      if (this !== host) {
        throw new TypeError('Illegal invocation on setTimeout: expected host receiver');
      }
      timerScheduled = true;
      // trigger handler synchronously for test revocation verification
      handler();
      return 1;
    },
    document: {
      createElement(this: unknown, _tagName: string) {
        return {
          href: '',
          download: '',
          rel: '',
          style: {},
          click: () => {
            clicked = true;
          },
        };
      },
      body: {
        appendChild(this: unknown, node: unknown) {
          return node;
        },
        removeChild(this: unknown, node: unknown) {
          return node;
        },
      },
    },
  };

  const result = triggerDownload(
    { content: 'host receiver test', filename: 'receiver.txt' },
    { host }
  );

  assert.equal(result.error, undefined);
  assert.equal(result.success, true);
  assert.equal(result.initiated, true);
  assert.equal(urlCreated, true);
  assert.equal(timerScheduled, true);
  assert.equal(urlRevoked, true);
  assert.equal(clicked, true);
});

test('download: preserves document and body receivers for DOM methods', () => {
  let docReceiverVerified = false;
  let bodyAppendReceiverVerified = false;
  let bodyRemoveReceiverVerified = false;

  const mockDoc: DownloadDocumentHost = {
    createElement(this: unknown, _tagName: string) {
      if (this !== mockDoc) {
        throw new TypeError('Illegal invocation on createElement: expected document receiver');
      }
      docReceiverVerified = true;
      return {
        href: '',
        download: '',
        rel: '',
        style: {},
        click: () => {},
      };
    },
    body: {
      appendChild(this: unknown, node: unknown) {
        if (this !== mockDoc.body) {
          throw new TypeError('Illegal invocation on appendChild: expected body receiver');
        }
        bodyAppendReceiverVerified = true;
        return node;
      },
      removeChild(this: unknown, node: unknown) {
        if (this !== mockDoc.body) {
          throw new TypeError('Illegal invocation on removeChild: expected body receiver');
        }
        bodyRemoveReceiverVerified = true;
        return node;
      },
    },
  };

  const host: DownloadHost = {
    Blob: Blob,
    createObjectURL: () => 'blob:mock://1',
    revokeObjectURL: () => {},
    setTimeout: (handler) => {
      handler();
      return 1;
    },
    document: mockDoc,
  };

  const result = triggerDownload(
    { content: 'dom receiver test', filename: 'dom-receiver.txt' },
    { host }
  );

  assert.equal(result.error, undefined);
  assert.equal(result.success, true);
  assert.equal(result.initiated, true);
  assert.equal(docReceiverVerified, true);
  assert.equal(bodyAppendReceiverVerified, true);
  assert.equal(bodyRemoveReceiverVerified, true);
});
