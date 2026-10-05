import test from 'node:test';
import assert from 'node:assert/strict';
import {
  saveConversationExport,
  type SaveExportPayload,
} from '@infra/conversation-export';
import type { DownloadOptions, DownloadPayload, DownloadResult } from '@infra/download';

test('Tauri environment: invokes save_conversation_export and returns saved outcome with path', async () => {
  let invokedCommand = '';
  let invokedArgs: Record<string, unknown> | undefined;

  const mockInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    invokedCommand = cmd;
    invokedArgs = args;
    return 'C:\\Users\\User\\Documents\\conversation-export.md' as unknown as T;
  };

  const payload: SaveExportPayload = {
    filename: 'conversation-export.md',
    content: '# Hello Export',
    format: 'markdown',
  };

  const result = await saveConversationExport(payload, {
    isTauriFn: () => true,
    invokeFn: mockInvoke,
  });

  assert.equal(invokedCommand, 'save_conversation_export');
  assert.deepEqual(invokedArgs, {
    defaultFilename: 'conversation-export.md',
    content: '# Hello Export',
    format: 'markdown',
  });
  assert.equal(result.outcome, 'saved');
  assert.equal(result.status, 'saved');
  if (result.outcome === 'saved') {
    assert.equal(result.path, 'C:\\Users\\User\\Documents\\conversation-export.md');
    assert.equal(result.filename, 'conversation-export.md');
  }
});

test('Tauri environment: dialog cancellation returns cancelled outcome without writing', async () => {
  const mockInvoke = async <T>(): Promise<T> => {
    return null as unknown as T;
  };

  const payload: SaveExportPayload = {
    filename: 'conversation-export.json',
    content: '{"schemaVersion": 1}',
    format: 'json',
  };

  const result = await saveConversationExport(payload, {
    isTauriFn: () => true,
    invokeFn: mockInvoke,
  });

  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.status, 'cancelled');
});

test('Tauri environment: native invocation error propagates and does NOT fallback to browser download', async () => {
  let browserDownloadTriggered = false;

  const mockInvoke = async (): Promise<never> => {
    throw new Error('OS native dialog failed: access denied');
  };

  const mockTriggerDownload = (): DownloadResult => {
    browserDownloadTriggered = true;
    return { success: true, initiated: true, filename: 'fallback.md' };
  };

  const payload: SaveExportPayload = {
    filename: 'conversation-export.md',
    content: '# Content',
    format: 'markdown',
  };

  await assert.rejects(
    async () => {
      await saveConversationExport(payload, {
        isTauriFn: () => true,
        invokeFn: mockInvoke,
        triggerDownloadFn: mockTriggerDownload,
      });
    },
    {
      name: 'Error',
      message: 'OS native dialog failed: access denied',
    }
  );

  assert.equal(browserDownloadTriggered, false, 'Must NEVER fallback to browser download in Tauri');
});

test('Web environment: delegates to triggerDownload and returns initiated outcome', async () => {
  let receivedPayload: DownloadPayload | undefined;

  const mockTriggerDownload = (p: DownloadPayload): DownloadResult => {
    receivedPayload = p;
    return {
      success: true,
      initiated: true,
      filename: p.filename,
    };
  };

  const payload: SaveExportPayload = {
    filename: 'web-export.md',
    content: '# Web Export Content',
    format: 'markdown',
    mimeType: 'text/markdown;charset=utf-8',
  };

  const result = await saveConversationExport(payload, {
    isTauriFn: () => false,
    triggerDownloadFn: mockTriggerDownload,
  });

  assert.equal(result.outcome, 'initiated');
  assert.equal(result.status, 'initiated');
  if (result.outcome === 'initiated') {
    assert.equal(result.filename, 'web-export.md');
  }
  assert.deepEqual(receivedPayload, {
    content: '# Web Export Content',
    filename: 'web-export.md',
    mimeType: 'text/markdown;charset=utf-8',
  });
});

test('Web environment: JSON format defaults to application/json charset mimeType', async () => {
  let receivedPayload: DownloadPayload | undefined;

  const mockTriggerDownload = (p: DownloadPayload): DownloadResult => {
    receivedPayload = p;
    return {
      success: true,
      initiated: true,
      filename: p.filename,
    };
  };

  const payload: SaveExportPayload = {
    filename: 'web-export.json',
    content: '{}',
    format: 'json',
  };

  await saveConversationExport(payload, {
    isTauriFn: () => false,
    triggerDownloadFn: mockTriggerDownload,
  });

  assert.equal(receivedPayload?.mimeType, 'application/json;charset=utf-8');
});

test('Web environment: forwards downloadOptions to triggerDownload', async () => {
  let receivedOptions: DownloadOptions | undefined;

  const mockTriggerDownload = (
    p: DownloadPayload,
    opts?: DownloadOptions
  ): DownloadResult => {
    receivedOptions = opts;
    return {
      success: true,
      initiated: true,
      filename: p.filename,
    };
  };

  const optionsToForward: DownloadOptions = {
    revokeDelayMs: 3000,
  };

  await saveConversationExport(
    {
      filename: 'test.md',
      content: 'test',
      format: 'markdown',
    },
    {
      isTauriFn: () => false,
      triggerDownloadFn: mockTriggerDownload,
      downloadOptions: optionsToForward,
    }
  );

  assert.deepEqual(receivedOptions, { revokeDelayMs: 3000 });
});

test('Web environment: failed download initiation propagates error', async () => {
  const mockTriggerDownload = (p: DownloadPayload): DownloadResult => {
    return {
      success: false,
      initiated: false,
      filename: p.filename,
      error: 'DOM document not ready',
    };
  };

  const payload: SaveExportPayload = {
    filename: 'web-export.md',
    content: '# Content',
    format: 'markdown',
  };

  await assert.rejects(
    async () => {
      await saveConversationExport(payload, {
        isTauriFn: () => false,
        triggerDownloadFn: mockTriggerDownload,
      });
    },
    {
      name: 'Error',
      message: 'DOM document not ready',
    }
  );
});

test('Parameter normalization: supports defaultFilename and format fallback', async () => {
  let invokedArgs: Record<string, unknown> | undefined;

  const mockInvoke = async <T>(_cmd: string, args?: Record<string, unknown>): Promise<T> => {
    invokedArgs = args;
    return 'C:\\path\\file.json' as unknown as T;
  };

  const payload: SaveExportPayload = {
    defaultFilename: 'normalized-export.json',
    content: '{"data": true}',
    format: 'json',
  };

  const result = await saveConversationExport(payload, {
    isTauriFn: () => true,
    invokeFn: mockInvoke,
  });

  assert.equal(result.outcome, 'saved');
  assert.deepEqual(invokedArgs, {
    defaultFilename: 'normalized-export.json',
    content: '{"data": true}',
    format: 'json',
  });
});
