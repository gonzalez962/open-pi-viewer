import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PiResourceEntry } from '@core/types/extensions';
import {
  setResourceActivationPi,
  getPiResources,
  savePiResource,
  MOCK_RESOURCE_ACTIVATION_STORAGE_KEY,
} from '@infra/bridge';
import {
  executeResourceAlwaysActiveToggle,
} from '@features/extensions/hooks/usePiResources';
import { ResourceCard } from '@features/extensions/components/ResourceCard';
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

test('extensions bridge: setResourceActivationPi invokes set_resource_activation for extensions in desktop/Tauri mode', async () => {
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
      kind: 'extension',
      identity: './tools/linter.ts',
      enabled: true,
    },
    mockInvoke as any
  );
  assert.deepStrictEqual(globalResult, { success: true });
  assert.strictEqual(recordedCalls.length, 1);
  assert.strictEqual(recordedCalls[0].cmd, 'set_resource_activation');
  const callArgs1 = recordedCalls[0].args as Record<string, unknown>;
  assert.strictEqual(callArgs1.kind, 'extension');
  assert.strictEqual(callArgs1.identity, './tools/linter.ts');
  assert.strictEqual(callArgs1.enabled, true);
  assert.strictEqual(callArgs1.cwd, undefined);

  // Project override (present cwd)
  const projectResult = await setResourceActivationPi(
    {
      kind: 'extension',
      identity: './tools/linter.ts',
      enabled: false,
      cwd: '/workspace/project-b',
    },
    mockInvoke as any
  );
  assert.deepStrictEqual(projectResult, { success: true });
  assert.strictEqual(recordedCalls.length, 2);
  const callArgs2 = recordedCalls[1].args as Record<string, unknown>;
  assert.strictEqual(callArgs2.kind, 'extension');
  assert.strictEqual(callArgs2.identity, './tools/linter.ts');
  assert.strictEqual(callArgs2.enabled, false);
  assert.strictEqual(callArgs2.cwd, '/workspace/project-b');
});

// ---------------------------------------------------------------------------
// 2. Preview Fallback & Policy Calculation Tests
// ---------------------------------------------------------------------------

test('extensions bridge: preview fallback persists policy, inherits native extension state, packages unaffected', async () => {
  const fakeStorage = new MemoryStorage();
  (globalThis as any).window = { localStorage: fakeStorage };
  (globalThis as any).localStorage = fakeStorage;

  try {
    // 1. Seed global extension and global package in mock storage
    await savePiResource({
      kind: 'extension',
      source: './tools/helper.ts',
      scope: 'global',
      enabled: true,
    });
    await savePiResource({
      kind: 'package',
      source: 'npm:@company/utils@1.0.0',
      scope: 'global',
      enabled: true,
    });

    // 2. Global listing without cwd: extension enabled = true, alwaysActive = false; package enabled = true
    const globalList = await getPiResources();
    assert.strictEqual(globalList.resources.length, 2);
    const globalExt = globalList.resources.find((r) => r.kind === 'extension')!;
    const globalPkg = globalList.resources.find((r) => r.kind === 'package')!;
    assert.strictEqual(globalExt.enabled, true);
    assert.strictEqual(globalExt.alwaysActive, false);
    assert.strictEqual(globalPkg.enabled, true);

    // 3. Project listing with cwd:
    // Extensions inherit native state unless explicitly overridden.
    // Packages are unaffected and retain existing behavior (enabled = true)!
    const projectList = await getPiResources('/workspace/app-1');
    assert.strictEqual(projectList.resources.length, 2);
    const projExt = projectList.resources.find((r) => r.kind === 'extension')!;
    const projPkg = projectList.resources.find((r) => r.kind === 'package')!;
    assert.strictEqual(projExt.enabled, true);
    assert.strictEqual(projExt.alwaysActive, false);
    assert.strictEqual(projExt.hasProjectOverride, false);
    assert.strictEqual(projPkg.enabled, true); // Package unaffected!

    // 4. Set global always-active exception on extension
    const actRes = await setResourceActivationPi({
      kind: 'extension',
      identity: './tools/helper.ts',
      enabled: true,
    });
    assert.strictEqual(actRes.success, true);

    // 5. Global listing reflects alwaysActive = true on extension
    const globalList2 = await getPiResources();
    const globalExt2 = globalList2.resources.find((r) => r.kind === 'extension')!;
    assert.strictEqual(globalExt2.alwaysActive, true);
    assert.strictEqual(globalExt2.enabled, true);

    // 6. Project listing now activates extension via exception
    const projectList2 = await getPiResources('/workspace/app-1');
    const projExt2 = projectList2.resources.find((r) => r.kind === 'extension')!;
    assert.strictEqual(projExt2.enabled, true);
    assert.strictEqual(projExt2.alwaysActive, true);
    assert.strictEqual(projExt2.hasProjectOverride, false);

    // 7. Explicit project override takes precedence over global always-active
    await setResourceActivationPi({
      kind: 'extension',
      identity: './tools/helper.ts',
      enabled: false,
      cwd: '/workspace/app-1',
    });

    const projectList3 = await getPiResources('/workspace/app-1');
    const projExt3 = projectList3.resources.find((r) => r.kind === 'extension')!;
    assert.strictEqual(projExt3.enabled, false);
    assert.strictEqual(projExt3.alwaysActive, true);
    assert.strictEqual(projExt3.hasProjectOverride, true);

    // 8. Other project remains active via global exception
    const projectListOther = await getPiResources('/workspace/app-2');
    const otherExt = projectListOther.resources.find((r) => r.kind === 'extension')!;
    assert.strictEqual(otherExt.enabled, true);
    assert.strictEqual(otherExt.hasProjectOverride, false);

    // 9. Activation policy persisted in mock storage
    const rawPolicy = JSON.parse(fakeStorage.getItem(MOCK_RESOURCE_ACTIVATION_STORAGE_KEY)!);
    assert.strictEqual(rawPolicy.version, 1);
    assert.ok(rawPolicy.alwaysExtensions.includes('./tools/helper.ts'));
  } finally {
    delete (globalThis as any).window;
    delete (globalThis as any).localStorage;
  }
});

