import React, { useEffect, useRef, useState } from 'react';
import { translate, type SupportedLocale } from '@shared/i18n';

export function nextToolsMenuIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowDown') return (current + 1) % count;
  if (key === 'ArrowUp') return current <= 0 ? count - 1 : current - 1;
  return null;
}

interface ToolsMenuProps {
  web: boolean;
  locale: SupportedLocale;
  isZenMode: boolean;
  dockerActive?: boolean;
  onToggleZen: () => void;
  onSelectDocker: () => void;
  buttonRef?: React.RefObject<HTMLButtonElement | null>;
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function ToolsMenu({ web, locale, isZenMode, dockerActive = false, onToggleZen, onSelectDocker, buttonRef, isOpen, onOpenChange }: ToolsMenuProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = isOpen ?? internalOpen;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const openAtEndRef = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const setOpen = (value: boolean) => {
    if (isOpen === undefined) setInternalOpen(value);
    onOpenChange?.(value);
  };
  const setOpenRef = useRef(setOpen);
  setOpenRef.current = setOpen;

  useEffect(() => {
    if (!open) return;
    const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    items?.[openAtEndRef.current ? items.length - 1 : 0]?.focus();
    openAtEndRef.current = false;
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpenRef.current(false);
    };
    // Capture before the drawer and Zen window listeners, even when focus is elsewhere.
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpenRef.current(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onEscape, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onEscape, true);
    };
  }, [open]);

  const handleMenuKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = nextToolsMenuIndex(event.key, index, items.length);
    if (next !== null) {
      event.preventDefault();
      items[next]?.focus();
    }
  };
  const label = translate(locale, 'header.tools');
  return (
    <div ref={wrapperRef} className="tools-menu">
      <button
        ref={node => {
          triggerRef.current = node;
          if (buttonRef) (buttonRef as React.MutableRefObject<HTMLButtonElement | null>).current = node;
        }}
        type="button"
        className={`btn-zen-toggle${open || dockerActive ? ' is-active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen(!open)}
        onKeyDown={event => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            openAtEndRef.current = event.key === 'ArrowUp';
            setOpen(true);
          }
        }}
      >
        {label} <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div ref={menuRef} className="tools-menu-popover" role="menu" aria-label={label} onKeyDown={handleMenuKeyDown}>
          <button type="button" role="menuitem" tabIndex={-1} title={translate(locale, isZenMode ? 'zen.exit_title' : 'zen.enter_title')} onClick={() => { setOpen(false); onToggleZen(); }}>Zen</button>
          {web && <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setOpen(false); onSelectDocker(); }}>{translate(locale, 'docker.title')}</button>}
        </div>
      )}
    </div>
  );
}
