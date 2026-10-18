import React, { useEffect, useId, useRef } from 'react';
import * as xtermModule from '@xterm/xterm';
import type { Terminal as XTermInstance } from '@xterm/xterm';
import * as fitModule from '@xterm/addon-fit';
import { translate, type SupportedLocale } from '@shared/i18n';
import type { TerminalSessionDto } from '@core/terminal';
import type { TerminalStatus } from '../types';

// Resolve CJS/ESM interop safely for Node tests and browser bundling
const XTermConstructor =
  (xtermModule as Record<string, any>).Terminal || (xtermModule as Record<string, any>)['default']?.Terminal || (xtermModule as Record<string, any>)['default'];
const FitAddonConstructor =
  (fitModule as Record<string, any>).FitAddon || (fitModule as Record<string, any>)['default']?.FitAddon || (fitModule as Record<string, any>)['default'];

export interface TerminalOverlayProps {
  isOpen: boolean;
  projectName: string;
  projectCwd: string;
  session?: TerminalSessionDto | null;
  locale?: SupportedLocale;
  status?: TerminalStatus;
  errorMessage?: string | null;
  exitCode?: number | null;
  isMobile?: boolean;
  onMinimize: () => void;
  onTerminate: () => void;
  onRetry?: () => void;
  onInput?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  terminalInstanceRef?: React.MutableRefObject<XTermInstance | null>;
}

export function TerminalOverlay({
  isOpen,
  projectName,
  projectCwd,
  session,
  locale = 'en',
  status = 'idle',
  errorMessage,
  exitCode,
  isMobile = false,
  onMinimize,
  onTerminate,
  onRetry,
  onInput,
  onResize,
  terminalInstanceRef,
}: TerminalOverlayProps): React.ReactElement | null {
  const containerRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
    translate(locale, key, params);

  // Focus isolation & keyboard containment
  useEffect(() => {
    if (!isOpen) return;
    const prevActive = document.activeElement as HTMLElement | null;

    // Focus the terminal container or helper textarea
    const timer = setTimeout(() => {
      const textarea = containerRef.current?.querySelector<HTMLTextAreaElement>(
        '.xterm-helper-textarea'
      );
      if (textarea) {
        textarea.focus();
      } else {
        containerRef.current?.focus();
      }
    }, 50);

    return () => {
      clearTimeout(timer);
      if (prevActive?.isConnected) {
        prevActive.focus();
      }
    };
  }, [isOpen]);

  // Terminal lifecycle & fit setup
  useEffect(() => {
    if (!isOpen || !screenRef.current) return;
    const screenEl = screenRef.current;

    // Guard against running in non-DOM/SSR environments
    if (typeof window === 'undefined' || !XTermConstructor || !FitAddonConstructor) return;

    const term = new XTermConstructor({
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: 'Consolas, "Fira Code", Monaco, monospace',
      fontSize: isMobile ? 12 : 13,
      lineHeight: 1.2,
      scrollback: 10000,
      theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
        selectionBackground: 'rgba(56, 139, 253, 0.4)',
        black: '#484f58',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39c5cf',
        white: '#b1bac4',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd',
        brightWhite: '#f0f6fc',
      },
    });

    const fitAddon = new FitAddonConstructor();
    term.loadAddon(fitAddon);
    term.open(screenEl);

    if (terminalInstanceRef) {
      terminalInstanceRef.current = term;
    }

    // Write scrollback history if session has replay buffer
    if (session?.replay) {
      term.write(session.replay);
    }

    const dataDisposable = term.onData((data: string) => {
      onInput?.(data);
    });

    // ResizeObserver for responsive full-window bounds & keyboard shifts
    let lastCols = term.cols;
    let lastRows = term.rows;

    const handleResize = () => {
      if (!screenEl || screenEl.clientWidth === 0 || screenEl.clientHeight === 0) return;
      try {
        fitAddon.fit();
        if (term.cols > 0 && term.rows > 0) {
          if (term.cols !== lastCols || term.rows !== lastRows) {
            lastCols = term.cols;
            lastRows = term.rows;
            onResize?.(term.cols, term.rows);
          }
        }
      } catch {
        // Safe catch for zero-dimension bounds
      }
    };

    const resizeObserver = new ResizeObserver(() => {
      handleResize();
    });
    resizeObserver.observe(screenEl);

    // Initial fit after DOM layout
    const fitTimer = setTimeout(() => {
      handleResize();
    }, 100);

    return () => {
      clearTimeout(fitTimer);
      resizeObserver.disconnect();
      dataDisposable.dispose();
      term.dispose();
      if (terminalInstanceRef) {
        terminalInstanceRef.current = null;
      }
    };
  }, [isOpen, session?.id, isMobile]);

  if (!isOpen) return null;

  return (
    <div
      ref={containerRef}
      className={`terminal-overlay ${isMobile ? 'is-mobile' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={(e) => {
        // Prevent keyboard shortcuts from bubbling into the outer app while typing in terminal
        if (e.key === 'Escape' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
          // Allow Escape to minimize cleanly
          e.stopPropagation();
          onMinimize();
        } else {
          e.stopPropagation();
        }
      }}
    >
      <header className="terminal-header">
        <div className="terminal-header-title">
          <svg
            className="terminal-icon"
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
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
          <span id={titleId} className="terminal-title-text">
            {t('terminal.title')}
          </span>
          {projectName && (
            <span className="terminal-project-badge" title={projectCwd}>
              {projectName}
            </span>
          )}
          {session?.pid && (
            <span className="terminal-pid-badge" title={`PID: ${session.pid}`}>
              PID {session.pid}
            </span>
          )}
        </div>

        <div className="terminal-header-controls">
          <button
            type="button"
            className="btn-terminal-minimize"
            onClick={onMinimize}
            title={t('terminal.minimize')}
            aria-label={t('terminal.minimize')}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span className="btn-label">{t('terminal.minimize')}</span>
          </button>

          <button
            type="button"
            className="btn-terminal-terminate"
            onClick={onTerminate}
            title={t('terminal.terminate')}
            aria-label={t('terminal.terminate')}
          >
            <svg
              width="14"
              height="14"
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
            <span className="btn-label">{t('terminal.terminate')}</span>
          </button>
        </div>
      </header>

      {status === 'error' && (
        <div className="terminal-error-banner" role="alert">
          <span className="error-message">{errorMessage || t('terminal.error')}</span>
          {onRetry && (
            <button type="button" className="btn btn-sm btn-terminal-retry" onClick={onRetry}>
              {t('terminal.retry')}
            </button>
          )}
        </div>
      )}

      {status === 'exited' && (
        <div className="terminal-exit-banner" role="status">
          <span>
            {t('terminal.process_exited', { code: exitCode !== null && exitCode !== undefined ? exitCode : 0 })}
          </span>
        </div>
      )}

      <main className="terminal-body">
        <div ref={screenRef} className="terminal-screen-container" />
      </main>
    </div>
  );
}