// ---------------------------------------------------------------------------
// 3. executeResourceAlwaysActiveToggle helper workflow
// ---------------------------------------------------------------------------

test('usePiResources: executeResourceAlwaysActiveToggle updates alwaysActive for extensions and ignores packages', async () => {
  const extensionResource: PiResourceEntry = {
    id: 'global:extension:./my-ext.ts',
    name: 'my-ext.ts',
    kind: 'extension',
    source: './my-ext.ts',
    scope: 'global',
    enabled: true,
    configPath: '~/.pi/agent/settings.json',
    alwaysActive: false,
  };

  const packageResource: PiResourceEntry = {
    id: 'global:package:npm:my-pkg',
    name: 'my-pkg',
    kind: 'package',
    source: 'npm:my-pkg',
    scope: 'global',
    enabled: true,
    configPath: '~/.pi/agent/settings.json',
  };

  const recordedCalls: any[] = [];
  const mockActivationFn = async (p: any) => {
    recordedCalls.push(p);
    return { success: true };
  };

  // Extension toggle
  const resExt = await executeResourceAlwaysActiveToggle({
    resources: [extensionResource],
    resource: extensionResource,
    alwaysActive: true,
    activationFn: mockActivationFn,
  });
  assert.strictEqual(resExt.success, true);
  assert.strictEqual(resExt.nextResources[0].alwaysActive, true);
  assert.strictEqual(recordedCalls.length, 1);
  assert.deepStrictEqual(recordedCalls[0], {
    kind: 'extension',
    identity: './my-ext.ts',
    enabled: true,
    cwd: undefined,
  });

  // Package toggle should be no-op (packages unaffected)
  const resPkg = await executeResourceAlwaysActiveToggle({
    resources: [packageResource],
    resource: packageResource,
    alwaysActive: true,
    activationFn: mockActivationFn,
  });
  assert.strictEqual(resPkg.success, true);
  assert.strictEqual(recordedCalls.length, 1); // No new call made!
});

// ---------------------------------------------------------------------------
// 4. ResourceCard Accessible 'Always activate in all projects' Control Tests
// ---------------------------------------------------------------------------

