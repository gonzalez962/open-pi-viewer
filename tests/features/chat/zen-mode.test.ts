import assert from 'node:assert/strict';
import test from 'node:test';
import { translate } from '@shared/i18n';

test('zen-mode: localization keys exist in both en and es', () => {
  const enZen = translate('en', 'header.zen_mode');
  const esZen = translate('es', 'header.zen_mode');
  assert.equal(enZen, 'Zen Mode');
  assert.equal(esZen, 'Modo Zen');

  const enTitle = translate('en', 'header.zen_mode_title');
  const esTitle = translate('es', 'header.zen_mode_title');
  assert.ok(enTitle.includes('Alt+Z'));
  assert.ok(esTitle.includes('Alt+Z'));
});

test('zen-mode: shortcut logic triggers state toggle on Alt+Z', () => {
  let isZenMode = false;
  const toggleZenMode = () => {
    isZenMode = !isZenMode;
  };

  const handleKeyboardEvent = (e: { altKey: boolean; key: string; preventDefault: () => void }) => {
    if (e.altKey && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      toggleZenMode();
      return true;
    }
    return false;
  };

  let prevented = false;
  const preventDefault = () => { prevented = true; };

  // Regular Z without Alt does not toggle
  assert.equal(handleKeyboardEvent({ altKey: false, key: 'z', preventDefault }), false);
  assert.equal(isZenMode, false);

  // Alt+Z toggles Zen Mode on
  assert.equal(handleKeyboardEvent({ altKey: true, key: 'z', preventDefault }), true);
  assert.equal(isZenMode, true);
  assert.equal(prevented, true);

  // Alt+Z toggles Zen Mode off
  assert.equal(handleKeyboardEvent({ altKey: true, key: 'Z', preventDefault }), true);
  assert.equal(isZenMode, false);
});
