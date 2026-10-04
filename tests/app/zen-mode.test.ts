import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isAltZShortcut,
  isEscapeShortcut,
  hasActiveModalOrOverlay,
  resolveZenKeyboardAction,
  determineZenFocusTarget,
  ZEN_MODE_CONTAINER_CLASS,
  ZEN_TOGGLE_BUTTON_CLASS,
  ZEN_FLOATING_EXIT_CLASS,
  type ZenKeyboardEvent,
} from '@app/zen-mode';

const makeKey = (overrides: Partial<ZenKeyboardEvent> = {}): ZenKeyboardEvent => ({
  key: 'z',
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  repeat: false,
  ...overrides,
});

test('zen-mode: isAltZShortcut detects Alt+Z combinations cleanly', () => {
  assert.equal(isAltZShortcut(makeKey({ key: 'z', altKey: true })), true);
  assert.equal(isAltZShortcut(makeKey({ key: 'Z', altKey: true })), true);
  // macOS Option+Z fallback (where key might be symbol 'Ω' but code is 'KeyZ')
  assert.equal(isAltZShortcut(makeKey({ key: 'Ω', code: 'KeyZ', altKey: true })), true);
});

test('zen-mode: isAltZShortcut avoids repeat keys, modifier collisions and wrong keys', () => {
  assert.equal(isAltZShortcut(makeKey({ key: 'z', altKey: true, repeat: true })), false);
  assert.equal(isAltZShortcut(makeKey({ key: 'z', altKey: true, ctrlKey: true })), false);
  assert.equal(isAltZShortcut(makeKey({ key: 'z', altKey: true, metaKey: true })), false);
  assert.equal(isAltZShortcut(makeKey({ key: 'z', altKey: true, shiftKey: true })), false);
  assert.equal(isAltZShortcut(makeKey({ key: 'z', altKey: false })), false);
  assert.equal(isAltZShortcut(makeKey({ key: 'x', code: 'KeyX', altKey: true })), false);
});

test('zen-mode: isEscapeShortcut detects un-modified Escape and rejects repeat/modifiers', () => {
  assert.equal(isEscapeShortcut(makeKey({ key: 'Escape' })), true);
  assert.equal(isEscapeShortcut(makeKey({ key: 'Escape', repeat: true })), false);
  assert.equal(isEscapeShortcut(makeKey({ key: 'Escape', altKey: true })), false);
  assert.equal(isEscapeShortcut(makeKey({ key: 'Escape', ctrlKey: true })), false);
  assert.equal(isEscapeShortcut(makeKey({ key: 'Escape', metaKey: true })), false);
  assert.equal(isEscapeShortcut(makeKey({ key: 'Escape', shiftKey: true })), false);
  assert.equal(isEscapeShortcut(makeKey({ key: 'Enter' })), false);
});

test('zen-mode: hasActiveModalOrOverlay detects open modal overlays safely', () => {
  assert.equal(hasActiveModalOrOverlay(null), false);
  assert.equal(hasActiveModalOrOverlay(undefined), false);
  assert.equal(hasActiveModalOrOverlay({ querySelector: () => null }), false);

  const mockDocWith = (selectorSubstring: string) => ({
    querySelector: (sel: string) => (sel.includes(selectorSubstring) ? {} : null),
  });

  assert.equal(hasActiveModalOrOverlay(mockDocWith('.modal-overlay')), true);
  assert.equal(hasActiveModalOrOverlay(mockDocWith('.file-viewer-overlay')), true);
  assert.equal(hasActiveModalOrOverlay(mockDocWith('.prompt-popover')), true);
  assert.equal(hasActiveModalOrOverlay(mockDocWith('[aria-modal="true"]')), true);
});

