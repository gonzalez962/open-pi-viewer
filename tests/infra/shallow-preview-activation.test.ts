import test from 'node:test';
import assert from 'node:assert/strict';
import { getMcpServersPi, getPiResources, MOCK_MCP_SERVERS_STORAGE_KEY, MOCK_PI_RESOURCES_STORAGE_KEY } from '@infra/bridge';

test('preview inherits configured extension and MCP states without blanket suppression', async () => {
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value), removeItem: (key: string) => store.delete(key) };
  const oldWindow = (globalThis as any).window;
  const oldStorage = (globalThis as any).localStorage;
  (globalThis as any).window = { localStorage: storage };
  (globalThis as any).localStorage = storage;
  try {
    storage.setItem(MOCK_MCP_SERVERS_STORAGE_KEY, JSON.stringify({ servers: [
      { name: 'active', enabled: true, disabled: false, scope: 'global', configPath: 'mcp.json' },
      { name: 'inactive', enabled: false, disabled: true, scope: 'global', configPath: 'mcp.json' },
    ] }));
    storage.setItem(MOCK_PI_RESOURCES_STORAGE_KEY, JSON.stringify([
      { id: 'active', name: 'active', kind: 'extension', source: 'extensions/active.ts', enabled: true, scope: 'global', configPath: 'settings.json' },
      { id: 'inactive', name: 'inactive', kind: 'extension', source: 'extensions/inactive.ts', enabled: false, scope: 'global', configPath: 'settings.json' },
    ]));
    const mcp = await getMcpServersPi('/workspace/app');
    assert.deepEqual(mcp.servers.map(s => [s.name, s.enabled, s.disabled]), [['active', true, false], ['inactive', false, true]]);
    const resources = await getPiResources('/workspace/app');
    assert.deepEqual(resources.resources.map(r => [r.id, r.enabled]), [['active', true], ['inactive', false]]);
    assert.ok(resources.resources.every(r => !r.hasProjectOverride));
  } finally {
    if (oldWindow === undefined) delete (globalThis as any).window; else (globalThis as any).window = oldWindow;
    if (oldStorage === undefined) delete (globalThis as any).localStorage; else (globalThis as any).localStorage = oldStorage;
  }
});
