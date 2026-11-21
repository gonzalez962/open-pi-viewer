import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getMcpServersPi,
  toggleMcpServerPi,
  saveMcpServerPi,
  deleteMcpServerPi,
  MOCK_MCP_SERVERS_STORAGE_KEY,
} from '@infra/bridge';
import type {
  DeleteMcpServerPayload,
  DeleteMcpServerResult,
  McpServerConfig,
  McpServersPayload,
  SaveMcpServerPayload,
  SaveMcpServerResult,
  ToggleMcpServerResult,
} from '@core/types/mcp';

test('mcp bridge: getMcpServersPi invokes get_mcp_servers with cwd and returns payload', async () => {
  const recordedCalls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];

  const mockPayload: McpServersPayload = {
    servers: [
      {
        name: 'test-server',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        serverType: 'stdio',
        envKeys: ['API_KEY'],
        disabled: false,
        enabled: true,
        scope: 'project',
        configPath: '/workspace/.pi/agent/mcp.json',
      },
    ],
  };

  const mockInvoke = async <T>(cmd: string, args?: unknown): Promise<T> => {
    recordedCalls.push({ cmd, args: args as Record<string, unknown> });
    if (cmd === 'get_mcp_servers') {
      return mockPayload as T;
    }
    throw new Error(`Unexpected command: ${cmd}`);
  };

  // With explicit cwd
  const resultWithCwd = await getMcpServersPi('/path/to/project', mockInvoke as any);
  assert.deepStrictEqual(resultWithCwd, mockPayload);
  assert.strictEqual(recordedCalls.length, 1);
  assert.strictEqual(recordedCalls[0].cmd, 'get_mcp_servers');
  assert.deepStrictEqual(recordedCalls[0].args, { cwd: '/path/to/project' });

  // Without cwd
  const resultWithoutCwd = await getMcpServersPi(undefined, mockInvoke as any);
  assert.deepStrictEqual(resultWithoutCwd, mockPayload);
  assert.strictEqual(recordedCalls.length, 2);
  assert.strictEqual(recordedCalls[1].cmd, 'get_mcp_servers');
  assert.deepStrictEqual(recordedCalls[1].args, { cwd: undefined });
});

test('mcp bridge: toggleMcpServerPi invokes toggle_mcp_server with proper parameters and returns result', async () => {
  const recordedCalls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];

  const mockResult: ToggleMcpServerResult = {
    success: true,
    name: 'custom-tool',
    enabled: true,
    path: '/workspace/.pi/agent/mcp.json',
  };

  const mockInvoke = async <T>(cmd: string, args?: unknown): Promise<T> => {
    recordedCalls.push({ cmd, args: args as Record<string, unknown> });
    if (cmd === 'toggle_mcp_server') {
      return mockResult as T;
    }
    throw new Error(`Unexpected command: ${cmd}`);
  };

  // Toggle with full payload
  const result = await toggleMcpServerPi(
    {
      name: 'custom-tool',
      enabled: true,
      cwd: '/workspace',
      scope: 'project',
    },
    mockInvoke as any
  );

  assert.deepStrictEqual(result, mockResult);
  assert.strictEqual(recordedCalls.length, 1);
  assert.strictEqual(recordedCalls[0].cmd, 'toggle_mcp_server');
  assert.deepStrictEqual(recordedCalls[0].args, {
    name: 'custom-tool',
    enabled: true,
    cwd: '/workspace',
    scope: 'project',
  });

  // Toggle with minimal payload (optional fields undefined)
  await toggleMcpServerPi(
    {
      name: 'global-tool',
      enabled: false,
    },
    mockInvoke as any
  );

  assert.strictEqual(recordedCalls.length, 2);
  assert.strictEqual(recordedCalls[1].cmd, 'toggle_mcp_server');
  assert.deepStrictEqual(recordedCalls[1].args, {
    name: 'global-tool',
    enabled: false,
    cwd: undefined,
    scope: undefined,
  });
});

