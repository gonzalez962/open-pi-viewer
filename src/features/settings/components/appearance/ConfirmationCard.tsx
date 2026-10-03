import React from 'react';
import type { TranslationKey } from '@shared/i18n';

export interface ConfirmationCardProps {
  isDirty: boolean;
  isDrafting: boolean;
  activeThemeName: string;
  onConfirm: () => void;
  onCancel: () => void;
  onResetAppearance?: () => void;
  error?: string | null;
  saveFeedback?: boolean;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  idPrefix?: string;
}

export const ConfirmationCard: React.FC<ConfirmationCardProps> = ({
  isDirty,
  activeThemeName,
  onConfirm,
  onCancel,
  onResetAppearance,
  error,
  saveFeedback,
  t,
}) => {
  return (
    <section
      className={`theme-confirmation-card ${isDirty ? 'is-pending-save' : 'is-saved'}`}
      aria-label={t('theme.confirmation_title')}
    >
      <div className="confirmation-card-header">
        <div className="confirmation-title-group">
          <span className="confirmation-badge" aria-hidden="true">
            {isDirty ? '⚡' : '✓'}
          </span>
          <div>
            <h3 className="confirmation-title">{t('theme.confirmation_title')}</h3>
            <p className="confirmation-desc">
              {isDirty ? t('theme.notice_unsaved') : t('theme.confirmation_subtitle')}
            </p>
          </div>
        </div>

        <div className="confirmation-status-pill">
          <span
            className={`status-dot ${isDirty ? 'status-dot-pending' : 'status-dot-active'}`}
            aria-hidden="true"
          />
          <span>
            {isDirty
              ? `${t('theme.status_previewing')}: ${activeThemeName}`
              : `${t('theme.status_active')}: ${activeThemeName}`}
          </span>
        </div>
      </div>

      {error && (
        <div className="theme-error-banner" role="alert">
          {error}
        </div>
      )}

      <div className="confirmation-actions-row">
        <button
          type="button"
          className="btn btn-primary btn-confirm-theme"
          onClick={onConfirm}
          disabled={!isDirty}
        >
          <span>✓ {t('theme.confirm_button')}</span>
        </button>

        {isDirty && (
          <button
            type="button"
            className="btn btn-secondary btn-reset-theme"
            onClick={onCancel}
          >
            <span>↺ {t('theme.cancel_button')}</span>
          </button>
        )}

        {onResetAppearance && (
          <button
            type="button"
            className="btn btn-secondary btn-reset-appearance"
            onClick={onResetAppearance}
            title={t('theme.reset_desc')}
          >
            <span>🗑 {t('theme.reset_button')}</span>
          </button>
        )}

        {saveFeedback && (
          <span className="confirmation-saved-notice" role="status">
            ✓ {t('theme.notice_saved')}
          </span>
        )}
      </div>
    </section>
  );
};
