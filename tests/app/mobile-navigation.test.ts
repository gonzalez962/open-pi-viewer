import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  MOBILE_BREAKPOINT,
  DRAWER_ID,
  isMobileViewport,
  isEscapeKey,
  resolveMobileNavKeyboardAction,
  decideMobileNavState,
  shouldCloseMobileNavOnSelection,
  getDrawerAriaAttributes,
  getDrawerAccessibilityProps,
  isElementVisible,
  getFocusableElements,
  decideFocusTransition,
  trapFocusInContainer,
  type MobileNavKeyboardEvent,
} from '@app/mobile-navigation';
import { MobileNavigation } from '@app/MobileNavigation';

test('mobile-navigation: MOBILE_BREAKPOINT is 768px', () => {
  assert.equal(MOBILE_BREAKPOINT, 768);
  assert.equal(DRAWER_ID, 'mobile-navigation-drawer');
});

test('mobile-navigation: isMobileViewport accurately detects mobile vs desktop viewports', () => {
  assert.equal(isMobileViewport(320), true);
  assert.equal(isMobileViewport(375), true);
  assert.equal(isMobileViewport(390), true);
  assert.equal(isMobileViewport(768), true);
  assert.equal(isMobileViewport(769), false);
  assert.equal(isMobileViewport(1024), false);
  assert.equal(isMobileViewport(1280), false);
});

test('mobile-navigation: isEscapeKey detects un-modified Escape key', () => {
  const pureEsc: MobileNavKeyboardEvent = { key: 'Escape' };
  assert.equal(isEscapeKey(pureEsc), true);

  assert.equal(isEscapeKey({ key: 'Escape', repeat: true }), false);
  assert.equal(isEscapeKey({ key: 'Escape', altKey: true }), false);
  assert.equal(isEscapeKey({ key: 'Escape', ctrlKey: true }), false);
  assert.equal(isEscapeKey({ key: 'Escape', metaKey: true }), false);
  assert.equal(isEscapeKey({ key: 'Escape', shiftKey: true }), false);
  assert.equal(isEscapeKey({ key: 'Enter' }), false);
  assert.equal(isEscapeKey({ key: 'Tab' }), false);
});

test('mobile-navigation: resolveMobileNavKeyboardAction resolves close only when drawer is open', () => {
  const pureEsc: MobileNavKeyboardEvent = { key: 'Escape' };

  // When open, Escape requests close
  assert.equal(resolveMobileNavKeyboardAction(pureEsc, true), 'close');

  // When closed, Escape does nothing
  assert.equal(resolveMobileNavKeyboardAction(pureEsc, false), null);

  // Other keys do nothing
  assert.equal(resolveMobileNavKeyboardAction({ key: 'Enter' }, true), null);

  // Modified Escape does nothing
  assert.equal(resolveMobileNavKeyboardAction({ key: 'Escape', altKey: true }, true), null);
});

test('mobile-navigation: decideMobileNavState handles open, close, and toggle transitions', () => {
  assert.equal(decideMobileNavState(false, 'open'), true);
  assert.equal(decideMobileNavState(true, 'open'), true);

  assert.equal(decideMobileNavState(true, 'close'), false);
  assert.equal(decideMobileNavState(false, 'close'), false);

  assert.equal(decideMobileNavState(false, 'toggle'), true);
  assert.equal(decideMobileNavState(true, 'toggle'), false);
});

test('mobile-navigation: shouldCloseMobileNavOnSelection closes when mobile nav is open', () => {
  assert.equal(shouldCloseMobileNavOnSelection(true), true);
  assert.equal(shouldCloseMobileNavOnSelection(false), false);
});

test('mobile-navigation: getDrawerAriaAttributes ensures hidden drawer is not keyboard reachable', () => {
  const openAttrs = getDrawerAriaAttributes(true);
  assert.equal(openAttrs['aria-hidden'], undefined);
  assert.equal(openAttrs.inert, undefined);

  const closedAttrs = getDrawerAriaAttributes(false);
  assert.equal(closedAttrs['aria-hidden'], 'true');
  assert.equal(closedAttrs.inert, '');
});