test('zen-mode: resolveZenKeyboardAction toggles on Alt+Z and exits on Escape without breaking modals', () => {
  const altZ = makeKey({ key: 'z', altKey: true });
  const esc = makeKey({ key: 'Escape' });

  // Alt+Z toggles when NO modal is open
  assert.equal(resolveZenKeyboardAction(altZ, { isZenMode: false, hasOpenModal: false }), 'toggle');
  assert.equal(resolveZenKeyboardAction(altZ, { isZenMode: true, hasOpenModal: false }), 'toggle');

  // Alt+Z does NOT toggle when a modal/overlay is open (preserves child dialog workflow)
  assert.equal(resolveZenKeyboardAction(altZ, { isZenMode: false, hasOpenModal: true }), null);
  assert.equal(resolveZenKeyboardAction(altZ, { isZenMode: true, hasOpenModal: true }), null);

  // Alt+Z does nothing if repeat or defaultPrevented
  assert.equal(resolveZenKeyboardAction({ ...altZ, repeat: true }, { isZenMode: false }), null);
  assert.equal(resolveZenKeyboardAction({ ...altZ, defaultPrevented: true }, { isZenMode: false }), null);

  // Escape exits when in Zen mode and NO modal is open
  assert.equal(resolveZenKeyboardAction(esc, { isZenMode: true, hasOpenModal: false }), 'exit');

  // Escape does NOT exit when Zen mode is inactive
  assert.equal(resolveZenKeyboardAction(esc, { isZenMode: false, hasOpenModal: false }), null);

  // Escape does NOT exit when a modal is open (protects modal Escape handling!)
  assert.equal(resolveZenKeyboardAction(esc, { isZenMode: true, hasOpenModal: true }), null);

  // Escape does NOT exit if default was already prevented or repeat
  assert.equal(resolveZenKeyboardAction({ ...esc, defaultPrevented: true }, { isZenMode: true }), null);
  assert.equal(resolveZenKeyboardAction({ ...esc, repeat: true }, { isZenMode: true }), null);

  // Other keys do nothing
  assert.equal(resolveZenKeyboardAction(makeKey({ key: 'Enter' }), { isZenMode: true }), null);
});

test('zen-mode: class name constants are stable', () => {
  assert.equal(ZEN_MODE_CONTAINER_CLASS, 'is-zen-mode');
  assert.equal(ZEN_TOGGLE_BUTTON_CLASS, 'btn-zen-toggle');
  assert.equal(ZEN_FLOATING_EXIT_CLASS, 'btn-zen-floating-exit');
});

test('zen-mode: localization keys resolve accurately in both English and Spanish', async () => {
  const { translate } = await import('@shared/i18n');

  assert.equal(translate('en', 'zen.toggle_button'), 'Zen');
  assert.equal(translate('es', 'zen.toggle_button'), 'Zen');

  assert.match(translate('en', 'zen.enter_title'), /Alt\+Z/);
  assert.match(translate('es', 'zen.enter_title'), /Alt\+Z/);

  assert.match(translate('en', 'zen.exit_title'), /Esc/);
  assert.match(translate('es', 'zen.exit_title'), /Esc/);

  assert.equal(translate('en', 'zen.exit_button'), 'Exit Zen');
  assert.equal(translate('es', 'zen.exit_button'), 'Salir de Zen');
});

test('zen-mode: determineZenFocusTarget transfers focus sensibly and avoids stealing focus', () => {
  // Initial mount (prevZenMode undefined): does nothing
  assert.equal(
    determineZenFocusTarget({ isZenMode: false, prevZenMode: undefined }),
    null
  );
  assert.equal(
    determineZenFocusTarget({ isZenMode: true, prevZenMode: undefined }),
    null
  );

  // No state change: does nothing
  assert.equal(
    determineZenFocusTarget({ isZenMode: true, prevZenMode: true }),
    null
  );
  assert.equal(
    determineZenFocusTarget({ isZenMode: false, prevZenMode: false }),
    null
  );

  // Across open modal: does nothing (protects modal focus)
  assert.equal(
    determineZenFocusTarget({ isZenMode: true, prevZenMode: false, hasOpenModal: true }),
    null
  );
  assert.equal(
    determineZenFocusTarget({ isZenMode: false, prevZenMode: true, hasOpenModal: true }),
    null
  );

  // Entering Zen mode: transfers to floating-exit
  assert.equal(
    determineZenFocusTarget({ isZenMode: true, prevZenMode: false, hasOpenModal: false }),
    'floating-exit'
  );

  // Exiting Zen mode: transfers to header-toggle
  assert.equal(
    determineZenFocusTarget({ isZenMode: false, prevZenMode: true, hasOpenModal: false }),
    'header-toggle'
  );

  // Entering/exiting while active element is input or textarea: does not steal focus
  assert.equal(
    determineZenFocusTarget({
      isZenMode: true,
      prevZenMode: false,
      hasOpenModal: false,
      activeElementIsInputOrTextarea: true,
    }),
    null
  );
  assert.equal(
    determineZenFocusTarget({
      isZenMode: false,
      prevZenMode: true,
      hasOpenModal: false,
      activeElementIsInputOrTextarea: true,
    }),
    null
  );
});

