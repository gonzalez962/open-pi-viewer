import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTerminalTouchScroll } from '@features/terminal/terminal-touch';
import type { Terminal as XTermInstance } from '@xterm/xterm';

// Lightweight mock for screen element with event listener tracking
function createMockScreenElement() {
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const dispatchedEvents: any[] = [];

  return {
    clientHeight: 400,
    clientWidth: 300,
    addEventListener(type: string, listener: (e: any) => void) {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(listener);
    },
    removeEventListener(type: string, listener: (e: any) => void) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter((l) => l !== listener);
    },
    dispatchEvent(event: any) {
      dispatchedEvents.push(event);
      return true;
    },
    getListenerCount(type: string) {
      return listeners[type]?.length || 0;
    },
    trigger(type: string, event: any) {
      listeners[type]?.forEach((l) => l(event));
    },
    dispatchedEvents,
  };
}

// Lightweight mock for xterm Terminal instance
function createMockTerminal(initialViewportY = 100, initialBaseY = 100) {
  const scrollCalls: number[] = [];
  let focusCalled = false;
  let scrollListeners: (() => void)[] = [];

  let viewportY = initialViewportY;
  let baseY = initialBaseY;

  return {
    rows: 25, // 400 / 25 = 16px rowHeight
    cols: 80,
    buffer: {
      active: {
        get viewportY() {
          return viewportY;
        },
        get baseY() {
          return baseY;
        },
      },
    },
    scrollLines(amount: number) {
      scrollCalls.push(amount);
      viewportY = Math.max(0, Math.min(baseY, viewportY + amount));
      scrollListeners.forEach((l) => l());
    },
    scrollToBottom() {
      viewportY = baseY;
      scrollListeners.forEach((l) => l());
    },
    onScroll(cb: () => void) {
      scrollListeners.push(cb);
      return {
        dispose: () => {
          scrollListeners = scrollListeners.filter((l) => l !== cb);
        },
      };
    },
    focus() {
      focusCalled = true;
    },
    scrollCalls,
    isFocusCalled: () => focusCalled,
    setViewportY: (val: number) => {
      viewportY = val;
      scrollListeners.forEach((l) => l());
    },
  } as unknown as XTermInstance & {
    scrollCalls: number[];
    isFocusCalled: () => boolean;
    setViewportY: (val: number) => void;
  };
}

test('Touch scroll: attaches and cleanly disposes event listeners', () => {
  const screenEl = createMockScreenElement();
  const term = createMockTerminal();

  const handle = setupTerminalTouchScroll(term, screenEl as any, { isMobile: true });

  assert.equal(screenEl.getListenerCount('touchstart'), 1);
  assert.equal(screenEl.getListenerCount('touchmove'), 1);
  assert.equal(screenEl.getListenerCount('touchend'), 1);
  assert.equal(screenEl.getListenerCount('touchcancel'), 1);

  handle.dispose();

  assert.equal(screenEl.getListenerCount('touchstart'), 0);
  assert.equal(screenEl.getListenerCount('touchmove'), 0);
  assert.equal(screenEl.getListenerCount('touchend'), 0);
  assert.equal(screenEl.getListenerCount('touchcancel'), 0);
});

test('Touch scroll: swiping down (deltaY > 0) scrolls up into history (negative scrollLines)', () => {
  const screenEl = createMockScreenElement();
  const term = createMockTerminal(50, 100);

  const handle = setupTerminalTouchScroll(term, screenEl as any, { isMobile: true });

  // Touch start at Y=100
  screenEl.trigger('touchstart', {
    touches: [{ clientY: 100, clientX: 50 }],
  });

  // Drag down by 48px (3 lines of 16px) -> finger moves from 100 to 148
  let defaultPrevented = false;
  screenEl.trigger('touchmove', {
    touches: [{ clientY: 148, clientX: 50 }],
    cancelable: true,
    preventDefault: () => {
      defaultPrevented = true;
    },
  });

  assert.equal(defaultPrevented, true, 'must preventDefault during scroll gesture');
  assert.ok((term as any).scrollCalls.length > 0, 'must call scrollLines');
  const totalScrolled = (term as any).scrollCalls.reduce((a: number, b: number) => a + b, 0);
  assert.equal(totalScrolled, -3, 'dragging down 48px with 16px rows must scroll -3 lines (up in buffer)');

  handle.dispose();
});

