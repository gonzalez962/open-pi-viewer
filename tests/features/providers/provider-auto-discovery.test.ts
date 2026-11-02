import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { useProviderModalForm } from '@features/providers/hooks/useProviderModalForm';

// Exercise the real hook with a small dispatcher: this repository has no DOM or React test renderer.
function mountHook(saveProvider: (data: any) => Promise<boolean> = async () => true) {
  const internals = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
  const previous = internals.ReactCurrentDispatcher.current;
  const slots: any[] = [];
  let cursor = 0;
  let pending: (() => void)[] = [];
  let result: ReturnType<typeof useProviderModalForm>;
  const dispatcher = {
    useState(initial: any) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], (value: any) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }];
    },
    useRef(initial: any) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useMemo(fn: () => any) { cursor++; return fn(); },
    useEffect(fn: () => any, deps: any[]) {
      const i = cursor++;
      const old = slots[i];
      if (!old || deps.some((v, n) => !Object.is(v, old.deps[n]))) {
        pending.push(() => { old?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; });
      }
    },
  };
  const t = (key: any) => key;
  function render() {
    cursor = 0; pending = []; internals.ReactCurrentDispatcher.current = dispatcher;
    try { result = useProviderModalForm({ t, modelThinkingLevels: {}, updateModelThinkingLevelsMap() {}, saveProvider }); }
    finally { internals.ReactCurrentDispatcher.current = previous; }
    for (const effect of pending) effect();
    return result!;
  }
  return { render, cleanup() { for (const s of slots) s?.cleanup?.(); internals.ReactCurrentDispatcher.current = previous; } };
}

for (const outcome of ['success', 'rejection'] as const) {
  test(`S3 auto discovery preserves key for save after ${outcome}`, async () => {
    const previousWindow = (globalThis as any).window;
    let calls = 0;
    (globalThis as any).window = { __IS_WEB_IPC__: true, __TAURI_INTERNALS__: { invoke: async (cmd: string, args: any) => {
      assert.equal(cmd, 'discover_provider_models');
      assert.equal(args.apiKey, 'transient-key');
      calls++;
      if (outcome === 'rejection') throw new Error('offline');
      return [{ id: 'model-one' }];
    } } };
    let savedKey: string | undefined;
    const hook = mountHook(async data => { savedKey = data.apiKey; return true; });
    try {
      let state = hook.render(); state.openAddModal(); state = hook.render();
      state.setFormData({ ...state.formData, id: 'p', baseUrl: 'https://example.test/v1', api: 'openai', apiKey: 'transient-key' });
      hook.render();
      await new Promise(resolve => setTimeout(resolve, 800));
      state = hook.render();
      assert.equal(calls, 1);
      assert.equal(state.formData.apiKey, 'transient-key');
      assert.equal(state.isAutoDiscovering, false);
      if (outcome === 'success') assert.equal(state.formData.models[0]?.id, 'model-one');
      await state.handleSaveProvider({ preventDefault() {} } as React.FormEvent);
      assert.equal(savedKey, 'transient-key');
      assert.equal(hook.render().formData.apiKey, '');
    } finally { hook.cleanup(); (globalThis as any).window = previousWindow; }
  });
}
