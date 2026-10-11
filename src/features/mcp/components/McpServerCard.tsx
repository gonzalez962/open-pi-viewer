import React from 'react';
import type { TranslationKey } from '@shared/i18n';
import type { McpServerConfig } from '@core/types/mcp';

export interface McpServerCardProps {
  server: McpServerConfig;
  onToggle: (server: McpServerConfig, nextEnabled: boolean) => void;
  isToggling?: boolean;
  onToggleAlwaysActive?: (server: McpServerConfig, nextAlwaysActive: boolean) => void;
  isTogglingAlwaysActive?: boolean;
  onEdit?: (server: McpServerConfig) => void;
  onDelete?: (server: McpServerConfig) => void;
  isDeleting?: boolean;
  deletingName?: string | null;
  onSetDeletingName?: (name: string | null) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

export const McpServerCard: React.FC<McpServerCardProps> = ({
  server,
  onToggle,
  isToggling = false,
  onToggleAlwaysActive,
  isTogglingAlwaysActive = false,
  onEdit,
  onDelete,
  isDeleting = false,
  deletingName = null,
  onSetDeletingName,
  t,
}) => {
  const scopeLabel =
    server.scope === 'global' ? t('mcp.scope_global') : t('mcp.scope_project');

  let typeLabel = t('mcp.badge_stdio');
  if (server.serverType === 'remote') {
    typeLabel = t('mcp.badge_remote');
  } else if (server.serverType === 'sse') {
    typeLabel = t('mcp.badge_sse');
  }

  const statusLabel = server.enabled
    ? t('mcp.status_active')
    : t('mcp.status_inactive');
  const toggleAriaLabel = `${server.name}: ${statusLabel}`;

  const isStdio = server.serverType === 'stdio';
  const commandText =
    isStdio && server.command
      ? [server.command, ...(server.args || [])].filter(Boolean).join(' ')
      : null;

  const isCurrentDeleting = deletingName === server.name;

  return (
    <article
      className={`mcp-server-card ${server.enabled ? 'mcp-server-enabled' : 'mcp-server-disabled'}`}
      data-server-name={server.name}
    >
      <div className="mcp-server-header">
        <div className="mcp-server-identity">
          <h3 className="mcp-server-name">{server.name}</h3>
          <div className="mcp-server-badges">
            <span
              className={`mcp-badge mcp-badge-scope mcp-badge-scope-${server.scope}`}
            >
              {scopeLabel}
            </span>
            <span
              className={`mcp-badge mcp-badge-type mcp-badge-type-${server.serverType}`}
            >
              {typeLabel}
            </span>
            {server.alwaysActive && (
              <span className="mcp-badge mcp-badge-always-active">
                {t('mcp.badge_always_active')}
              </span>
            )}
          </div>
        </div>

        <div className="mcp-server-actions">
          <div className="mcp-server-toggle-area">
            <label
              className={`mcp-toggle-label ${isToggling ? 'mcp-toggling' : ''}`}
              htmlFor={`mcp-toggle-${server.scope}-${server.name}`}
            >
              <span
                className={`mcp-status-pill ${server.enabled ? 'active' : 'inactive'}`}
              >
                {statusLabel}
              </span>
              <input
                id={`mcp-toggle-${server.scope}-${server.name}`}
                type="checkbox"
                className="mcp-toggle-checkbox"
                checked={server.enabled}
                disabled={isToggling || isDeleting}
                aria-label={toggleAriaLabel}
                onChange={() => onToggle(server, !server.enabled)}
              />
              <span className="mcp-toggle-slider" aria-hidden="true" />
            </label>
          </div>

          {onToggleAlwaysActive && (
            <div className="mcp-always-active-area">
              <label
                className={`mcp-always-active-label ${isTogglingAlwaysActive ? 'mcp-toggling' : ''}`}
                htmlFor={`mcp-always-${server.scope}-${server.name}`}
              >
                <span className="mcp-always-active-text">
                  {t('mcp.always_activate_label')}
                </span>
                <input
                  id={`mcp-always-${server.scope}-${server.name}`}
                  type="checkbox"
                  className="mcp-toggle-checkbox mcp-always-checkbox"
                  checked={Boolean(server.alwaysActive)}
                  disabled={isToggling || isDeleting || isTogglingAlwaysActive}
                  aria-label={`${server.name}: ${t('mcp.always_activate_label')}`}
                  onChange={() => onToggleAlwaysActive(server, !server.alwaysActive)}
                />
                <span className="mcp-toggle-slider" aria-hidden="true" />
              </label>
            </div>
          )}

          {onEdit && (
            <button
              type="button"
              className="btn btn-secondary btn-sm mcp-edit-btn"
              onClick={() => onEdit(server)}
              disabled={isToggling || isDeleting}
            >
              {t('action.edit')}
            </button>
          )}

          {onDelete && (
            isCurrentDeleting ? (
              <div className="mcp-delete-confirm">
                <button
                  type="button"
                  className="btn btn-danger btn-sm mcp-confirm-delete-btn"
                  onClick={() => onDelete(server)}
                  disabled={isDeleting}
                >
                  {isDeleting ? t('action.saving') : t('mcp.confirm_delete')}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm mcp-cancel-delete-btn"
                  onClick={() => onSetDeletingName?.(null)}
                  disabled={isDeleting}
                >
                  {t('action.cancel')}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-icon-danger btn-sm mcp-delete-btn"
                onClick={() => onSetDeletingName?.(server.name)}
                disabled={isToggling || isDeleting}
                title={t('action.delete')}
                aria-label={t('action.delete')}
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
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  <line x1="10" y1="11" x2="10" y2="17" />
                  <line x1="14" y1="11" x2="14" y2="17" />
                </svg>
              </button>
            )
          )}
        </div>
      </div>

      <div className="mcp-server-body">
        {commandText && (
          <div className="mcp-server-detail mcp-server-command">
            <span className="mcp-detail-label">{t('mcp.badge_stdio')}:</span>
            <code className="mcp-code-block">{commandText}</code>
          </div>
        )}

        {(server.serverType === 'remote' || server.serverType === 'sse') &&
          server.url && (
            <div className="mcp-server-detail mcp-server-url">
              <span className="mcp-detail-label">URL:</span>
              <code className="mcp-code-block">{server.url}</code>
            </div>
          )}

        {server.envKeys && server.envKeys.length > 0 && (
          <div className="mcp-server-env">
            <span className="mcp-env-label">{t('mcp.env_keys_label')}</span>
            <div className="mcp-env-pills">
              {server.envKeys.map((key) => (
                <span key={key} className="mcp-env-pill">
                  {key}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </article>
  );
};
