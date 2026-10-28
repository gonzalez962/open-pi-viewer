import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { SpeechSettingsSection } from '@features/settings/components/SpeechSettingsSection';
import { DEFAULT_SPEECH_PREFERENCES } from '@core/types/speech';

// Exercise the actual component's event handlers without a browser DOM.
function harness(save: (patch: any) => any) {
  const state: any[] = [];
  let cursor = 0;
  let tree: any;
  const toasts: string[] = [];
  const internals = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
  const dispatcher = {
    useState(initial: any) { const i = cursor++; if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial;
      return [state[i], (value: any) => { state[i] = typeof value === 'function' ? value(state[i]) : value; }]; },
    useRef(initial: any) { const i = cursor++; if (!(i in state)) state[i] = { current: initial }; return state[i]; },
    useContext() {
      return {
        success: (msg: string) => { toasts.push(msg); return 'toast-id'; },
        error: () => '',
        warning: () => '',
        info: () => '',
        clearAll: () => { toasts.length = 0; },
      };
    },
    useEffect() {}, useCallback(fn: any) { return fn; }, useMemo(fn: any) { return fn(); },
  };
  function render() {
    cursor = 0;
    const previous = internals.ReactCurrentDispatcher.current;
    internals.ReactCurrentDispatcher.current = dispatcher;
    try { tree = SpeechSettingsSection({ preferences: DEFAULT_SPEECH_PREFERENCES, onSpeechPreferencesChange: save }); }
    finally { internals.ReactCurrentDispatcher.current = previous; }
    return tree;
  }
  function nodes(): any[] {
    const found: any[] = [];
    function visit(node: any) { if (Array.isArray(node)) { node.forEach(visit); return; } if (!node || typeof node !== 'object') return; found.push(node); visit(node.props?.children); }
    visit(render()); return found;
  }
  function button(label: string) { const node = nodes().find((n) => n.type === 'button' && n.props.children === label); assert.ok(node, label); return node; }
  function statuses() { return [...toasts]; }
  return { nodes, button, statuses };
}

for (const [label, message] of [['Guardar conexión OpenAI', 'Conexión OpenAI guardada'], ['Guardar TTS', 'Ajustes TTS guardados'], ['Guardar STT', 'Ajustes STT guardados']] as const) {
  test(`${label}: success is announced only after save and cleared on edit`, async () => {
    let release!: (value: any) => void;
    const h = harness(() => new Promise((resolve) => { release = resolve; }));
    h.button(label).props.onClick();
    assert.deepEqual(h.statuses(), []);
    release({ success: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(h.statuses(), [message]);
    h.nodes().find((n) => n.props?.id === 'tts-master-switch').props.onChange({ target: { checked: true } });
    assert.deepEqual(h.statuses(), []);
  });
  test(`${label}: failure never announces success`, async () => {
    const h = harness(async () => ({ success: false, error: 'save failed' }));
    h.button(label).props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(h.statuses(), []);
    assert.ok(h.nodes().some((n) => n.props?.role === 'alert'));
  });
}
