import React from 'react';
import type { TranslationKey } from '@shared/i18n';
import type { CustomProviderConfig } from '@core/types/providers';
import type { ModelThinkingLevelsMap } from '@core/types/models';
import { isModelAllowed } from '../providers';

export interface ProviderCardProps {
  provider: CustomProviderConfig;
  modelThinkingLevels?: ModelThinkingLevelsMap;
  deletingId: string | null;
  isSaving: boolean;
  isBusy: boolean;
  onOpenEditModal: (provider: CustomProviderConfig, initialEditModelId?: string) => void;
  onSetDeletingId: (id: string | null) => void;
  onDeleteProvider: (id: string) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

export const ProviderCard: React.FC<ProviderCardProps> = ({
  provider,
  modelThinkingLevels: _modelThinkingLevels,
  deletingId,
  isSaving,
  isBusy,
  onOpenEditModal,
  onSetDeletingId,
  onDeleteProvider,
  t,
}) => {
  const policy = {
    includedModels: provider.includedModels,
    excludedModels: provider.excludedModels,
  };
  const activeModels = (provider.models || []).filter((m) => isModelAllowed(m.id, policy));
  const modelCount = activeModels.length;

  return (
    <div className="provider-card" data-provider-id={provider.id}>
      <div className="provider-card-header">
        <div className="provider-title-group">
          <h3 className="provider-card-title" title={provider.name || provider.id}>
            {provider.name || provider.id}
          </h3>
          <span className="provider-models-count">
            {t('providers.models_heading', { count: modelCount })}
          </span>
        </div>
      </div>

      <div className="provider-card-actions">
        {deletingId === provider.id ? (
          <div className="provider-delete-confirm">
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() => onDeleteProvider(provider.id)}
              disabled={isSaving}
            >
              {t('providers.confirm_delete')}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => onSetDeletingId(null)}
              disabled={isSaving}
            >
              {t('action.cancel')}
            </button>
          </div>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-secondary btn-sm btn-edit-provider"
              onClick={() => onOpenEditModal(provider)}
              disabled={isSaving || isBusy}
              title={t('providers.edit_title')}
            >
              {t('action.edit')}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm btn-delete-provider"
              onClick={() => onSetDeletingId(provider.id)}
              disabled={isSaving || isBusy}
              title={t('providers.delete_title')}
            >
              {t('action.delete')}
            </button>
          </>
        )}
      </div>
    </div>
  );
};
