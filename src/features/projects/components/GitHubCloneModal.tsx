import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  createGitHubCloneController,
  getSavedGitHubPat,
  type GitHubCloneController,
  type GitHubCloneState,
} from '../github-clone';
import { FolderPickerModal } from './FolderPickerModal';
import { translate, type SupportedLocale } from '@shared/i18n';
import type {
  GitHubAuthStatus,
  CloneGitHubRepositoryPayload,
  CloneGitHubRepositoryResult,
  ListGitHubRepositoriesResult,
  GitHubOwnerGroup,
  GitHubRepositorySummary,
} from '@infra/bridge';

export interface GitHubCloneModalProps {
  isOpen: boolean;
  initialDestinationPath?: string;
  initialIsSubmitting?: boolean;
  initialAuthStatus?: {
    loading: boolean;
    installed: boolean;
    authenticated: boolean;
    username?: string;
  };
  initialRepoState?: {
    loading?: boolean;
    error?: string | null;
    groups: GitHubOwnerGroup[];
    total: number;
    selectedRepo?: GitHubRepositorySummary;
  };
  storage?: Storage | null;
  locale: SupportedLocale;
  onClose: () => void;
  onCloneSuccess: (clonedPath: string) => void;
  onOpenLocalFolder?: () => void;
  onOpenCreateRepo?: () => void;
  getAuthStatus?: () => Promise<GitHubAuthStatus>;
  cloneRepository?: (payload: CloneGitHubRepositoryPayload) => Promise<CloneGitHubRepositoryResult>;
  listRepositories?: (payload?: { token?: string }) => Promise<ListGitHubRepositoriesResult>;
}

