import React, { useCallback, useMemo, useState } from 'react';
import {
  formatLocalizedDiagnostic,
  type SupportedLocale,
  type TranslationKey,
} from '@shared/i18n';
import type {
  PiResourceEntry,
  SavePiResourcePayload,
} from '@core/types/extensions';
import { ResourceCard } from './components/ResourceCard';
import { ResourceModal } from './components/ResourceModal';
import { ExtensionSearchBar } from './components/ExtensionSearchBar';
import { useResourceModalForm } from './hooks/useResourceModalForm';
import { usePiResources } from './hooks/usePiResources';
import { computeResourceCounts, filterResources } from './types';
import './extensions.css';

export interface ExtensionsViewProps {
  cwd?: string;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  language: SupportedLocale;
  isBusy?: boolean;
  resources?: PiResourceEntry[];
  onToggleResource?: (
    resource: PiResourceEntry,
    enabled: boolean
  ) => Promise<void>;
  onToggleAlwaysActive?: (
    resource: PiResourceEntry,
    alwaysActive: boolean
  ) => Promise<void>;
  onRefresh?: () => Promise<void>;
  onSaveResource?: (
    payload: SavePiResourcePayload,
    original?: PiResourceEntry | null
  ) => Promise<boolean>;
  onDeleteResource?: (resource: PiResourceEntry) => Promise<boolean>;
}

