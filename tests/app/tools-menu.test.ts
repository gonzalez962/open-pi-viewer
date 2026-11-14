import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { nextToolsMenuIndex } from '@app/components/ToolsMenu';

test('S13 action menu keyboard movement wraps and honors boundaries', () => {
  assert.equal(nextToolsMenuIndex('ArrowDown', 0, 2), 1);
  assert.equal(nextToolsMenuIndex('ArrowDown', 1, 2), 0);
  assert.equal(nextToolsMenuIndex('ArrowUp', 0, 2), 1);
  assert.equal(nextToolsMenuIndex('Home', 1, 2), 0);
  assert.equal(nextToolsMenuIndex('End', 0, 2), 1);
  assert.equal(nextToolsMenuIndex('Tab', 0, 2), null);
  assert.equal(nextToolsMenuIndex('ArrowDown', 0, 0), null);
});

// SSR verifies production markup only; keyboard, dismissal and focus need a mounted browser.
for (const web of [false, true]) {
  test(`S13 Tools exposes Zen and ${web ? 'web Docker' : 'no desktop Docker'} with action-menu semantics`, async () => {
    const { ToolsMenu } = await import('@app/components/ToolsMenu');
    const html = renderToStaticMarkup(React.createElement(ToolsMenu, {
      web, locale: 'en', isOpen: true, isZenMode: false,
      onToggleZen: () => {}, onSelectDocker: () => {},
    } as any));
    assert.match(html, /<button\b[^>]*aria-haspopup="menu"/);
    assert.match(html, /aria-expanded="true"/);
    assert.match(html, /role="menu"/);
    assert.match(html, /role="menuitem"[^>]*>[^<]*Zen/i);
    assert.equal(/role="menuitem"[^>]*>[^<]*Docker/i.test(html), web);
  });
}
