import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AppearanceLifecycleController,
  applyAppearance,
  clearAppearanceCustomVariables,
  computeEffectiveAppearance,
  isAppearanceDirty,
  MANAGED_APPEARANCE_VARIABLES,
  type AppearanceDomTarget,
} from '@features/settings/appearance';
import { useAppearanceDraft } from '@features/settings/hooks/useAppearanceDraft';
import type {
  AppearanceInput,
  AppearancePreferences,
} from '@infra/preferences';

function createMockDomTarget(): AppearanceDomTarget & {
  attributes: Map<string, string>;
  styles: Map<string, string>;
} {
  const attributes = new Map<string, string>();
  const styles = new Map<string, string>();
  return {
    attributes,
    styles,
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
    removeAttribute(name: string) {
      attributes.delete(name);
    },
    style: {
      colorScheme: '',
      setProperty(name: string, value: string) {
        styles.set(name, value);
      },
      removeProperty(name: string) {
        styles.delete(name);
      },
      getPropertyValue(name: string) {
        return styles.get(name) ?? '';
      },
    },
  };
}

function createMockWindow(initialColorScheme: 'dark' | 'light' = 'dark') {
  let currentScheme = initialColorScheme;
  const listeners = new Set<(e: { matches: boolean }) => void>();
  return {
    window: {
      matchMedia(query: string) {
        return {
          matches: currentScheme === 'dark',
          media: query,
          addEventListener(_type: string, listener: (e: { matches: boolean }) => void) {
            listeners.add(listener);
          },
          removeEventListener(_type: string, listener: (e: { matches: boolean }) => void) {
            listeners.delete(listener);
          },
        } as unknown as MediaQueryList;
      },
    },
    setColorScheme(scheme: 'dark' | 'light') {
      currentScheme = scheme;
      for (const listener of listeners) {
        listener({ matches: scheme === 'dark' });
      }
    },
    getListenerCount: () => listeners.size,
  };
}

test('isolated draft preview: update applies DOM preview variables without writing to storage', () => {
  const domTarget = createMockDomTarget();
  let storageWrites = 0;
  let saved: AppearancePreferences = { theme: 'dark' };

  const controller = new AppearanceLifecycleController({
    getSavedAppearance: () => saved,
    commitAppearance: (_candidate) => {
      storageWrites++;
      return { success: true };
    },
    rootElement: domTarget,
  }).start();

  // Begin drafting
  controller.begin();
  assert.strictEqual(controller.getState().isDrafting, true);
  assert.strictEqual(storageWrites, 0, 'begin must not write to storage');

  // Update with custom accent and custom text color
  controller.update({
    customAccent: '#ff007f',
    customTextColor: '#f0f0f0',
  });

  // Verify preview styles applied to DOM target
  assert.strictEqual(domTarget.styles.get('--accent-primary'), '#ff007f');
  assert.strictEqual(domTarget.styles.get('--fg-default'), '#f0f0f0');
  assert.strictEqual(domTarget.styles.get('--text-primary'), '#f0f0f0');
  assert.strictEqual(storageWrites, 0, 'update preview must never write to storage');

  // Second update with a different accent
  controller.update({
    customAccent: '#00ffcc',
  });
  assert.strictEqual(domTarget.styles.get('--accent-primary'), '#00ffcc');
  assert.strictEqual(domTarget.styles.get('--fg-default'), '#f0f0f0', 'preserved previous draft properties');
  assert.strictEqual(storageWrites, 0, 'subsequent updates must never write to storage');

  controller.dispose();
});

