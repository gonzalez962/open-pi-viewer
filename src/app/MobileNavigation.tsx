import React, { useEffect, useRef, useState } from 'react';
import { translate, type SupportedLocale } from '@shared/i18n';
import {
  DRAWER_ID,
  BACKDROP_ID,
  MOBILE_DRAWER_CLOSE_CLASS,
  MOBILE_BREAKPOINT,
  isEscapeKey,
  trapFocusInContainer,
  getDrawerAccessibilityProps,
  isElementVisible,
  decideFocusTransition,
  checkIsMobileViewport,
} from './mobile-navigation';

export interface MobileNavigationProps {
  isOpen: boolean;
  onClose: () => void;
  isMobile?: boolean;
  activeProjectName?: string;
  locale?: SupportedLocale;
  triggerRef?: React.RefObject<HTMLElement | null>;
  restoreFocusOnClose?: boolean;
  children?: React.ReactNode;
}

export const MobileNavigation: React.FC<MobileNavigationProps> = ({
  isOpen,
  onClose,
  isMobile: isMobileProp,
  activeProjectName: _activeProjectName,
  locale = 'en',
  triggerRef,
  restoreFocusOnClose = true,
  children,
}) => {
  const drawerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const prevFocusedElementRef = useRef<HTMLElement | null>(null);

  const isFirstMountRef = useRef<boolean>(true);
  const prevIsOpenRef = useRef<boolean>(isOpen);
  const prevIsMobileRef = useRef<boolean | undefined>(undefined);

  // Viewport detection when isMobile prop is not explicitly provided
  const [internalIsMobile, setInternalIsMobile] = useState<boolean>(() => checkIsMobileViewport());

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const update = () => {
      setInternalIsMobile(checkIsMobileViewport());
    };

    if (typeof window.matchMedia === 'function') {
      const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`);
      if (typeof mql.addEventListener === 'function') {
        mql.addEventListener('change', update);
        return () => mql.removeEventListener('change', update);
      }
    }

    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  const isMobile = isMobileProp !== undefined ? isMobileProp : internalIsMobile;

  // Manage accessible focus and keyboard interactions on real transitions (never on initial mount)
  useEffect(() => {
    const isFirstMount = isFirstMountRef.current;
    const prevIsOpen = prevIsOpenRef.current;
    const prevIsMobile = prevIsMobileRef.current ?? isMobile;

    isFirstMountRef.current = false;
    prevIsOpenRef.current = isOpen;
    prevIsMobileRef.current = isMobile;

    const isTriggerVisible = isElementVisible(triggerRef?.current ?? null);
    const isPrevElementVisible = isElementVisible(prevFocusedElementRef.current);

    const transitionAction = decideFocusTransition({
      isFirstMount,
      prevIsOpen,
      isOpen,
      isMobile,
      prevIsMobile,
      isTriggerVisible,
      isPrevElementVisible,
      shouldRestoreFocus: restoreFocusOnClose,
    });

    if (transitionAction === 'open-drawer') {
      // Capture previously focused element before moving into mobile drawer
      if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
        prevFocusedElementRef.current = document.activeElement;
      }

      const focusTimer = setTimeout(() => {
        if (closeButtonRef.current && typeof closeButtonRef.current.focus === 'function') {
          closeButtonRef.current.focus();
        } else if (drawerRef.current && typeof drawerRef.current.focus === 'function') {
          drawerRef.current.focus();
        }
      }, 10);

      return () => clearTimeout(focusTimer);
    }

    if (transitionAction === 'restore-focus-trigger') {
      if (triggerRef?.current && typeof triggerRef.current.focus === 'function') {
        triggerRef.current.focus();
      }
      prevFocusedElementRef.current = null;
      return;
    }

    if (transitionAction === 'restore-focus-previous') {
      if (
        prevFocusedElementRef.current &&
        typeof prevFocusedElementRef.current.focus === 'function' &&
        document.contains(prevFocusedElementRef.current)
      ) {
        prevFocusedElementRef.current.focus();
      }
      prevFocusedElementRef.current = null;
      return;
    }

    // transitionAction === 'no-op': do nothing (prevents stealing focus to hidden elements)
  }, [isOpen, isMobile, triggerRef]);

  // Trap focus and handle Escape ONLY when mobile drawer is actually open
  useEffect(() => {
    if (!isMobile || !isOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEscapeKey(event)) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key === 'Tab') {
        trapFocusInContainer(event, drawerRef.current);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isMobile, isOpen, onClose]);

  const closeLabel = translate(locale, 'action.close') || (locale === 'es' ? 'Cerrar' : 'Close');
  const navTitle = locale === 'es' ? 'Navegación' : 'Navigation';
  const productTitle = translate(locale, 'app.title') || 'Pi Viewer';
  const productVersion = translate(locale, 'app.version') || 'v0.2.0';

  return (
    <>
      {isMobile && (
        <div
          id={BACKDROP_ID}
          className={`mobile-nav-backdrop ${isOpen ? 'is-visible' : ''}`}
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      <aside
        id={DRAWER_ID}
        ref={drawerRef}
        className={`mobile-nav-drawer ${isMobile ? (isOpen ? 'is-open' : 'is-closed') : 'is-desktop'}`}
        aria-label={navTitle}
        tabIndex={isMobile ? -1 : undefined}
        {...getDrawerAccessibilityProps(isMobile, isOpen)}
      >
        {isMobile && (
          <div className="mobile-nav-drawer-header">
            <div className="mobile-nav-drawer-title-group">
              <span className="mobile-nav-drawer-heading mobile-nav-drawer-title">
                {productTitle}
              </span>
              <span className="mobile-nav-drawer-version">
                {productVersion}
              </span>
            </div>
            <button
              ref={closeButtonRef}
              type="button"
              className={`${MOBILE_DRAWER_CLOSE_CLASS}`}
              onClick={onClose}
              title={closeLabel}
              aria-label={closeLabel}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        )}

        <div className="mobile-nav-drawer-body">{children}</div>
      </aside>
    </>
  );
};