test('mcp bridge: preview fallback storage roundtrips correctly when non-Tauri', async () => {
  const originalLocalStorage = (globalThis as unknown as { localStorage: unknown }).localStorage;
  const storageMap = new Map<string, string>();

  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => storageMap.get(k) ?? null,
    setItem: (k: string, v: string) => storageMap.set(k, v),
    removeItem: (k: string) => storageMap.delete(k),
    clear: () => storageMap.clear(),
  };

  try {
    // 1. Initial read on empty storage returns empty servers array
    const initial = await getMcpServersPi();
    assert.deepStrictEqual(initial, { servers: [] });

    // 2. Pre-seed mock storage with initial server
    const initialServer: McpServerConfig = {
      name: 'existing-server',
      command: 'node',
      args: ['server.js'],
      serverType: 'stdio',
      envKeys: ['TOKEN'],
      disabled: false,
      enabled: true,
      scope: 'global',
      configPath: '~/.pi/agent/mcp.json',
    };
    storageMap.set(
      MOCK_MCP_SERVERS_STORAGE_KEY,
      JSON.stringify({ servers: [initialServer] })
    );

    // 3. Read seeded servers
    const readSeeded = await getMcpServersPi();
    assert.strictEqual(readSeeded.servers.length, 1);
    assert.strictEqual(readSeeded.servers[0].name, 'existing-server');
    assert.strictEqual(readSeeded.servers[0].enabled, true);
    assert.strictEqual(readSeeded.servers[0].disabled, false);

    // 4. Toggle existing server off
    const toggleOffRes = await toggleMcpServerPi({
      name: 'existing-server',
      enabled: false,
    });
    assert.deepStrictEqual(toggleOffRes, {
      success: true,
      name: 'existing-server',
      enabled: false,
      path: '~/.pi/agent/mcp.json',
    });

    // 5. Verify updated in storage
    const readAfterToggleOff = await getMcpServersPi();
    assert.strictEqual(readAfterToggleOff.servers.length, 1);
    assert.strictEqual(readAfterToggleOff.servers[0].enabled, false);
    assert.strictEqual(readAfterToggleOff.servers[0].disabled, true);

    // 6. Toggle a brand new server on with project scope
    const toggleNewRes = await toggleMcpServerPi({
      name: 'new-project-server',
      enabled: true,
      cwd: '/mock/project',
      scope: 'project',
    });
    assert.strictEqual(toggleNewRes.success, true);
    assert.strictEqual(toggleNewRes.name, 'new-project-server');
    assert.strictEqual(toggleNewRes.enabled, true);
    assert.strictEqual(toggleNewRes.path, '/mock/project/.pi/agent/mcp.json');

    // 7. Verify both servers are present in subsequent read
    const readFinal = await getMcpServersPi('/mock/project');
    assert.strictEqual(readFinal.servers.length, 2);
    const newServer = readFinal.servers.find((s) => s.name === 'new-project-server');
    assert.ok(newServer);
    assert.strictEqual(newServer.enabled, true);
    assert.strictEqual(newServer.disabled, false);
    assert.strictEqual(newServer.scope, 'project');

    // 8. Corrupted JSON gracefully falls back to empty servers array
    storageMap.set(MOCK_MCP_SERVERS_STORAGE_KEY, '{ invalid json');
    const readCorrupt = await getMcpServersPi();
    assert.deepStrictEqual(readCorrupt, { servers: [] });
  } finally {
    (globalThis as unknown as { localStorage: unknown }).localStorage = originalLocalStorage;
  }
});

