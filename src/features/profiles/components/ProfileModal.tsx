import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  type ReasoningEffort,
  isSyntheticAgentKey,
} from '@core/types/profiles';
import {
  type ModelInfo,
  type ModelThinkingLevelsMap,
  getSupportedReasoningEffortsForModel,
  resolveModelDefaultThinkingLevel,
} from '@core/types/models';
import { getModelThinkingLevelsPi } from '@infra/bridge';
import { translate, type SupportedLocale, type TranslationKey } from '@shared/i18n';
import { findModelInCatalog } from '../lib/approvedModels';
import { resolveCompatibleEffort } from '../lib/effort';
import type { ProfileModalProps } from '../types';
import { ModelSelect } from './ModelSelect';
import { EffortSelect } from './EffortSelect';

const getActiveLocale = (): SupportedLocale => {
  if (typeof document !== 'undefined' && document.documentElement.lang === 'es') {
    return 'es';
  }
  return 'en';
};

const tLocal = (key: TranslationKey, params?: Record<string, string | number>): string => {
  return translate(getActiveLocale(), key, params);
};

export const ProfileModal: React.FC<ProfileModalProps> = ({
  isOpen,
  isEditing,
  isSaving,
  formData,
  error,
  availableModels,
  categories,
  agentMeta,
  modelThinkingLevels: modelThinkingLevelsProp,
  cwd,
  onClose,
  onChangeField,
  onChangeAgentModel,
  onRemoveAgentOverride,
  onSave,
}) => {
  const [internalThinkingLevels, setInternalThinkingLevels] = useState<ModelThinkingLevelsMap>({});

  useEffect(() => {
    if (modelThinkingLevelsProp) return;
    let active = true;
    getModelThinkingLevelsPi()
      .then((levels) => {
        if (active && levels) setInternalThinkingLevels(levels);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [modelThinkingLevelsProp]);

  const modelThinkingLevels = modelThinkingLevelsProp || internalThinkingLevels;

  const getInheritEffortLabel = (effort: string | undefined): string => {
    if (!effort) return 'defecto';
    try {
      return tLocal(`thinking_level.${effort}` as TranslationKey) || effort;
    } catch {
      return effort;
    }
  };

  // Accordion state: dynamically expanded first category when available
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    () => (categories.length > 0 ? new Set([categories[0].id]) : new Set())
  );
  const autoExpandedRef = useRef(false);

  useEffect(() => {
    if (!autoExpandedRef.current && categories.length > 0) {
      autoExpandedRef.current = true;
      setExpandedCategories(new Set([categories[0].id]));
    }
  }, [categories]);

  useEffect(() => {
    if (!isOpen) {
      autoExpandedRef.current = false;
      setExpandedCategories(new Set());
    }
  }, [isOpen]);

  const installedAgentKeys = useMemo(() => {
    return new Set(categories.flatMap((c) => c.agents));
  }, [categories]);

  const legacyOverrides = useMemo(() => {
    return Object.keys(formData.model_profiles || {})
      .filter((k) => !installedAgentKeys.has(k) && !isSyntheticAgentKey(k))
      .sort((a, b) => a.localeCompare(b));
  }, [formData.model_profiles, installedAgentKeys]);

  // Keyboard Esc listener
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSaving) {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isSaving, onClose]);

  // Strictly accepted provider models from ~/.pi/agent/models.json
  const allAvailableModels = useMemo<ModelInfo[]>(() => {
    const seen = new Set<string>();
    const result: ModelInfo[] = [];
    for (const m of availableModels) {
      if (m.id && !seen.has(m.id)) {
        seen.add(m.id);
        result.push(m);
      }
    }
    return result;
  }, [availableModels]);

  const selectedMainModel = useMemo(() => {
    return findModelInCatalog(allAvailableModels, formData.default_model);
  }, [allAvailableModels, formData.default_model]);

  const mainSupportedEfforts = useMemo(() => {
    return getSupportedReasoningEffortsForModel(selectedMainModel);
  }, [selectedMainModel]);

  const handleMainModelChange = (newModelId: string) => {
    const nextMainModel = findModelInCatalog(allAvailableModels, newModelId);
    const nextSupportedEfforts = getSupportedReasoningEffortsForModel(nextMainModel);

    // On selecting/changing orchestrator model, set default_effort to canonical resolved default for the selected model
    const nextDefaultEffort = newModelId
      ? resolveModelDefaultThinkingLevel(
          nextMainModel,
          modelThinkingLevels,
          nextSupportedEfforts
        )
      : '';

    // Ensure effort compatibility for agents inheriting the main model
    const nextModelProfiles = { ...formData.model_profiles };
    let profilesChanged = false;

    for (const [agentKey, entry] of Object.entries(nextModelProfiles)) {
      if (!entry?.model || entry.model.trim() === '') {
        // This agent inherits main model
        if (entry?.effort) {
          const compatibleAgentEffort = resolveCompatibleEffort(
            entry.effort,
            nextSupportedEfforts
          );
          if (compatibleAgentEffort !== entry.effort) {
            nextModelProfiles[agentKey] = {
              ...entry,
              effort: compatibleAgentEffort ? compatibleAgentEffort : undefined,
            };
            profilesChanged = true;
          }
        }
      }
    }

    onChangeField('default_model', newModelId);
    onChangeField('default_effort', (nextDefaultEffort as ReasoningEffort) || '');
    if (profilesChanged) {
      onChangeField('model_profiles', nextModelProfiles);
    }
  };

  const handleDefaultEffortChange = (val: ReasoningEffort | '') => {
    if (val === '') {
      onChangeField('default_effort', '');
      return;
    }
    const compatibleEffort = resolveCompatibleEffort(val, mainSupportedEfforts);
    onChangeField('default_effort', compatibleEffort);
  };

  const handleAgentModelChange = (
    agentKey: string,
    newModelId: string,
    _currentEffort?: ReasoningEffort | ''
  ) => {
    const trimmed = (newModelId || '').trim();
    if (!trimmed) {
      // Switched to inherit main model: preserve inherit behavior
      onChangeAgentModel(agentKey, '', '');
      return;
    }

    const targetModel = findModelInCatalog(allAvailableModels, trimmed);
    const targetSupported = getSupportedReasoningEffortsForModel(targetModel);
    const resolvedEffort = resolveModelDefaultThinkingLevel(
      targetModel,
      modelThinkingLevels,
      targetSupported
    );

    onChangeAgentModel(agentKey, trimmed, (resolvedEffort as ReasoningEffort) || '');
  };

  const handleAgentEffortChange = (
    agentKey: string,
    currentModelId: string,
    newEffort: ReasoningEffort | ''
  ) => {
    if (newEffort === '') {
      onChangeAgentModel(agentKey, currentModelId, '');
      return;
    }

    const effectiveModelId = currentModelId || formData.default_model;
    const effectiveModel = findModelInCatalog(
      allAvailableModels,
      effectiveModelId
    ) || (currentModelId ? null : selectedMainModel);
    const effectiveSupportedEfforts = getSupportedReasoningEffortsForModel(effectiveModel);

    const compatibleEffort = resolveCompatibleEffort(
      newEffort,
      effectiveSupportedEfforts
    );

    onChangeAgentModel(agentKey, currentModelId, compatibleEffort);
  };

  if (!isOpen) {
    return null;
  }

  const toggleCategory = (categoryId: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(categoryId)) {
        next.delete(categoryId);
      } else {
        next.add(categoryId);
      }
      return next;
    });
  };

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && !isSaving) {
      onClose();
    }
  };

  const titleId = 'profile-modal-title';

  return (
    <div
      className="profile-modal-backdrop"
      onClick={handleBackdropClick}
      role="presentation"
    >
      <div
        className="profile-modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        {/* Header */}
        <div className="profile-modal-header">
          <div className="profile-modal-title-group">
            <h2 id={titleId} className="profile-modal-title">
              {isEditing ? 'Editar Perfil de Modelos' : 'Crear Nuevo Perfil de Modelos'}
            </h2>
            <p className="profile-modal-subtitle">
              Configura el modelo del orquestador y las asignaciones dedicadas para cada subagente.
            </p>
          </div>
          <button
            type="button"
            className="profile-modal-close-btn"
            onClick={onClose}
            disabled={isSaving}
            aria-label="Cerrar modal"
            title="Cerrar (Esc)"
          >
            <svg
              width="18"
              height="18"
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

        {/* Form Body */}
        <form onSubmit={onSave} className="profile-modal-form">
          <div className="profile-modal-body">
            {/* Error Banner */}
            {error && (
              <div className="profile-error-banner" role="alert">
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
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <span>{error}</span>
              </div>
            )}

            {/* General Information Section */}
            <fieldset className="profile-form-section">
              <legend className="profile-section-legend">Información General</legend>

              <div className="profile-form-grid">
                <div className="profile-form-group profile-col-span-2">
                  <label htmlFor="profile-name-input" className="profile-form-label">
                    Nombre del perfil <span className="profile-required">*</span>
                  </label>
                  <input
                    id="profile-name-input"
                    type="text"
                    className="profile-input"
                    placeholder="p. ej. balanced-custom, deep-sdd, turbo-local"
                    value={formData.name}
                    onChange={(e) => onChangeField('name', e.target.value)}
                    required
                    disabled={isSaving}
                    autoFocus
                  />
                  <span className="profile-field-hint">
                    Identificador único para el archivo de configuración (.json).
                  </span>
                </div>

                <div className="profile-form-group profile-col-span-2">
                  <label htmlFor="profile-desc-input" className="profile-form-label">
                    Descripción
                  </label>
                  <textarea
                    id="profile-desc-input"
                    className="profile-textarea"
                    rows={2}
                    placeholder="Describe el propósito de este perfil (ej. optimizado para arquitectura y revisión estricta)"
                    value={formData.description}
                    onChange={(e) => onChangeField('description', e.target.value)}
                    disabled={isSaving}
                  />
                </div>

                <div className="profile-form-group profile-col-span-2">
                  <span className="profile-form-label">Ámbito de guardado</span>
                  <div className="profile-scope-radio-grid">
                    <label
                      className={`profile-scope-card ${
                        formData.scope === 'global' ? 'selected' : ''
                      }`}
                    >
                      <input
                        type="radio"
                        name="profile-scope"
                        value="global"
                        checked={formData.scope === 'global'}
                        onChange={() => onChangeField('scope', 'global')}
                        disabled={isSaving}
                      />
                      <div className="profile-scope-card-content">
                        <span className="profile-scope-card-title">Global (~/.pi/agent/profiles/)</span>
                        <span className="profile-scope-card-desc">
                          Disponible en todos tus proyectos y sesiones.
                        </span>
                      </div>
                    </label>

                    <label
                      className={`profile-scope-card ${
                        formData.scope === 'project' ? 'selected' : ''
                      } ${!cwd ? 'disabled' : ''}`}
                      title={!cwd ? 'Requiere un proyecto abierto' : undefined}
                    >
                      <input
                        type="radio"
                        name="profile-scope"
                        value="project"
                        checked={formData.scope === 'project'}
                        onChange={() => onChangeField('scope', 'project')}
                        disabled={isSaving || !cwd}
                      />
                      <div className="profile-scope-card-content">
                        <span className="profile-scope-card-title">Proyecto actual (.pi/profiles/)</span>
                        <span className="profile-scope-card-desc">
                          {cwd
                            ? 'Exclusivo para este repositorio de trabajo.'
                            : 'Requiere tener un proyecto activo seleccionado.'}
                        </span>
                      </div>
                    </label>
                  </div>
                </div>
              </div>
            </fieldset>

            {/* Main / Orchestrator Model Section */}
            <fieldset className="profile-form-section profile-highlight-section">
              <legend className="profile-section-legend">
                Modelo Principal / Orquestador
              </legend>
              <p className="profile-section-desc">
                Este modelo será utilizado por el orquestador principal y actuará como modelo base
                predeterminado para cualquier subagente que no tenga una regla específica asignada.
              </p>

              <div className="profile-form-grid profile-main-model-grid">
                <div className="profile-form-group">
                  <label htmlFor="profile-default-model-input" className="profile-form-label">
                    Modelo Principal
                  </label>
                  <ModelSelect
                    id="profile-default-model-input"
                    value={formData.default_model}
                    onChange={handleMainModelChange}
                    availableModels={allAvailableModels}
                    disabled={isSaving}
                    placeholder="Selecciona un modelo (ej. anthropic/claude-sonnet-4-5)"
                    aria-label="Modelo Principal"
                  />
                </div>

                <div className="profile-form-group">
                  <label htmlFor="profile-default-effort-select" className="profile-form-label">
                    Esfuerzo de razonamiento (thinking)
                  </label>
                  <EffortSelect
                    id="profile-default-effort-select"
                    value={formData.default_effort}
                    onChange={handleDefaultEffortChange}
                    supportedEfforts={mainSupportedEfforts}
                    disabled={isSaving}
                    aria-label="Esfuerzo de razonamiento del modelo principal"
                  />
                </div>
              </div>
            </fieldset>

            {/* Subagents configuration by Category */}
            <fieldset className="profile-form-section">
              <legend className="profile-section-legend">
                Configuración de Subagentes por Categoría
              </legend>
              <p className="profile-section-desc">
                Personaliza qué modelo y nivel de razonamiento ejecuta cada subagente. Los subagentes
                sin asignación heredarán automáticamente el modelo principal.
              </p>

              <div className="profile-accordions-list">
                {categories.length === 0 && legacyOverrides.length === 0 ? (
                  <div className="profile-empty-agents-state">
                    <div className="profile-empty-agents-icon">🤖</div>
                    <div className="profile-empty-agents-content">
                      <h4 className="profile-empty-agents-title">
                        {tLocal('profiles.empty_subagents_title')}
                      </h4>
                      <p className="profile-empty-agents-desc">
                        {tLocal('profiles.empty_subagents_desc')}
                      </p>
                    </div>
                  </div>
                ) : (
                  <>
                    {categories.map((cat) => {
                      const isExpanded = expandedCategories.has(cat.id);
                      const assignedCount = cat.agents.filter(
                        (agentKey) =>
                          formData.model_profiles[agentKey]?.model &&
                          formData.model_profiles[agentKey].model.trim() !== ''
                      ).length;

                      return (
                        <div
                          key={cat.id}
                          className={`profile-accordion-item ${isExpanded ? 'expanded' : ''}`}
                        >
                          <button
                            type="button"
                            className="profile-accordion-header"
                            onClick={() => toggleCategory(cat.id)}
                            aria-expanded={isExpanded}
                          >
                            <div className="profile-accordion-header-info">
                              <span className="profile-accordion-title">{cat.name}</span>
                              <span className="profile-accordion-desc">{cat.description}</span>
                            </div>

                            <div className="profile-accordion-header-meta">
                              <span
                                className={`profile-accordion-badge ${
                                  assignedCount > 0 ? 'has-overrides' : ''
                                }`}
                              >
                                {assignedCount} / {cat.agents.length} personalizados
                              </span>
                              <svg
                                className="profile-accordion-chevron"
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
                                <polyline points="6 9 12 15 18 9" />
                              </svg>
                            </div>
                          </button>

                          {isExpanded && (
                            <div className="profile-accordion-content">
                              <div className="profile-agents-table">
                                <div className="profile-agents-table-header">
                                  <span className="profile-col-agent">Subagente</span>
                                  <span className="profile-col-model">Modelo Asignado</span>
                                  <span className="profile-col-effort">Razonamiento</span>
                                  <span className="profile-col-actions">Acción</span>
                                </div>

                                <div className="profile-agents-table-body">
                                  {cat.agents.map((agentKey) => {
                                    const currentEntry = formData.model_profiles[agentKey];
                                    const hasOverride = Boolean(
                                      currentEntry?.model && currentEntry.model.trim() !== ''
                                    );
                                    const currentModel = currentEntry?.model || '';
                                    const currentEffort = currentEntry?.effort || '';

                                    const effectiveSubagentModelId = currentModel || formData.default_model;
                                    const selectedSubagentModel = findModelInCatalog(
                                      allAvailableModels,
                                      effectiveSubagentModelId
                                    ) || (currentModel ? null : selectedMainModel);
                                    const subagentSupportedEfforts =
                                      getSupportedReasoningEffortsForModel(selectedSubagentModel);

                                    return (
                                      <div
                                        key={agentKey}
                                        className={`profile-agent-row ${
                                          hasOverride ? 'has-override' : ''
                                        }`}
                                      >
                                        <div className="profile-col-agent">
                                          <code className="profile-agent-name">{agentKey}</code>
                                          {agentMeta?.[agentKey]?.description && (
                                            <div className="profile-agent-desc-hint" title={agentMeta[agentKey].description}>
                                              {agentMeta[agentKey].description}
                                            </div>
                                          )}
                                        </div>

                                        <div className="profile-col-model">
                                          <ModelSelect
                                            allowInherit
                                            inheritLabel={formData.default_model || 'predeterminado'}
                                            value={currentModel}
                                            onChange={(val) =>
                                              handleAgentModelChange(agentKey, val, currentEffort)
                                            }
                                            availableModels={allAvailableModels}
                                            size="sm"
                                            disabled={isSaving}
                                            aria-label={`Modelo para ${agentKey}`}
                                          />
                                        </div>

                                        <div className="profile-col-effort">
                                          <EffortSelect
                                            allowInherit
                                            inheritLabel={getInheritEffortLabel(formData.default_effort)}
                                            value={currentEffort}
                                            onChange={(val) =>
                                              handleAgentEffortChange(
                                                agentKey,
                                                currentModel,
                                                val
                                              )
                                            }
                                            supportedEfforts={subagentSupportedEfforts}
                                            size="sm"
                                            disabled={isSaving}
                                            aria-label={`Razonamiento para ${agentKey}`}
                                          />
                                        </div>

                                        <div className="profile-col-actions">
                                          {hasOverride ? (
                                            <button
                                              type="button"
                                              className="btn btn-secondary btn-xs profile-reset-override-btn"
                                              onClick={() => {
                                                onRemoveAgentOverride(agentKey);
                                              }}
                                              disabled={isSaving}
                                              title="Restablecer para heredar el modelo principal"
                                            >
                                              Heredar
                                            </button>
                                          ) : (
                                            <span className="profile-inherited-tag">
                                              Heredado
                                            </span>
                                          )}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}

                    {legacyOverrides.length > 0 && (
                      <div
                        className={`profile-accordion-item profile-accordion-legacy ${
                          expandedCategories.has('legacy-overrides') ? 'expanded' : ''
                        }`}
                      >
                        <button
                          type="button"
                          className="profile-accordion-header"
                          onClick={() => toggleCategory('legacy-overrides')}
                          aria-expanded={expandedCategories.has('legacy-overrides')}
                        >
                          <div className="profile-accordion-header-info">
                            <span className="profile-accordion-title">
                              {tLocal('profiles.legacy_overrides_title')}
                            </span>
                            <span className="profile-accordion-desc">
                              {tLocal('profiles.legacy_overrides_desc')}
                            </span>
                          </div>

                          <div className="profile-accordion-header-meta">
                            <span className="profile-accordion-badge profile-legacy-badge">
                              {legacyOverrides.length} {tLocal('profiles.legacy_badge')}
                            </span>
                            <svg
                              className="profile-accordion-chevron"
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
                              <polyline points="6 9 12 15 18 9" />
                            </svg>
                          </div>
                        </button>

                        {expandedCategories.has('legacy-overrides') && (
                          <div className="profile-accordion-content">
                            <div className="profile-agents-table">
                              <div className="profile-agents-table-header">
                                <span className="profile-col-agent">Subagente</span>
                                <span className="profile-col-model">Modelo Asignado</span>
                                <span className="profile-col-effort">Razonamiento</span>
                                <span className="profile-col-actions">Acción</span>
                              </div>

                              <div className="profile-agents-table-body">
                                {legacyOverrides.map((agentKey) => {
                                  const currentEntry = formData.model_profiles[agentKey];
                                  const currentModel = currentEntry?.model || '';
                                  const currentEffort = currentEntry?.effort || '';

                                  const effectiveSubagentModelId =
                                    currentModel || formData.default_model;
                                  const selectedSubagentModel =
                                    findModelInCatalog(
                                      allAvailableModels,
                                      effectiveSubagentModelId
                                    ) || (currentModel ? null : selectedMainModel);
                                  const subagentSupportedEfforts =
                                    getSupportedReasoningEffortsForModel(
                                      selectedSubagentModel
                                    );

                                  return (
                                    <div
                                      key={agentKey}
                                      className="profile-agent-row has-override profile-agent-row-legacy"
                                    >
                                      <div className="profile-col-agent">
                                        <code className="profile-agent-name">{agentKey}</code>
                                        {agentMeta?.[agentKey]?.description && (
                                          <div className="profile-agent-desc-hint" title={agentMeta[agentKey].description}>
                                            {agentMeta[agentKey].description}
                                          </div>
                                        )}
                                        <span className="profile-agent-legacy-tag">
                                          {tLocal('profiles.legacy_badge')}
                                        </span>
                                      </div>

                                      <div className="profile-col-model">
                                        <ModelSelect
                                          allowInherit
                                          inheritLabel={
                                            formData.default_model || 'predeterminado'
                                          }
                                          value={currentModel}
                                          onChange={(val) =>
                                            handleAgentModelChange(
                                              agentKey,
                                              val,
                                              currentEffort
                                            )
                                          }
                                          availableModels={allAvailableModels}
                                          size="sm"
                                          disabled={isSaving}
                                          aria-label={`Modelo para ${agentKey}`}
                                        />
                                      </div>

                                      <div className="profile-col-effort">
                                        <EffortSelect
                                          allowInherit
                                          inheritLabel={getInheritEffortLabel(formData.default_effort)}
                                          value={currentEffort}
                                          onChange={(val) =>
                                            handleAgentEffortChange(
                                              agentKey,
                                              currentModel,
                                              val
                                            )
                                          }
                                          supportedEfforts={subagentSupportedEfforts}
                                          size="sm"
                                          disabled={isSaving}
                                          aria-label={`Razonamiento para ${agentKey}`}
                                        />
                                      </div>

                                      <div className="profile-col-actions">
                                        <button
                                          type="button"
                                          className="btn btn-secondary btn-xs profile-reset-override-btn"
                                          onClick={() => {
                                            onRemoveAgentOverride(agentKey);
                                          }}
                                          disabled={isSaving}
                                          title="Eliminar anulación de este subagente no instalado"
                                        >
                                          Eliminar
                                        </button>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            </fieldset>
          </div>

          {/* Footer */}
          <div className="profile-modal-footer">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={isSaving}
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={isSaving}
            >
              {isSaving
                ? 'Guardando...'
                : isEditing
                  ? 'Guardar Cambios'
                  : 'Crear Perfil'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
