import React, { useMemo, useState } from 'react';
import { translate, type SupportedLocale, type TranslationKey } from '@shared/i18n';
import type { SessionSummary } from '@core/types/sessions';
import { SidebarSearchBar } from './components/SidebarSearchBar';

export interface SessionSidebarProps {
  sessions: SessionSummary[];
  isLoading: boolean;
  isSwitching: boolean;
  error: string | null;
  activeSessionId: string | null;
  activeSessionFile: string | null;
  onSelectSession: (session: SessionSummary) => void;
  onNewSession: () => void;
  onDeleteSession: (session: SessionSummary) => void;
  onRenameSession: (sessionPath: string, name: string) => void;
  onClose: () => void;
  locale: SupportedLocale;
  filesPanel: React.ReactNode;
  filesChangesCount?: number;
  projectName?: string;
}

export type TimeGroup = 'today' | 'yesterday' | 'previous_days' | 'older';

/**
 * Determines whether a session item can be selected/activated.
 * Active sessions can still be selected (e.g. to close settings or focus).
 * Deleting or switching states disable selection.
 */
export function canSelectSession(isSwitching: boolean, isConfirmingDelete: boolean): boolean {
  return !isSwitching && !isConfirmingDelete;
}

/**
 * Categorize a date string into chronological groups.
 */
export function categorizeSessionTime(dateStr?: string, now = new Date()): TimeGroup {
  if (!dateStr) return 'older';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 'older';

  const nowDay = Math.floor(now.getTime() / (24 * 60 * 60 * 1000));
  const itemDay = Math.floor(d.getTime() / (24 * 60 * 60 * 1000));
  const diffDays = nowDay - itemDay;

  if (diffDays <= 0) {
    return 'today';
  } else if (diffDays === 1) {
    return 'yesterday';
  } else if (diffDays <= 7) {
    return 'previous_days';
  }
  return 'older';
}

/**
 * Format timestamp nicely for session items according to locale.
 */