test('Touch scroll: swiping up (deltaY < 0) scrolls down towards prompt (positive scrollLines)', () => {
  const screenEl = createMockScreenElement();
  const term = createMockTerminal(50, 100);

  const handle = setupTerminalTouchScroll(term, screenEl as any, { isMobile: true });

  // Touch start at Y=200
  screenEl.trigger('touchstart', {
    touches: [{ clientY: 200, clientX: 50 }],
  });

  // Drag up by 32px (2 lines of 16px) -> finger moves from 200 to 168
  let defaultPrevented = false;
  screenEl.trigger('touchmove', {
    touches: [{ clientY: 168, clientX: 50 }],
    cancelable: true,
    preventDefault: () => {
      defaultPrevented = true;
    },
  });

  assert.equal(defaultPrevented, true, 'must preventDefault during scroll gesture');
  const totalScrolled = (term as any).scrollCalls.reduce((a: number, b: number) => a + b, 0);
  assert.equal(totalScrolled, 2, 'dragging up 32px with 16px rows must scroll +2 lines (down in buffer)');

  handle.dispose();
});

test('Touch scroll: threshold ignores tiny movements (< 6px)', () => {
  const screenEl = createMockScreenElement();
  const term = createMockTerminal(50, 100);

  const handle = setupTerminalTouchScroll(term, screenEl as any, { isMobile: true });

  screenEl.trigger('touchstart', {
    touches: [{ clientY: 100, clientX: 50 }],
  });

  let defaultPrevented = false;
  screenEl.trigger('touchmove', {
    touches: [{ clientY: 103, clientX: 50 }],
    cancelable: true,
    preventDefault: () => {
      defaultPrevented = true;
    },
  });

  assert.equal(defaultPrevented, false, 'must NOT preventDefault below 6px deadband');
  assert.equal((term as any).scrollCalls.length, 0, 'must not trigger scroll below deadband');

  handle.dispose();
});

test('Touch scroll: horizontal swipe is ignored', () => {
  const screenEl = createMockScreenElement();
  const term = createMockTerminal(50, 100);

  const handle = setupTerminalTouchScroll(term, screenEl as any, { isMobile: true });

  screenEl.trigger('touchstart', {
    touches: [{ clientY: 100, clientX: 50 }],
  });

  let defaultPrevented = false;
  // Moves 20px horizontally and only 4px vertically
  screenEl.trigger('touchmove', {
    touches: [{ clientY: 104, clientX: 70 }],
    cancelable: true,
    preventDefault: () => {
      defaultPrevented = true;
    },
  });

  assert.equal(defaultPrevented, false, 'must NOT preventDefault for horizontal swipe');
  assert.equal((term as any).scrollCalls.length, 0, 'must not trigger scroll on horizontal swipe');

  handle.dispose();
});

test('Touch scroll: tap gesture triggers term.focus()', () => {
  const screenEl = createMockScreenElement();
  const term = createMockTerminal(100, 100);

  const handle = setupTerminalTouchScroll(term, screenEl as any, { isMobile: true });

  screenEl.trigger('touchstart', {
    touches: [{ clientY: 100, clientX: 50 }],
  });

  // Touchend with zero movement (tap)
  screenEl.trigger('touchend', {
    touches: [],
  });

  assert.equal((term as any).isFocusCalled(), true, 'tap gesture must focus terminal');

  handle.dispose();
});

test('Touch scroll: tracks viewport scroll state (isScrolledUp)', () => {
  const screenEl = createMockScreenElement();
  const term = createMockTerminal(100, 100);

  let reportedScrolledUp: boolean | null = null;
  const handle = setupTerminalTouchScroll(term, screenEl as any, {
    isMobile: true,
    onScrollStateChange: (scrolledUp) => {
      reportedScrolledUp = scrolledUp;
    },
  });

  assert.equal(handle.isScrolledUp(), false, 'initially at bottom (100 == 100)');

  // Scroll up into history
  (term as any).setViewportY(60);

  assert.equal(handle.isScrolledUp(), true, 'scrolled up when viewportY < baseY');
  assert.equal(reportedScrolledUp, true, 'onScrollStateChange must report true');

  // Scroll back to bottom
  (term as any).scrollToBottom();

  assert.equal(handle.isScrolledUp(), false, 'at bottom when viewportY == baseY');
  assert.equal(reportedScrolledUp, false, 'onScrollStateChange must report false');

  handle.dispose();
});
