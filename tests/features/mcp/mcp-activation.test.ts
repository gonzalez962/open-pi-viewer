import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { McpServerConfig } from '@core/types/mcp';
import {
  setResourceActivationPi,
  getMcpServersPi,
  MOCK_MCP_SERVERS_STORAGE_KEY,
  MOCK_RESOURCE_ACTIVATION_STORAGE_KEY,
} from '@infra/bridge';
import {
  executeMcpAlwaysActiveToggle,
} from '@features/mcp/hooks/useMcpServers';
import { McpServerCard } from '@features/mcp/components/McpServerCard';
import { translate } from '@shared/i18n';

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

// ---------------------------------------------------------------------------
// 1. IPC Bridge & Tauri command invocation
// ---------------------------------------------------------------------------

test('mcp bridge: setResourceActivationPi invokes set_resource_activation with proper payload in desktop/Tauri mode', async () => {
  const recordedCalls: Array<{ cmd: string; args?: unknown }> = [];
  const mockInvoke = async <T>(cmd: string, args?: unknown): Promise<T> => {
    recordedCalls.push({ cmd, args });
    if (cmd === 'set_resource_activation') {
      return { success: true } as T;
    }
    throw new Error(`Unexpected command: ${cmd}`);
  };

  // Global exception (absent cwd)
  const globalResult = await setResourceActivationPi(
    {
      kind: 'mcp',
      identity: 'github-server',
      enabled: true,
    },
    mockInvoke as any
  );
  assert.deepStrictEqual(globalResult, { success: true });
  assert.strictEqual(recordedCalls.length, 1);
  assert.strictEqual(recordedCalls[0].cmd, 'set_resource_activation');
  const callArgs1 = recordedCalls[0].args as Record<string, unknown>;
  assert.strictEqual(callArgs1.kind, 'mcp');
  assert.strictEqual(callArgs1.identity, 'github-server');
  assert.strictEqual(callArgs1.enabled, true);
  assert.strictEqual(callArgs1.cwd, undefined);

  // Project override (present cwd)
  const projectResult = await setResourceActivationPi(
    {
      kind: 'mcp',
      identity: 'github-server',
      enabled: false,
      cwd: '/workspace/project-a',
    },
    mockInvoke as any
  );
  assert.deepStrictEqual(projectResult, { success: true });
  assert.strictEqual(recordedCalls.length, 2);
  const callArgs2 = recordedCalls[1].args as Record<string, unknown>;
  assert.strictEqual(callArgs2.kind, 'mcp');
  assert.strictEqual(callArgs2.identity, 'github-server');
  assert.strictEqual(callArgs2.enabled, false);
  assert.strictEqual(callArgs2.cwd, '/workspace/project-a');
});

// ---------------------------------------------------------------------------
// 2. Preview Fallback & Policy Calculation Tests
// ---------------------------------------------------------------------------

