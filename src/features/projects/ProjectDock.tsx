import React, { useState, useCallback } from 'react';
import {
  type ProjectItem,
  type ProjectStatusInfo,
  getProjectDisplayName,
  getProjectMonogram,
} from './projects';
import { FolderPickerModal } from './components/FolderPickerModal';
import type { ConnectionState } from '@core/types/connection';
import type { AgentActivity } from '@core/types/messages';
import { translate, type SupportedLocale } from '@shared/i18n';

export interface ProjectDockProps {
  projects: ProjectItem[];
  activeProjectId: string | null;
  connectionState: ConnectionState;
  agentActivity: AgentActivity;
  isBusy: boolean;
  locale: SupportedLocale;
  projectStatusMap?: Record<string, ProjectStatusInfo>;
  onSelectProject: (project: ProjectItem) => void;
  onAddProject: (customPath?: string, customName?: string) => void;
  onRenameProject: (projectId: string, newName: string) => void;
  onRemoveProject: (projectId: string) => void;
  isSettingsOpen?: boolean;
  onOpenSettings?: () => void;
}

/**
 * Derives the CSS status dot class for a project based on active state,
 * connection state, and agent activity.
 */
export function getProjectStatusClass(
  isActive: boolean,
  connectionState: ConnectionState,
  agentActivity: AgentActivity,
  isBusy: boolean
): string {
  if (isBusy || agentActivity === 'busy') {
    return 'status-busy';
  }
  if (connectionState === 'connecting') {
    return 'status-connecting';
  }
  if (connectionState === 'connected') {
    return 'status-ready';
  }
  if (connectionState === 'error') {
    return 'status-error';
  }
  if (isActive) {
    return 'status-offline';
  }
  return 'status-inactive';
}

/**
 * Returns localized status label text for display inside the project details.
 */
export function getProjectStatusLabel(
  isActive: boolean,
  connectionState: ConnectionState,
  agentActivity: AgentActivity,
  isBusy: boolean,
  locale: SupportedLocale
): string {
  if (isBusy || agentActivity === 'busy') {
    return translate(locale, 'projects.status_busy');
  }
  if (connectionState === 'connecting') {
    return translate(locale, 'projects.status_connecting');
  }
  if (connectionState === 'connected') {
    return translate(locale, 'projects.status_ready');
  }
  if (connectionState === 'error') {
    return translate(locale, 'projects.status_error');
  }
  if (isActive) {
    return translate(locale, 'status.disconnected');
  }
  return translate(locale, 'projects.status_inactive');
}