export const ExtensionsView: React.FC<ExtensionsViewProps> = ({
  cwd,
  t,
  language,
  isBusy = false,
  resources: controlledResources,
  onToggleResource: controlledToggleResource,
  onToggleAlwaysActive: controlledToggleAlwaysActive,
  onRefresh: controlledRefresh,
  onSaveResource: controlledSaveResource,
  onDeleteResource: controlledDeleteResource,
}) => {
  const isControlled = controlledResources !== undefined;

  // Uncontrolled state managed by cohesive usePiResources hook
  const hookResources = usePiResources({ cwd });

  const resources = isControlled
    ? controlledResources
    : hookResources.resources;
  const isLoading = isControlled ? false : hookResources.isLoading;

  const [searchQuery, setSearchQuery] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  const [togglingIds, setTogglingIds] = useState<Set<string>>(
    () => new Set()
  );
  const [togglingAlwaysActiveIds, setTogglingAlwaysActiveIds] = useState<Set<string>>(
    () => new Set()
  );
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);

  const modalForm = useResourceModalForm();

  const handleRefresh = useCallback(async () => {
    setError(null);
    setSuccessNotice(null);
    if (controlledRefresh) {
      await controlledRefresh();
    } else {
      await hookResources.refreshResources();
    }
  }, [controlledRefresh, hookResources]);

  const handleToggleResource = useCallback(
    async (resource: PiResourceEntry, nextEnabled: boolean) => {
      setTogglingIds((prev) => new Set(prev).add(resource.id));
      setError(null);
      setSuccessNotice(null);

      try {
        if (controlledToggleResource) {
          await controlledToggleResource(resource, nextEnabled);
        } else {
          await hookResources.handleToggleResource(resource, nextEnabled);
        }

        const kindLabel =
          resource.kind === 'extension'
            ? t('extensions.badge_extension')
            : t('extensions.badge_package');
        const statusText = nextEnabled
          ? t('extensions.status_active')
          : t('extensions.status_inactive');

        setSuccessNotice(
          t('extensions.toggle_success', {
            kind: kindLabel,
            name: resource.name,
            status: statusText.toLowerCase(),
          })
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(
          t('extensions.toggle_error', {
            kind: resource.kind,
            name: resource.name,
            error: message,
          })
        );
      } finally {
        setTogglingIds((prev) => {
          const next = new Set(prev);
          next.delete(resource.id);
          return next;
        });
      }
    },
    [controlledToggleResource, hookResources, t]
  );

  const handleToggleAlwaysActive = useCallback(
    async (resource: PiResourceEntry, nextAlwaysActive: boolean) => {
      if (resource.kind !== 'extension') return;
      setTogglingAlwaysActiveIds((prev) => new Set(prev).add(resource.id));
      setError(null);
      setSuccessNotice(null);

      try {
        if (controlledToggleAlwaysActive) {
          await controlledToggleAlwaysActive(resource, nextAlwaysActive);
        } else {
          await hookResources.handleToggleAlwaysActive(
            resource,
            nextAlwaysActive
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      } finally {
        setTogglingAlwaysActiveIds((prev) => {
          const next = new Set(prev);
          next.delete(resource.id);
          return next;
        });
      }
    },
    [controlledToggleAlwaysActive, hookResources]
  );

  const handleSaveResource = useCallback(
    async (
      payload: SavePiResourcePayload,
      original?: PiResourceEntry | null
    ): Promise<boolean> => {
      setError(null);
      setSuccessNotice(null);

      try {
        const success = controlledSaveResource
          ? await controlledSaveResource(payload, original)
          : await hookResources.handleSaveResource(payload, original);

        if (!success) {
          setError(t('extensions.error_save_failed'));
          return false;
        }

        if (controlledRefresh) {
          await controlledRefresh();
        }

        const kindLabel =
          payload.kind === 'extension'
            ? t('extensions.badge_extension')
            : t('extensions.badge_package');

        setSuccessNotice(
          t('extensions.save_success', {
            kind: kindLabel,
            name: payload.source,
          })
        );
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        return false;
      }
    },
    [controlledSaveResource, hookResources, controlledRefresh, t]
  );

  const handleDeleteResource = useCallback(
    async (resource: PiResourceEntry) => {
      setIsDeleting(true);
      setError(null);
      setSuccessNotice(null);

      try {
        const success = controlledDeleteResource
          ? await controlledDeleteResource(resource)
          : await hookResources.handleDeleteResource(resource);

        if (!success) {
          setError(
            t('extensions.error_delete_failed', {
              name: resource.name,
              error: 'Delete operation failed',
            })
          );
          return;
        }

        if (controlledRefresh) {
          await controlledRefresh();
        }

        setDeletingId(null);
        const kindLabel =
          resource.kind === 'extension'
            ? t('extensions.badge_extension')
            : t('extensions.badge_package');

        setSuccessNotice(
          t('extensions.delete_success', {
            kind: kindLabel,
            name: resource.name,
          })
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(
          t('extensions.error_delete_failed', {
            name: resource.name,
            error: message,
          })
        );
      } finally {
        setIsDeleting(false);
      }
    },
    [controlledDeleteResource, hookResources, controlledRefresh, t]
  );

  const filteredResources = useMemo(
    () => filterResources(resources, searchQuery),
    [resources, searchQuery]
  );

  const { total, active } = useMemo(
    () => computeResourceCounts(resources),
    [resources]
  );

  const displayError = error || (!isControlled ? hookResources.error : null);
  const displaySuccess =
    successNotice || (!isControlled ? hookResources.successNotice : null);

  return (
    <>
      {/* Toolbar */}
      <div className="settings-pane-toolbar ext-toolbar">
        <ExtensionSearchBar
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder={t('extensions.search_placeholder')}
          clearAriaLabel={t('sidebar.clear_search')}
        />

        <div className="ext-toolbar-actions">
          <span className="ext-stat-pill ext-stat-total">
            {t('extensions.total_count', { count: total })}
          </span>
          <span className="ext-stat-pill ext-stat-active">
            {t('extensions.active_count', { count: active })}
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-sm ext-reload-btn"
            onClick={() => void handleRefresh()}
            disabled={isLoading || isBusy}
            title={t('extensions.reload')}
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
              className={isLoading ? 'spin' : ''}
              aria-hidden="true"
            >
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            <span>{t('extensions.reload')}</span>
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm ext-add-btn"
            onClick={() => modalForm.openAddModal()}
            disabled={isLoading || isBusy}
            title={t('extensions.btn_add')}
          >
            + {t('extensions.btn_add')}
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="settings-view-body ext-view-body">
        {/* Notice Banner */}
        <div className="ext-notice-banner" role="status">
          <svg
            className="ext-notice-icon"
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
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          <div className="ext-notice-text">
            <span>{t('extensions.notice_reload')}</span>
            <span className="ext-notice-subtext">{t('extensions.activation_next_session_notice')}</span>
          </div>
        </div>

        {/* Error Banner */}
        {displayError && (
          <div className="validation-error-banner" role="alert">
            <span>{formatLocalizedDiagnostic(displayError, language)}</span>
          </div>
        )}

        {/* Success Banner */}
        {displaySuccess && (
          <div
            className="storage-warning-banner ext-success-banner"
            role="status"
          >
            <span>{displaySuccess}</span>
          </div>
        )}

        {/* Resource List / States */}
        {isLoading ? (
          <div className="ext-loading-state">
            <div className="spinner" />
            <span>{t('extensions.loading')}</span>
          </div>
        ) : resources.length === 0 ? (
          <div className="ext-empty-state">
            <div className="ext-empty-icon" aria-hidden="true">
              <svg
                width="40"
                height="40"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                <line x1="12" y1="22.08" x2="12" y2="12" />
              </svg>
            </div>
            <h2 className="ext-empty-title">{t('extensions.empty_title')}</h2>
            <p className="ext-empty-desc">{t('extensions.empty_desc')}</p>
          </div>
        ) : filteredResources.length === 0 ? (
          <div className="ext-empty-state ext-no-results">
            <p className="ext-empty-desc">{t('sidebar.no_search_results')}</p>
          </div>
        ) : (
          <div className="ext-grid">
            {filteredResources.map((resource) => (
              <ResourceCard
                key={resource.id}
                resource={resource}
                onToggle={handleToggleResource}
                isToggling={togglingIds.has(resource.id)}
                onToggleAlwaysActive={handleToggleAlwaysActive}
                isTogglingAlwaysActive={togglingAlwaysActiveIds.has(resource.id)}
                onEdit={modalForm.openEditModal}
                onDelete={handleDeleteResource}
                isDeleting={isDeleting && deletingId === resource.id}
                deletingId={deletingId}
                onSetDeletingId={setDeletingId}
                t={t}
              />
            ))}
          </div>
        )}
      </div>

      {/* Modal Dialog */}
      <ResourceModal
        modalForm={modalForm}
        onSave={handleSaveResource}
        t={t}
        cwd={cwd}
      />
    </>
  );
};
