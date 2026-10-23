import React from 'react';
import type { SupportedLocale, TranslationKey } from '@shared/i18n';
import type { BuiltinOAuthProviderStatus } from '@core/types/oauth';
import type { CustomModelDefinition, CustomProviderConfig } from '@core/types/providers';
import type { ModelInfo } from '@core/types/models';
import { getBuiltinProviderCatalogPi } from '@infra/bridge';
import { isPiBuiltinProvider } from './providers';
import { useProvidersData } from './hooks/useProvidersData';
import { useProviderModalForm } from './hooks/useProviderModalForm';
import { useBuiltinOAuthAccounts } from './hooks/useBuiltinOAuthAccounts';
import { ProvidersHeader } from './components/ProvidersHeader';
import { BuiltinOAuthAccounts } from './components/BuiltinOAuthAccounts';
import { RawJsonViewer } from './components/RawJsonViewer';
import { ProviderCard } from './components/ProviderCard';
import { ProviderModal } from './components/ProviderModal';

export interface ProvidersViewProps {
  onRefreshModels?: () => Promise<void>;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  language: SupportedLocale;
  isBusy?: boolean;
  oauthOverride?: ReturnType<typeof useBuiltinOAuthAccounts>;
  providersDataOverride?: Partial<ReturnType<typeof useProvidersData>>;
}