export const ProjectDock: React.FC<ProjectDockProps> = ({
  projects,
  activeProjectId,
  connectionState,
  agentActivity,
  isBusy,
  locale,
  projectStatusMap,
  onSelectProject,
  onAddProject,
  onRenameProject,
  onRemoveProject,
  isSettingsOpen,
  onOpenSettings,
}) => {
  const isSettingsActive = Boolean(isSettingsOpen);
  const [isHovered, setIsHovered] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState<string>('');
  const [confirmingRemoveId, setConfirmingRemoveId] = useState<string | null>(null);
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false);

  const isEditing = editingProjectId !== null;
  const isConfirmingRemove = confirmingRemoveId !== null;
  const isExpanded = isHovered || isEditing || isConfirmingRemove;

  const handleRowClick = useCallback(
    (project: ProjectItem) => {
      if (editingProjectId === project.id || confirmingRemoveId === project.id) {
        return;
      }
      onSelectProject(project);
    },
    [editingProjectId, confirmingRemoveId, onSelectProject]
  );

  const handleStartRename = useCallback((project: ProjectItem) => {
    setRenameValue(getProjectDisplayName(project));
    setEditingProjectId(project.id);
    setConfirmingRemoveId(null);
  }, []);

  const handleSaveRename = useCallback(
    (projectId: string) => {
      onRenameProject(projectId, renameValue);
      setEditingProjectId(null);
    },
    [onRenameProject, renameValue]
  );

  const handleCancelRename = useCallback(() => {
    setEditingProjectId(null);
  }, []);

  const handleStartRemove = useCallback((projectId: string) => {
    setConfirmingRemoveId(projectId);
    setEditingProjectId(null);
  }, []);

  const handleConfirmRemove = useCallback(
    (projectId: string) => {
      onRemoveProject(projectId);
      setConfirmingRemoveId(null);
    },
    [onRemoveProject]
  );

  const handleCancelRemove = useCallback(() => {
    setConfirmingRemoveId(null);
  }, []);

  return (
    <div className="project-dock-container">
      <aside
        className={`project-dock ${isExpanded ? 'is-expanded' : ''}`}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onFocus={() => setIsHovered(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setIsHovered(false);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            if (isEditing) {
              handleCancelRename();
              e.stopPropagation();
            } else if (isConfirmingRemove) {
              handleCancelRemove();
              e.stopPropagation();
            }
          }
        }}
        aria-label={translate(locale, 'projects.dock_label')}
      >
        <div className="project-dock-list" role="list">
          {projects.map((project) => {
            const isActive = project.id === activeProjectId;
            const displayName = getProjectDisplayName(project);
            const monogram = getProjectMonogram(displayName);
            const statusInfo = projectStatusMap?.[project.id] ?? (isActive
              ? { connectionState, agentActivity, isBusy }
              : { connectionState: 'disconnected', agentActivity: 'idle', isBusy: false });
            const statusClass = getProjectStatusClass(
              isActive,
              statusInfo.connectionState,
              statusInfo.agentActivity,
              Boolean(statusInfo.isBusy)
            );
            const statusLabel = getProjectStatusLabel(
              isActive,
              statusInfo.connectionState,
              statusInfo.agentActivity,
              Boolean(statusInfo.isBusy),
              locale
            );
            const isRowEditing = editingProjectId === project.id;
            const isRowConfirming = confirmingRemoveId === project.id;

            return (
              <div
                key={project.id}
                className={`project-row ${isActive ? 'is-active' : ''}`}
                role="listitem"
                onClick={() => handleRowClick(project)}
              >
                <button
                  type="button"
                  className={`project-tile ${isActive ? 'is-active' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRowClick(project);
                  }}
                  aria-label={displayName}
                  aria-current={isActive ? 'true' : undefined}
                  title={displayName}
                >
                  <span className="project-monogram" aria-hidden="true">
                    {monogram}
                  </span>
                  <span
                    className={`project-status-dot ${statusClass}`}
                    aria-hidden="true"
                  />
                </button>

                <div className="project-details">
                  {isRowEditing ? (
                    <div
                      className="project-inline-rename"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        id={`rename-input-${project.id}`}
                        type="text"
                        className="project-rename-input"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            e.stopPropagation();
                            handleSaveRename(project.id);
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            e.stopPropagation();
                            handleCancelRename();
                          }
                        }}
                        placeholder={translate(
                          locale,
                          'projects.rename_placeholder'
                        )}
                        autoFocus
                      />
                      <div className="project-inline-actions">
                        <button
                          type="button"
                          className="project-action-btn project-btn-save"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSaveRename(project.id);
                          }}
                          title={translate(locale, 'projects.save_name')}
                          aria-label={translate(locale, 'projects.save_name')}
                        >
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="project-action-btn project-btn-cancel"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCancelRename();
                          }}
                          title={translate(locale, 'projects.cancel')}
                          aria-label={translate(locale, 'projects.cancel')}
                        >
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  ) : isRowConfirming ? (
                    <div
                      className="project-inline-confirm"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <span className="project-confirm-prompt">
                        {translate(locale, 'projects.remove_confirm')}
                      </span>
                      <div className="project-confirm-btn-group">
                        <button
                          type="button"
                          className="project-confirm-btn project-btn-danger"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleConfirmRemove(project.id);
                          }}
                        >
                          {translate(locale, 'projects.remove')}
                        </button>
                        <button
                          type="button"
                          className="project-confirm-btn project-btn-cancel"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCancelRemove();
                          }}
                        >
                          {translate(locale, 'projects.cancel')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="project-name-row">
                        <span className="project-name" title={displayName}>
                          {displayName}
                        </span>
                        <div className="project-actions">
                          <button
                            type="button"
                            className="project-action-btn project-action-rename"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleStartRename(project);
                            }}
                            title={translate(locale, 'projects.rename')}
                            aria-label={translate(locale, 'projects.rename')}
                          >
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            className="project-action-btn project-action-remove"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleStartRemove(project.id);
                            }}
                            title={translate(locale, 'projects.remove')}
                            aria-label={translate(locale, 'projects.remove')}
                          >
                            <svg
                              width="12"
                              height="12"
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
                            </svg>
                          </button>
                        </div>
                      </div>

                      <div className="project-status-row">
                        <span className="project-status-text">
                          {statusLabel}
                        </span>
                        <span className="project-path-text" title={project.path}>
                          {project.path}
                        </span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="project-dock-footer">
          <button
            type="button"
            className="project-footer-row"
            onClick={() => setIsFolderPickerOpen(true)}
            title={translate(locale, 'projects.add_project')}
            aria-label={translate(locale, 'projects.add_project')}
          >
            <div className="project-tile project-tile-add" aria-hidden="true">
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
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </div>
            <span className="project-add-label">
              {translate(locale, 'projects.add_project')}
            </span>
          </button>

          <button
            type="button"
            className={`project-footer-row project-footer-settings ${isSettingsActive ? 'is-active' : ''}`}
            onClick={onOpenSettings}
            title={translate(locale, 'settings.title')}
            aria-label={translate(locale, 'settings.title')}
          >
            <div
              className={`project-tile project-tile-settings ${isSettingsActive ? 'is-active' : ''}`}
              aria-hidden="true"
            >
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
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </div>
            <span className="project-settings-label">
              {translate(locale, 'settings.title')}
            </span>
          </button>
        </div>
      </aside>

      <FolderPickerModal
        isOpen={isFolderPickerOpen}
        initialPath={projects.find((p) => p.id === activeProjectId)?.path}
        onClose={() => setIsFolderPickerOpen(false)}
        onSelectFolder={(folderPath, customName) => {
          onAddProject(folderPath, customName);
        }}
        locale={locale}
      />
    </div>
  );
};
