import React from 'react';
import type { TranslationKey } from '@shared/i18n';
import type { ModelThinkingLevelsMap } from '@core/types/models';
import type { useProviderModalForm } from '../hooks/useProviderModalForm';
import { ProviderConfigFields } from './ProviderConfigFields';
import { ProviderModelDraftList } from './ProviderModelDraftList';
import { ModelSubform } from './ModelSubform';
import { IncludedModelsSection } from './IncludedModelsSection';
import { ExcludedModelsSection } from './ExcludedModelsSection';

export interface ProviderModalProps {
  modalForm: ReturnType<typeof useProviderModalForm>;
  modelThinkingLevels: ModelThinkingLevelsMap;
  isSaving: boolean;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

export const ProviderModal: React.FC<ProviderModalProps> = ({
  modalForm,
  modelThinkingLevels,
  isSaving,
  t,
}) => {
  if (!modalForm.isModalOpen) return null;

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="modal-provider-title">
      <div className="modal-container provider-modal">
        <header className="modal-header">
          <h2 id="modal-provider-title" className="modal-title">
            {modalForm.formData.isBuiltin
              ? t('providers.oauth.edit_models_title', { id: modalForm.formData.id })
              : modalForm.isEditing
                ? t('providers.modal_edit_title', { id: modalForm.formData.id })
                : t('providers.modal_add_title')}
          </h2>
          <button
            type="button"
            className="btn-icon-subtle modal-close-btn"
            onClick={modalForm.closeModal}
            title={t('action.cancel')}
          >
            ✕
          </button>
        </header>

        <form onSubmit={modalForm.handleSaveProvider} className="modal-form">
          <div className="modal-scrollable-body">
            {modalForm.formError && (
              <div className="validation-error-banner" role="alert">
                <span>{modalForm.formError}</span>
              </div>
            )}

            {/* Section 1: Provider Config */}
            {modalForm.formData.isBuiltin ? (
              <div
                className="builtin-provider-info-card form-fieldset"
                role="region"
                aria-label="Built-in Provider Information"
                style={{
                  marginBottom: '16px',
                  padding: '12px 14px',
                  borderRadius: '6px',
                  background: 'var(--bg-subtle, rgba(255,255,255,0.03))',
                  border: '1px solid var(--border-subtle, rgba(255,255,255,0.08))',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                  <strong style={{ fontSize: '15px' }}>
                    {modalForm.formData.name || modalForm.formData.id}
                  </strong>
                  <span className="badge badge-subtle">{modalForm.formData.id}</span>
                  <span className="badge badge-primary">{t('providers.oauth.status_connected')}</span>
                </div>
                <p style={{ margin: 0, fontSize: '12px', opacity: 0.85 }}>
                  {t('providers.oauth.builtin_info')}
                </p>
              </div>
            ) : (
              <ProviderConfigFields
                formData={modalForm.formData}
                setFormData={modalForm.setFormData}
                isEditing={modalForm.isEditing}
                showApiKey={modalForm.showApiKey}
                setShowApiKey={modalForm.setShowApiKey}
                t={t}
              />
            )}

            {/* Section 2: Models Builder */}
            <ProviderModelDraftList
              models={modalForm.formData.models}
              providerId={modalForm.formData.id}
              editingModelId={modalForm.editingModelId}
              modelThinkingLevels={modelThinkingLevels}
              isFetchingModelsInModal={modalForm.isFetchingModelsInModal}
              isAutoDiscovering={modalForm.isAutoDiscovering}
              autoDiscoveryNotice={modalForm.autoDiscoveryNotice}
              onFetchModels={modalForm.handleFetchModelsInModal}
              onStartEditModel={modalForm.handleStartEditModel}
              onExcludeModel={modalForm.handleExcludeModel}
              onRemoveModelFromDraft={modalForm.handleRemoveModelFromDraft}
              t={t}
            />

            <ModelSubform
              isAddModelOpen={modalForm.isAddModelOpen}
              setIsAddModelOpen={modalForm.setIsAddModelOpen}
              editingModelId={modalForm.editingModelId}
              modelError={modalForm.modelError}
              newModelId={modalForm.newModelId}
              newModelName={modalForm.newModelName}
              setNewModelName={modalForm.setNewModelName}
              newModelContext={modalForm.newModelContext}
              setNewModelContext={modalForm.setNewModelContext}
              newModelMaxTokens={modalForm.newModelMaxTokens}
              setNewModelMaxTokens={modalForm.setNewModelMaxTokens}
              newModelReasoning={modalForm.newModelReasoning}
              setNewModelReasoning={modalForm.setNewModelReasoning}
              newModelThinkingLevel={modalForm.newModelThinkingLevel}
              setNewModelThinkingLevel={modalForm.setNewModelThinkingLevel}
              newModelSupportsImage={modalForm.newModelSupportsImage}
              setNewModelSupportsImage={modalForm.setNewModelSupportsImage}
              supportedThinkingLevels={modalForm.supportedThinkingLevels}
              onModelIdChange={modalForm.handleModelIdChange}
              onSaveEditedModel={modalForm.handleSaveEditedModel}
              onCancelEditModel={modalForm.handleCancelEditModel}
              onAddModelToDraft={modalForm.handleAddModelToDraft}
              t={t}
            />

            {/* Section 3: Included Models (Include-Only) */}
            <IncludedModelsSection
              includedModels={modalForm.formData.includedModels}
              isIncludedOpen={modalForm.isIncludedOpen}
              setIsIncludedOpen={modalForm.setIsIncludedOpen}
              includedSectionRef={modalForm.includedSectionRef}
              newIncludedInput={modalForm.newIncludedInput}
              setNewIncludedInput={modalForm.setNewIncludedInput}
              onRemoveIncludedModel={modalForm.handleRemoveIncludedModel}
              onAddIncludedPattern={modalForm.handleAddIncludedPattern}
              t={t}
            />

            {/* Section 4: Excluded Models */}
            <ExcludedModelsSection
              excludedModels={modalForm.formData.excludedModels}
              isExcludedOpen={modalForm.isExcludedOpen}
              setIsExcludedOpen={modalForm.setIsExcludedOpen}
              excludedSectionRef={modalForm.excludedSectionRef}
              newExcludedInput={modalForm.newExcludedInput}
              setNewExcludedInput={modalForm.setNewExcludedInput}
              onRemoveExcludedModel={modalForm.handleRemoveExcludedModel}
              onAddExcludedPattern={modalForm.handleAddExcludedPattern}
              t={t}
            />
          </div>

          <footer className="modal-footer">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={isSaving}
            >
              {isSaving ? t('action.saving') : t('providers.btn_save_provider')}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={modalForm.closeModal}
              disabled={isSaving}
            >
              {t('action.cancel')}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
};