test('cancel: discards draft and removes all preview-only inline custom variables, restoring saved appearance', () => {
  const domTarget = createMockDomTarget();
  const saved: AppearancePreferences = {
    theme: 'dark',
    customAccent: '#00e5ff',
  };

  const controller = new AppearanceLifecycleController({
    getSavedAppearance: () => saved,
    rootElement: domTarget,
  }).start();

  // Initial saved styles are applied
  assert.strictEqual(domTarget.attributes.get('data-theme'), 'dark');
  assert.strictEqual(domTarget.styles.get('--accent-primary'), '#00e5ff');

  // Begin and apply preview with extra variables
  controller.begin();
  controller.update({
    theme: 'light',
    customAccent: '#ff1493',
    customTextColor: '#112233',
    customLabelColor: '#445566',
    customBackground: {
      canvas: { color: '#ffffff', opacity: 0.9 },
    },
  });

  assert.strictEqual(domTarget.attributes.get('data-theme'), 'light');
  assert.strictEqual(domTarget.styles.get('--accent-primary'), '#ff1493');
  assert.strictEqual(domTarget.styles.get('--fg-default'), '#112233');
  assert.strictEqual(domTarget.styles.get('--activity-badge-fg'), '#445566');
  assert.ok(domTarget.styles.has('--custom-bg-canvas'));

  // Cancel draft
  controller.cancel();

  // Saved appearance is restored
  assert.strictEqual(domTarget.attributes.get('data-theme'), 'dark');
  assert.strictEqual(domTarget.styles.get('--accent-primary'), '#00e5ff');

  // Preview-only custom variables are completely removed
  assert.strictEqual(domTarget.styles.has('--fg-default'), false);
  assert.strictEqual(domTarget.styles.has('--text-primary'), false);
  assert.strictEqual(domTarget.styles.has('--activity-badge-fg'), false);
  assert.strictEqual(domTarget.styles.has('--custom-bg-canvas'), false);

  assert.strictEqual(controller.getState().isDrafting, false);
  assert.strictEqual(controller.getState().draft, null);
  assert.strictEqual(controller.getState().isDirty, false);

  controller.dispose();
});

test('dispose: cleans up preview variables and restores saved appearance', () => {
  const domTarget = createMockDomTarget();
  const saved: AppearancePreferences = { theme: 'dark' };

  const controller = new AppearanceLifecycleController({
    getSavedAppearance: () => saved,
    rootElement: domTarget,
  }).start();

  controller.begin();
  controller.update({
    theme: 'DjRomoro',
    customAccent: '#f59e0b',
  });

  assert.strictEqual(domTarget.attributes.get('data-theme'), 'DjRomoro');
  assert.strictEqual(domTarget.styles.get('--accent-primary'), '#f59e0b');

  // Dispose while drafting
  controller.dispose();

  // Saved theme restored and preview variables wiped
  assert.strictEqual(domTarget.attributes.get('data-theme'), 'dark');
  assert.strictEqual(domTarget.styles.has('--accent-primary'), false);
});

test('latest saved restoration: cancelling restores the latest saved state even if saved changed while drafting', () => {
  const domTarget = createMockDomTarget();
  let saved: AppearancePreferences = {
    theme: 'dark',
    customAccent: '#111111',
  };

  const controller = new AppearanceLifecycleController({
    getSavedAppearance: () => saved,
    rootElement: domTarget,
  }).start();

  controller.begin();
  controller.update({ customAccent: '#999999' });
  assert.strictEqual(domTarget.styles.get('--accent-primary'), '#999999');

  // Saved appearance is updated externally while user was drafting
  saved = {
    theme: 'dark',
    customAccent: '#222222',
  };
  controller.setSavedAppearance(saved);

  // Active draft preview was NOT overwritten by external saved update
  assert.strictEqual(domTarget.styles.get('--accent-primary'), '#999999');

  // Cancel restores the LATEST saved appearance
  controller.cancel();
  assert.strictEqual(domTarget.styles.get('--accent-primary'), '#222222');

  controller.dispose();
});

test('guarded saved effect: saved appearance changes do not overwrite DOM while an active draft preview is present', () => {
  const domTarget = createMockDomTarget();
  let saved: AppearancePreferences = { theme: 'dark' };

  const controller = new AppearanceLifecycleController({
    getSavedAppearance: () => saved,
    rootElement: domTarget,
  }).start();

  assert.strictEqual(domTarget.attributes.get('data-theme'), 'dark');

  controller.begin();
  controller.update({ theme: 'Minimalist-Ninja' });
  assert.strictEqual(domTarget.attributes.get('data-theme'), 'Minimalist-Ninja');

  // External update occurs
  saved = { theme: 'light' };
  controller.setSavedAppearance(saved);

  // DOM must STILL be the previewed theme
  assert.strictEqual(domTarget.attributes.get('data-theme'), 'Minimalist-Ninja');

  controller.dispose();
});