test('ResourceCard: renders accessible Always activate control for extensions but NOT for packages', () => {
  const ext: PiResourceEntry = {
    id: 'global:extension:./my-ext.ts',
    name: 'my-ext.ts',
    kind: 'extension',
    source: './my-ext.ts',
    scope: 'global',
    enabled: true,
    configPath: '~/.pi/agent/settings.json',
    alwaysActive: false,
  };

  const pkg: PiResourceEntry = {
    id: 'global:package:npm:my-pkg',
    name: 'my-pkg',
    kind: 'package',
    source: 'npm:my-pkg',
    scope: 'global',
    enabled: true,
    configPath: '~/.pi/agent/settings.json',
  };

  // Render extension card
  const extHtml = renderToStaticMarkup(
    React.createElement(ResourceCard, {
      resource: ext,
      onToggle: () => {},
      onToggleAlwaysActive: () => {},
      t: (key: string) => translate('en', key as any),
    })
  );

  assert.ok(
    extHtml.includes('Always activate in all projects'),
    'Extension card must render Always activate control'
  );
  assert.ok(
    extHtml.includes('id="ext-always-global:extension:./my-ext.ts"'),
    'Extension card must render dedicated input id'
  );
  assert.ok(
    extHtml.includes('for="ext-always-global:extension:./my-ext.ts"'),
    'Extension card must link label via htmlFor'
  );
  assert.ok(
    extHtml.includes('aria-label="my-ext.ts: Always activate in all projects"'),
    'Extension card must have accessible aria-label'
  );

  // Render package card
  const pkgHtml = renderToStaticMarkup(
    React.createElement(ResourceCard, {
      resource: pkg,
      onToggle: () => {},
      onToggleAlwaysActive: () => {},
      t: (key: string) => translate('en', key as any),
    })
  );

  assert.strictEqual(
    pkgHtml.includes('Always activate in all projects'),
    false,
    'Package card must NOT render Always activate control (packages unaffected)'
  );
});

// ---------------------------------------------------------------------------
// 5. Localization Tests (en and es parity)
// ---------------------------------------------------------------------------

test('extensions localization: en and es translations exist for always active controls and reload notice', () => {
  const enLabel = translate('en', 'extensions.always_activate_label' as any);
  const esLabel = translate('es', 'extensions.always_activate_label' as any);
  assert.strictEqual(enLabel, 'Always activate in all projects');
  assert.strictEqual(esLabel, 'Activar siempre en todos los proyectos');

  const enBadge = translate('en', 'extensions.badge_always_active' as any);
  const esBadge = translate('es', 'extensions.badge_always_active' as any);
  assert.ok(enBadge.length > 0);
  assert.ok(esBadge.length > 0);

  const enNotice = translate('en', 'extensions.activation_next_session_notice' as any);
  const esNotice = translate('es', 'extensions.activation_next_session_notice' as any);
  assert.ok(enNotice.length > 0);
  assert.ok(esNotice.length > 0);
});

// ---------------------------------------------------------------------------
// 6. S6: ResourceCard Hover Title on Name/Source and Name Fallbacks
// ---------------------------------------------------------------------------