export const GitHubCloneModal: React.FC<GitHubCloneModalProps> = ({
  isOpen,
  initialDestinationPath = '',
  initialIsSubmitting = false,
  initialAuthStatus,
  initialRepoState,
  storage,
  locale,
  onClose,
  onCloneSuccess,
  onOpenLocalFolder,
  onOpenCreateRepo,
  getAuthStatus,
  cloneRepository,
  listRepositories,
}) => {
  const [activeTab, setActiveTab] = useState<'browse' | 'manual'>('browse');
  const [repository, setRepository] = useState('');
  const [destinationPath, setDestinationPath] = useState(initialDestinationPath);
  const [token, setToken] = useState(() => getSavedGitHubPat(storage));
  const [patUser, setPatUser] = useState<string | undefined>(undefined);
  const [isSubmitting, setIsSubmitting] = useState(initialIsSubmitting);
  const [authStatus, setAuthStatus] = useState<{
    loading: boolean;
    installed: boolean;
    authenticated: boolean;
    username?: string;
  }>(() => initialAuthStatus ?? {
    loading: false,
    installed: false,
    authenticated: false,
  });
  const [repoState, setRepoState] = useState<{
    loading: boolean;
    error: string | null;
    groups: GitHubOwnerGroup[];
    total: number;
    selectedRepo?: GitHubRepositorySummary;
  }>(() => ({
    loading: Boolean(initialRepoState?.loading),
    error: initialRepoState?.error ?? null,
    groups: initialRepoState?.groups ?? [],
    total: initialRepoState?.total ?? 0,
    selectedRepo: initialRepoState?.selectedRepo,
  }));
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedOwners, setExpandedOwners] = useState<Record<string, boolean>>({});
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [isDestinationPickerOpen, setIsDestinationPickerOpen] = useState(false);

  const cardRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const controllerRef = useRef<GitHubCloneController | null>(null);

  const onCloneSuccessRef = useRef(onCloneSuccess);
  onCloneSuccessRef.current = onCloneSuccess;
  const getAuthStatusRef = useRef(getAuthStatus);
  getAuthStatusRef.current = getAuthStatus;
  const cloneRepositoryRef = useRef(cloneRepository);
  cloneRepositoryRef.current = cloneRepository;
  const listRepositoriesRef = useRef(listRepositories);
  listRepositoriesRef.current = listRepositories;

  // Initialize or update controller
  useEffect(() => {
    const ctrl = createGitHubCloneController({
      initialDestinationPath,
      storage,
      getAuthStatus: getAuthStatus ? () => getAuthStatusRef.current!() : undefined,
      cloneRepository: cloneRepository ? (p) => cloneRepositoryRef.current!(p) : undefined,
      listRepositories: listRepositories ? (p) => listRepositoriesRef.current!(p) : undefined,
      onSuccess: (clonedPath) => {
        onCloneSuccessRef.current(clonedPath);
      },
      onStateChange: (state: GitHubCloneState) => {
        setIsSubmitting(state.isSubmitting);
        setAuthStatus(state.authStatus);
        setPatUser(state.patUser);
        setErrorKey(state.error);
        setToken((prev) => (prev !== state.token ? state.token : prev));
        setRepoState(state.repositories);
      },
    });
    controllerRef.current = ctrl;

    return () => {
      ctrl.dispose();
      controllerRef.current = null;
    };
  }, [initialDestinationPath, storage]);

  // Load auth status and sync initial destination on open
  useEffect(() => {
    if (isOpen) {
      setDestinationPath(initialDestinationPath);
      controllerRef.current?.setDestinationPath(initialDestinationPath);
      const saved = getSavedGitHubPat(storage);
      if (saved) {
        setToken(saved);
        controllerRef.current?.setToken(saved);
      }
      void controllerRef.current?.loadAuthStatus().then(() => {
        void controllerRef.current?.loadRepositories();
      });
    } else {
      setErrorKey(null);
      setSearchQuery('');
    }
  }, [isOpen, initialDestinationPath, storage]);

  // Keyboard navigation, accessibility, focus trap
  useEffect(() => {
    if (!isOpen) return;

    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      previousFocusRef.current = document.activeElement;
    }

    const timer = setTimeout(() => {
      if (closeBtnRef.current && typeof closeBtnRef.current.focus === 'function') {
        closeBtnRef.current.focus();
      }
    }, 25);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (isDestinationPickerOpen) return;

      if (e.key === 'Escape') {
        if (!isSubmitting) {
          e.preventDefault();
          e.stopPropagation();
          handleClose();
        }
        return;
      }

      if (e.key === 'Tab' && cardRef.current) {
        const focusables = Array.from(
          cardRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => {
          if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
          if (el.style && (el.style.display === 'none' || el.style.visibility === 'hidden')) return false;
          return true;
        });

        if (focusables.length === 0) {
          e.preventDefault();
          return;
        }

        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;

        if (e.shiftKey) {
          if (active === first || !cardRef.current.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (active === last || !cardRef.current.contains(active)) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', handleKeyDown);
      const prevEl = previousFocusRef.current;
      if (
        prevEl &&
        typeof prevEl.focus === 'function' &&
        typeof document !== 'undefined' &&
        document.contains(prevEl) &&
        !prevEl.closest?.('[inert], [aria-hidden="true"], .is-closed')
      ) {
        prevEl.focus();
      }
    };
  }, [isOpen, isSubmitting, isDestinationPickerOpen]);

  const handleClose = useCallback(() => {
    if (isSubmitting) return;
    setErrorKey(null);
    onClose();
  }, [isSubmitting, onClose]);

  const handleClearPat = useCallback(() => {
    setToken('');
    controllerRef.current?.clearToken();
  }, []);

  const handleRepoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setRepository(val);
    setErrorKey(null);
    controllerRef.current?.setRepository(val);
  };

  const handleDestChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setDestinationPath(val);
    setErrorKey(null);
    controllerRef.current?.setDestinationPath(val);
  };

  const handleTokenChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setToken(val);
    setErrorKey(null);
    controllerRef.current?.setToken(val);
  };

  const toggleOwnerExpand = (owner: string) => {
    setExpandedOwners((prev) => ({
      ...prev,
      [owner]: !prev[owner],
    }));
  };

  const handleSelectRepository = (repo: GitHubRepositorySummary) => {
    setRepository(repo.fullName);
    setErrorKey(null);
    controllerRef.current?.selectRepository(repo);
  };

  const handleRefreshRepos = () => {
    void controllerRef.current?.loadRepositories();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    if (controllerRef.current) {
      controllerRef.current.setRepository(repository);
      controllerRef.current.setDestinationPath(destinationPath);
      controllerRef.current.setToken(token);
      await controllerRef.current.submit();
    }
  };

  // Filter groups and repositories based on search query, with repositories sorted alphabetically
  const filteredGroups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const sortedGroups = repoState.groups.map((group) => ({
      ...group,
      repositories: [...group.repositories].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      ),
    }));

    if (!q) return sortedGroups;

    return sortedGroups
      .map((group) => {
        const matchesOwner = group.owner.toLowerCase().includes(q);
        const matchingRepos = group.repositories.filter(
          (repo) =>
            repo.name.toLowerCase().includes(q) ||
            repo.fullName.toLowerCase().includes(q) ||
            (repo.description && repo.description.toLowerCase().includes(q))
        );

        if (matchesOwner) {
          return group;
        }

        if (matchingRepos.length > 0) {
          return {
            ...group,
            repositories: matchingRepos,
          };
        }

        return null;
      })
      .filter((g): g is GitHubOwnerGroup => g !== null);
  }, [repoState.groups, searchQuery]);

  if (!isOpen) return null;

  return (
    <>
      <div
        className="github-clone-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="github-clone-title"
      >
        <div
          ref={cardRef}
          className="github-clone-card"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="github-clone-header">
            <div className="github-clone-title-group">
              <span className="github-clone-icon" aria-hidden="true">
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
                  <path d="M9 18c-4.51 2-5-2-7-2" />
                </svg>
              </span>
              <div>
                <h3 id="github-clone-title" className="github-clone-title">
                  {translate(locale, 'projects.github_clone.title')}
                </h3>
                <p className="github-clone-subtitle">
                  {translate(locale, 'projects.github_clone.subtitle')}
                </p>
              </div>
            </div>

            <div className="github-clone-header-actions">
              {onOpenCreateRepo && (
                <button
                  type="button"
                  className="github-clone-create-repo-btn"
                  onClick={() => {
                    handleClose();
                    onOpenCreateRepo();
                  }}
                  disabled={isSubmitting}
                  title={translate(locale, 'projects.github_clone.create_repo')}
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
                  <span>{translate(locale, 'projects.github_clone.create_repo')}</span>
                </button>
              )}
              {onOpenLocalFolder && (
                <button
                  type="button"
                  className="github-clone-local-repo-btn"
                  onClick={() => {
                    handleClose();
                    onOpenLocalFolder();
                  }}
                  disabled={isSubmitting}
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
                  <span>{translate(locale, 'projects.github_clone.open_local_folder')}</span>
                </button>
              )}
              <button
                ref={closeBtnRef}
                type="button"
                className="github-clone-close-btn"
                onClick={handleClose}
                disabled={isSubmitting}
                aria-label={translate(locale, 'projects.cancel')}
              >
                ✕
              </button>
            </div>
          </div>

          {/* Form */}
          <form className="github-clone-form" onSubmit={handleSubmit}>
            <div className="github-clone-body">
              {/* Auth Status Banner */}
              <div
                className={`github-clone-auth-banner ${
                  authStatus.authenticated ? 'is-authenticated' : 'is-unauthenticated'
                }`}
              >
                {authStatus.loading ? (
                  <span className="github-clone-auth-text">...</span>
                ) : authStatus.authenticated ? (
                  <div className="github-clone-auth-row">
                    <span className="github-clone-auth-badge">✓</span>
                    <span className="github-clone-auth-text">
                      {authStatus.username
                        ? translate(locale, 'projects.github_clone.auth_gh_ready', { user: authStatus.username })
                        : translate(locale, 'projects.github_clone.auth_gh_ready_generic')}
                    </span>
                  </div>
                ) : (
                  <div className="github-clone-auth-info">
                    <div className="github-clone-auth-row">
                      <span className="github-clone-auth-badge">ℹ</span>
                      <span className="github-clone-auth-text">
                        {translate(locale, 'projects.github_clone.auth_gh_missing')}
                      </span>
                    </div>
                    <span className="github-clone-auth-subtext">
                      {translate(locale, 'projects.github_clone.auth_public_hint')}
                    </span>
                  </div>
                )}
              </div>

              {/* Error display - safe fixed localized text only */}
              {errorKey && (
                <div className="github-clone-error-box" role="alert">
                  <span className="github-clone-error-icon" aria-hidden="true">⚠</span>
                  <span className="github-clone-error-message">
                    {translate(locale, errorKey as any)}
                  </span>
                </div>
              )}

              {/* Tabs for Browse Repositories vs Manual URL */}
              <div className="github-clone-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'browse'}
                  className={`github-clone-tab ${activeTab === 'browse' ? 'is-active' : ''}`}
                  onClick={() => setActiveTab('browse')}
                  disabled={isSubmitting}
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
                    <line x1="8" y1="6" x2="21" y2="6" />
                    <line x1="8" y1="12" x2="21" y2="12" />
                    <line x1="8" y1="18" x2="21" y2="18" />
                    <line x1="3" y1="6" x2="3.01" y2="6" />
                    <line x1="3" y1="12" x2="3.01" y2="12" />
                    <line x1="3" y1="18" x2="3.01" y2="18" />
                  </svg>
                  <span>{translate(locale, 'projects.github_clone.tab_browse')}</span>
                  {repoState.total > 0 && (
                    <span className="github-clone-tab-badge">{repoState.total}</span>
                  )}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'manual'}
                  className={`github-clone-tab ${activeTab === 'manual' ? 'is-active' : ''}`}
                  onClick={() => setActiveTab('manual')}
                  disabled={isSubmitting}
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
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                  </svg>
                  <span>{translate(locale, 'projects.github_clone.tab_manual')}</span>
                </button>
              </div>

              {/* Tab 1: Browse Repositories Categorized by Owner */}
              {activeTab === 'browse' && (
                <div className="github-clone-browse-section">
                  <div className="github-clone-browse-search-row">
                    <input
                      type="text"
                      className="github-clone-input github-clone-search-input"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder={translate(locale, 'projects.github_clone.search_repos')}
                      disabled={isSubmitting || repoState.loading}
                    />
                    <button
                      type="button"
                      className="github-clone-refresh-btn"
                      onClick={handleRefreshRepos}
                      disabled={isSubmitting || repoState.loading}
                      title={translate(locale, 'projects.github_clone.refresh_repos')}
                      aria-label={translate(locale, 'projects.github_clone.refresh_repos')}
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
                        className={repoState.loading ? 'is-spinning' : ''}
                        aria-hidden="true"
                      >
                        <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                      </svg>
                    </button>
                  </div>

                  {repoState.loading ? (
                    <div className="github-clone-repos-loading">
                      <span className="github-clone-spinner" aria-hidden="true" />
                      <span>{translate(locale, 'projects.github_clone.loading_repos')}</span>
                    </div>
                  ) : repoState.error ? (
                    <div className="github-clone-repos-empty">
                      <span>{translate(locale, repoState.error as any)}</span>
                    </div>
                  ) : filteredGroups.length === 0 ? (
                    <div className="github-clone-repos-empty">
                      <span>{translate(locale, 'projects.github_clone.no_repos_found')}</span>
                    </div>
                  ) : (
                    <div className="github-clone-owner-groups">
                      {filteredGroups.map((group) => {
                        const isExpanded = Boolean(searchQuery.trim()) || Boolean(expandedOwners[group.owner]);
                        return (
                          <div key={group.owner} className="github-clone-owner-group">
                            <div
                              className={`github-clone-owner-header ${!isExpanded ? 'is-collapsed' : ''}`}
                              role="button"
                              tabIndex={0}
                              aria-expanded={isExpanded}
                              onClick={() => toggleOwnerExpand(group.owner)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  toggleOwnerExpand(group.owner);
                                }
                              }}
                            >
                              <span
                                className={`github-clone-owner-chevron ${!isExpanded ? 'is-collapsed' : ''}`}
                                aria-hidden="true"
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
                                >
                                  <polyline points="6 9 12 15 18 9" />
                                </svg>
                              </span>
                              {group.ownerAvatarUrl ? (
                                <img
                                  src={group.ownerAvatarUrl}
                                  alt={group.owner}
                                  className="github-clone-owner-avatar"
                                />
                              ) : (
                                <div className="github-clone-owner-avatar-placeholder">
                                  {group.owner.slice(0, 2).toUpperCase()}
                                </div>
                              )}
                              <div className="github-clone-owner-meta">
                                <span className="github-clone-owner-name">{group.owner}</span>
                                <span className="github-clone-owner-badge">
                                  {group.isCurrentUser
                                    ? translate(locale, 'projects.github_clone.my_repos')
                                    : translate(locale, 'projects.github_clone.org_repos')}
                                </span>
                              </div>
                              <span className="github-clone-owner-count">
                                {group.repositories.length}
                              </span>
                            </div>

                            {isExpanded && (
                              <div className="github-clone-repo-list">
                                {group.repositories.map((repo) => {
                                  const isSelected = repository === repo.fullName;
                                  return (
                                    <div
                                      key={repo.id || repo.fullName}
                                      role="button"
                                      tabIndex={0}
                                      className={`github-clone-repo-item ${isSelected ? 'is-selected' : ''}`}
                                      onClick={() => handleSelectRepository(repo)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter' || e.key === ' ') {
                                          e.preventDefault();
                                          handleSelectRepository(repo);
                                        }
                                      }}
                                    >
                                      <div className="github-clone-repo-item-main">
                                        <div className="github-clone-repo-title-row">
                                          <span className="github-clone-repo-name">{repo.name}</span>
                                          <span
                                            className={`github-clone-repo-visibility-badge ${
                                              repo.isPrivate ? 'is-private' : 'is-public'
                                            }`}
                                          >
                                            {repo.isPrivate
                                              ? translate(locale, 'projects.github_clone.private_badge')
                                              : translate(locale, 'projects.github_clone.public_badge')}
                                          </span>
                                          {repo.archived && (
                                            <span className="github-clone-repo-archived-badge">
                                              {translate(locale, 'projects.github_clone.archived_badge')}
                                            </span>
                                          )}
                                        </div>
                                        {repo.description && (
                                          <span className="github-clone-repo-desc" title={repo.description}>
                                            {repo.description}
                                          </span>
                                        )}
                                      </div>
                                      <span className="github-clone-repo-check" aria-hidden="true">
                                        {isSelected ? '✓' : ''}
                                      </span>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Tab 2: Manual Repository URL Input */}
              {activeTab === 'manual' && (
                <div className="github-clone-field">
                  <label htmlFor="github-clone-repo-input" className="github-clone-label">
                    {translate(locale, 'projects.github_clone.repo_label')}
                  </label>
                  <input
                    id="github-clone-repo-input"
                    type="text"
                    className="github-clone-input"
                    value={repository}
                    onChange={handleRepoChange}
                    placeholder={translate(locale, 'projects.github_clone.repo_placeholder')}
                    disabled={isSubmitting}
                    required
                    autoFocus
                  />
                  <span className="github-clone-hint">
                    {translate(locale, 'projects.github_clone.repo_hint')}
                  </span>
                </div>
              )}

              {/* Destination Field */}
              <div className="github-clone-field">
                <label htmlFor="github-clone-dest-input" className="github-clone-label">
                  {translate(locale, 'projects.github_clone.destination_label')}
                </label>
                <div className="github-clone-dest-row">
                  <input
                    id="github-clone-dest-input"
                    type="text"
                    className="github-clone-input github-clone-dest-input"
                    value={destinationPath}
                    onChange={handleDestChange}
                    placeholder={translate(locale, 'projects.github_clone.destination_placeholder')}
                    disabled={isSubmitting}
                    required
                  />
                  <button
                    type="button"
                    className="github-clone-browse-btn"
                    onClick={() => setIsDestinationPickerOpen(true)}
                    disabled={isSubmitting}
                  >
                    {translate(locale, 'projects.github_clone.browse')}
                  </button>
                </div>
                <span className="github-clone-hint">
                  {translate(locale, 'projects.github_clone.destination_hint')}
                </span>
              </div>

              {/* PAT field: asked only when gh is NOT authenticated */}
              {!authStatus.loading && !authStatus.authenticated && (
                <div className="github-clone-field">
                  <div className="github-clone-label-row">
                    <label htmlFor="github-clone-pat-input" className="github-clone-label">
                      {translate(locale, 'projects.github_clone.pat_label')}
                    </label>
                    {token && (
                      <button
                        type="button"
                        className="github-clone-clear-pat-btn"
                        onClick={handleClearPat}
                        disabled={isSubmitting}
                      >
                        {translate(locale, 'projects.github_clone.pat_clear')}
                      </button>
                    )}
                  </div>
                  <input
                    id="github-clone-pat-input"
                    type="password"
                    className="github-clone-input"
                    value={token}
                    onChange={handleTokenChange}
                    placeholder={translate(locale, 'projects.github_clone.pat_placeholder')}
                    disabled={isSubmitting}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <span className="github-clone-hint">
                    {patUser
                      ? translate(locale, 'projects.github_clone.auth_pat_user', { user: patUser })
                      : translate(locale, 'projects.github_clone.pat_hint')}
                  </span>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="github-clone-footer">
              <button
                type="button"
                className="github-clone-btn-cancel"
                onClick={handleClose}
                disabled={isSubmitting}
              >
                {translate(locale, 'projects.github_clone.cancel')}
              </button>
              <button
                type="submit"
                className="github-clone-btn-submit"
                disabled={isSubmitting || !repository.trim() || !destinationPath.trim()}
              >
                {isSubmitting ? (
                  <span className="github-clone-spinner-text">
                    <span className="github-clone-spinner" aria-hidden="true" />
                    {translate(locale, 'projects.github_clone.cloning')}
                  </span>
                ) : (
                  translate(locale, 'projects.github_clone.submit')
                )}
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* Destination Folder Picker Modal Reuse */}
      {isDestinationPickerOpen && (
        <FolderPickerModal
          isOpen={isDestinationPickerOpen}
          initialPath={destinationPath}
          locale={locale}
          onClose={() => setIsDestinationPickerOpen(false)}
          onSelectFolder={(pickedFolder) => {
            setDestinationPath(pickedFolder);
            controllerRef.current?.setDestinationPath(pickedFolder);
            setIsDestinationPickerOpen(false);
          }}
        />
      )}
    </>
  );
};

export default GitHubCloneModal;