test('system events: system theme change updates preview if draft theme is system, but not if explicit', () => {
  const domTarget = createMockDomTarget();
  const mockWin = createMockWindow('dark');
  const saved: AppearancePreferences = { theme: 'dark' };

  const controller = new AppearanceLifecycleController({
    getSavedAppearance: () => saved,
    rootElement: domTarget,
    targetWindow: mockWin.window as unknown as Window,
  }).start();

  controller.begin();
  controller.update({ theme: 'system' });
  assert.strictEqual(domTarget.attributes.get('data-theme'), 'dark');
  assert.strictEqual(domTarget.style.colorScheme, 'dark');

  // System changes to light
  mockWin.setColorScheme('light');
  assert.strictEqual(domTarget.attributes.get('data-theme'), 'light');
  assert.strictEqual(domTarget.style.colorScheme, 'light');

  // Switch draft to explicit theme
  controller.update({ theme: 'arch-electric' });
  assert.strictEqual(domTarget.attributes.get('data-theme'), 'arch-electric');

  // System changes back to dark
  mockWin.setColorScheme('dark');
  // Arch-electric is explicit and must not be changed by system
  assert.strictEqual(domTarget.attributes.get('data-theme'), 'arch-electric');

  controller.dispose();
});

test('system events: system theme change updates saved appearance if saved theme is system and not drafting', () => {
  const domTarget = createMockDomTarget();
  const mockWin = createMockWindow('dark');
  const saved: AppearancePreferences = { theme: 'system' };

  const controller = new AppearanceLifecycleController({
    getSavedAppearance: () => saved,
    rootElement: domTarget,
    targetWindow: mockWin.window as unknown as Window,
  }).start();

  assert.strictEqual(domTarget.attributes.get('data-theme'), 'dark');

  // System changes to light
  mockWin.setColorScheme('light');
  assert.strictEqual(domTarget.attributes.get('data-theme'), 'light');
  assert.strictEqual(domTarget.style.colorScheme, 'light');

  controller.dispose();
});

test('listener cleanup: dispose removes system watcher listener idempotently', () => {
  const domTarget = createMockDomTarget();
  const mockWin = createMockWindow('dark');
  const saved: AppearancePreferences = { theme: 'system' };

  const controller = new AppearanceLifecycleController({
    getSavedAppearance: () => saved,
    rootElement: domTarget,
    targetWindow: mockWin.window as unknown as Window,
  }).start();

  assert.strictEqual(mockWin.getListenerCount(), 1);

  // Idempotent dispose
  controller.dispose();
  assert.strictEqual(mockWin.getListenerCount(), 0);

  controller.dispose();
  assert.strictEqual(mockWin.getListenerCount(), 0);
});

test('confirm failure: commit failure retains draft, DOM preview, and records error without reporting success', () => {
  const domTarget = createMockDomTarget();
  const saved: AppearancePreferences = { theme: 'dark' };
  let commitAttempts = 0;

  const controller = new AppearanceLifecycleController({
    getSavedAppearance: () => saved,
    commitAppearance: (_candidate) => {
      commitAttempts++;
      return {
        success: false,
        error: 'QuotaExceeded: Storage full',
      };
    },
    rootElement: domTarget,
  }).start();

  controller.begin();
  controller.update({
    theme: 'light',
    customAccent: '#ff3366',
  });

  const result = controller.confirm();
  assert.strictEqual(commitAttempts, 1, 'called commit exactly once');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error, 'QuotaExceeded: Storage full');

  // Draft state and preview retained
  assert.strictEqual(controller.getState().isDrafting, true);
  assert.strictEqual(controller.getState().error, 'QuotaExceeded: Storage full');
  assert.strictEqual(domTarget.attributes.get('data-theme'), 'light');
  assert.strictEqual(domTarget.styles.get('--accent-primary'), '#ff3366');

  controller.dispose();
});