test('mobile-navigation: getDrawerAccessibilityProps enforces desktop vs mobile accessibility rules', () => {
  // Desktop must NEVER be inert, aria-hidden, or dialog modal
  const desktopClosed = getDrawerAccessibilityProps(false, false);
  assert.deepEqual(desktopClosed, {});
  assert.equal(desktopClosed.role, undefined);
  assert.equal(desktopClosed['aria-modal'], undefined);
  assert.equal(desktopClosed['aria-hidden'], undefined);
  assert.equal(desktopClosed.inert, undefined);

  const desktopOpen = getDrawerAccessibilityProps(false, true);
  assert.deepEqual(desktopOpen, {});
  assert.equal(desktopOpen.role, undefined);
  assert.equal(desktopOpen['aria-modal'], undefined);
  assert.equal(desktopOpen['aria-hidden'], undefined);
  assert.equal(desktopOpen.inert, undefined);

  // Closed mobile must be inert, aria-hidden, and dialog
  const mobileClosed = getDrawerAccessibilityProps(true, false);
  assert.deepEqual(mobileClosed, {
    role: 'dialog',
    'aria-hidden': 'true',
    inert: '',
  });

  // Open mobile must be dialog modal, NOT inert, NOT aria-hidden
  const mobileOpen = getDrawerAccessibilityProps(true, true);
  assert.deepEqual(mobileOpen, {
    role: 'dialog',
    'aria-modal': 'true',
  });
});

test('mobile-navigation: isElementVisible correctly detects visible vs hidden elements', () => {
  assert.equal(isElementVisible(null), false);

  const visibleBtn = {
    hidden: false,
    getAttribute: (attr: string) => (attr === 'aria-hidden' ? null : null),
    hasAttribute: (attr: string) => (attr === 'disabled' ? false : false),
    style: { display: 'block' },
  } as unknown as HTMLElement;
  assert.equal(isElementVisible(visibleBtn), true);

  const hiddenAttrBtn = {
    hidden: true,
    getAttribute: () => null,
  } as unknown as HTMLElement;
  assert.equal(isElementVisible(hiddenAttrBtn), false);

  const ariaHiddenBtn = {
    hidden: false,
    getAttribute: (attr: string) => (attr === 'aria-hidden' ? 'true' : null),
  } as unknown as HTMLElement;
  assert.equal(isElementVisible(ariaHiddenBtn), false);

  const cssDisplayNoneBtn = {
    hidden: false,
    getAttribute: () => null,
    style: { display: 'none' },
  } as unknown as HTMLElement;
  assert.equal(isElementVisible(cssDisplayNoneBtn), false);

  const insideHiddenAncestorBtn = {
    hidden: false,
    getAttribute: () => null,
    closest: (sel: string) => (sel.includes('.is-hidden') ? {} : null),
  } as unknown as HTMLElement;
  assert.equal(isElementVisible(insideHiddenAncestorBtn), false);
});

test('mobile-navigation: getFocusableElements filters CSS-hidden descendants from focus candidates', () => {
  const visibleBtn = {
    hidden: false,
    getAttribute: () => null,
    hasAttribute: () => false,
  } as unknown as HTMLElement;

  const hiddenBtn = {
    hidden: false,
    getAttribute: () => null,
    hasAttribute: () => false,
    style: { display: 'none' },
  } as unknown as HTMLElement;

  const container = {
    querySelectorAll: () => [visibleBtn, hiddenBtn],
  } as unknown as HTMLElement;

  const candidates = getFocusableElements(container);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0], visibleBtn);
});

test('mobile-navigation: decideFocusTransition ignores initial mount and handles resize to desktop', () => {
  // 1. Initial mount: never steals or moves focus regardless of state
  assert.equal(
    decideFocusTransition({
      isFirstMount: true,
      prevIsOpen: false,
      isOpen: false,
      isMobile: false,
      isTriggerVisible: false,
    }),
    'no-op'
  );
  assert.equal(
    decideFocusTransition({
      isFirstMount: true,
      prevIsOpen: false,
      isOpen: true,
      isMobile: true,
      isTriggerVisible: true,
    }),
    'no-op'
  );

  // 2. Open mobile transition: moves focus into drawer
  assert.equal(
    decideFocusTransition({
      isFirstMount: false,
      prevIsOpen: false,
      isOpen: true,
      isMobile: true,
      isTriggerVisible: true,
    }),
    'open-drawer'
  );

  // 3. Close mobile transition with visible trigger: restores focus to trigger
  assert.equal(
    decideFocusTransition({
      isFirstMount: false,
      prevIsOpen: true,
      isOpen: false,
      isMobile: true,
      isTriggerVisible: true,
    }),
    'restore-focus-trigger'
  );

  // 4. Resize to desktop (or close with hidden trigger): must NOT steal focus to hidden trigger!
  assert.equal(
    decideFocusTransition({
      isFirstMount: false,
      prevIsOpen: true,
      isOpen: false,
      isMobile: false,
      isTriggerVisible: false,
      isPrevElementVisible: false,
    }),
    'no-op'
  );
});

