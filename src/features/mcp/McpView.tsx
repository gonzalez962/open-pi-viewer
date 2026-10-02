import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  formatLocalizedDiagnostic,
  type SupportedLocale,
  type TranslationKey,
} from '@shared/i18n';
import type {
  McpServerConfig,
  McpServerScope,
  McpServerType,
  SaveMcpServerPayload,
  SaveMcpServerResult,
  DeleteMcpServerPayload,
  DeleteMcpServerResult,
} from '@core/types/mcp';
import {
  getMcpServersPi,
  toggleMcpServerPi,
  saveMcpServerPi,
  deleteMcpServerPi,
} from '@infra/bridge';
import { McpServerCard } from './components/McpServerCard';
import { McpModal } from './components/McpModal';
import { McpSearchBar } from './components/McpSearchBar';
import { useMcpModalForm } from './hooks/useMcpModalForm';

export interface McpViewProps {
  cwd?: string;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  language: SupportedLocale;
  isBusy?: boolean;
  servers?: McpServerConfig[];
  onToggleServer?: (server: McpServerConfig, enabled: boolean) => Promise<void>;
  onRefresh?: () => Promise<void>;
  onSaveServer?: (
    payload: SaveMcpServerPayload
  ) => Promise<SaveMcpServerResult | boolean>;
  onDeleteServer?: (
    server: McpServerConfig | DeleteMcpServerPayload
  ) => Promise<DeleteMcpServerResult | boolean>;
}

/**
 * Filter servers by query matching name, command, args, or url.
 */
export function filterMcpServers(
  servers: McpServerConfig[],
  query: string
): McpServerConfig[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    return servers;
  }
  return servers.filter((server) => {
    if (server.name.toLowerCase().includes(trimmed)) {
      return true;
    }
    if (server.command && server.command.toLowerCase().includes(trimmed)) {
      return true;
    }
    if (
      server.args &&
      server.args.some((arg) => arg.toLowerCase().includes(trimmed))
    ) {
      return true;
    }
    if (server.url && server.url.toLowerCase().includes(trimmed)) {
      return true;
    }
    return false;
  });
}

import {
  computeMcpServerCounts,
  calculateToggledServerState,
} from './mcp-utils';

export {
  computeMcpServerCounts,
  calculateToggledServerState,
};

/**
 * Immutably calculate state after saving or updating a server.
 */
export function calculateSavedServerState(
  servers: McpServerConfig[],
  payload: SaveMcpServerPayload,
  targetPath?: string
): McpServerConfig[] {
  const isStdio =
    payload.server.type === 'stdio' ||
    payload.server.serverType === 'stdio' ||
    Boolean(payload.server.command);

  const env = payload.server.env as Record<string, string> | undefined;
  const headers = payload.server.headers as Record<string, string> | undefined;

  const updatedServer: McpServerConfig = {
    name: payload.name,
    serverType: (payload.server.serverType ||
      payload.server.type ||
      (isStdio ? 'stdio' : 'sse')) as McpServerType,
    command: payload.server.command as string | undefined,
    args: payload.server.args as string[] | undefined,
    url: payload.server.url as string | undefined,
    env,
    envKeys: env ? Object.keys(env).sort() : [],
    headers,
    disabled:
      payload.server.disabled !== undefined
        ? Boolean(payload.server.disabled)
        : payload.server.enabled !== undefined
          ? !payload.server.enabled
          : false,
    enabled:
      payload.server.enabled !== undefined
        ? Boolean(payload.server.enabled)
        : payload.server.disabled !== undefined
          ? !payload.server.disabled
          : true,
    scope: payload.scope || 'global',
    configPath: targetPath || '',
  };

  const targetOldName = payload.oldName?.trim() || payload.name.trim();
  const existingIndex = servers.findIndex(
    (s) =>
      s.name === targetOldName &&
      (payload.scope ? s.scope === payload.scope : true)
  );

  if (existingIndex >= 0) {
    const next = [...servers];
    next[existingIndex] = {
      ...next[existingIndex],
      ...updatedServer,
      configPath: targetPath || next[existingIndex].configPath,
    };
    return next;
  }

  return [...servers, updatedServer];
}

