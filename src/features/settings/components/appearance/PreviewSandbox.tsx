import React, { useMemo } from 'react';
import type { TranslationKey } from '@shared/i18n';
import {
  computeWorkAnimationStyles,
  type AppearancePreferences,
} from '@infra/preferences';

export interface PreviewSandboxProps {
  effectiveAppearance: AppearancePreferences;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

export const PreviewSandbox: React.FC<PreviewSandboxProps> = ({
  effectiveAppearance,
  t,
}) => {
  const sandboxWorkStyles = useMemo(
    () => computeWorkAnimationStyles(effectiveAppearance.workAnimation),
    [effectiveAppearance.workAnimation]
  );

  return (
    <section className="theme-preview-sandbox-section" aria-label={t('theme.preview_title')}>
      <div className="section-title-wrap">
        <h3 className="theme-section-title">{t('theme.preview_title')}</h3>
        <p className="theme-section-subtitle">{t('theme.preview_subtitle')}</p>
      </div>

      <div className="sandbox-viewport">
        {/* Header Mock */}
        <div className="sandbox-header-mock">
          <span className="sandbox-brand">PI-Viewer</span>
          <div className="sandbox-header-controls">
            <span className="sandbox-status-badge">● Connected</span>
            <button type="button" className="btn btn-secondary btn-sm sandbox-btn">
              ↻
            </button>
          </div>
        </div>

        {/* Chat Mock */}
        <div className="sandbox-chat-area">
          {/* User message */}
          <div className="sandbox-msg sandbox-msg-user">
            <div className="sandbox-msg-header">user • 10:24</div>
            <div className="sandbox-msg-body">{t('theme.sample_user_prompt')}</div>
          </div>

          {/* Assistant message with Code Card */}
          <div className="sandbox-msg sandbox-msg-assistant">
            <div className="sandbox-msg-header">
              <span>assistant • 10:25</span>
            </div>
            <div className="sandbox-msg-body">
              <p>{t('theme.sample_assistant_response')}</p>
              <div className="sandbox-code-card">
                <div className="sandbox-code-header">
                  <span>asm:risc_add.s</span>
                  <span className="sandbox-code-badge">assembly</span>
                </div>
                <pre className="sandbox-code-pre">
                  <code>
                    <span style={{ color: 'var(--syntax-keyword)' }}>LOAD</span> R1, [0x1000]{'\n'}
                    <span style={{ color: 'var(--syntax-keyword)' }}>LOAD</span> R2, [0x1004]{'\n'}
                    <span style={{ color: 'var(--syntax-fn)' }}>ADD</span>  R3, R1, R2{'\n'}
                    <span style={{ color: 'var(--syntax-keyword)' }}>STORE</span> R3, [0x1008]
                  </code>
                </pre>
              </div>
            </div>
          </div>

          {/* Status Pills Mock */}
          <div className="sandbox-pills-mock">
            <span className="session-status-badge status-working">⚡ Working</span>
            <span className="session-status-badge status-completed">✓ Done</span>
            <span className="session-status-badge status-waiting">⚠ Input needed</span>
          </div>

          {/* Prompt Loader Mock */}
          <div className="sandbox-prompt-mock">
            <span className="sandbox-prompt-label">PROMPT</span>
            <section
              className={sandboxWorkStyles.className}
              style={sandboxWorkStyles.style as React.CSSProperties}
              aria-hidden="true"
            >
              <div className="loader">
                {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
                  <div
                    key={`sdot-1-${i}`}
                    className="dot"
                    style={{ '--i': i } as React.CSSProperties}
                  />
                ))}
              </div>
              <h2>Working</h2>
              <div className="loader">
                {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
                  <div
                    key={`sdot-2-${i}`}
                    className="dot"
                    style={{ '--i': i } as React.CSSProperties}
                  />
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>
    </section>
  );
};