test('mcp bridge: saveMcpServerPi invokes save_mcp_server with proper parameters and returns result', async () => {
  const recordedCalls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];

  const mockResult: SaveMcpServerResult = {
    success: true,
    name: 'custom-tool',
    path: '/workspace/.pi/agent/mcp.json',
  };

  const mockInvoke = async <T>(cmd: string, args?: unknown): Promise<T> => {
    recordedCalls.push({ cmd, args: args as Record<string, unknown> });
    if (cmd === 'save_mcp_server') {
      return mockResult as T;
    }
    throw new Error(`Unexpected command: ${cmd}`);
  };

  // Full parameters payload
  const fullPayload: SaveMcpServerPayload = {
    name: 'custom-tool',
    oldName: 'old-tool',
    server: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres'],
      env: { DATABASE_URL: 'postgres://localhost/db' },
      disabled: false,
    },
    cwd: '/workspace',
    scope: 'project',
  };

  const result = await saveMcpServerPi(fullPayload, mockInvoke as any);
  assert.deepStrictEqual(result, mockResult);
  assert.strictEqual(recordedCalls.length, 1);
  assert.strictEqual(recordedCalls[0].cmd, 'save_mcp_server');
  assert.deepStrictEqual(recordedCalls[0].args, {
    name: 'custom-tool',
    oldName: 'old-tool',
    server: fullPayload.server,
    cwd: '/workspace',
    scope: 'project',
  });

  // Minimal payload (optional fields undefined)
  const minimalPayload: SaveMcpServerPayload = {
    name: 'remote-server',
    server: {
      url: 'https://mcp.example.com/sse',
    },
  };

  await saveMcpServerPi(minimalPayload, mockInvoke as any);
  assert.strictEqual(recordedCalls.length, 2);
  assert.strictEqual(recordedCalls[1].cmd, 'save_mcp_server');
  assert.deepStrictEqual(recordedCalls[1].args, {
    name: 'remote-server',
    oldName: undefined,
    server: minimalPayload.server,
    cwd: undefined,
    scope: undefined,
  });
});

test('mcp bridge: deleteMcpServerPi invokes delete_mcp_server with proper parameters and returns result', async () => {
  const recordedCalls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];

  const mockResult: DeleteMcpServerResult = {
    success: true,
    name: 'tool-to-delete',
    path: '/workspace/.pi/agent/mcp.json',
  };

  const mockInvoke = async <T>(cmd: string, args?: unknown): Promise<T> => {
    recordedCalls.push({ cmd, args: args as Record<string, unknown> });
    if (cmd === 'delete_mcp_server') {
      return mockResult as T;
    }
    throw new Error(`Unexpected command: ${cmd}`);
  };

  // Full parameters payload
  const fullPayload: DeleteMcpServerPayload = {
    name: 'tool-to-delete',
    cwd: '/workspace',
    scope: 'project',
  };

  const result = await deleteMcpServerPi(fullPayload, mockInvoke as any);
  assert.deepStrictEqual(result, mockResult);
  assert.strictEqual(recordedCalls.length, 1);
  assert.strictEqual(recordedCalls[0].cmd, 'delete_mcp_server');
  assert.deepStrictEqual(recordedCalls[0].args, {
    name: 'tool-to-delete',
    cwd: '/workspace',
    scope: 'project',
  });

  // Minimal parameters payload
  await deleteMcpServerPi({ name: 'global-tool' }, mockInvoke as any);
  assert.strictEqual(recordedCalls.length, 2);
  assert.strictEqual(recordedCalls[1].cmd, 'delete_mcp_server');
  assert.deepStrictEqual(recordedCalls[1].args, {
    name: 'global-tool',
    cwd: undefined,
    scope: undefined,
  });
});