test('MobileNavigation: desktop mode NEVER renders dialog role, aria-modal, aria-hidden, inert or mobile header even if isOpen is true', () => {
  const html = renderToStaticMarkup(
    React.createElement(
      MobileNavigation,
      {
        isOpen: true,
        isMobile: false,
        onClose: () => {},
        locale: 'en',
      },
      React.createElement('div', { id: 'desktop-content' }, 'Dock & Sidebar')
    )
  );

  assert.ok(html.includes('id="mobile-navigation-drawer"'));
  assert.ok(!html.includes('role="dialog"'), 'Desktop must NEVER have role="dialog"');
  assert.ok(!html.includes('aria-modal'), 'Desktop must NEVER have aria-modal');
  assert.ok(!html.includes('aria-hidden'), 'Desktop must NEVER have aria-hidden');
  assert.ok(!html.includes('inert'), 'Desktop must NEVER have inert');
  assert.ok(!html.includes('mobile-nav-backdrop'), 'Desktop must NOT render mobile backdrop');
  assert.ok(!html.includes('mobile-nav-drawer-header'), 'Desktop must NOT render mobile drawer header');
  assert.ok(html.includes('id="desktop-content"'));
});

test('mobile-navigation: decideFocusTransition handles all transition permutations safely', () => {
  // Case A: Initial mount with open mobile -> no-op (no stealing on mount)
  assert.equal(
    decideFocusTransition({
      isFirstMount: true,
      prevIsOpen: false,
      isOpen: true,
      isMobile: true,
      isTriggerVisible: true,
    }),
    'no-op'
  );

  // Case B: In desktop mode, toggling open/close -> no-op (desktop is in-flow)
  assert.equal(
    decideFocusTransition({
      isFirstMount: false,
      prevIsOpen: false,
      isOpen: true,
      isMobile: false,
      isTriggerVisible: false,
    }),
    'no-op'
  );
  assert.equal(
    decideFocusTransition({
      isFirstMount: false,
      prevIsOpen: true,
      isOpen: false,
      isMobile: false,
      isTriggerVisible: false,
    }),
    'no-op'
  );

  // Case C: Open mobile to desktop transition when trigger is hidden -> no-op
  assert.equal(
    decideFocusTransition({
      isFirstMount: false,
      prevIsOpen: true,
      isOpen: false,
      isMobile: false,
      isTriggerVisible: false,
      isPrevElementVisible: false,
    }),
    'no-op'
  );

  // Case D: Open mobile to closed mobile with visible trigger -> restore-focus-trigger
  assert.equal(
    decideFocusTransition({
      isFirstMount: false,
      prevIsOpen: true,
      isOpen: false,
      isMobile: true,
      isTriggerVisible: true,
    }),
    'restore-focus-trigger'
  );

  // Case E: Open mobile to closed mobile with hidden trigger but visible previous element -> restore-focus-previous
  assert.equal(
    decideFocusTransition({
      isFirstMount: false,
      prevIsOpen: true,
      isOpen: false,
      isMobile: true,
      isTriggerVisible: false,
      isPrevElementVisible: true,
    }),
    'restore-focus-previous'
  );

  // Case F: Open mobile to closed mobile with shouldRestoreFocus=false -> no-op (prevents stealing modal focus)
  assert.equal(
    decideFocusTransition({
      isFirstMount: false,
      prevIsOpen: true,
      isOpen: false,
      isMobile: true,
      isTriggerVisible: true,
      shouldRestoreFocus: false,
    }),
    'no-op'
  );
});

test('MobileNavigation: closed mobile mode renders inert, aria-hidden, dialog but no aria-modal', () => {
  const html = renderToStaticMarkup(
    React.createElement(
      MobileNavigation,
      {
        isOpen: false,
        isMobile: true,
        onClose: () => {},
        locale: 'en',
      },
      React.createElement('div', { id: 'mobile-content' }, 'Dock & Sidebar')
    )
  );

  assert.ok(html.includes('id="mobile-navigation-drawer"'));
  assert.ok(html.includes('role="dialog"'));
  assert.ok(html.includes('aria-hidden="true"'));
  assert.ok(html.includes('inert'));
  assert.ok(!html.includes('aria-modal="true"'));
  assert.ok(html.includes('is-closed'));
});

