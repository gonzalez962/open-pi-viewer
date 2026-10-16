/**
 * Mobile Navigation - State, keyboard, and accessibility helpers (MOBILE-1)
 */

export const MOBILE_BREAKPOINT = 768;
export const DRAWER_ID = 'mobile-navigation-drawer';
export const BACKDROP_ID = 'mobile-navigation-backdrop';
export const MOBILE_MENU_TOGGLE_CLASS = 'btn-mobile-menu-toggle';
export const MOBILE_DRAWER_CLOSE_CLASS = 'btn-mobile-nav-close';

/**
 * Resolves the mobile brand title: returns active project name when available,
 * or falls back to the default app title (e.g. 'Pi Viewer').
 */
export function resolveMobileBrandTitle(
  activeProjectName?: string | null,
  fallbackTitle: string = 'Pi Viewer'
): string {
  const trimmed = activeProjectName?.trim();
  return trimmed ? trimmed : fallbackTitle;
}

export const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export interface MobileNavKeyboardEvent {
  key: string;
  repeat?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  defaultPrevented?: boolean;
}

export interface DrawerAccessibilityProps {
  role?: 'dialog';
  'aria-modal'?: 'true';
  'aria-hidden'?: 'true';
  inert?: '';
}

export type NavTransitionAction =
  | 'open-drawer'
  | 'restore-focus-trigger'
  | 'restore-focus-previous'
  | 'no-op';

/**
 * Detects if a viewport width is within the mobile threshold (<=768px).
 */
export function isMobileViewport(width: number): boolean {
  return width <= MOBILE_BREAKPOINT;
}

/**
 * Checks if the current browser window is within the mobile viewport.
 * Defaults to false in non-browser environments.
 */
export function checkIsMobileViewport(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches;
  }
  return isMobileViewport(window.innerWidth);
}

/**
 * Detects an un-modified Escape key press.
 */
export function isEscapeKey(event: MobileNavKeyboardEvent): boolean {
  if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return false;
  }
  return event.key === 'Escape';
}

/**
 * Resolves keyboard action for the mobile navigation drawer.
 * Only unmodified Escape while drawer is open triggers a close action.
 */
export function resolveMobileNavKeyboardAction(
  event: MobileNavKeyboardEvent,
  isOpen: boolean
): 'close' | null {
  if (!isOpen || event.repeat || event.defaultPrevented) {
    return null;
  }
  if (isEscapeKey(event)) {
    return 'close';
  }
  return null;
}

/**
 * Pure transition helper for mobile navigation state.
 */
export function decideMobileNavState(
  current: boolean,
  action: 'open' | 'close' | 'toggle'
): boolean {
  switch (action) {
    case 'open':
      return true;
    case 'close':
      return false;
    case 'toggle':
      return !current;
  }
}

/**
 * Determines if selecting an item (project or session) should dismiss the drawer.
 */
export function shouldCloseMobileNavOnSelection(isMobileNavOpen: boolean): boolean {
  return isMobileNavOpen;
}

/**
 * Deprecated alias kept for backwards compatibility.
 * Returns aria and inert attributes for closed mobile drawer.
 */
export function getDrawerAriaAttributes(isOpen: boolean): {
  'aria-hidden'?: 'true';
  inert?: '';
} {
  if (isOpen) {
    return {};
  }
  return {
    'aria-hidden': 'true',
    inert: '',
  };
}

/**
 * Enforces viewport-aware accessibility rules:
 * - Desktop (> 768px): NEVER inert, NEVER aria-hidden, NEVER dialog modal.
 * - Mobile Open: role="dialog", aria-modal="true", not inert, not aria-hidden.
 * - Mobile Closed: role="dialog", aria-hidden="true", inert="".
 */
export function getDrawerAccessibilityProps(
  isMobile: boolean,
  isOpen: boolean
): DrawerAccessibilityProps {
  if (!isMobile) {
    return {};
  }
  if (isOpen) {
    return {
      role: 'dialog',
      'aria-modal': 'true',
    };
  }
  return {
    role: 'dialog',
    'aria-hidden': 'true',
    inert: '',
  };
}

