import React from 'react';
import type { TranslationKey } from '@shared/i18n';

export interface ProvidersHeaderProps {
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  showRawJson: boolean;
  onToggleRawJson: () => void;
  onOpenAddModal: () => void;
  isSaving: boolean;
  isBusy: boolean;
}

export const ProvidersHeader: React.FC<ProvidersHeaderProps> = ({
  t,
  showRawJson,
  onToggleRawJson,
  onOpenAddModal,
  isSaving,
  isBusy,
}) => {
  return (
    <div className="settings-pane-toolbar providers-toolbar">
      <div className="providers-toolbar-info">
        <span className="providers-count-badge" />
      </div>
      <div className="providers-header-actions">
        <button
          type="button"
          className="btn btn-secondary btn-sm btn-toggle-raw-json"
          onClick={onToggleRawJson}
          title={showRawJson ? t('providers.hide_json') : t('providers.view_json')}
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
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
          </svg>
          <span>{showRawJson ? t('providers.hide_json') : t('providers.view_json')}</span>
        </button>

        <button
          type="button"
          className="btn btn-primary btn-sm btn-add-provider"
          onClick={onOpenAddModal}
          disabled={isSaving || isBusy}
          title={t('providers.btn_add_provider')}
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
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          <span>{t('providers.btn_add_provider')}</span>
        </button>
      </div>
    </div>
  );
};