test('confirm success: commit success persists atomically once, clears draft, aligns saved appearance without stale closures', () => {
  const domTarget = createMockDomTarget();
  let saved: AppearancePreferences = { theme: 'dark' };
  let committedCandidate: AppearanceInput | null = null;
  let commitAttempts = 0;

  const controller = new AppearanceLifecycleController({
    getSavedAppearance: () => saved,
    commitAppearance: (candidate) => {
      commitAttempts++;
      committedCandidate = candidate;
      saved = {
        theme: candidate.theme ?? 'dark',
        customAccent: candidate.customAccent,
      };
      return { success: true };
    },
    rootElement: domTarget,
  }).start();

  controller.begin();
  controller.update({
    theme: 'arch-electric',
    customAccent: '#00ff88',
  });

  const result = controller.confirm();
  assert.strictEqual(commitAttempts, 1);
  assert.strictEqual(result.success, true);
  assert.strictEqual((committedCandidate as AppearanceInput | null)?.theme, 'arch-electric');
  assert.strictEqual((committedCandidate as AppearanceInput | null)?.customAccent, '#00ff88');

  // Draft aligned and closed
  assert.strictEqual(controller.getState().isDrafting, false);
  assert.strictEqual(controller.getState().draft, null);
  assert.strictEqual(controller.getState().isDirty, false);
  assert.strictEqual(controller.getState().error, null);
  assert.strictEqual(controller.getState().saved.theme, 'arch-electric');

  // DOM retains confirmed appearance
  assert.strictEqual(domTarget.attributes.get('data-theme'), 'arch-electric');
  assert.strictEqual(domTarget.styles.get('--accent-primary'), '#00ff88');

  controller.dispose();
});

test('null marker preservation: partial update with customAccent: null preserves explicit null semantics', () => {
  const domTarget = createMockDomTarget();
  let committedCandidate: AppearanceInput | null = null;
  let saved: AppearancePreferences = {
    theme: 'dark',
    customAccent: '#123456',
  };

  const controller = new AppearanceLifecycleController({
    getSavedAppearance: () => saved,
    commitAppearance: (candidate) => {
      committedCandidate = candidate;
      return { success: true };
    },
    rootElement: domTarget,
  }).start();

  controller.begin();
  assert.strictEqual(controller.getState().isDirty, false);

  // Clear accent explicitly
  controller.update({ customAccent: null });
  assert.strictEqual(controller.getState().draft?.customAccent, null);
  assert.strictEqual(controller.getState().isDirty, true);
  assert.strictEqual(domTarget.styles.has('--accent-primary'), false);

  // Subsequent partial update (theme change) must not lose customAccent: null
  controller.update({ theme: 'light' });
  assert.strictEqual(controller.getState().draft?.customAccent, null);
  assert.strictEqual(controller.getState().draft?.theme, 'light');

  controller.confirm();
  assert.strictEqual((committedCandidate as AppearanceInput | null)?.customAccent, null);

  controller.dispose();
});

test('dirty state: computes isDirty accurately across themes, colors, backgrounds, and animations', () => {
  const saved: AppearancePreferences = {
    theme: 'dark',
    customAccent: '#00e5ff',
    customTextColor: '#ffffff',
  };

  const controller = new AppearanceLifecycleController({
    getSavedAppearance: () => saved,
  }).start();

  controller.begin();
  assert.strictEqual(controller.getState().isDirty, false);

  // Same value
  controller.update({ customAccent: '#00e5ff' });
  assert.strictEqual(controller.getState().isDirty, false);

  // Different theme
  controller.update({ theme: 'DjRomoro' });
  assert.strictEqual(controller.getState().isDirty, true);
  assert.strictEqual(isAppearanceDirty(saved, { theme: 'DjRomoro' }), true);

  // Revert theme
  controller.update({ theme: 'dark' });
  assert.strictEqual(controller.getState().isDirty, false);

  // Add work animation
  controller.update({
    workAnimation: { mode: 'single', color1: '#ff0000', color2: '#00ff00' },
  });
  assert.strictEqual(controller.getState().isDirty, true);

  controller.dispose();
});

