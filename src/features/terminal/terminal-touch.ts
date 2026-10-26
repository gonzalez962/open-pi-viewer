import type { Terminal as XTermInstance } from '@xterm/xterm';

export interface TerminalTouchScrollOptions {
  isMobile?: boolean;
  onScrollStateChange?: (isScrolledUp: boolean) => void;
}

export interface TerminalTouchScrollHandle {
  dispose: () => void;
  isScrolledUp: () => boolean;
}

/**
 * Attaches touch gesture listeners to enable vertical scrollback navigation
 * on mobile and touch devices for xterm.js.
 *
 * Implements:
 * - Single-finger vertical swipe to buffer scroll navigation
 * - Natural scroll direction (swiping down scrolls up into scrollback history)
 * - Inertial momentum decay on flick
 * - Safe fallback for mouse tracking modes (e.g., less, vim, htop)
 * - Tap to focus terminal input
 * - Viewport scroll state monitoring (isScrolledUp)
 */
export function setupTerminalTouchScroll(
  term: XTermInstance,
  screenEl: HTMLElement,
  options?: TerminalTouchScrollOptions
): TerminalTouchScrollHandle {
  let touchStartY = 0;
  let touchStartX = 0;
  let touchLastY = 0;
  let touchLastTime = 0;
  let isScrolling = false;
  let accumulatedDeltaY = 0;
  let touchVelocity = 0;
  let momentumRafId: number | null = null;
  let isDisposed = false;

  const cancelMomentum = () => {
    if (momentumRafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(momentumRafId);
      momentumRafId = null;
    }
  };

  const getRowHeight = (): number => {
    if (term.rows > 0 && screenEl.clientHeight > 0) {
      return screenEl.clientHeight / term.rows;
    }
    return options?.isMobile ? 14 : 16;
  };

  const checkScrollState = (): boolean => {
    try {
      const buffer = term.buffer?.active;
      if (buffer && typeof buffer.viewportY === 'number' && typeof buffer.baseY === 'number') {
        const scrolledUp = buffer.viewportY < buffer.baseY;
        options?.onScrollStateChange?.(scrolledUp);
        return scrolledUp;
      }
    } catch {
      // Safe catch for detached or disposing terminals
    }
    return false;
  };

  const scrollByDeltaPixels = (deltaPixels: number) => {
    if (isDisposed) return;
    accumulatedDeltaY += deltaPixels;
    const rowHeight = getRowHeight();
    const lines = Math.trunc(accumulatedDeltaY / rowHeight);
    if (lines !== 0) {
      try {
        const isMouseActive = Boolean(
          (term as any)._core?.coreMouseService?.areMouseEventsActive?.()
        );
        if (isMouseActive && typeof WheelEvent !== 'undefined') {
          screenEl.dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              deltaY: lines * rowHeight,
            })
          );
        } else if (typeof term.scrollLines === 'function') {
          term.scrollLines(lines);
        }
      } catch {
        if (typeof term.scrollLines === 'function') {
          term.scrollLines(lines);
        }
      }
      accumulatedDeltaY -= lines * rowHeight;
      checkScrollState();
    }
  };

  const handleTouchStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) return;
    cancelMomentum();
    const touch = e.touches[0];
    touchStartY = touch.clientY;
    touchStartX = touch.clientX;
    touchLastY = touch.clientY;
    touchLastTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    isScrolling = false;
    accumulatedDeltaY = 0;
    touchVelocity = 0;
  };

  const handleTouchMove = (e: TouchEvent) => {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    const deltaY = touch.clientY - touchLastY;
    const totalDeltaY = touch.clientY - touchStartY;
    const totalDeltaX = touch.clientX - touchStartX;

    if (!isScrolling) {
      // Require at least 6px vertical movement and predominantly vertical gesture
      if (Math.abs(totalDeltaY) > 6 && Math.abs(totalDeltaY) >= Math.abs(totalDeltaX)) {
        isScrolling = true;
      }
    }

    if (isScrolling) {
      if (e.cancelable) {
        e.preventDefault();
      }
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const dt = now - touchLastTime;
      if (dt > 0) {
        const instantVelocity = deltaY / dt;
        touchVelocity = 0.6 * touchVelocity + 0.4 * instantVelocity;
        touchLastTime = now;
      }

      // Swiping finger down (deltaY > 0) scrolls up into history (-lines)
      // Swiping finger up (deltaY < 0) scrolls down towards prompt (+lines)
      scrollByDeltaPixels(-deltaY);
      touchLastY = touch.clientY;
    }
  };

  const handleTouchEnd = (e: TouchEvent) => {
    if (isScrolling) {
      if (Math.abs(touchVelocity) > 0.15 && typeof requestAnimationFrame === 'function') {
        let currentVelocity = touchVelocity;
        let lastFrameTime = typeof performance !== 'undefined' ? performance.now() : Date.now();

        const momentumStep = () => {
          if (isDisposed) return;
          const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
          const dt = Math.min(now - lastFrameTime, 32);
          lastFrameTime = now;

          const stepDelta = currentVelocity * dt;
          currentVelocity *= 0.90; // friction decay

          scrollByDeltaPixels(-stepDelta);

          if (Math.abs(currentVelocity) > 0.03) {
            momentumRafId = requestAnimationFrame(momentumStep);
          } else {
            momentumRafId = null;
          }
        };

        momentumRafId = requestAnimationFrame(momentumStep);
      }
    } else {
      // Tap gesture: focus terminal input helper
      if (e.touches.length === 0 && typeof term.focus === 'function') {
        term.focus();
      }
    }
    isScrolling = false;
  };

  const handleTouchCancel = () => {
    cancelMomentum();
    isScrolling = false;
  };

  screenEl.addEventListener('touchstart', handleTouchStart, { passive: true });
  screenEl.addEventListener('touchmove', handleTouchMove, { passive: false });
  screenEl.addEventListener('touchend', handleTouchEnd, { passive: true });
  screenEl.addEventListener('touchcancel', handleTouchCancel, { passive: true });

  let scrollDisposable: { dispose: () => void } | null = null;
  if (typeof term.onScroll === 'function') {
    scrollDisposable = term.onScroll(() => {
      checkScrollState();
    });
  }

  // Initial scroll state evaluation
  checkScrollState();

  return {
    dispose: () => {
      isDisposed = true;
      cancelMomentum();
      screenEl.removeEventListener('touchstart', handleTouchStart);
      screenEl.removeEventListener('touchmove', handleTouchMove);
      screenEl.removeEventListener('touchend', handleTouchEnd);
      screenEl.removeEventListener('touchcancel', handleTouchCancel);
      scrollDisposable?.dispose();
    },
    isScrolledUp: () => checkScrollState(),
  };
}