export function formatSessionTimestamp(dateStr?: string, locale: SupportedLocale = 'en'): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';

  const isToday = categorizeSessionTime(dateStr) === 'today';
  if (isToday) {
    return d.toLocaleTimeString(locale === 'es' ? 'es-ES' : 'en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  return d.toLocaleDateString(locale === 'es' ? 'es-ES' : 'en-US', {
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Resolves the display title for a session item: a non-blank custom title (set via
 * rename) wins over the first-message preview; falls back to `fallback` when neither
 * is available (e.g. a brand new session with no messages and no custom title yet).
 */
export function getSessionDisplayTitle(session: SessionSummary, fallback: string): string {
  const custom = session.customTitle?.trim();
  if (custom) return custom;
  return session.firstMessage || fallback;
}

/**
 * Normalizes a candidate session name for a rename: trims surrounding whitespace.
 * Whitespace-only input normalizes to an empty string, which callers must reject.
 */
export function normalizeSessionName(name: string): string {
  return name.trim();
}

/**
 * True if `session` matches a (already normalized-by-caller) search query, checked
 * against its custom title, first message, and id. An empty/whitespace query matches
 * everything.
 */
export function matchesSessionSearch(session: SessionSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const title = session.customTitle?.toLowerCase() ?? '';
  const msg = session.firstMessage?.toLowerCase() ?? '';
  const id = session.id?.toLowerCase() ?? '';
  return title.includes(q) || msg.includes(q) || id.includes(q);
}

export const SessionSidebar: React.FC<SessionSidebarProps> = ({
  sessions,
  isLoading,
  isSwitching,
  error,
  activeSessionId,
  activeSessionFile,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  onRenameSession,
  onClose,
  locale,
  filesPanel,
  filesChangesCount,
  projectName,
}) => {
  const [activeTab, setActiveTab] = useState<'sessions' | 'files'>('sessions');
  const [searchTerm, setSearchTerm] = useState('');
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  const t = (key: TranslationKey, params?: Record<string, string | number>) =>
    translate(locale, key, params);

  const startEditing = (session: SessionSummary) => {
    setEditingPath(session.path);
    setEditValue(session.customTitle ?? '');
  };

  const cancelEditing = () => {
    setEditingPath(null);
    setEditValue('');
  };

  const commitEditing = (session: SessionSummary) => {
    const normalized = normalizeSessionName(editValue);
    if (!normalized) {
      return;
    }
    onRenameSession(session.path, normalized);
    setEditingPath(null);
    setEditValue('');
  };

  // Filter sessions by search query
  const filteredSessions = useMemo(() => {
    if (!searchTerm.trim()) return sessions;
    return sessions.filter((s) => matchesSessionSearch(s, searchTerm));
  }, [sessions, searchTerm]);

  // Group filtered sessions chronologically
  const groupedSessions = useMemo(() => {
    const groups: Record<TimeGroup, SessionSummary[]> = {
      today: [],
      yesterday: [],
      previous_days: [],
      older: [],
    };

    for (const session of filteredSessions) {
      const groupKey = categorizeSessionTime(session.modifiedAt || session.createdAt);
      groups[groupKey].push(session);
    }

    return groups;
  }, [filteredSessions]);

  const groupOrder: TimeGroup[] = ['today', 'yesterday', 'previous_days', 'older'];
  const groupTitles: Record<TimeGroup, string> = {
    today: t('sidebar.today'),
    yesterday: t('sidebar.yesterday'),
    previous_days: t('sidebar.previous_days'),
    older: t('sidebar.older'),
  };

  return (
    <nav className="session-sidebar" aria-label={t('sidebar.title')}>
      {/* Sidebar Header */}
      <div className="sidebar-header">
        <div className="sidebar-header-left">
          <span
            className="sidebar-title"
            title={activeTab === 'sessions' ? (projectName || t('sidebar.title')) : t('file_tree.title')}
          >
            {activeTab === 'sessions' ? (projectName || t('sidebar.title')) : t('file_tree.title')}
          </span>
        </div>
        <div className="sidebar-header-actions">
          {activeTab === 'sessions' && (
            <button
              type="button"
              className="btn-sidebar-icon"
              onClick={onNewSession}
              disabled={isSwitching}
              title={t('sidebar.new_session')}
              aria-label={t('sidebar.new_session')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          )}
          <button
            type="button"
            className="btn-sidebar-icon"
            onClick={onClose}
            title={t('sidebar.toggle')}
            aria-label={t('sidebar.toggle')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Sidebar Tabs */}
      <div className="sidebar-tabs" role="tablist" aria-label={t('sidebar.title')}>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'sessions'}
          className={`sidebar-tab ${activeTab === 'sessions' ? 'active' : ''}`}
          onClick={() => setActiveTab('sessions')}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <span>{t('sidebar.tab_sessions')}</span>
          <span className="sidebar-tab-count">{sessions.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'files'}
          className={`sidebar-tab ${activeTab === 'files' ? 'active' : ''}`}
          onClick={() => setActiveTab('files')}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <span>{t('sidebar.tab_files')}</span>
          {filesChangesCount !== undefined && filesChangesCount > 0 && (
            <span
              className="sidebar-tab-count"
              title={t('file_tree.git_changed_count', { count: filesChangesCount })}
            >
              {filesChangesCount}
            </span>
          )}
        </button>
      </div>

      {/* Sessions Tab Panel */}
      <div
        className={`sidebar-tab-panel ${activeTab !== 'sessions' ? 'is-hidden' : ''}`}
        role="tabpanel"
        aria-hidden={activeTab !== 'sessions'}
      >
        {/* Search Input */}
        <SidebarSearchBar
          value={searchTerm}
          onChange={setSearchTerm}
          placeholder={t('sidebar.search_placeholder')}
          clearAriaLabel={t('sidebar.clear_search')}
        />

      {/* Sessions List View */}
      <div className="sidebar-list-container" tabIndex={0} role="region" aria-label={t('sidebar.title')}>
        {isLoading && sessions.length === 0 && (
          <div className="sidebar-loading-state">
            <span className="loading-spinner" aria-hidden="true" />
            <span>{t('sidebar.loading')}</span>
          </div>
        )}

        {error && (
          <div className="sidebar-error-notice" role="alert">
            <span>{error}</span>
          </div>
        )}

        {filteredSessions.length === 0 && (!isLoading || sessions.length > 0) && (
          <div className="sidebar-empty-state">
            {searchTerm.trim().length > 0 ? (
              <span>{t('sidebar.no_search_results')}</span>
            ) : (
              <span>{t('sidebar.empty')}</span>
            )}
          </div>
        )}

        {filteredSessions.length > 0 && (
          <div className="sidebar-groups">
            {groupOrder.map((groupKey) => {
              const groupItems = groupedSessions[groupKey];
              if (groupItems.length === 0) return null;

              return (
                <div key={groupKey} className="sidebar-group">
                  <div className="sidebar-group-header">
                    <span>{groupTitles[groupKey]}</span>
                    <span className="group-count">{groupItems.length}</span>
                  </div>
                  <ul className="sidebar-items-list" role="list">
                    {groupItems.map((session) => {
                      const isActive =
                        session.isActive ||
                        (activeSessionId && session.id === activeSessionId) ||
                        (activeSessionFile && session.path === activeSessionFile);

                      const canDelete =
                        session.messageCount > 0 &&
                        Boolean(session.path && session.path.trim().length > 0);

                      const canRename = Boolean(session.path && session.path.trim().length > 0);

                      const isConfirmingDelete = canDelete && deletingPath === session.path;
                      const isEditing = canRename && editingPath === session.path;

                      const displayTitle = getSessionDisplayTitle(session, t('sidebar.no_messages'));

                      const formattedTime = formatSessionTimestamp(
                        session.modifiedAt || session.createdAt,
                        locale
                      );

                      const countLabel =
                        session.messageCount === 0
                          ? t('sidebar.no_messages')
                          : session.messageCount === 1
                            ? t('sidebar.single_message')
                            : t('sidebar.messages_count', {
                                count: session.messageCount,
                              });

                      return (
                        <li
                          key={session.id || session.path}
                          className={`sidebar-item ${isActive ? 'is-active' : ''} ${isSwitching ? 'is-disabled' : ''} ${isConfirmingDelete ? 'is-confirming-delete' : ''} ${isEditing ? 'is-editing' : ''}`}
                          role="button"
                          tabIndex={isSwitching || isConfirmingDelete || isEditing ? -1 : 0}
                          aria-current={isActive ? 'true' : undefined}
                          onClick={() => {
                            if (canSelectSession(isSwitching, isConfirmingDelete || isEditing)) {
                              onSelectSession(session);
                            }
                          }}
                          onKeyDown={(e) => {
                            if ((e.key === 'Enter' || e.key === ' ') && canSelectSession(isSwitching, isConfirmingDelete || isEditing)) {
                              e.preventDefault();
                              onSelectSession(session);
                            }
                          }}
                        >
                          {isConfirmingDelete ? (
                            <div className="item-delete-confirm-box" onClick={(e) => e.stopPropagation()}>
                              <span className="delete-prompt-text">{t('sidebar.delete_confirm_prompt')}</span>
                              <div className="delete-prompt-actions">
                                <button
                                  type="button"
                                  className="btn-confirm-delete"
                                  onClick={() => {
                                    setDeletingPath(null);
                                    onDeleteSession(session);
                                  }}
                                  aria-label={t('action.delete')}
                                >
                                  {t('action.delete')}
                                </button>
                                <button
                                  type="button"
                                  className="btn-cancel-delete"
                                  onClick={() => setDeletingPath(null)}
                                  aria-label={t('action.cancel')}
                                >
                                  {t('action.cancel')}
                                </button>
                              </div>
                            </div>
                          ) : isEditing ? (
                            <div className="item-rename-box" onClick={(e) => e.stopPropagation()}>
                              <input
                                type="text"
                                className="item-rename-input"
                                value={editValue}
                                autoFocus
                                maxLength={200}
                                placeholder={t('sidebar.rename_placeholder')}
                                aria-label={t('sidebar.rename_title')}
                                onChange={(e) => setEditValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    e.preventDefault();
                                    commitEditing(session);
                                  } else if (e.key === 'Escape') {
                                    e.preventDefault();
                                    cancelEditing();
                                  }
                                }}
                              />
                              <div className="rename-prompt-actions">
                                <button
                                  type="button"
                                  className="btn-confirm-rename"
                                  onClick={() => commitEditing(session)}
                                  disabled={!normalizeSessionName(editValue)}
                                  aria-label={t('action.save')}
                                >
                                  {t('action.save')}
                                </button>
                                <button
                                  type="button"
                                  className="btn-cancel-rename"
                                  onClick={cancelEditing}
                                  aria-label={t('action.cancel')}
                                >
                                  {t('action.cancel')}
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <div className="item-title-row">
                                <span className="item-title" title={displayTitle}>
                                  {displayTitle}
                                </span>
                                <div className="item-badges-and-actions">
                                  {isActive && (
                                    <span className="active-badge">
                                      {t('sidebar.active')}
                                    </span>
                                  )}
                                  {canRename && (
                                    <button
                                      type="button"
                                      className="btn-item-rename"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        startEditing(session);
                                      }}
                                      title={t('sidebar.rename_title')}
                                      aria-label={t('sidebar.rename_title')}
                                      disabled={isSwitching}
                                    >
                                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M12 20h9" />
                                        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
                                      </svg>
                                    </button>
                                  )}
                                  {canDelete && (
                                    <button
                                      type="button"
                                      className="btn-item-delete"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setDeletingPath(session.path);
                                      }}
                                      title={t('sidebar.delete_title')}
                                      aria-label={t('sidebar.delete_title')}
                                      disabled={isSwitching}
                                    >
                                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <polyline points="3 6 5 6 21 6" />
                                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                      </svg>
                                    </button>
                                  )}
                                </div>
                              </div>
                              <div className="item-meta-row">
                                <span className="item-time">{formattedTime}</span>
                                <span className="item-bullet">•</span>
                                <span className="item-count">{countLabel}</span>
                              </div>
                            </>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </div>
      </div>

      {/* Files Tab Panel */}
      <div
        className={`sidebar-tab-panel ${activeTab !== 'files' ? 'is-hidden' : ''}`}
        role="tabpanel"
        aria-hidden={activeTab !== 'files'}
      >
        {filesPanel}
      </div>
    </nav>
  );
};