test('cancel vs resetAppearance: cancel reverts draft to saved customizations without storage writes; resetAppearance calls atomic reset API', () => {
  const domTarget = createMockDomTarget();
  let resetCalled = 0;
  let saved: AppearancePreferences = {
    theme: 'DjRomoro',
    customAccent: '#f43888',
  };

  const controller = new AppearanceLifecycleController({
    getSavedAppearance: () => saved,
    resetAppearance: () => {
      resetCalled++;
      saved = { theme: 'dark', customAccent: null };
      return { success: true };
    },
    rootElement: domTarget,
  }).start();

  // Begin drafting
  controller.begin();
  controller.update({ theme: 'light', customAccent: '#111111' });

  // Cancel must NOT call resetAppearance!
  controller.cancel();
  assert.strictEqual(resetCalled, 0, 'cancel must not call resetAppearance');
  assert.strictEqual(domTarget.attributes.get('data-theme'), 'DjRomoro');
  assert.strictEqual(domTarget.styles.get('--accent-primary'), '#f43888');

  // Now explicitly invoke resetAppearance
  const resetRes = controller.resetAppearance();
  assert.strictEqual(resetCalled, 1);
  assert.strictEqual(resetRes.success, true);
  assert.strictEqual(domTarget.attributes.get('data-theme'), 'dark');
  assert.strictEqual(domTarget.styles.has('--accent-primary'), false);

  controller.dispose();
});

test('centralized applyAppearance: correctly sets data-theme, colorScheme, and derived CSS variables including work animation and area backgrounds', () => {
  const domTarget = createMockDomTarget();

  const appearance: AppearancePreferences = {
    theme: 'arch-electric',
    customAccent: '#00e5ff',
    customTextColor: '#f8fafc',
    customLabelColor: '#a855f7',
    workAnimation: {
      mode: 'single',
      color1: '#00ff66',
      color2: '#00aaff',
    },
    customBackground: {
      canvas: { color: '#050505', opacity: 0.8 },
      sidebar: { color: '#101010', opacity: 0.9 },
    },
  };

  applyAppearance(appearance, { rootElement: domTarget });

  assert.strictEqual(domTarget.attributes.get('data-theme'), 'arch-electric');
  assert.strictEqual(domTarget.style.colorScheme, 'dark');
  assert.strictEqual(domTarget.styles.get('--accent-primary'), '#00e5ff');
  assert.strictEqual(domTarget.styles.get('--fg-default'), '#f8fafc');
  assert.strictEqual(domTarget.styles.get('--activity-badge-fg'), '#a855f7');
  assert.strictEqual(domTarget.styles.get('--loader-color1'), '#00ff66');
  assert.ok(domTarget.styles.get('--custom-bg-canvas')?.includes('rgba(5, 5, 5, 0.8)'));
  assert.ok(domTarget.styles.get('--custom-bg-sidebar')?.includes('rgba(16, 16, 16, 0.9)'));

  // Test clearAppearanceCustomVariables
  clearAppearanceCustomVariables(domTarget);
  for (const varName of MANAGED_APPEARANCE_VARIABLES) {
    assert.strictEqual(domTarget.styles.has(varName), false, `${varName} should be cleared`);
  }
});

test('computeEffectiveAppearance merges saved appearance with active draft overrides', () => {
  const saved: AppearancePreferences = {
    theme: 'dark',
    customAccent: '#00e5ff',
    customTextColor: '#ffffff',
  };

  // Not drafting: returns copy of saved
  assert.deepEqual(computeEffectiveAppearance(saved, null, false), saved);

  // Drafting with partial override: returns merged effective appearance
  const effective = computeEffectiveAppearance(
    saved,
    { customAccent: '#ff00aa', theme: 'arch-electric' },
    true
  );
  assert.strictEqual(effective.theme, 'arch-electric');
  assert.strictEqual(effective.customAccent, '#ff00aa');
  assert.strictEqual(effective.customTextColor, '#ffffff');

  // Drafting with explicit null accent: clears customAccent in effective
  const effectiveCleared = computeEffectiveAppearance(
    saved,
    { customAccent: null },
    true
  );
  assert.strictEqual(effectiveCleared.customAccent, null);
  assert.strictEqual(effectiveCleared.theme, 'dark');
});