/**
 * Checks whether an element is visible in the DOM and layout.
 * Filters out hidden, disabled, display:none, visibility:hidden, and .is-hidden descendants.
 */
export function isElementVisible(el: HTMLElement | null): boolean {
  if (!el) {
    return false;
  }
  if (el.hidden) {
    return false;
  }
  if (typeof el.getAttribute === 'function' && el.getAttribute('aria-hidden') === 'true') {
    return false;
  }
  if (typeof el.hasAttribute === 'function' && el.hasAttribute('disabled')) {
    return false;
  }

  // Check inline style object if present
  if (el.style) {
    if (el.style.display === 'none' || el.style.visibility === 'hidden') {
      return false;
    }
  }

  // Check computed styles if window is available
  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    try {
      const style = window.getComputedStyle(el);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse'
      ) {
        return false;
      }
    } catch {
      // ignore
    }
  }

  // Check closest ancestor that may hide this element
  if (typeof el.closest === 'function') {
    try {
      if (el.closest('.is-hidden, [hidden], [aria-hidden="true"]')) {
        return false;
      }
    } catch {
      // ignore
    }
  }

  // Check layout dimensions if available in browser
  if (typeof el.offsetParent !== 'undefined' && el.offsetParent === null) {
    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
      try {
        const style = window.getComputedStyle(el);
        if (style.position !== 'fixed') {
          return false;
        }
      } catch {
        // ignore
      }
    }
  }

  return true;
}

/**
 * Finds all currently focusable and visible elements within a container element.
 * Filters out CSS-hidden descendants from focus candidates.
 */
export function getFocusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container || typeof container.querySelectorAll !== 'function') {
    return [];
  }
  const elements = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  return elements.filter((el) => isElementVisible(el));
}

/**
 * Pure transition decider for accessible focus management:
 * - On first mount, never perform drawer open focus movement or restore focus.
 * - On transition to open mobile, moves focus into drawer.
 * - On transition from open mobile to closed, restores focus to visible trigger or visible previous element.
 * - On resize to desktop (or when trigger is CSS hidden), ignores hidden trigger to avoid stealing focus.
 */
export function decideFocusTransition(options: {
  isFirstMount: boolean;
  prevIsOpen: boolean;
  isOpen: boolean;
  isMobile: boolean;
  prevIsMobile?: boolean;
  isTriggerVisible: boolean;
  isPrevElementVisible?: boolean;
  shouldRestoreFocus?: boolean;
}): NavTransitionAction {
  // On first mount, never perform open focus movement or restore focus
  if (options.isFirstMount) {
    return 'no-op';
  }

  // Transition from closed to open mobile:
  if (!options.prevIsOpen && options.isOpen && options.isMobile) {
    return 'open-drawer';
  }

  // Transition from open mobile to closed or desktop:
  if (options.prevIsOpen && (!options.isOpen || !options.isMobile)) {
    if (options.shouldRestoreFocus === false) {
      return 'no-op';
    }
    if (options.isTriggerVisible) {
      return 'restore-focus-trigger';
    }
    if (options.isPrevElementVisible) {
      return 'restore-focus-previous';
    }
    return 'no-op';
  }

  return 'no-op';
}

/**
 * Traps Tab focus within the drawer container while open.
 */
export function trapFocusInContainer(
  event: KeyboardEvent,
  container: HTMLElement | null
): void {
  if (event.key !== 'Tab' || !container) {
    return;
  }

  const focusable = getFocusableElements(container);
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }

  const firstElement = focusable[0];
  const lastElement = focusable[focusable.length - 1];
  const activeElement = document.activeElement;

  if (event.shiftKey) {
    if (activeElement === firstElement || !container.contains(activeElement)) {
      event.preventDefault();
      lastElement.focus();
    }
  } else {
    if (activeElement === lastElement || !container.contains(activeElement)) {
      event.preventDefault();
      firstElement.focus();
    }
  }
}