/**
 * Immutably calculate state after deleting a server.
 */
export function calculateDeletedServerState(
  servers: McpServerConfig[],
  serverName: string,
  scope?: McpServerScope
): McpServerConfig[] {
  return servers.filter((s) => {
    if (scope) {
      return !(s.name === serverName && s.scope === scope);
    }
    return s.name !== serverName;
  });
}

export const McpView: React.FC<McpViewProps> = ({
  cwd,
  t,
  language,
  isBusy = false,
  servers: controlledServers,
  onToggleServer: controlledToggleServer,
  onRefresh: controlledRefresh,
  onSaveServer,
  onDeleteServer,
}) => {
  const [internalServers, setInternalServers] = useState<McpServerConfig[]>([]);
  const isControlled = controlledServers !== undefined;
  const servers = isControlled ? controlledServers : internalServers;

  const [isLoading, setIsLoading] = useState<boolean>(!isControlled);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  const [togglingServers, setTogglingServers] = useState<Set<string>>(
    () => new Set()
  );

  const [deletingName, setDeletingName] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);

  const modalForm = useMcpModalForm();

  const loadServers = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      if (controlledRefresh) {
        await controlledRefresh();
      } else {
        const payload = await getMcpServersPi(cwd);
        setInternalServers(payload.servers || []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, [cwd, controlledRefresh]);

  useEffect(() => {
    if (!isControlled) {
      void loadServers();
    }
  }, [loadServers, isControlled]);

  const handleToggleServer = useCallback(
    async (server: McpServerConfig, nextEnabled: boolean) => {
      setTogglingServers((prev) => new Set(prev).add(server.name));
      setError(null);
      setSuccessNotice(null);

      try {
        if (controlledToggleServer) {
          await controlledToggleServer(server, nextEnabled);
        } else {
          const res = await toggleMcpServerPi({
            name: server.name,
            enabled: nextEnabled,
            cwd,
            scope: cwd ? server.scope : 'global',
          });

          if (res.success) {
            setInternalServers((prev) =>
              calculateToggledServerState(prev, server.name, nextEnabled)
            );
          } else {
            setError(
              t('mcp.toggle_error', {
                name: server.name,
                error: 'Operation failed',
              })
            );
            return;
          }
        }

        const statusText = nextEnabled
          ? t('mcp.status_active')
          : t('mcp.status_inactive');
        setSuccessNotice(
          t('mcp.toggle_success', {
            name: server.name,
            status: statusText.toLowerCase(),
          })
        );
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        setError(
          t('mcp.toggle_error', {
            name: server.name,
            error: errorMsg,
          })
        );
      } finally {
        setTogglingServers((prev) => {
          const next = new Set(prev);
          next.delete(server.name);
          return next;
        });
      }
    },
    [cwd, t, controlledToggleServer]
  );

  const handleSaveServer = useCallback(
    async (payload: SaveMcpServerPayload): Promise<boolean> => {
      setError(null);
      setSuccessNotice(null);
      try {
        const result = onSaveServer
          ? await onSaveServer(payload)
          : await saveMcpServerPi(payload);

        const isSuccess = typeof result === 'boolean' ? result : result.success;
        if (!isSuccess) {
          setError(t('mcp.error_save_failed'));
          return false;
        }

        const resultPath = typeof result === 'object' && result ? result.path : undefined;
        setInternalServers((prev) =>
          calculateSavedServerState(prev, payload, resultPath)
        );

        if (controlledRefresh) {
          await controlledRefresh();
        }

        setSuccessNotice(t('mcp.save_success', { name: payload.name }));
        return true;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        setError(errorMsg);
        return false;
      }
    },
    [onSaveServer, controlledRefresh, t]
  );

  const handleDeleteServer = useCallback(
    async (server: McpServerConfig) => {
      setIsDeleting(true);
      setError(null);
      setSuccessNotice(null);

      try {
        const effectiveScope = cwd ? server.scope : 'global';
        const payload: DeleteMcpServerPayload = {
          name: server.name,
          cwd,
          scope: effectiveScope,
        };

        const result = onDeleteServer
          ? await onDeleteServer(server)
          : await deleteMcpServerPi(payload);

        const isSuccess = typeof result === 'boolean' ? result : result.success;
        if (!isSuccess) {
          setError(
            t('mcp.error_delete_failed', {
              name: server.name,
              error: 'Delete operation failed',
            })
          );
          return;
        }

        setInternalServers((prev) =>
          calculateDeletedServerState(prev, server.name, effectiveScope)
        );

        if (controlledRefresh) {
          await controlledRefresh();
        }

        setDeletingName(null);
        setSuccessNotice(t('mcp.delete_success', { name: server.name }));
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        setError(
          t('mcp.error_delete_failed', {
            name: server.name,
            error: errorMsg,
          })
        );
      } finally {
        setIsDeleting(false);
      }
    },
    [cwd, onDeleteServer, controlledRefresh, t]
  );

  const filteredServers = useMemo(
    () => filterMcpServers(servers, searchQuery),
    [servers, searchQuery]
  );

  const { total, active } = useMemo(
    () => computeMcpServerCounts(servers),
    [servers]
  );

  return (
    <>
      <div className="settings-pane-toolbar mcp-toolbar">
        <McpSearchBar
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder={t('mcp.search_placeholder')}
          clearAriaLabel={t('sidebar.clear_search')}
        />

        <div className="mcp-toolbar-actions">
          <span className="mcp-stat-pill mcp-stat-total">
            {t('mcp.servers_count', { count: total })}
          </span>
          <span className="mcp-stat-pill mcp-stat-active">
            {t('mcp.active_count', { count: active })}
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-sm mcp-reload-btn"
            onClick={() => void loadServers()}
            disabled={isLoading || isBusy}
            title={t('mcp.reload')}
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
            <span>{t('mcp.reload')}</span>
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm mcp-add-btn"
            onClick={() => modalForm.openAddModal()}
            disabled={isLoading || isBusy}
            title={t('mcp.btn_add_server')}
          >
            + {t('mcp.btn_add_server')}
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="settings-view-body mcp-view-body">
        {/* Notice Banner */}
        <div className="mcp-notice-banner" role="status">
          <svg
            className="mcp-notice-icon"
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
          <span>{t('mcp.notice_reload')}</span>
        </div>

        {/* Error Banner */}
        {error && (
          <div className="validation-error-banner" role="alert">
            <span>{formatLocalizedDiagnostic(error, language)}</span>
          </div>
        )}

        {/* Success Banner */}
        {successNotice && (
          <div
            className="storage-warning-banner mcp-success-banner"
            role="status"
          >
            <span>{successNotice}</span>
          </div>
        )}

        {/* Server List / States */}
        {isLoading ? (
          <div className="mcp-loading-state">
            <div className="spinner" />
            <span>{t('mcp.loading')}</span>
          </div>
        ) : servers.length === 0 ? (
          <div className="mcp-empty-state">
            <div className="mcp-empty-icon" aria-hidden="true">
              <svg
                width="40"
                height="40"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
                <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
                <line x1="6" y1="6" x2="6.01" y2="6" />
                <line x1="6" y1="18" x2="6.01" y2="18" />
              </svg>
            </div>
            <h2 className="mcp-empty-title">{t('mcp.empty_title')}</h2>
            <p className="mcp-empty-desc">{t('mcp.empty_desc')}</p>
          </div>
        ) : filteredServers.length === 0 ? (
          <div className="mcp-empty-state mcp-no-results">
            <p className="mcp-empty-desc">{t('sidebar.no_search_results')}</p>
          </div>
        ) : (
          <div className="mcp-grid">
            {filteredServers.map((server) => (
              <McpServerCard
                key={`${server.scope}-${server.name}`}
                server={server}
                onToggle={handleToggleServer}
                isToggling={togglingServers.has(server.name)}
                onEdit={modalForm.openEditModal}
                onDelete={handleDeleteServer}
                isDeleting={isDeleting && deletingName === server.name}
                deletingName={deletingName}
                onSetDeletingName={setDeletingName}
                t={t}
              />
            ))}
          </div>
        )}
      </div>

      {/* Modal Dialog */}
      <McpModal
        modalForm={modalForm}
        onSave={handleSaveServer}
        t={t}
        cwd={cwd}
      />
    </>
  );
};