test('useAppearanceDraft hook module exports expected callable hook', () => {
  assert.strictEqual(typeof useAppearanceDraft, 'function');
});

test('constructor purity: constructor does not attach global listeners or mutate DOM target', () => {
  const domTarget = createMockDomTarget();
  const mockWin = createMockWindow('dark');
  const saved: AppearancePreferences = { theme: 'system', customAccent: '#00e5ff' };

  // Pure constructor must not mutate DOM or register listeners
  const ctrl = new AppearanceLifecycleController({
    getSavedAppearance: () => saved,
    rootElement: domTarget,
    targetWindow: mockWin.window as unknown as Window,
  });

  assert.strictEqual(domTarget.attributes.size, 0, 'constructor must not set DOM attributes');
  assert.strictEqual(domTarget.styles.size, 0, 'constructor must not set DOM styles');
  assert.strictEqual(mockWin.getListenerCount(), 0, 'constructor must not register system listeners');

  ctrl.dispose();
});

test('same-instance StrictMode replay: start -> stop -> start reuses same controller instance with live events, preview, confirm, and reset', () => {
  const domTarget = createMockDomTarget();
  const mockWin = createMockWindow('dark');
  let saved: AppearancePreferences = { theme: 'system', customAccent: '#00e5ff' };
  let committedCandidate: AppearanceInput | null = null;
  let resetInvoked = false;

  const ctrl = new AppearanceLifecycleController({
    getSavedAppearance: () => saved,
    commitAppearance: (candidate) => {
      committedCandidate = candidate;
      saved = {
        theme: candidate.theme ?? 'dark',
        customAccent: candidate.customAccent,
      };
      return { success: true };
    },
    resetAppearance: () => {
      resetInvoked = true;
      saved = { theme: 'dark', customAccent: null };
      return { success: true };
    },
    rootElement: domTarget,
    targetWindow: mockWin.window as unknown as Window,
  });

  // Mount 1 (setup)
  ctrl.start();
  assert.strictEqual(mockWin.getListenerCount(), 1);
  assert.strictEqual(domTarget.attributes.get('data-theme'), 'dark');
  assert.strictEqual(domTarget.styles.get('--accent-primary'), '#00e5ff');

  // System scheme change works in mount 1
  mockWin.setColorScheme('light');
  assert.strictEqual(domTarget.attributes.get('data-theme'), 'light');

  // StrictMode cleanup 1 (teardown without terminal disposal)
  ctrl.stop();
  assert.strictEqual(mockWin.getListenerCount(), 0, 'stop must remove system listener');

  // StrictMode remount (setup 2 on EXACT SAME instance)
  ctrl.start();
  assert.strictEqual(mockWin.getListenerCount(), 1, 'start must reattach system listener on same instance');
  assert.strictEqual(domTarget.attributes.get('data-theme'), 'light');

  // Preview works after remount
  ctrl.begin();
  ctrl.update({ theme: 'DjRomoro', customAccent: '#ff0077' });
  assert.strictEqual(domTarget.attributes.get('data-theme'), 'DjRomoro');
  assert.strictEqual(domTarget.styles.get('--accent-primary'), '#ff0077');

  // Confirm works after remount
  const confirmRes = ctrl.confirm();
  assert.strictEqual(confirmRes.success, true);
  assert.strictEqual((committedCandidate as AppearanceInput | null)?.theme, 'DjRomoro');
  assert.strictEqual((committedCandidate as AppearanceInput | null)?.customAccent, '#ff0077');
  assert.strictEqual(domTarget.attributes.get('data-theme'), 'DjRomoro');

  // Reset works after remount
  const resetRes = ctrl.resetAppearance();
  assert.strictEqual(resetRes.success, true);
  assert.strictEqual(resetInvoked, true);
  assert.strictEqual(domTarget.attributes.get('data-theme'), 'dark');
  assert.strictEqual(domTarget.styles.has('--accent-primary'), false);

  // Final unmount
  ctrl.stop();
  assert.strictEqual(mockWin.getListenerCount(), 0);
  ctrl.dispose();
});