test('S6 ResourceCard: hover title on name and source displays extensionDir (fallback extensionPath, then source, NEVER configPath)', () => {
  const extWithDir: PiResourceEntry = {
    id: 'global:extension:./plugins/git-tools/index.ts',
    name: 'git-tools',
    kind: 'extension',
    source: './plugins/git-tools/index.ts',
    scope: 'project',
    enabled: true,
    configPath: '/workspace/project/.pi/settings.json',
    extensionPath: '/workspace/project/plugins/git-tools/index.ts',
    extensionDir: '/workspace/project/plugins/git-tools',
  };

  const html = renderToStaticMarkup(
    React.createElement(ResourceCard, {
      resource: extWithDir,
      onToggle: () => {},
      t: (key: string) => translate('en', key as any),
    })
  );

  // Must display extensionDir in title on name
  assert.ok(
    html.includes('class="ext-card-name" title="/workspace/project/plugins/git-tools"'),
    'ResourceCard must display extensionDir in hover title on name'
  );
  // Must display extensionDir in title on source
  assert.ok(
    html.includes('title="/workspace/project/plugins/git-tools"'),
    'ResourceCard must display extensionDir in hover title on source'
  );
  // Must NEVER display configPath in title
  assert.ok(
    !html.includes('title="/workspace/project/.pi/settings.json"'),
    'ResourceCard must NEVER display configPath in hover title'
  );

  // Fallback to extensionPath when extensionDir absent
  const extWithPath: PiResourceEntry = {
    id: 'global:extension:./tools/runner.ts',
    name: 'runner',
    kind: 'extension',
    source: './tools/runner.ts',
    scope: 'project',
    enabled: true,
    configPath: '/workspace/project/.pi/settings.json',
    extensionPath: '/workspace/project/tools/runner.ts',
  };

  const htmlPath = renderToStaticMarkup(
    React.createElement(ResourceCard, {
      resource: extWithPath,
      onToggle: () => {},
      t: (key: string) => translate('en', key as any),
    })
  );
  assert.ok(
    htmlPath.includes('title="/workspace/project/tools/runner.ts"'),
    'Should fall back to extensionPath in hover title'
  );
  assert.ok(
    !htmlPath.includes('title="/workspace/project/.pi/settings.json"'),
    'Must NEVER use configPath as hover title'
  );

  // Fallback to source when neither metadata is present
  const extWithSourceOnly: PiResourceEntry = {
    id: 'global:extension:./tools/runner.ts',
    name: 'runner',
    kind: 'extension',
    source: './tools/runner.ts',
    scope: 'project',
    enabled: true,
    configPath: '/workspace/project/.pi/settings.json',
  };

  const htmlSource = renderToStaticMarkup(
    React.createElement(ResourceCard, {
      resource: extWithSourceOnly,
      onToggle: () => {},
      t: (key: string) => translate('en', key as any),
    })
  );
  assert.ok(
    htmlSource.includes('title="./tools/runner.ts"'),
    'Should fall back to source in hover title'
  );
  assert.ok(
    !htmlSource.includes('title="/workspace/project/.pi/settings.json"'),
    'Must NEVER use configPath as hover title'
  );
});

test('S6 ResourceCard: defensive UI name fallback for index trio (ts/js/mjs) and index to parent folder', () => {
  const extIndexMjs: PiResourceEntry = {
    id: 'global:extension:./extensions/markdown-it/index.mjs',
    name: 'index.mjs',
    kind: 'extension',
    source: './extensions/markdown-it/index.mjs',
    scope: 'global',
    enabled: true,
    configPath: '~/.pi/agent/settings.json',
    extensionDir: '/home/user/.pi/extensions/markdown-it',
  };

  const html = renderToStaticMarkup(
    React.createElement(ResourceCard, {
      resource: extIndexMjs,
      onToggle: () => {},
      t: (key: string) => translate('en', key as any),
    })
  );

  assert.ok(
    html.includes('markdown-it'),
    'index.mjs extension must fall back to parent folder name "markdown-it"'
  );
  assert.ok(
    !html.includes('<h3 class="ext-card-name" title="/home/user/.pi/extensions/markdown-it">index.mjs</h3>'),
    'Must not display "index.mjs" as the card title text'
  );
});

// ---------------------------------------------------------------------------
// 7. S6: Preview Directory-Owned Project Policy Simulation
// ---------------------------------------------------------------------------

