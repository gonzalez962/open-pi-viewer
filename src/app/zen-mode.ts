/**
 * Zen Focus Mode - Pure Keyboard & State Helpers (Issue #40)
 */

export interface ZenKeyboardEvent {
  key: string;
  code?: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
}

export interface ZenContext {
  isZenMode: boolean;
  hasOpenModal?: boolean;
}

export type ZenAction = 'toggle' | 'exit' | null;

export type ZenFocusTarget = 'floating-exit' | 'header-toggle' | null;

export interface ZenFocusTargetOptions {
  isZenMode: boolean;
  prevZenMode?: boolean;
  hasOpenModal?: boolean;
  activeElementIsInputOrTextarea?: boolean;
}

export const ZEN_MODE_CONTAINER_CLASS = 'is-zen-mode';
export const ZEN_TOGGLE_BUTTON_CLASS = 'btn-zen-toggle';
export const ZEN_FLOATING_EXIT_CLASS = 'btn-zen-floating-exit';

export const MODAL_OR_POPUP_SELECTORS = [
  '.modal-overlay',
  '.file-viewer-overlay',
  '.folder-picker-overlay',
  '.extension-dialog-overlay',
  '.prompt-popover',
  '.command-palette-popover',
  '[role="dialog"]',
  '[aria-modal="true"]',
].join(', ');

/** Detects Alt+Z toggle shortcut while avoiding repeat keys and modifier collisions. */
export function isAltZShortcut(event: ZenKeyboardEvent): boolean {
  if (event.repeat || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return false;
  }
  const isKeyZ = typeof event.key === 'string' && event.key.toLowerCase() === 'z';
  const isCodeKeyZ = event.code === 'KeyZ';
  return isKeyZ || isCodeKeyZ;
}

/** Detects un-modified Escape exit shortcut while rejecting repeat events. */
export function isEscapeShortcut(event: ZenKeyboardEvent): boolean {
  if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return false;
  }
  return event.key === 'Escape';
}

/** Safely checks whether an active modal, dialog or popover overlay is present in the DOM. */
export function hasActiveModalOrOverlay(
  targetDocument?: { querySelector: (selector: string) => unknown } | null
): boolean {
  if (!targetDocument || typeof targetDocument.querySelector !== 'function') {
    return false;
  }
  try {
    return Boolean(targetDocument.querySelector(MODAL_OR_POPUP_SELECTORS));
  } catch {
    return false;
  }
}

/** Resolves the Zen action for an event, protecting modal and overlay workflows. */
export function resolveZenKeyboardAction(
  event: ZenKeyboardEvent,
  context: ZenContext
): ZenAction {
  if (event.repeat || event.defaultPrevented || context.hasOpenModal) {
    return null;
  }
  if (isAltZShortcut(event)) {
    return 'toggle';
  }
  if (context.isZenMode && isEscapeShortcut(event)) {
    return 'exit';
  }
  return null;
}

/**
 * Determines where focus should be transferred on Zen Mode state changes.
 * Avoids stealing focus on initial mount, across open modals, or when an
 * input or textarea is actively focused.
 */
export function determineZenFocusTarget(
  options: ZenFocusTargetOptions
): ZenFocusTarget {
  const {
    isZenMode,
    prevZenMode,
    hasOpenModal = false,
    activeElementIsInputOrTextarea = false,
  } = options;

  if (prevZenMode === undefined || prevZenMode === isZenMode) {
    return null;
  }

  if (hasOpenModal || activeElementIsInputOrTextarea) {
    return null;
  }

  return isZenMode ? 'floating-exit' : 'header-toggle';
}