test('options churn regression: passing new options on re-render does not recreate controller, lose active draft, or leak stale options', () => {
  const domTarget = createMockDomTarget();
  let commitCount = 0;
  let commitVersion = 1;

  // Simulate useAppearanceDraft optionsRef adapter
  let latestOptions = {
    getSavedAppearance: () => ({ theme: 'dark' as const }),
    commitAppearance: (_candidate: AppearanceInput) => {
      commitCount += commitVersion;
      return { success: true };
    },
    rootElement: domTarget,
  };

  const optionsRef = { current: latestOptions };

  const ownedController = new AppearanceLifecycleController({
    getSavedAppearance: () => optionsRef.current.getSavedAppearance(),
    commitAppearance: (c) => optionsRef.current.commitAppearance(c),
    rootElement: optionsRef.current.rootElement,
  });

  // Mount effect starts owned controller
  ownedController.start();

  // User begins drafting and updates theme
  ownedController.begin();
  ownedController.update({ theme: 'DjRomoro', customAccent: '#123456' });
  assert.strictEqual(ownedController.getState().isDrafting, true);
  assert.strictEqual(domTarget.attributes.get('data-theme'), 'DjRomoro');

  // Parent re-renders 5 times with fresh inline options objects and new callback references
  for (let i = 2; i <= 6; i++) {
    commitVersion = i;
    latestOptions = {
      getSavedAppearance: () => ({ theme: 'dark' as const }),
      commitAppearance: (_candidate: AppearanceInput) => {
        commitCount += commitVersion;
        return { success: true };
      },
      rootElement: domTarget,
    };
    optionsRef.current = latestOptions;
  }

  // Active draft was NOT reset by options churn
  assert.strictEqual(ownedController.getState().isDrafting, true);
  assert.strictEqual(ownedController.getState().draft?.theme, 'DjRomoro');
  assert.strictEqual(domTarget.attributes.get('data-theme'), 'DjRomoro');

  // Confirm invokes the LATEST commit handler without stale closures
  ownedController.confirm();
  assert.strictEqual(commitCount, 6, 'invoked latest version 6 callback');

  ownedController.stop();
  ownedController.dispose();
});

test('external controller ownership: unmounting consumer cancels draft but preserves owner system watcher', () => {
  const domTarget = createMockDomTarget();
  const mockWin = createMockWindow('dark');
  const parentSaved: AppearancePreferences = { theme: 'system' };

  // Parent controller owned by usePreferences
  const parentController = new AppearanceLifecycleController({
    getSavedAppearance: () => parentSaved,
    rootElement: domTarget,
    targetWindow: mockWin.window as unknown as Window,
  });
  parentController.start();

  assert.strictEqual(mockWin.getListenerCount(), 1);

  // Consumer (e.g. useAppearanceDraft with external controller) begins draft
  parentController.begin();
  parentController.update({ theme: 'light' });
  assert.strictEqual(parentController.getState().isDrafting, true);
  assert.strictEqual(domTarget.attributes.get('data-theme'), 'light');

  // Consumer unmounts: cancels draft to restore saved appearance
  parentController.cancel();

  // Assert draft cancelled and saved appearance restored
  assert.strictEqual(parentController.getState().isDrafting, false);
  assert.strictEqual(domTarget.attributes.get('data-theme'), 'dark');

  // CRITICAL: Parent controller remains active with system watcher alive
  assert.strictEqual(parentController.isControllerActive, true);
  assert.strictEqual(mockWin.getListenerCount(), 1, 'external controller watcher must NOT be torn down on consumer unmount');

  // System theme changes still work on parent controller
  mockWin.setColorScheme('light');
  assert.strictEqual(domTarget.attributes.get('data-theme'), 'light');

  // Parent finally stops on parent unmount
  parentController.stop();
  assert.strictEqual(mockWin.getListenerCount(), 0);
  parentController.dispose();
});
