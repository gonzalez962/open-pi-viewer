import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isNearBottom,
  scrollToBottom,
  ScrollController,
  shouldShowScrollToBottom,
  preserveScrollOnPrepend,
  DEFAULT_BOTTOM_THRESHOLD_PX,
  type ScrollMetrics,
} from '@shared/scroll';

test('isNearBottom: returns true when metrics is null or undefined', () => {
  assert.equal(isNearBottom(null), true);
  assert.equal(isNearBottom(undefined), true);
});

test('isNearBottom: returns true when scrollHeight <= clientHeight (content fits viewport)', () => {
  const metrics: ScrollMetrics = {
    scrollHeight: 500,
    scrollTop: 0,
    clientHeight: 600,
  };
  assert.equal(isNearBottom(metrics), true);

  const exactFit: ScrollMetrics = {
    scrollHeight: 600,
    scrollTop: 0,
    clientHeight: 600,
  };
  assert.equal(isNearBottom(exactFit), true);
});

test('isNearBottom: returns true when exactly at the bottom', () => {
  const metrics: ScrollMetrics = {
    scrollHeight: 1500,
    scrollTop: 900,
    clientHeight: 600,
  };
  assert.equal(isNearBottom(metrics), true);
});

test('isNearBottom: respects custom threshold when near bottom', () => {
  // Distance from bottom is 1500 - 800 - 600 = 100px
  const metrics: ScrollMetrics = {
    scrollHeight: 1500,
    scrollTop: 800,
    clientHeight: 600,
  };

  // With default threshold (120px), 100px <= 120px -> true
  assert.equal(isNearBottom(metrics), true);

  // With smaller threshold (50px), 100px > 50px -> false
  assert.equal(isNearBottom(metrics, 50), false);

  // With larger threshold (200px), 100px <= 200px -> true
  assert.equal(isNearBottom(metrics, 200), true);
});

test('isNearBottom: returns false when scrolled far up', () => {
  // Distance from bottom is 2500 - 200 - 600 = 1700px
  const metrics: ScrollMetrics = {
    scrollHeight: 2500,
    scrollTop: 200,
    clientHeight: 600,
  };
  assert.equal(isNearBottom(metrics), false);
});

test('scrollToBottom: sets scrollTop directly when behavior is auto or scrollTo is absent', () => {
  const mockElement = {
    scrollTop: 100,
    scrollHeight: 1200,
  };

  scrollToBottom(mockElement, 'auto');
  assert.equal(mockElement.scrollTop, 1200);

  // When scrollTo is absent, even 'smooth' falls back safely to scrollTop assignment
  mockElement.scrollTop = 50;
  scrollToBottom(mockElement, 'smooth');
  assert.equal(mockElement.scrollTop, 1200);
});

test('scrollToBottom: invokes element.scrollTo when smooth behavior requested and supported', () => {
  let calledWith: ScrollToOptions | null = null;
  const mockElement = {
    scrollTop: 100,
    scrollHeight: 1450,
    scrollTo: (options: ScrollToOptions) => {
      calledWith = options;
    },
  };

  scrollToBottom(mockElement, 'smooth');
  assert.deepEqual(calledWith, { top: 1450, behavior: 'smooth' });
});

test('scrollToBottom: handles null and undefined safely without throwing', () => {
  assert.doesNotThrow(() => scrollToBottom(null));
  assert.doesNotThrow(() => scrollToBottom(undefined));
});

test('ScrollController: initializes pinned to bottom by default', () => {
  const controller = new ScrollController();
  assert.equal(controller.isPinned(), true);
  assert.equal(controller.shouldAutoScroll(), true);
  assert.equal(controller.getThreshold(), DEFAULT_BOTTOM_THRESHOLD_PX);
});

test('ScrollController: updates pinning state on handleScroll', () => {
  const controller = new ScrollController(100);

  // User scrolls up far from bottom (distance = 1800 - 500 - 600 = 700px > 100px)
  controller.handleScroll({
    scrollHeight: 1800,
    scrollTop: 500,
    clientHeight: 600,
  });
  assert.equal(controller.isPinned(), false);
  assert.equal(controller.shouldAutoScroll(), false);

  // User scrolls back near bottom (distance = 1800 - 1150 - 600 = 50px <= 100px)
  controller.handleScroll({
    scrollHeight: 1800,
    scrollTop: 1150,
    clientHeight: 600,
  });
  assert.equal(controller.isPinned(), true);
  assert.equal(controller.shouldAutoScroll(), true);
});

test('ScrollController: pinToBottom and unpin override state deterministically', () => {
  const controller = new ScrollController();

  controller.unpin();
  assert.equal(controller.isPinned(), false);
  assert.equal(controller.shouldAutoScroll(), false);

  controller.pinToBottom();
  assert.equal(controller.isPinned(), true);
  assert.equal(controller.shouldAutoScroll(), true);
});

test('ScrollController: handleScroll with null or undefined safely defaults to pinned', () => {
  const controller = new ScrollController();
  controller.unpin();
  assert.equal(controller.isPinned(), false);

  controller.handleScroll(null);
  assert.equal(controller.isPinned(), true);
});

test('shouldShowScrollToBottom: returns true only when scrolled up away from bottom and messages exist', () => {
  // Not at bottom and messages exist -> true
  assert.equal(shouldShowScrollToBottom(false, 1), true);
  assert.equal(shouldShowScrollToBottom(false, 10), true);

  // At bottom -> false (regardless of message count)
  assert.equal(shouldShowScrollToBottom(true, 1), false);
  assert.equal(shouldShowScrollToBottom(true, 10), false);
  assert.equal(shouldShowScrollToBottom(true, 0), false);

  // No messages -> false (even if scrolled up)
  assert.equal(shouldShowScrollToBottom(false, 0), false);
  assert.equal(shouldShowScrollToBottom(false, -1), false);
});

test('preserveScrollOnPrepend: adjusts scrollTop by scrollHeight delta accurately', () => {
  const mockElement = {
    scrollTop: 100,
    scrollHeight: 1500,
  };

  // Prepending items increased scrollHeight from 1000 to 1500 (+500px)
  preserveScrollOnPrepend(mockElement, 1000);
  assert.equal(mockElement.scrollTop, 600);

  // When scrollHeight is unchanged, scrollTop remains untouched
  preserveScrollOnPrepend(mockElement, 1500);
  assert.equal(mockElement.scrollTop, 600);

  // Null/undefined does not throw
  assert.doesNotThrow(() => preserveScrollOnPrepend(null, 1000));
  assert.doesNotThrow(() => preserveScrollOnPrepend(undefined, 1000));
});