export const ProvidersView: React.FC<ProvidersViewProps> = ({
  onRefreshModels,
  t,
  isBusy = false,
  oauthOverride,
  providersDataOverride,
}) => {
  const internalData = useProvidersData({ t, onRefreshModels });
  const data = providersDataOverride ? { ...internalData, ...providersDataOverride } : internalData;
  const internalOauth = useBuiltinOAuthAccounts({ t, onRefreshModels });
  const oauth = oauthOverride ?? internalOauth;

  const modalForm = useProviderModalForm({
    t,
    modelThinkingLevels: data.modelThinkingLevels,
    updateModelThinkingLevelsMap: data.updateModelThinkingLevelsMap,
    saveProvider: data.saveProvider,
  });

  const customProviders = React.useMemo(() => {
    return (data.providers || []).filter((p) => !isPiBuiltinProvider(p));
  }, [data.providers]);

  const [loadingCatalogProviderId, setLoadingCatalogProviderId] = React.useState<string | null>(null);

  const handleOpenEditBuiltinModels = async (provider: BuiltinOAuthProviderStatus) => {
    const savedConfig = data.fullConfig.providers?.[provider.id]
      ? ({ id: provider.id, ...data.fullConfig.providers[provider.id] } as CustomProviderConfig)
      : undefined;

    const isRegisteredInModelsJson = Boolean(
      savedConfig && (
        (savedConfig.models && savedConfig.models.length > 0) ||
        (savedConfig.includedModels && savedConfig.includedModels.length > 0) ||
        (savedConfig.excludedModels && savedConfig.excludedModels.length > 0) ||
        savedConfig.isBuiltin
      )
    );

    if (isRegisteredInModelsJson && savedConfig) {
      modalForm.openEditBuiltinModal(provider, savedConfig.models || [], savedConfig);
      return;
    }

    setLoadingCatalogProviderId(provider.id);
    try {
      let catalogModels: ModelInfo[] = [];
      try {
        catalogModels = await getBuiltinProviderCatalogPi(provider.id);
      } catch {
        // Proceed with empty catalog fallback
      }

      const catalogDefs: CustomModelDefinition[] = catalogModels
        .filter(
          (m) =>
            typeof m.id === 'string' &&
            m.id.trim() !== '' &&
            (!('provider' in m) || !m.provider || m.provider.toLowerCase() === provider.id.toLowerCase())
        )
        .map((m) => ({
          id: (m.id || '').trim(),
          name: m.name || m.id,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          reasoning: m.reasoning,
          reasoningEfforts: (m as any).reasoningEfforts,
          input: m.input || (m as any).input_modalities || ['text'],
          thinkingLevel: m.thinkingLevel,
          defaultThinkingLevel: m.defaultThinkingLevel,
        }));

      const initialBuiltinConfig: CustomProviderConfig = {
        id: provider.id,
        name: provider.name || provider.id,
        models: catalogDefs,
        excludedModels: [],
        includedModels: [],
        isBuiltin: true,
      };

      if (catalogDefs.length > 0) {
        try {
          await data.saveProvider(
            {
              id: provider.id,
              name: provider.name || provider.id,
              baseUrl: '',
              api: '',
              apiKey: '',
              models: catalogDefs,
              excludedModels: [],
              includedModels: [],
              isBuiltin: true,
            },
            false,
            true
          );
        } catch {
          // Proceed to open modal even if silent auto-persist failed
        }
      }

      modalForm.openEditBuiltinModal(provider, catalogDefs, initialBuiltinConfig);
    } finally {
      setLoadingCatalogProviderId(null);
    }
  };

  return (
    <>
      <ProvidersHeader
        t={t}
        showRawJson={data.showRawJson}
        onToggleRawJson={() => data.setShowRawJson((prev) => !prev)}
        onOpenAddModal={modalForm.openAddModal}
        isSaving={data.isSaving}
        isBusy={isBusy}
      />

      <div className="settings-view-body providers-view-body">
        {data.error && (
          <div className="validation-error-banner" role="alert">
            <span>{data.error}</span>
          </div>
        )}

        {data.successNotice && (
          <div className="storage-warning-banner providers-success-banner" role="status">
            <span>{data.successNotice}</span>
          </div>
        )}

        {data.showRawJson && (
          <RawJsonViewer
            fullConfig={data.fullConfig}
            copiedRawJson={data.copiedRawJson}
            onCopyRawJson={data.handleCopyRawJson}
            t={t}
          />
        )}

        {/* Standalone Built-in OAuth Account Section */}
        <BuiltinOAuthAccounts
          oauth={oauth}
          t={t}
          isBusy={isBusy}
          onOpenEditModels={handleOpenEditBuiltinModels}
          loadingCatalogProviderId={loadingCatalogProviderId}
        />

        {/* Separate Custom Provider Editor Section (models.json) */}
        <section className="custom-providers-section" aria-labelledby="custom-providers-heading">
          <div className="custom-providers-section-header">
            <div className="custom-providers-header-text">
              <div className="custom-providers-title-row">
                <h2 id="custom-providers-heading" className="custom-providers-title">
                  {t('providers.custom_section_title')}
                </h2>
                <span className="badge badge-subtle">{customProviders.length}</span>
              </div>
              <p className="custom-providers-subtitle">
                {t('providers.custom_section_subtitle')}
              </p>
            </div>
            <div className="custom-providers-header-actions">
              <button
                type="button"
                className="btn btn-primary btn-sm btn-add-provider"
                onClick={modalForm.openAddModal}
                disabled={data.isSaving || isBusy}
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

          {data.isLoading ? (
            <div className="providers-loading-state">
              <div className="spinner" />
              <span>{t('providers.loading')}</span>
            </div>
          ) : customProviders.length === 0 ? (
            <div className="providers-empty-state">
              <div className="providers-empty-icon" aria-hidden="true">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
                  <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
                  <line x1="6" y1="6" x2="6.01" y2="6" />
                  <line x1="6" y1="18" x2="6.01" y2="18" />
                </svg>
              </div>
              <h3 className="providers-empty-title">{t('providers.empty_title')}</h3>
              <p className="providers-empty-text">{t('providers.empty_text')}</p>
              <button
                type="button"
                className="btn btn-primary btn-add-provider"
                onClick={modalForm.openAddModal}
              >
                {t('providers.btn_add_provider')}
              </button>
            </div>
          ) : (
            <div className="providers-grid">
              {customProviders.map((provider) => (
                <ProviderCard
                  key={provider.id}
                  provider={provider}
                  modelThinkingLevels={data.modelThinkingLevels}
                  deletingId={data.deletingId}
                  isSaving={data.isSaving}
                  isBusy={isBusy}
                  onOpenEditModal={modalForm.openEditModal}
                  onSetDeletingId={data.setDeletingId}
                  onDeleteProvider={data.handleDeleteProvider}
                  t={t}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      <ProviderModal
        modalForm={modalForm}
        modelThinkingLevels={data.modelThinkingLevels}
        isSaving={data.isSaving}
        t={t}
      />
    </>
  );
};