test('S6 bridge: preview simulates directory-owned project policy in separate per-cwd storage with legacy fallback', async () => {
  const fakeStorage = new MemoryStorage();
  (globalThis as any).window = { localStorage: fakeStorage };
  (globalThis as any).localStorage = fakeStorage;

  try {
    const cwd1 = '/workspace/project-one';
    const cwd2 = '/workspace/project-two';

    // 1. Seed legacy global activation policy with legacy project choices
    const legacyPolicy = {
      version: 1,
      alwaysExtensions: ['./tools/global-always.ts'],
      alwaysMcpServers: ['global-mcp'],
      projects: {
        [cwd1.toLowerCase()]: {
          extensions: { './tools/legacy-ext.ts': true, './tools/stale-ext.ts': true },
          mcpServers: { 'legacy-mcp': true, 'stale-mcp': true },
        },
      },
    };
    fakeStorage.setItem(MOCK_RESOURCE_ACTIVATION_STORAGE_KEY, JSON.stringify(legacyPolicy));

    // Seed mock resources
    await savePiResource({
      kind: 'extension',
      source: './tools/legacy-ext.ts',
      scope: 'global',
      enabled: true,
    });
    await savePiResource({
      kind: 'extension',
      source: './tools/stale-ext.ts',
      scope: 'global',
      enabled: true,
    });

    // 2. Query cwd1 with ABSENT local store: falls back to legacy choices read-only!
    const resLegacy = await getPiResources(cwd1);
    const legacyExt = resLegacy.resources.find((r) => r.source === './tools/legacy-ext.ts');
    assert.strictEqual(legacyExt?.enabled, true, 'Absent local store must fall back to legacy choices read-only');
    assert.strictEqual(legacyExt?.hasProjectOverride, true);

    // 3. First explicit project toggle on cwd1:
    // Seeds local per-cwd file with legacy choices, then applies toggle!
    await setResourceActivationPi({
      kind: 'extension',
      identity: './tools/legacy-ext.ts',
      enabled: false,
      cwd: cwd1,
    });

    // Verify separate per-cwd storage was created
    const expectedLocalKey = `pi_viewer_project_activation_mock:${cwd1.toLowerCase()}`;
    const rawLocal = fakeStorage.getItem(expectedLocalKey);
    assert.ok(rawLocal, 'Per-cwd storage key must be created upon explicit project toggle');
    const parsedLocal = JSON.parse(rawLocal!);
    assert.strictEqual(parsedLocal.version, 1);
    assert.strictEqual(parsedLocal.extensions['./tools/legacy-ext.ts'], false);
    // Legacy choice './tools/stale-ext.ts' was seeded:
    assert.strictEqual(parsedLocal.extensions['./tools/stale-ext.ts'], true);

    // Legacy store in central policy was NOT deleted
    const preservedLegacy = JSON.parse(fakeStorage.getItem(MOCK_RESOURCE_ACTIVATION_STORAGE_KEY)!);
    assert.strictEqual(preservedLegacy.projects[cwd1.toLowerCase()].extensions['./tools/legacy-ext.ts'], true, 'Legacy data must be preserved non-destructively');

    // 4. Authoritative local file: delete or omit a key in local store.
    // Local authoritative emptiness masks stale legacy keys!
    delete parsedLocal.extensions['./tools/stale-ext.ts'];
    fakeStorage.setItem(expectedLocalKey, JSON.stringify(parsedLocal));

    const resAuthoritative = await getPiResources(cwd1);
    const staleExt = resAuthoritative.resources.find((r) => r.source === './tools/stale-ext.ts');
    // Local absence masks legacy keys while inheriting native enabled state.
    assert.strictEqual(staleExt?.enabled, true, 'Local authoritative emptiness must inherit native state');
    assert.strictEqual(staleExt?.hasProjectOverride, false);

    // Global always-on extension remains enabled via global exception:
    await savePiResource({
      kind: 'extension',
      source: './tools/global-always.ts',
      scope: 'global',
      enabled: true,
    });
    const resAlways = await getPiResources(cwd1);
    const alwaysExt = resAlways.resources.find((r) => r.source === './tools/global-always.ts');
    assert.strictEqual(alwaysExt?.enabled, true, 'Global always exception must activate even with local store');
    assert.strictEqual(alwaysExt?.alwaysActive, true);

    // 5. Project isolation: cwd2 has no local store and is unaffected by cwd1's local writes
    const resCwd2 = await getPiResources(cwd2);
    const cwd2Legacy = resCwd2.resources.find((r) => r.source === './tools/legacy-ext.ts');
    assert.strictEqual(cwd2Legacy?.enabled, true, 'cwd2 inherits native state and is isolated from cwd1');
    const localKeyCwd2 = `pi_viewer_project_activation_mock:${cwd2.toLowerCase()}`;
    assert.strictEqual(fakeStorage.getItem(localKeyCwd2), null, 'cwd2 should not have local storage created');
  } finally {
    delete (globalThis as any).window;
    delete (globalThis as any).localStorage;
  }
});