test('mcp bridge: preview fallback persists policy and defaults inactive per project without exception', async () => {
  const fakeStorage = new MemoryStorage();
  (globalThis as any).window = { localStorage: fakeStorage };
  (globalThis as any).localStorage = fakeStorage;

  try {
    // 1. Seed global servers in mock storage with ordinary global enabled = true
    const globalServer: McpServerConfig = {
      name: 'postgres-mcp',
      command: 'npx',
      args: ['-y', 'mcp-postgres'],
      serverType: 'stdio',
      envKeys: [],
      disabled: false,
      enabled: true,
      scope: 'global',
      configPath: '~/.pi/agent/mcp.json',
    };
    fakeStorage.setItem(
      MOCK_MCP_SERVERS_STORAGE_KEY,
      JSON.stringify({ servers: [globalServer] })
    );

    // 2. Global listing (no cwd): displays ordinary configured enabled = true, alwaysActive = false
    const globalList = await getMcpServersPi();
    assert.strictEqual(globalList.servers.length, 1);
    assert.strictEqual(globalList.servers[0].enabled, true);
    assert.strictEqual(globalList.servers[0].alwaysActive, false);

    // 3. Project listing with cwd: defaults INACTIVE per project (enabled = false, disabled = true)
    const projectList = await getMcpServersPi('/workspace/my-app');
    assert.strictEqual(projectList.servers.length, 1);
    assert.strictEqual(projectList.servers[0].enabled, false);
    assert.strictEqual(projectList.servers[0].disabled, true);
    assert.strictEqual(projectList.servers[0].alwaysActive, false);
    assert.strictEqual(projectList.servers[0].hasProjectOverride, false);

    // 4. Set global always-active exception via setResourceActivationPi
    const actResult = await setResourceActivationPi({
      kind: 'mcp',
      identity: 'postgres-mcp',
      enabled: true,
    });
    assert.strictEqual(actResult.success, true);

    // 5. Global listing now reflects alwaysActive = true, global enabled still true
    const globalListAfterException = await getMcpServersPi();
    assert.strictEqual(globalListAfterException.servers[0].alwaysActive, true);
    assert.strictEqual(globalListAfterException.servers[0].enabled, true);

    // 6. Project listing without local override now activates via alwaysActive exception
    const projectListWithException = await getMcpServersPi('/workspace/my-app');
    assert.strictEqual(projectListWithException.servers[0].enabled, true);
    assert.strictEqual(projectListWithException.servers[0].disabled, false);
    assert.strictEqual(projectListWithException.servers[0].alwaysActive, true);
    assert.strictEqual(projectListWithException.servers[0].hasProjectOverride, false);

    // 7. Explicit project override to disable takes precedence over global always-on
    const overrideResult = await setResourceActivationPi({
      kind: 'mcp',
      identity: 'postgres-mcp',
      enabled: false,
      cwd: '/workspace/my-app',
    });
    assert.strictEqual(overrideResult.success, true);

    const projectListOverridden = await getMcpServersPi('/workspace/my-app');
    assert.strictEqual(projectListOverridden.servers[0].enabled, false);
    assert.strictEqual(projectListOverridden.servers[0].disabled, true);
    assert.strictEqual(projectListOverridden.servers[0].alwaysActive, true);
    assert.strictEqual(projectListOverridden.servers[0].hasProjectOverride, true);

    // 8. Other project remains unaffected by my-app override and uses always-on exception
    const otherProjectList = await getMcpServersPi('/workspace/other-app');
    assert.strictEqual(otherProjectList.servers[0].enabled, true);
    assert.strictEqual(otherProjectList.servers[0].hasProjectOverride, false);

    // 9. Global config was NOT mutated by activation policy operations
    const rawStoredMcp = JSON.parse(fakeStorage.getItem(MOCK_MCP_SERVERS_STORAGE_KEY)!);
    assert.strictEqual(rawStoredMcp.servers[0].enabled, true);

    // 10. Policy is persisted faithfully under MOCK_RESOURCE_ACTIVATION_STORAGE_KEY
    const rawPolicy = JSON.parse(fakeStorage.getItem(MOCK_RESOURCE_ACTIVATION_STORAGE_KEY)!);
    assert.strictEqual(rawPolicy.version, 1);
    assert.ok(rawPolicy.alwaysMcpServers.includes('postgres-mcp'));
  } finally {
    delete (globalThis as any).window;
    delete (globalThis as any).localStorage;
  }
});

// ---------------------------------------------------------------------------
// 3. executeMcpAlwaysActiveToggle helper workflow
// ---------------------------------------------------------------------------