test('MobileNavigation: open mobile mode renders dialog modal, active backdrop, and header with close control', () => {
  const html = renderToStaticMarkup(
    React.createElement(
      MobileNavigation,
      {
        isOpen: true,
        isMobile: true,
        onClose: () => {},
        locale: 'en',
      },
      React.createElement('div', { id: 'mobile-content' }, 'Dock & Sidebar')
    )
  );

  assert.ok(html.includes('id="mobile-navigation-drawer"'));
  assert.ok(html.includes('role="dialog"'));
  assert.ok(html.includes('aria-modal="true"'));
  assert.ok(!/<aside[^>]*aria-hidden/.test(html), 'Open drawer container must NOT be aria-hidden');
  assert.ok(!/<aside[^>]*inert/.test(html), 'Open drawer container must NOT be inert');
  assert.ok(html.includes('is-open'));
  assert.ok(html.includes('mobile-nav-backdrop'));
  assert.ok(html.includes('is-visible'));
  assert.ok(html.includes('mobile-nav-drawer-header'));
  assert.ok(html.includes('btn-mobile-nav-close'));
});

test('MobileNavigation: renders translated close button and header title in English and Spanish', () => {
  const htmlEn = renderToStaticMarkup(
    React.createElement(MobileNavigation, { isOpen: true, isMobile: true, onClose: () => {}, locale: 'en' }, null)
  );
  assert.ok(htmlEn.includes('Navigation') || htmlEn.includes('Close'));

  const htmlEs = renderToStaticMarkup(
    React.createElement(MobileNavigation, { isOpen: true, isMobile: true, onClose: () => {}, locale: 'es' }, null)
  );
  assert.ok(htmlEs.includes('Navegación') || htmlEs.includes('Cerrar'));
});

test('MobileNavigation: does not duplicate sidebars and renders single instance of children', () => {
  const html = renderToStaticMarkup(
    React.createElement(
      MobileNavigation,
      {
        isOpen: true,
        onClose: () => {},
        locale: 'en',
      },
      React.createElement('div', { className: 'project-dock-container' }, 'Project Dock'),
      React.createElement('div', { className: 'session-sidebar' }, 'Session Sidebar')
    )
  );

  const dockOccurrences = (html.match(/project-dock-container/g) || []).length;
  const sidebarOccurrences = (html.match(/session-sidebar/g) || []).length;

  assert.equal(dockOccurrences, 1, 'ProjectDock must appear exactly once (no duplicates)');
  assert.equal(sidebarOccurrences, 1, 'SessionSidebar must appear exactly once (no duplicates)');
});

test('mobile-navigation: trapFocusInContainer handles Tab wrapping around container bounds', () => {
  let focusedIndex = 0;
  const btn1 = {
    getAttribute: () => null,
    hasAttribute: () => false,
    focus: () => { focusedIndex = 1; },
  };
  const btn2 = {
    getAttribute: () => null,
    hasAttribute: () => false,
    focus: () => { focusedIndex = 2; },
  };

  const mockContainer = {
    querySelectorAll: () => [btn1, btn2],
    contains: (el: unknown) => el === btn1 || el === btn2,
  } as unknown as HTMLElement;

  // Forward tab from last element wraps to first
  let defaultPrevented = false;
  global.document = { activeElement: btn2 } as unknown as Document;
  const tabEvent = {
    key: 'Tab',
    shiftKey: false,
    preventDefault: () => { defaultPrevented = true; },
  } as unknown as KeyboardEvent;

  trapFocusInContainer(tabEvent, mockContainer);
  assert.equal(defaultPrevented, true);
  assert.equal(focusedIndex, 1);

  // Backward tab (Shift+Tab) from first element wraps to last
  defaultPrevented = false;
  global.document = { activeElement: btn1 } as unknown as Document;
  const shiftTabEvent = {
    key: 'Tab',
    shiftKey: true,
    preventDefault: () => { defaultPrevented = true; },
  } as unknown as KeyboardEvent;

  trapFocusInContainer(shiftTabEvent, mockContainer);
  assert.equal(defaultPrevented, true);
  assert.equal(focusedIndex, 2);
});