test('mcp bridge: non-Tauri preview roundtrips unprotected entries and rejects protected writes', async () => {
  const originalLocalStorage = (globalThis as unknown as { localStorage: unknown }).localStorage;
  const storageMap = new Map<string, string>();

  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => storageMap.get(k) ?? null,
    setItem: (k: string, v: string) => storageMap.set(k, v),
    removeItem: (k: string) => storageMap.delete(k),
    clear: () => storageMap.clear(),
  };

  try {
    // Save and read a project-scoped preview entry without protected values.
    const addStdioRes = await saveMcpServerPi({
      name: 'fs-server',
      server: { command: 'npx' },
      cwd: '/mock/project',
      scope: 'project',
    });
    assert.strictEqual(addStdioRes.success, true);
    assert.strictEqual(addStdioRes.name, 'fs-server');
    assert.strictEqual(addStdioRes.path, '/mock/project/.pi/agent/mcp.json');

    // Verify it is returned by getMcpServersPi
    const serversAfterAdd = await getMcpServersPi('/mock/project');
    const fsServer = serversAfterAdd.servers.find((s) => s.name === 'fs-server');
    assert.ok(fsServer);
    assert.strictEqual(fsServer.command, 'npx');
    assert.strictEqual(fsServer.args, undefined);
    assert.strictEqual(fsServer.serverType, 'stdio');
    assert.deepStrictEqual(fsServer.envKeys, []);
    assert.strictEqual(fsServer.enabled, true);
    assert.strictEqual(fsServer.disabled, false);
    assert.strictEqual(fsServer.scope, 'project');

    const storedBeforeRejection = [...storageMap];
    const rejectedProjectEdit = await saveMcpServerPi({
      name: 'fs-server',
      server: { command: 'node', args: ['filesystem.js'] },
      cwd: '/mock/project',
      scope: 'project',
    });
    assert.deepStrictEqual(rejectedProjectEdit, { success: false, name: 'fs-server', path: '' });
    assert.deepStrictEqual([...storageMap], storedBeforeRejection);
    assert.deepStrictEqual(await getMcpServersPi('/mock/project'), serversAfterAdd);

    const rejectedGlobalAdd = await saveMcpServerPi({
      name: 'remote-sse',
      server: { url: 'https://mcp.example.com/sse', headers: { Authorization: 'Bearer fixture' } },
      scope: 'global',
    });
    assert.deepStrictEqual(rejectedGlobalAdd, { success: false, name: 'remote-sse', path: '' });
    assert.deepStrictEqual([...storageMap], storedBeforeRejection);
    assert.deepStrictEqual(await getMcpServersPi('/mock/project'), serversAfterAdd);

    const addGlobalRes = await saveMcpServerPi({
      name: 'global-tool',
      server: { command: 'node' },
      scope: 'global',
    });
    assert.deepStrictEqual(addGlobalRes, { success: true, name: 'global-tool', path: '~/.pi/agent/mcp.json' });
    assert.strictEqual((await getMcpServersPi()).servers.find((s) => s.name === 'global-tool')?.scope, 'global');

    const editRes = await saveMcpServerPi({
      name: 'fs-server',
      server: { command: 'node' },
      cwd: '/mock/project',
      scope: 'project',
    });
    assert.strictEqual(editRes.success, true);

    const serversAfterEdit = await getMcpServersPi('/mock/project');
    const updatedFs = serversAfterEdit.servers.find((s) => s.name === 'fs-server');
    assert.ok(updatedFs);
    assert.strictEqual(updatedFs.command, 'node');
    assert.strictEqual(updatedFs.args, undefined);
    assert.deepStrictEqual(updatedFs.envKeys, []);

    // Rename the allowed entry without losing its command.
    const renameRes = await saveMcpServerPi({
      name: 'fs-renamed',
      oldName: 'fs-server',
      server: { command: 'node' },
      cwd: '/mock/project',
      scope: 'project',
    });
    assert.strictEqual(renameRes.success, true);
    assert.strictEqual(renameRes.name, 'fs-renamed');

    const serversAfterRename = await getMcpServersPi('/mock/project');
    assert.strictEqual(serversAfterRename.servers.find((s) => s.name === 'fs-server'), undefined);
    const renamed = serversAfterRename.servers.find((s) => s.name === 'fs-renamed');
    assert.ok(renamed);
    assert.strictEqual(renamed.name, 'fs-renamed');
    assert.strictEqual(renamed.command, 'node');
    assert.strictEqual(renamed.scope, 'project');

    // Delete the project entry without affecting the global one.
    const deleteRes = await deleteMcpServerPi({
      name: 'fs-renamed',
      cwd: '/mock/project',
      scope: 'project',
    });
    assert.strictEqual(deleteRes.success, true);
    assert.strictEqual(deleteRes.name, 'fs-renamed');
    assert.strictEqual(deleteRes.path, '/mock/project/.pi/agent/mcp.json');

    const serversAfterDelete = await getMcpServersPi('/mock/project');
    assert.strictEqual(serversAfterDelete.servers.find((s) => s.name === 'fs-renamed'), undefined);
    assert.deepStrictEqual(serversAfterDelete.servers.map((s) => s.name), ['global-tool']);

    const deleteGlobalRes = await deleteMcpServerPi({ name: 'global-tool' });
    assert.strictEqual(deleteGlobalRes.success, true);
    assert.strictEqual(deleteGlobalRes.path, '~/.pi/agent/mcp.json');

    const finalServers = await getMcpServersPi();
    assert.strictEqual(finalServers.servers.length, 0);
  } finally {
    (globalThis as unknown as { localStorage: unknown }).localStorage = originalLocalStorage;
  }
});
