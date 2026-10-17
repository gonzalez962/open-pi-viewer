import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getPiResources,
  savePiResource,
  setResourceActivationPi,
  togglePiResource,
  deletePiResource,
  MOCK_PI_RESOURCES_STORAGE_KEY,
} from '@infra/bridge';
import {
  deriveResourceName,
  normalizeResourceId,
  normalizeTargetSource,
  validateResourceSource,
  extractPackageIdentity,
  packageIdentitiesMatch,
  extensionSourcesMatch,
  resourceIdentitiesMatch,
  type PiResourcesPayload,
  type SavePiResourcePayload,
  type SavePiResourceResult,
  type TogglePiResourcePayload,
  type TogglePiResourceResult,
  type DeletePiResourcePayload,
  type DeletePiResourceResult,
} from '@core/types/extensions';

// Mock storage for non-Tauri preview tests
class MemoryStorage {
  private store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

test('extensions domain: validateResourceSource validates extension and package sources', () => {
  // Extensions
  assert.equal(validateResourceSource('extension', './my-ext.ts').valid, true);
  assert.equal(validateResourceSource('extension', '!./my-ext.ts').valid, true);
  assert.equal(validateResourceSource('extension', '+./my-ext.ts').valid, true);
  assert.equal(validateResourceSource('extension', 'extensions/**/*.ts').valid, true);
  assert.equal(validateResourceSource('extension', '/opt/pi/ext.js').valid, true);
  assert.equal(validateResourceSource('extension', 'C:\\pi\\ext.ts').valid, true);
  assert.equal(validateResourceSource('extension', '').valid, false);
  assert.equal(validateResourceSource('extension', '   ').valid, false);
  assert.equal(validateResourceSource('extension', '!').valid, false);
  assert.equal(validateResourceSource('extension', 'ext\0bad.ts').valid, false);

  // Packages
  assert.equal(validateResourceSource('package', 'npm:@scope/pkg@1.0.0').valid, true);
  assert.equal(validateResourceSource('package', 'npm:simple-pkg').valid, true);
  assert.equal(validateResourceSource('package', 'git:github.com/user/repo').valid, true);
  assert.equal(validateResourceSource('package', 'git:git@github.com:user/repo@v1').valid, true);
  assert.equal(validateResourceSource('package', 'https://github.com/user/repo').valid, true);
  assert.equal(validateResourceSource('package', 'ssh://git@github.com/user/repo').valid, true);
  assert.equal(validateResourceSource('package', 'git@github.com:user/repo.git').valid, true);
  assert.equal(validateResourceSource('package', './local/path').valid, true);
  assert.equal(validateResourceSource('package', '../parent/path').valid, true);
  assert.equal(validateResourceSource('package', '/root/path').valid, true);
  assert.equal(validateResourceSource('package', '~/home/path').valid, true);
  assert.equal(validateResourceSource('package', 'some-npm-pkg').valid, true);
  assert.equal(validateResourceSource('package', '').valid, false);
  assert.equal(validateResourceSource('package', '   ').valid, false);
  assert.equal(validateResourceSource('package', 'bogus::source with spaces').valid, false);
});

test('extensions domain: normalizeResourceId produces stable and clean identifiers', () => {
  assert.equal(
    normalizeResourceId('project', 'extension', './tool.ts'),
    'project:extension:./tool.ts'
  );
  // Strips leading '!' for extension
  assert.equal(
    normalizeResourceId('global', 'extension', '!./tool.ts'),
    'global:extension:./tool.ts'
  );
  assert.equal(
    normalizeResourceId('project', 'package', 'npm:@tools/pkg@1.0.0'),
    'project:package:npm:@tools/pkg@1.0.0'
  );
});

test('extensions domain: normalizeTargetSource and normalizeResourceId reject bare markers and empty targets', () => {
  assert.throws(() => normalizeTargetSource('extension', '!'), /bare marker/);
  assert.throws(() => normalizeTargetSource('extension', '!   '), /bare marker/);
  assert.throws(() => normalizeTargetSource('extension', '+'), /bare marker/);
  assert.throws(() => normalizeTargetSource('extension', '-'), /bare marker/);
  assert.throws(() => normalizeTargetSource('extension', '-   '), /bare marker/);
  assert.throws(() => normalizeTargetSource('extension', ''), /empty/);
  assert.throws(() => normalizeTargetSource('extension', '   '), /empty/);
  assert.throws(() => normalizeTargetSource('package', ''), /empty/);
  assert.throws(() => normalizeTargetSource('package', '   '), /empty/);

  assert.throws(() => normalizeResourceId('global', 'extension', '!'), /bare marker/);
  assert.throws(() => normalizeResourceId('global', 'extension', '!   '), /bare marker/);
  assert.throws(() => normalizeResourceId('global', 'extension', '-'), /bare marker/);
  assert.throws(() => normalizeResourceId('global', 'extension', '-   '), /bare marker/);
  assert.throws(() => normalizeResourceId('project', 'extension', ''), /empty/);

  assert.equal(normalizeTargetSource('extension', '!./my-tool.ts'), './my-tool.ts');
  assert.equal(normalizeTargetSource('extension', '+./my-tool.ts'), './my-tool.ts');
  assert.equal(normalizeTargetSource('extension', '-./my-tool.ts'), './my-tool.ts');
  assert.equal(normalizeTargetSource('package', 'npm:pkg'), 'npm:pkg');
});

test('extensions domain: deriveResourceName extracts human-readable labels', () => {
  // Packages
  assert.equal(deriveResourceName('package', 'npm:@scope/my-pkg@2.0.0'), '@scope/my-pkg');
  assert.equal(deriveResourceName('package', 'npm:simple-tool'), 'simple-tool');
  assert.equal(deriveResourceName('package', 'git:github.com/org/repo@v1'), 'repo');
  assert.equal(deriveResourceName('package', 'https://github.com/org/cool-package.git'), 'cool-package');

  // Extensions
  assert.equal(deriveResourceName('extension', './src/extensions/helper.ts'), 'helper.ts');
  assert.equal(deriveResourceName('extension', '!./disabled-helper.ts'), 'disabled-helper.ts');
  assert.equal(deriveResourceName('extension', 'C:\\tools\\windows-ext.js'), 'windows-ext.js');
  // Auto-discovered folder/index.ts patterns
  assert.equal(deriveResourceName('extension', 'extensions/cpamc-auto-switcher/index.ts'), 'cpamc-auto-switcher');
  assert.equal(deriveResourceName('extension', 'cpamc-auto-switcher/index.ts'), 'cpamc-auto-switcher');
  assert.equal(deriveResourceName('extension', 'extensions/cpamc-auto-switcher/index.js'), 'cpamc-auto-switcher');
  assert.equal(deriveResourceName('extension', 'extensions/cpamc-auto-switcher/index.mjs'), 'cpamc-auto-switcher');
  assert.equal(deriveResourceName('extension', 'cpamc-auto-switcher/index.mjs'), 'cpamc-auto-switcher');
  assert.equal(deriveResourceName('extension', 'extensions/my-tool.ts'), 'my-tool.ts');
  assert.equal(deriveResourceName('extension', 'my-tool.ts'), 'my-tool.ts');
  assert.equal(deriveResourceName('extension', 'extensions/index.ts'), 'index.ts');
  assert.equal(deriveResourceName('extension', '!extensions/cpamc-auto-switcher/index.ts'), 'cpamc-auto-switcher');
});

test('extensions bridge: getPiResources invokes get_pi_resources via mock invoke', async () => {
  const recordedCalls: Array<{ cmd: string; args?: unknown }> = [];

  const mockPayload: PiResourcesPayload = {
    resources: [
      {
        id: 'project:extension:./ext.ts',
        name: 'ext.ts',
        kind: 'extension',
        source: './ext.ts',
        scope: 'project',
        enabled: true,
        configPath: '/workspace/.pi/settings.json',
      },
    ],
  };

  const mockInvoke = async <T>(cmd: string, args?: unknown): Promise<T> => {
    recordedCalls.push({ cmd, args });
    if (cmd === 'get_pi_resources') {
      return mockPayload as T;
    }
    throw new Error(`Unexpected command: ${cmd}`);
  };

  // With explicit cwd
  const res1 = await getPiResources('/workspace', mockInvoke as any);
  assert.deepStrictEqual(res1, mockPayload);
  assert.strictEqual(recordedCalls.length, 1);
  assert.strictEqual(recordedCalls[0].cmd, 'get_pi_resources');
  assert.deepStrictEqual(recordedCalls[0].args, { cwd: '/workspace' });

  // Without cwd
  const res2 = await getPiResources(undefined, mockInvoke as any);
  assert.deepStrictEqual(res2, mockPayload);
  assert.strictEqual(recordedCalls.length, 2);
  assert.deepStrictEqual(recordedCalls[1].args, { cwd: undefined });
});

test('extensions bridge: savePiResource invokes save_pi_resource with proper parameters', async () => {
  const recordedCalls: Array<{ cmd: string; args?: unknown }> = [];

  const mockResult: SavePiResourceResult = {
    success: true,
    id: 'project:package:npm:my-pkg',
    kind: 'package',
    source: 'npm:my-pkg',
    scope: 'project',
    configPath: '/workspace/.pi/settings.json',
    requiresReload: true,
  };

  const mockInvoke = async <T>(cmd: string, args?: unknown): Promise<T> => {
    recordedCalls.push({ cmd, args });
    if (cmd === 'save_pi_resource') {
      return mockResult as T;
    }
    throw new Error(`Unexpected command: ${cmd}`);
  };

  const payload: SavePiResourcePayload = {
    kind: 'package',
    source: 'npm:my-pkg',
    oldSource: 'npm:old-pkg',
    scope: 'project',
    enabled: true,
    cwd: '/workspace',
  };

  const result = await savePiResource(payload, mockInvoke as any);
  assert.deepStrictEqual(result, mockResult);
  assert.strictEqual(result.requiresReload, true);
  assert.strictEqual(recordedCalls.length, 1);
  assert.strictEqual(recordedCalls[0].cmd, 'save_pi_resource');
  assert.deepStrictEqual(recordedCalls[0].args, {
    cwd: '/workspace',
    scope: 'project',
    kind: 'package',
    source: 'npm:my-pkg',
    oldSource: 'npm:old-pkg',
    enabled: true,
    raw: undefined,
  });
});

test('extensions bridge: togglePiResource invokes toggle_pi_resource with proper parameters', async () => {
  const recordedCalls: Array<{ cmd: string; args?: unknown }> = [];

  const mockResult: TogglePiResourceResult = {
    success: true,
    id: 'project:extension:./tool.ts',
    kind: 'extension',
    source: './tool.ts',
    scope: 'project',
    enabled: false,
    configPath: '/workspace/.pi/settings.json',
    requiresReload: true,
  };

  const mockInvoke = async <T>(cmd: string, args?: unknown): Promise<T> => {
    recordedCalls.push({ cmd, args });
    if (cmd === 'toggle_pi_resource') {
      return mockResult as T;
    }
    throw new Error(`Unexpected command: ${cmd}`);
  };

  const payload: TogglePiResourcePayload = {
    kind: 'extension',
    source: './tool.ts',
    enabled: false,
    scope: 'project',
    cwd: '/workspace',
  };

  const result = await togglePiResource(payload, mockInvoke as any);
  assert.deepStrictEqual(result, mockResult);
  assert.strictEqual(result.requiresReload, true);
  assert.strictEqual(recordedCalls.length, 1);
  assert.strictEqual(recordedCalls[0].cmd, 'toggle_pi_resource');
  assert.deepStrictEqual(recordedCalls[0].args, {
    cwd: '/workspace',
    scope: 'project',
    kind: 'extension',
    source: './tool.ts',
    enabled: false,
  });
});

test('extensions bridge: deletePiResource invokes delete_pi_resource with proper parameters', async () => {
  const recordedCalls: Array<{ cmd: string; args?: unknown }> = [];

  const mockResult: DeletePiResourceResult = {
    success: true,
    id: 'project:package:npm:delete-me',
    kind: 'package',
    source: 'npm:delete-me',
    scope: 'project',
    configPath: '/workspace/.pi/settings.json',
    requiresReload: true,
  };

  const mockInvoke = async <T>(cmd: string, args?: unknown): Promise<T> => {
    recordedCalls.push({ cmd, args });
    if (cmd === 'delete_pi_resource') {
      return mockResult as T;
    }
    throw new Error(`Unexpected command: ${cmd}`);
  };

  const payload: DeletePiResourcePayload = {
    kind: 'package',
    source: 'npm:delete-me',
    scope: 'project',
    cwd: '/workspace',
  };

  const result = await deletePiResource(payload, mockInvoke as any);
  assert.deepStrictEqual(result, mockResult);
  assert.strictEqual(result.requiresReload, true);
  assert.strictEqual(recordedCalls.length, 1);
  assert.strictEqual(recordedCalls[0].cmd, 'delete_pi_resource');
  assert.deepStrictEqual(recordedCalls[0].args, {
    cwd: '/workspace',
    scope: 'project',
    kind: 'package',
    source: 'npm:delete-me',
  });
});

test('extensions bridge: preview fallback mock storage CRUD round-trip', async () => {
  const fakeStorage = new MemoryStorage();
  (globalThis as any).window = { localStorage: fakeStorage };
  (globalThis as any).localStorage = fakeStorage;

  try {
    // 1. Initial list is empty
    assert.strictEqual(typeof MOCK_PI_RESOURCES_STORAGE_KEY, 'string');
    const initial = await getPiResources('/workspace');
    assert.deepStrictEqual(initial.resources, []);

    // 2. Add extension in project scope
    const saveExt = await savePiResource({
      kind: 'extension',
      source: './my-tool.ts',
      scope: 'project',
      enabled: true,
      cwd: '/workspace',
    });
    assert.strictEqual(saveExt.success, true);
    assert.strictEqual(saveExt.requiresReload, true);
    assert.strictEqual(saveExt.source, './my-tool.ts');

    // 3. Add package in global scope
    const savePkg = await savePiResource({
      kind: 'package',
      source: 'npm:@scope/package@1.0.0',
      scope: 'global',
      enabled: true,
    });
    assert.strictEqual(savePkg.success, true);
    assert.strictEqual(savePkg.scope, 'global');

    // 4. List resources and verify both are present
    const list1 = await getPiResources('/workspace');
    assert.strictEqual(list1.resources.length, 2);
    const extEntry = list1.resources.find((r) => r.source === './my-tool.ts')!;
    const pkgEntry = list1.resources.find((r) => r.source === 'npm:@scope/package@1.0.0')!;
    assert.strictEqual(extEntry.scope, 'project');
    assert.strictEqual(extEntry.enabled, true);
    assert.strictEqual(pkgEntry.scope, 'global');
    assert.strictEqual(pkgEntry.enabled, true);

    // 5. Toggle extension to disabled
    const toggleRes = await togglePiResource({
      kind: 'extension',
      source: './my-tool.ts',
      enabled: false,
      scope: 'project',
      cwd: '/workspace',
    });
    assert.strictEqual(toggleRes.success, true);
    assert.strictEqual(toggleRes.enabled, false);
    assert.strictEqual(toggleRes.requiresReload, true);

    // Verify toggle persisted
    const list2 = await getPiResources('/workspace');
    assert.strictEqual(
      list2.resources.find((r) => r.source === './my-tool.ts')?.enabled,
      false
    );

    // 6. Edit/rename package using oldSource
    const editPkg = await savePiResource({
      kind: 'package',
      source: 'npm:@scope/package@2.0.0',
      oldSource: 'npm:@scope/package@1.0.0',
      scope: 'global',
      enabled: true,
    });
    assert.strictEqual(editPkg.success, true);
    assert.strictEqual(editPkg.source, 'npm:@scope/package@2.0.0');

    const list3 = await getPiResources('/workspace');
    assert.strictEqual(list3.resources.length, 2);
    assert.strictEqual(
      list3.resources.some((r) => r.source === 'npm:@scope/package@1.0.0'),
      false
    );
    assert.strictEqual(
      list3.resources.some((r) => r.source === 'npm:@scope/package@2.0.0'),
      true
    );

    // 7. Delete extension
    const delRes = await deletePiResource({
      kind: 'extension',
      source: './my-tool.ts',
      scope: 'project',
      cwd: '/workspace',
    });
    assert.strictEqual(delRes.success, true);
    assert.strictEqual(delRes.requiresReload, true);

    const list4 = await getPiResources('/workspace');
    assert.strictEqual(list4.resources.length, 1);
    assert.strictEqual(list4.resources[0].source, 'npm:@scope/package@2.0.0');

    // 8. Delete non-existent throws
    await assert.rejects(
      async () => {
        await deletePiResource({
          kind: 'extension',
          source: './non-existent.ts',
          scope: 'project',
        });
      },
      /not found/
    );
  } finally {
    delete (globalThis as any).window;
    delete (globalThis as any).localStorage;
  }
});

test('extensions domain: extractPackageIdentity extracts canonical package identities', () => {
  assert.equal(extractPackageIdentity('npm:@scope/my-pkg@1.2.3'), '@scope/my-pkg');
  assert.equal(extractPackageIdentity('npm:@scope/my-pkg'), '@scope/my-pkg');
  assert.equal(extractPackageIdentity('@scope/my-pkg@2.0.0'), '@scope/my-pkg');
  assert.equal(extractPackageIdentity('npm:plain-tool@1.0.0'), 'plain-tool');
  assert.equal(extractPackageIdentity('npm:plain-tool'), 'plain-tool');
  assert.equal(extractPackageIdentity('git:github.com/org/repo@v1'), 'github.com/org/repo');
  assert.equal(extractPackageIdentity('git:github.com/org/repo.git'), 'github.com/org/repo');
  assert.equal(extractPackageIdentity('https://github.com/org/repo@v2'), 'github.com/org/repo');
  assert.equal(extractPackageIdentity('./local/path'), './local/path');
  assert.equal(extractPackageIdentity('.\\local\\path'), './local/path');
});

test('extensions domain: packageIdentitiesMatch and extensionSourcesMatch match canonical resources', () => {
  // Package identities
  assert.equal(packageIdentitiesMatch('npm:@scope/my-pkg@1.2.3', '@scope/my-pkg@2.0.0'), true);
  assert.equal(packageIdentitiesMatch('npm:plain-tool', 'plain-tool@1.0.0'), true);
  assert.equal(packageIdentitiesMatch('git:github.com/org/repo@v1', 'https://github.com/org/repo.git'), true);
  assert.equal(packageIdentitiesMatch('npm:pkg-a', 'npm:pkg-b'), false);

  // Extension sources
  assert.equal(extensionSourcesMatch('./my-ext.ts', 'my-ext.ts'), true);
  assert.equal(extensionSourcesMatch('!./my-ext.ts', './my-ext.ts'), true);
  assert.equal(extensionSourcesMatch('+./tools/my-ext.ts', 'tools/my-ext.ts'), true);
  assert.equal(extensionSourcesMatch('.\\tools\\my-ext.ts', 'tools/my-ext.ts'), true);
  assert.equal(extensionSourcesMatch('./my-ext.ts', './other-ext.ts'), false);
  // Auto-discovered extensions matching
  assert.equal(extensionSourcesMatch('extensions/dir/index.ts', '!extensions/dir/index.ts'), true);
  assert.equal(extensionSourcesMatch('extensions/dir/index.ts', 'dir/index.ts'), true);
  assert.equal(extensionSourcesMatch('extensions/dir/index.ts', 'dir'), true);
  assert.equal(extensionSourcesMatch('dir', 'extensions/dir/index.ts'), true);
  assert.equal(extensionSourcesMatch('extensions/dir', 'extensions/dir/index.ts'), true);
  assert.equal(extensionSourcesMatch('-extensions/dir/index.ts', 'dir'), true);

  // Resource identities match
  assert.equal(resourceIdentitiesMatch('package', 'npm:@tools/pkg@1.0.0', '@tools/pkg@2.0.0'), true);
  assert.equal(resourceIdentitiesMatch('extension', '!./my-ext.ts', './my-ext.ts'), true);
  assert.equal(resourceIdentitiesMatch('extension', './ext-a.ts', './ext-b.ts'), false);
});

test('extensions bridge: preview fallback mock storage granular per-project override lifecycle', async () => {
  const fakeStorage = new MemoryStorage();
  (globalThis as any).window = { localStorage: fakeStorage };
  (globalThis as any).localStorage = fakeStorage;

  try {
    // 1. Add global extension and global package
    await savePiResource({
      kind: 'extension',
      source: './tools/linter.ts',
      scope: 'global',
      enabled: true,
    });
    await savePiResource({
      kind: 'package',
      source: 'npm:@company/code-tools@1.0.0',
      scope: 'global',
      enabled: true,
    });
    // Set global always-active exception so extension is active by default across projects
    await setResourceActivationPi({
      kind: 'extension',
      identity: './tools/linter.ts',
      enabled: true,
    });

    // 2. Query with cwd: both are returned as global with hasProjectOverride: false
    const initialProjectList = await getPiResources('/my-workspace');
    assert.strictEqual(initialProjectList.resources.length, 2);
    const globalExt = initialProjectList.resources.find((r) => r.name === 'linter.ts')!;
    const globalPkg = initialProjectList.resources.find((r) => r.name === '@company/code-tools')!;
    assert.strictEqual(globalExt.scope, 'global');
    assert.strictEqual(globalExt.enabled, true);
    assert.strictEqual(globalExt.globalEnabled, true);
    assert.strictEqual(globalExt.hasProjectOverride, false);
    assert.strictEqual(globalPkg.scope, 'global');
    assert.strictEqual(globalPkg.enabled, true);
    assert.strictEqual(globalPkg.hasProjectOverride, false);

    // 3. Deactivate global extension for project only
    const toggleExtResult = await togglePiResource({
      kind: 'extension',
      source: './tools/linter.ts',
      enabled: false,
      scope: 'project',
      cwd: '/my-workspace',
    });
    assert.strictEqual(toggleExtResult.success, true);
    assert.strictEqual(toggleExtResult.enabled, false);

    // Query project: extension is now overridden as disabled
    const listAfterExtToggle = await getPiResources('/my-workspace');
    assert.strictEqual(listAfterExtToggle.resources.length, 2); // Merged, not duplicated!
    const overriddenExt = listAfterExtToggle.resources.find((r) => r.name === 'linter.ts')!;
    assert.strictEqual(overriddenExt.enabled, false);
    assert.strictEqual(overriddenExt.globalEnabled, true);
    assert.strictEqual(overriddenExt.hasProjectOverride, true);

    // 4. Query global without cwd: still enabled
    const globalOnlyList = await getPiResources();
    const pureGlobalExt = globalOnlyList.resources.find((r) => r.name === 'linter.ts')!;
    assert.strictEqual(pureGlobalExt.enabled, true);
    assert.strictEqual(pureGlobalExt.hasProjectOverride, false);

    // 5. Deactivate global package for project
    const togglePkgResult = await togglePiResource({
      kind: 'package',
      source: 'npm:@company/code-tools@1.0.0',
      enabled: false,
      scope: 'project',
      cwd: '/my-workspace',
    });
    assert.strictEqual(togglePkgResult.success, true);
    assert.strictEqual(togglePkgResult.enabled, false);

    const listAfterPkgToggle = await getPiResources('/my-workspace');
    const overriddenPkg = listAfterPkgToggle.resources.find((r) => r.name === '@company/code-tools')!;
    assert.strictEqual(overriddenPkg.enabled, false);
    assert.strictEqual(overriddenPkg.autoload, false);
    assert.strictEqual(overriddenPkg.hasProjectOverride, true);

    // 6. Delete extension override from project
    const delExtOverride = await deletePiResource({
      kind: 'extension',
      source: './tools/linter.ts',
      scope: 'project',
      cwd: '/my-workspace',
    });
    assert.strictEqual(delExtOverride.success, true);

    // After deleting override, resource reverts to global default (enabled: true, hasProjectOverride: false)
    const listAfterDelete = await getPiResources('/my-workspace');
    const revertedExt = listAfterDelete.resources.find((r) => r.name === 'linter.ts')!;
    assert.strictEqual(revertedExt.enabled, true);
    assert.strictEqual(revertedExt.hasProjectOverride, false);
  } finally {
    delete (globalThis as any).window;
    delete (globalThis as any).localStorage;
  }
});

test('extensions bridge: preview fallback mock storage auto-discovered extension project override and revert', async () => {
  const fakeStorage = new MemoryStorage();
  (globalThis as any).window = { localStorage: fakeStorage };
  (globalThis as any).localStorage = fakeStorage;

  try {
    // Seed mock storage with a global auto-discovered extension
    const autoExt = {
      id: 'global:extension:extensions/cpamc-auto-switcher/index.ts',
      name: 'cpamc-auto-switcher',
      kind: 'extension' as const,
      source: 'extensions/cpamc-auto-switcher/index.ts',
      scope: 'global' as const,
      enabled: true,
      configPath: '/home/.pi/agent/extensions/cpamc-auto-switcher/index.ts',
    };
    fakeStorage.setItem(
      MOCK_PI_RESOURCES_STORAGE_KEY,
      JSON.stringify({ resources: [autoExt] })
    );
    // Set global always-active exception for auto-discovered extension
    await setResourceActivationPi({
      kind: 'extension',
      identity: 'extensions/cpamc-auto-switcher/index.ts',
      enabled: true,
    });

    // 1. Initial query: auto-discovered extension is enabled, no project override
    const initialList = await getPiResources('/project-workspace');
    assert.strictEqual(initialList.resources.length, 1);
    const initialCard = initialList.resources[0];
    assert.strictEqual(initialCard.name, 'cpamc-auto-switcher');
    assert.strictEqual(initialCard.enabled, true);
    assert.strictEqual(initialCard.globalEnabled, true);
    assert.strictEqual(initialCard.hasProjectOverride, false);
    assert.strictEqual(initialCard.configPath, '/home/.pi/agent/extensions/cpamc-auto-switcher/index.ts');

    // 2. Disable in project scope
    const toggleDisableRes = await togglePiResource({
      kind: 'extension',
      source: 'extensions/cpamc-auto-switcher/index.ts',
      enabled: false,
      scope: 'project',
      cwd: '/project-workspace',
    });
    assert.strictEqual(toggleDisableRes.success, true);
    assert.strictEqual(toggleDisableRes.enabled, false);

    // 3. Query project: merged into 1 card, disabled with hasProjectOverride
    const disabledList = await getPiResources('/project-workspace');
    assert.strictEqual(disabledList.resources.length, 1); // No duplicate cards!
    const disabledCard = disabledList.resources[0];
    assert.strictEqual(disabledCard.name, 'cpamc-auto-switcher');
    assert.strictEqual(disabledCard.enabled, false);
    assert.strictEqual(disabledCard.globalEnabled, true);
    assert.strictEqual(disabledCard.hasProjectOverride, true);
    assert.strictEqual(disabledCard.configPath, '/home/.pi/agent/extensions/cpamc-auto-switcher/index.ts');

    // 4. Re-enable in project scope -> should remove exclusion and revert to default enabled
    const toggleEnableRes = await togglePiResource({
      kind: 'extension',
      source: 'extensions/cpamc-auto-switcher/index.ts',
      enabled: true,
      scope: 'project',
      cwd: '/project-workspace',
    });
    assert.strictEqual(toggleEnableRes.success, true);
    assert.strictEqual(toggleEnableRes.enabled, true);

    // 5. Query project: reverted to default enabled
    const revertedList = await getPiResources('/project-workspace');
    assert.strictEqual(revertedList.resources.length, 1);
    const revertedCard = revertedList.resources[0];
    assert.strictEqual(revertedCard.name, 'cpamc-auto-switcher');
    assert.strictEqual(revertedCard.enabled, true);
    assert.strictEqual(revertedCard.globalEnabled, true);
    assert.strictEqual(revertedCard.hasProjectOverride, false);
  } finally {
    delete (globalThis as any).window;
    delete (globalThis as any).localStorage;
  }
});