test('useMcpServers: executeMcpAlwaysActiveToggle updates alwaysActive and rolls back on failure', async () => {
  const servers: McpServerConfig[] = [
    {
      name: 'srv-1',
      serverType: 'stdio',
      envKeys: [],
      disabled: false,
      enabled: true,
      scope: 'global',
      configPath: '~/.pi/agent/mcp.json',
      alwaysActive: false,
    },
  ];

  let shouldFail = false;
  const mockActivationFn = async (_p: any) => {
    if (shouldFail) return { success: false };
    return { success: true };
  };

  // Success case
  const res1 = await executeMcpAlwaysActiveToggle({
    servers,
    server: servers[0],
    alwaysActive: true,
    activationFn: mockActivationFn,
  });
  assert.strictEqual(res1.success, true);
  assert.strictEqual(res1.nextServers[0].alwaysActive, true);

  // Failure rollback
  shouldFail = true;
  const res2 = await executeMcpAlwaysActiveToggle({
    servers,
    server: servers[0],
    alwaysActive: true,
    activationFn: mockActivationFn,
  });
  assert.strictEqual(res2.success, false);
  assert.strictEqual(res2.nextServers[0].alwaysActive, false);
  assert.ok(res2.error);
});

// ---------------------------------------------------------------------------
// 4. McpServerCard Accessible 'Always activate in all projects' Control Tests
// ---------------------------------------------------------------------------

test('McpServerCard: renders accessible Always activate in all projects control separate from regular toggle', () => {
  const server: McpServerConfig = {
    name: 'test-mcp',
    command: 'node',
    args: ['srv.js'],
    serverType: 'stdio',
    envKeys: [],
    disabled: false,
    enabled: true,
    scope: 'global',
    configPath: '~/.pi/agent/mcp.json',
    alwaysActive: false,
  };

  const html = renderToStaticMarkup(
    React.createElement(McpServerCard, {
      server,
      onToggle: () => {},
      onToggleAlwaysActive: () => {},
      t: (key: string) => translate('en', key as any),
    })
  );

  // Accessible control assertions
  assert.ok(
    html.includes('Always activate in all projects'),
    'Should render visible Always activate in all projects label'
  );
  assert.ok(
    html.includes('id="mcp-always-global-test-mcp"'),
    'Should render dedicated input id for always activate'
  );
  assert.ok(
    html.includes('for="mcp-always-global-test-mcp"'),
    'Should link label to input via htmlFor'
  );
  assert.ok(
    html.includes('aria-label="test-mcp: Always activate in all projects"'),
    'Should provide accessible aria-label'
  );
  assert.ok(
    html.includes('id="mcp-toggle-global-test-mcp"'),
    'Ordinary enabled toggle must remain separate and present'
  );
});

test('McpServerCard: renders always-active badge when alwaysActive is true', () => {
  const server: McpServerConfig = {
    name: 'active-mcp',
    serverType: 'stdio',
    envKeys: [],
    disabled: false,
    enabled: true,
    scope: 'global',
    configPath: '~/.pi/agent/mcp.json',
    alwaysActive: true,
  };

  const html = renderToStaticMarkup(
    React.createElement(McpServerCard, {
      server,
      onToggle: () => {},
      onToggleAlwaysActive: () => {},
      t: (key: string) => translate('en', key as any),
    })
  );

  assert.ok(
    html.includes('mcp-badge-always-active'),
    'Should display always-active badge'
  );
  assert.ok(
    html.includes('checked=""') && html.includes('id="mcp-always-global-active-mcp"'),
    'Always active checkbox must be checked'
  );
});

// ---------------------------------------------------------------------------
// 5. Localization Tests (en and es parity)
// ---------------------------------------------------------------------------

test('mcp localization: en and es translations exist for always active controls and reload notice', () => {
  const enLabel = translate('en', 'mcp.always_activate_label' as any);
  const esLabel = translate('es', 'mcp.always_activate_label' as any);
  assert.strictEqual(enLabel, 'Always activate in all projects');
  assert.strictEqual(esLabel, 'Activar siempre en todos los proyectos');

  const enBadge = translate('en', 'mcp.badge_always_active' as any);
  const esBadge = translate('es', 'mcp.badge_always_active' as any);
  assert.ok(enBadge.length > 0);
  assert.ok(esBadge.length > 0);

  const enNotice = translate('en', 'mcp.activation_next_session_notice' as any);
  const esNotice = translate('es', 'mcp.activation_next_session_notice' as any);
  assert.ok(enNotice.length > 0);
  assert.ok(esNotice.length > 0);
});
