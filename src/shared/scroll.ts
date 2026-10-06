/**
 * Viewport scroll controller and calculation utilities.
 * Ensures the conversation scroll viewport never clips history or shifts ancestor elements.
 */

export interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export const DEFAULT_BOTTOM_THRESHOLD_PX = 120;

/**
 * Determines whether the viewport is currently near the bottom within a given threshold.
 * Returns true if the distance remaining to the bottom is <= threshold or if content fits.
 */
export function isNearBottom(
  metrics: ScrollMetrics | null | undefined,
  threshold: number = DEFAULT_BOTTOM_THRESHOLD_PX
): boolean {
  if (!metrics) return true;
  const { scrollHeight, scrollTop, clientHeight } = metrics;
  // If content fits completely inside the viewport, it is always considered at bottom
  if (scrollHeight <= clientHeight) {
    return true;
  }
  const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
  return distanceFromBottom <= threshold;
}

/**
 * Scrolls a scrollable container element to its bottom.
 * Uses direct scrollTop or scrollTo to guarantee ancestor containers are never scrolled.
 */
export function scrollToBottom(
  element: { scrollTop: number; scrollHeight: number; scrollTo?: (options: ScrollToOptions) => void } | null | undefined,
  behavior: 'auto' | 'smooth' = 'auto'
): void {
  if (!element) return;
  if (behavior === 'smooth' && typeof element.scrollTo === 'function') {
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
  } else {
    element.scrollTop = element.scrollHeight;
  }
}

/**
 * Determines whether the floating "scroll to bottom" button should be displayed.
 * Visible only when the user is scrolled away from the bottom and messages exist.
 */
export function shouldShowScrollToBottom(isAtBottom: boolean, messageCount: number): boolean {
  return !isAtBottom && messageCount > 0;
}

/**
 * Preserves scroll position when prepending older items to a scrollable container.
 * Adjusts scrollTop by the difference in scrollHeight before and after layout.
 */
export function preserveScrollOnPrepend(
  element: { scrollTop: number; scrollHeight: number } | null | undefined,
  previousScrollHeight: number
): void {
  if (!element) return;
  const delta = element.scrollHeight - previousScrollHeight;
  if (delta > 0) {
    element.scrollTop += delta;
  }
}

/**
 * Pure controller managing auto-scroll decisions and user scroll interaction state.
 */
export class ScrollController {
  private isPinnedToBottom = true;
  private threshold: number;

  constructor(threshold: number = DEFAULT_BOTTOM_THRESHOLD_PX) {
    this.threshold = threshold;
  }

  /**
   * Called on container scroll events to track whether user has scrolled away from bottom.
   */
  public handleScroll(metrics: ScrollMetrics | null | undefined): void {
    this.isPinnedToBottom = isNearBottom(metrics, this.threshold);
  }

  /**
   * Queries whether an automatic scroll to bottom should occur on incoming messages/tokens.
   */
  public shouldAutoScroll(): boolean {
    return this.isPinnedToBottom;
  }

  /**
   * Explicitly forces pinning to bottom (e.g. when user submits prompt or starts fresh conversation).
   */
  public pinToBottom(): void {
    this.isPinnedToBottom = true;
  }

  /**
   * Explicitly unpins from bottom (e.g. when user scrolls away).
   */
  public unpin(): void {
    this.isPinnedToBottom = false;
  }

  /**
   * Returns current pinning state.
   */
  public isPinned(): boolean {
    return this.isPinnedToBottom;
  }

  /**
   * Returns configured threshold in pixels.
   */
  public getThreshold(): number {
    return this.threshold;
  }
}
