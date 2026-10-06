import React, { useEffect, useMemo, useState } from 'react';
import { openExternalUrl } from '@infra/opener';
import { getPiChainsPi, type PiChain } from '@infra/bridge';
import { translate, type SupportedLocale, type TranslationKey } from '@shared/i18n';
import { useProfiles } from './hooks/useProfiles';
import { ProfileCard } from './components/ProfileCard';
import { ProfileModal } from './components/ProfileModal';
import {
  computeProfileCounts,
  filterProfiles,
  type ProfileScope,
  type ProfilesViewProps,
} from './types';

const getActiveLocale = (): SupportedLocale => {
  if (typeof document !== 'undefined' && document.documentElement?.lang === 'en') {
    return 'en';
  }
  return 'es';
};

export const ProfilesView: React.FC<ProfilesViewProps> = ({
  cwd,
  isBusy = false,
  onClose: _onClose,
  t,
}) => {
  const {
    profiles,
    effectiveActiveProfile: _effectiveActiveProfile,
    effectiveScope,
    categories,
    agentMeta,
    availableModels,
    modelThinkingLevels,
    isLoading,
    error,
    successNotice,
    activatingName,
    deletingName,
    isDeleting,
    refreshProfiles,
    handleActivateProfile,
    handleClearProjectActive,
    handleDeleteProfile,
    clearNotices,
    isModalOpen,
    isEditing,
    isSaving,
    modalError,
    formData,
    openCreateModal,
    openEditModal,
    openDuplicateModal,
    closeModal,
    updateFormField,
    updateAgentModel,
    removeAgentOverride,
    handleSaveProfile,
  } = useProfiles({ cwd });

  const [searchQuery, setSearchQuery] = useState<string>('');
  const [scopeFilter, setScopeFilter] = useState<'all' | ProfileScope>('all');
  const [chains, setChains] = useState<PiChain[]>([]);

  useEffect(() => {
    let active = true;
    getPiChainsPi()
      .then((c) => {
        if (active && c) setChains(c);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const tLocal = (key: TranslationKey, params?: Record<string, string | number>): string => {
    return t ? t(key, params) : translate(getActiveLocale(), key, params);
  };

  // Compute profile counts
  const counts = useMemo(() => computeProfileCounts(profiles), [profiles]);

  // Filter profiles by search query and scope filter
  const filteredProfiles = useMemo(
    () => filterProfiles(profiles, searchQuery, scopeFilter),
    [profiles, searchQuery, scopeFilter]
  );

  const handleOpenExternal = (e: React.MouseEvent, url: string) => {
    e.preventDefault();
    void openExternalUrl(url);
  };

  return (
    <>
      {/* Toolbar */}
      <div className="settings-pane-toolbar profiles-toolbar">
        <div className="profiles-search-box">
          <svg
            className="profiles-search-icon"
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
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            className="profiles-search-input"
            placeholder={tLocal('profiles.search_placeholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="Buscar perfiles"
          />
          {searchQuery && (
            <button
              type="button"
              className="profiles-search-clear-btn"
              onClick={() => setSearchQuery('')}
              aria-label="Limpiar búsqueda"
              title="Limpiar búsqueda"
            >
              ✕
            </button>
          )}
        </div>

        <div className="profiles-toolbar-actions">
          <span className="profiles-stat-pill profiles-stat-total">
            {tLocal('profiles.stat_total', { count: counts.total })}
          </span>
          <span className="profiles-stat-pill profiles-stat-global">
            {tLocal('profiles.stat_global', { count: counts.global })}
          </span>
          <span className="profiles-stat-pill profiles-stat-project">
            {tLocal('profiles.stat_project', { count: counts.project })}
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-sm profiles-reload-btn"
            onClick={() => void refreshProfiles()}
            disabled={isLoading || isBusy}
            title={tLocal('profiles.reload')}
          >
            <svg
              className={`profiles-refresh-icon ${isLoading ? 'spin' : ''}`}
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
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            <span>{tLocal('profiles.reload')}</span>
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm profiles-add-btn"
            onClick={openCreateModal}
            disabled={isLoading || isBusy}
            title={tLocal('profiles.btn_create_profile')}
          >
            {tLocal('profiles.btn_create_profile')}
          </button>
        </div>
      </div>

      {/* Scrollable Body */}
      <div className="settings-view-body profiles-view-body">
        {/* Attribution Banner */}
        <section className="profiles-attribution-banner" aria-label="Reconocimiento y agradecimientos">
          <div className="profiles-attribution-icon-col" aria-hidden="true">
            <svg
              className="profiles-heart-icon"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
            </svg>
          </div>

          <div className="profiles-attribution-content">
            <div className="profiles-attribution-header">
              <span className="profiles-attribution-badge">Arquitectura comunitaria</span>
              <span className="profiles-attribution-tagline">
                Inspirado y desarrollado con base en la obra de{' '}
                <a
                  href="https://github.com/CinloDev/"
                  onClick={(e) => handleOpenExternal(e, 'https://github.com/CinloDev/')}
                  className="profiles-attribution-author"
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  @CinloDev
                </a>
              </span>
            </div>

            <p className="profiles-attribution-desc">
              Agradecemos especialmente a <strong>CinloDev</strong> por diseñar el sistema original{' '}
              <a
                href="https://github.com/CinloDev/pi-sdd-profiles"
                onClick={(e) => handleOpenExternal(e, 'https://github.com/CinloDev/pi-sdd-profiles')}
                className="profiles-attribution-repo"
                rel="noopener noreferrer"
                target="_blank"
              >
                pi-sdd-profiles
              </a>
              , pionero en el desacoplamiento de modelos, categorización de subagentes y persistencia de
              perfiles por ámbito para Spec-Driven Development.
            </p>
          </div>

          <div className="profiles-attribution-actions">
            <a
              href="https://github.com/CinloDev/pi-sdd-profiles"
              onClick={(e) => handleOpenExternal(e, 'https://github.com/CinloDev/pi-sdd-profiles')}
              className="btn btn-secondary btn-sm profiles-attribution-link"
              rel="noopener noreferrer"
              target="_blank"
              title="Ver repositorio original en GitHub"
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
                <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
              </svg>
              <span>GitHub / pi-sdd-profiles</span>
            </a>
          </div>
        </section>

        {/* Notices */}
        {error && (
          <div className="profiles-banner profiles-error-banner" role="alert">
            <div className="profiles-banner-content">
              <span>{error}</span>
            </div>
            <button
              type="button"
              className="profiles-banner-dismiss"
              onClick={clearNotices}
              aria-label="Cerrar aviso de error"
            >
              ✕
            </button>
          </div>
        )}

        {successNotice && (
          <div className="profiles-banner profiles-success-banner" role="status">
            <div className="profiles-banner-content">
              <span>{successNotice}</span>
            </div>
            <button
              type="button"
              className="profiles-banner-dismiss"
              onClick={clearNotices}
              aria-label="Cerrar aviso de éxito"
            >
              ✕
            </button>
          </div>
        )}

        {/* Scope Filter Tabs */}
        <div className="profiles-scope-tabs" role="tablist" aria-label="Filtrar por ámbito">
          <button
            type="button"
            role="tab"
            aria-selected={scopeFilter === 'all'}
            className={`profiles-tab ${scopeFilter === 'all' ? 'active' : ''}`}
            onClick={() => setScopeFilter('all')}
          >
            {tLocal('profiles.tab_all')} <span className="profiles-tab-count">{counts.total}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scopeFilter === 'global'}
            className={`profiles-tab ${scopeFilter === 'global' ? 'active' : ''}`}
            onClick={() => setScopeFilter('global')}
          >
            {tLocal('profiles.tab_global')} <span className="profiles-tab-count">{counts.global}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scopeFilter === 'project'}
            className={`profiles-tab ${scopeFilter === 'project' ? 'active' : ''}`}
            onClick={() => setScopeFilter('project')}
          >
            {tLocal('profiles.tab_project')} <span className="profiles-tab-count">{counts.project}</span>
          </button>
        </div>

        {/* Profiles Grid or States */}
        {isLoading ? (
          <div className="profiles-loading-state">
            <div className="spinner" />
            <span>Cargando perfiles de modelos...</span>
          </div>
        ) : profiles.length === 0 ? (
          <div className="profiles-empty-state">
            <div className="profiles-empty-icon" aria-hidden="true">
              <svg
                width="40"
                height="40"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            </div>
            <h3 className="profiles-empty-title">
              {tLocal('profiles.empty_title')}
            </h3>
            <p className="profiles-empty-desc">
              {tLocal('profiles.empty_desc')}
            </p>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={openCreateModal}
            >
              {tLocal('profiles.empty_create_btn')}
            </button>
          </div>
        ) : filteredProfiles.length === 0 ? (
          <div className="profiles-empty-state profiles-no-results">
            <p className="profiles-empty-desc">
              {tLocal('profiles.no_results')}
            </p>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                setSearchQuery('');
                setScopeFilter('all');
              }}
            >
              {tLocal('profiles.reset_filters')}
            </button>
          </div>
        ) : (
          <div className="profiles-grid">
            {filteredProfiles.map((profile) => (
              <ProfileCard
                key={`${profile.scope}-${profile.name}`}
                profile={profile}
                isActive={profile.is_active}
                effectiveScope={effectiveScope}
                cwd={cwd}
                isActivating={activatingName === profile.name}
                isDeleting={isDeleting && deletingName === profile.name}
                onActivate={handleActivateProfile}
                onClearActive={handleClearProjectActive}
                onEdit={openEditModal}
                onDuplicate={openDuplicateModal}
                onDelete={handleDeleteProfile}
              />
            ))}
          </div>
        )}

        {/* Pi Execution Chains Section */}
        {chains.length > 0 && (
          <div className="profiles-chains-section">
            <div className="profiles-section-header">
              <h3 className="profiles-section-title">Cadenas de Trabajo / Chains ({chains.length})</h3>
              <p className="profiles-section-subtitle">
                Pipelines coordinados de subagentes para planificación, verificación y revisión formal.
              </p>
            </div>
            <div className="chains-grid">
              {chains.map((chain) => (
                <div key={chain.name} className="chain-card">
                  <div className="chain-card-header">
                    <span className="chain-badge">Chain</span>
                    <h4 className="chain-name">{chain.name}</h4>
                  </div>
                  <p className="chain-desc">{chain.description}</p>
                  <div className="chain-steps">
                    <span className="chain-steps-label">Flujo de ejecución:</span>
                    <div className="chain-steps-flow">
                      {chain.steps.map((st, sIdx) => (
                        <React.Fragment key={st.name}>
                          <span className="chain-step-chip" title={st.description || st.name}>
                            {st.name}
                          </span>
                          {sIdx < chain.steps.length - 1 && <span className="chain-step-arrow">→</span>}
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Modal Dialog */}
      <ProfileModal
        isOpen={isModalOpen}
        isEditing={isEditing}
        isSaving={isSaving}
        formData={formData}
        error={modalError}
        availableModels={availableModels}
        categories={categories}
        agentMeta={agentMeta}
        modelThinkingLevels={modelThinkingLevels}
        cwd={cwd}
        onClose={closeModal}
        onChangeField={updateFormField}
        onChangeAgentModel={updateAgentModel}
        onRemoveAgentOverride={removeAgentOverride}
        onSave={(e) => void handleSaveProfile(e)}
      />
    </>
  );
};
