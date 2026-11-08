import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { scrollToBottom, ScrollController, isNearBottom, shouldShowScrollToBottom } from '@shared/scroll';
import type { ChatMessage } from '@core/types/messages';
import { readScrollPosition, saveScrollPosition } from '../lib/scroll-position';

export interface UseChatScrollInput {
  messages: ChatMessage[];
  projectId: string | null;
  sessionId: string | null;
  isHydrated: boolean;
  showSettings: boolean;
}

export interface UseChatScrollResult {
  chatViewportRef: React.RefObject<HTMLElement>;
  showScrollBottom: boolean;
  handleViewportScroll: (e: React.UIEvent<HTMLElement>) => void;
  handleScrollToBottom: () => void;
  pinAndHide: () => void;
  scrollToBottomNextFrame: () => void;
  pinAndJumpToBottom: () => void;
}

export function useChatScroll({ messages, projectId, sessionId, isHydrated, showSettings }: UseChatScrollInput): UseChatScrollResult {
  const chatViewportRef = useRef<HTMLElement>(null);
  const controller = useRef(new ScrollController()).current;
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const context = JSON.stringify([projectId, sessionId, isHydrated, showSettings]);
  const contextRef = useRef(context);
  contextRef.current = context;
  const restoredRef = useRef<string | null>(null);

  // Restore before the streaming effect can act on the previous session's pin state.
  useLayoutEffect(() => {
    restoredRef.current = null;
    const el = chatViewportRef.current;
    if (!isHydrated || showSettings || !el) return;
    const saved = projectId && sessionId ? readScrollPosition(projectId, sessionId) : null;
    if (saved && !saved.pinned) {
      el.scrollTop = saved.top;
      controller.unpin();
      setShowScrollBottom(shouldShowScrollToBottom(false, messages.length));
    } else {
      controller.pinToBottom();
      scrollToBottom(el, 'auto');
      setShowScrollBottom(false);
    }
    restoredRef.current = context;
  }, [projectId, sessionId, isHydrated, showSettings]);

  const handleViewportScroll = (e: React.UIEvent<HTMLElement>) => {
    const el = e.currentTarget;
    if (restoredRef.current !== context || el !== chatViewportRef.current || !el.isConnected) return;
    controller.handleScroll(el);
    const atBottom = isNearBottom(el);
    setShowScrollBottom(shouldShowScrollToBottom(atBottom, messages.length));
    if (projectId && sessionId && isHydrated && !showSettings) {
      saveScrollPosition(projectId, sessionId, { top: el.scrollTop, pinned: atBottom });
    }
  };

  const handleScrollToBottom = () => {
    controller.pinToBottom();
    setShowScrollBottom(false);
    scrollToBottom(chatViewportRef.current, 'smooth');
  };
  const pinAndHide = () => {
    controller.pinToBottom();
    setShowScrollBottom(false);
  };
  const scrollToBottomNextFrame = () => {
    const scheduledContext = contextRef.current;
    requestAnimationFrame(() => {
      if (contextRef.current === scheduledContext && restoredRef.current === scheduledContext) {
        scrollToBottom(chatViewportRef.current, 'auto');
      }
    });
  };
  const pinAndJumpToBottom = () => {
    pinAndHide();
    scrollToBottomNextFrame();
  };

  useEffect(() => {
    if (restoredRef.current === context && controller.shouldAutoScroll()) {
      scrollToBottom(chatViewportRef.current, 'auto');
      setShowScrollBottom(false);
    }
  }, [messages, context, controller]);

  return { chatViewportRef, showScrollBottom, handleViewportScroll, handleScrollToBottom, pinAndHide, scrollToBottomNextFrame, pinAndJumpToBottom };
}
