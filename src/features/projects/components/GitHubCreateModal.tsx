import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  createGitHubCreateController,
  getSavedGitHubPat,
  type GitHubCreateController,
  type GitHubCreateState,
} from '../github-create';
import { FolderPickerModal } from './FolderPickerModal';
import { translate, type SupportedLocale } from '@shared/i18n';
import type {
  GitHubAuthStatus,
  CreateGitHubRepositoryPayload,
  CreateGitHubRepositoryResult,
} from '@infra/bridge';

export interface GitHubCreateModalProps {
  isOpen: boolean;
  initialDestinationPath?: string;
  initialIsSubmitting?: boolean;
  initialAuthStatus?: {
    loading: boolean;
    installed: boolean;
    authenticated: boolean;
    username?: string;
  };
  storage?: Storage | null;
  locale: SupportedLocale;
  onClose: () => void;
  onCreateSuccess: (result: CreateGitHubRepositoryResult) => void;
  getAuthStatus?: () => Promise<GitHubAuthStatus>;
  createRepository?: (payload: CreateGitHubRepositoryPayload) => Promise<CreateGitHubRepositoryResult>;
}

export const GitHubCreateModal: React.FC<GitHubCreateModalProps> = ({
  isOpen,
  initialDestinationPath = '',
  initialIsSubmitting = false,
  initialAuthStatus,
  storage,
  locale,
  onClose,
  onCreateSuccess,
  getAuthStatus,
  createRepository,
}) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [autoInit, setAutoInit] = useState(true);
  const [cloneLocally, setCloneLocally] = useState(true);
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
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [isDestinationPickerOpen, setIsDestinationPickerOpen] = useState(false);

  const cardRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const controllerRef = useRef<GitHubCreateController | null>(null);

  const onCreateSuccessRef = useRef(onCreateSuccess);
  onCreateSuccessRef.current = onCreateSuccess;
  const getAuthStatusRef = useRef(getAuthStatus);
  getAuthStatusRef.current = getAuthStatus;
  const createRepositoryRef = useRef(createRepository);
  createRepositoryRef.current = createRepository;

  // Initialize or update controller
  useEffect(() => {
    const ctrl = createGitHubCreateController({
      initialDestinationPath,
      storage,
      getAuthStatus: getAuthStatus ? () => getAuthStatusRef.current!() : undefined,
      createRepository: createRepository ? (p) => createRepositoryRef.current!(p) : undefined,
      onSuccess: (res) => {
        onCreateSuccessRef.current(res);
      },
      onStateChange: (state: GitHubCreateState) => {
        setName(state.name);
        setDescription(state.description);
        setIsPrivate(state.isPrivate);
        setAutoInit(state.autoInit);
        setCloneLocally(state.cloneLocally);
        setDestinationPath(state.destinationPath);
        setToken(state.token);
        setPatUser(state.patUser);
        setIsSubmitting(state.isSubmitting);
        setAuthStatus(state.authStatus);
        setErrorKey(state.error);
      },
    });

    controllerRef.current = ctrl;

    if (isOpen) {
      void ctrl.loadAuthStatus();
      if (token.trim()) {
        void ctrl.fetchPatUser(token);
      }
    }

    return () => {
      ctrl.reset();
    };
  }, [isOpen, initialDestinationPath, storage]);

  // Accessibility focus management
  useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement;
      const timer = setTimeout(() => {
        const input = cardRef.current?.querySelector<HTMLInputElement>('#github-create-name-input');
        input?.focus();
      }, 50);
      return () => clearTimeout(timer);
    } else {
      if (previousFocusRef.current && typeof previousFocusRef.current.focus === 'function') {
        try {
          if (!previousFocusRef.current.closest?.('[inert], [aria-hidden="true"], .is-closed')) {
            previousFocusRef.current.focus();
          }
        } catch {}
      }
    }
  }, [isOpen]);

  // Keydown trap (Escape to close, Tab cycle)
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }

      if (e.key === 'Tab') {
        const focusable = cardRef.current?.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (!focusable || focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [onClose]
  );

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setName(val);
    setErrorKey(null);
    controllerRef.current?.setName(val);
  };

  const handleDescriptionChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setDescription(val);
    controllerRef.current?.setDescription(val);
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    if (controllerRef.current) {
      controllerRef.current.setName(name);
      controllerRef.current.setDescription(description);
      controllerRef.current.setIsPrivate(isPrivate);
      controllerRef.current.setAutoInit(autoInit);
      controllerRef.current.setCloneLocally(cloneLocally);
      controllerRef.current.setDestinationPath(destinationPath);
      controllerRef.current.setToken(token);
      await controllerRef.current.submit();
    }
  };

  if (!isOpen) return null;

  return (
    <>
      <div
        className="github-clone-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="github-create-title"
      >
        <div
          ref={cardRef}
          className="github-clone-card"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={handleKeyDown}
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
                  <line x1="12" y1="5" x2="12" y2="11" />
                  <line x1="9" y1="8" x2="15" y2="8" />
                </svg>
              </span>
              <div>
                <h3 id="github-create-title" className="github-clone-title">
                  {translate(locale, 'projects.github_create.title')}
                </h3>
                <p className="github-clone-subtitle">
                  {translate(locale, 'projects.github_create.subtitle')}
                </p>
              </div>
            </div>

            <button
              ref={closeBtnRef}
              type="button"
              className="github-clone-close-btn"
              onClick={onClose}
              aria-label={translate(locale, 'projects.github_create.cancel')}
              title={translate(locale, 'projects.github_create.cancel')}
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
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* Form */}
          <form className="github-clone-form" onSubmit={handleSubmit}>
            <div className="github-clone-body">
              {/* Auth status indicator */}
              <div
                className={`github-clone-auth-banner ${
                  authStatus.authenticated ? 'is-authenticated' : 'is-unauthenticated'
                }`}
              >
                {authStatus.loading ? (
                  <span className="github-clone-auth-text">...</span>
                ) : authStatus.authenticated ? (
                  <div className="github-clone-auth-row">
                    <span className="github-clone-auth-badge" aria-hidden="true">✓</span>
                    <span className="github-clone-auth-text">
                      {authStatus.username
                        ? translate(locale, 'projects.github_create.auth_gh_ready', { user: authStatus.username })
                        : translate(locale, 'projects.github_create.auth_gh_ready_generic')}
                    </span>
                  </div>
                ) : patUser ? (
                  <div className="github-clone-auth-row">
                    <span className="github-clone-auth-badge" aria-hidden="true">✓</span>
                    <span className="github-clone-auth-text">
                      {translate(locale, 'projects.github_create.auth_pat_user', { user: patUser })}
                    </span>
                  </div>
                ) : (
                  <div className="github-clone-auth-info">
                    <div className="github-clone-auth-row">
                      <span className="github-clone-auth-badge" aria-hidden="true">ℹ</span>
                      <span className="github-clone-auth-text">
                        {translate(locale, 'projects.github_create.auth_gh_missing')}
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {/* Error message */}
              {errorKey && (
                <div className="github-clone-error-box" role="alert">
                  <span className="github-clone-error-icon" aria-hidden="true">⚠</span>
                  <span className="github-clone-error-message">
                    {translate(locale, errorKey as any)}
                  </span>
                </div>
              )}

              {/* Repository Name */}
              <div className="github-clone-field">
                <label htmlFor="github-create-name-input" className="github-clone-label">
                  {translate(locale, 'projects.github_create.name_label')}
                  <span style={{ color: '#ef4444', marginLeft: '4px' }}>*</span>
                </label>
                <div className="github-input-wrapper">
                  <span className="github-input-icon" aria-hidden="true">
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                    </svg>
                  </span>
                  <input
                    id="github-create-name-input"
                    type="text"
                    className="github-clone-input has-icon"
                    placeholder={translate(locale, 'projects.github_create.name_placeholder')}
                    value={name}
                    onChange={handleNameChange}
                    disabled={isSubmitting}
                    autoComplete="off"
                    spellCheck="false"
                    required
                  />
                </div>
                <span className="github-clone-hint">
                  {translate(locale, 'projects.github_create.name_hint')}
                </span>
              </div>

              {/* Description */}
              <div className="github-clone-field">
                <label htmlFor="github-create-desc-input" className="github-clone-label">
                  {translate(locale, 'projects.github_create.desc_label')}
                </label>
                <input
                  id="github-create-desc-input"
                  type="text"
                  className="github-clone-input"
                  placeholder={translate(locale, 'projects.github_create.desc_placeholder')}
                  value={description}
                  onChange={handleDescriptionChange}
                  disabled={isSubmitting}
                />
              </div>

              {/* Visibility (Interactive Cards: Public vs Private) */}
              <div className="github-clone-field">
                <label className="github-clone-label">
                  {translate(locale, 'projects.github_create.visibility_label')}
                </label>
                <div className="github-create-visibility-grid">
                  <button
                    type="button"
                    className={`github-create-vis-card ${!isPrivate ? 'is-selected' : ''}`}
                    onClick={() => {
                      setIsPrivate(false);
                      controllerRef.current?.setIsPrivate(false);
                    }}
                    disabled={isSubmitting}
                  >
                    <span className="github-create-vis-icon" aria-hidden="true">
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <circle cx="12" cy="12" r="10" />
                        <line x1="2" y1="12" x2="22" y2="12" />
                        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                      </svg>
                    </span>
                    <div className="github-create-vis-content">
                      <div className="github-create-vis-title-row">
                        <span className="github-create-vis-title">
                          {translate(locale, 'projects.github_create.public_label')}
                        </span>
                        {!isPrivate && (
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="3"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            style={{ color: 'var(--accent-primary, #6366f1)' }}
                            aria-hidden="true"
                          >
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </div>
                      <span className="github-create-vis-desc">
                        {translate(locale, 'projects.github_create.public_desc')}
                      </span>
                    </div>
                  </button>

                  <button
                    type="button"
                    className={`github-create-vis-card ${isPrivate ? 'is-selected' : ''}`}
                    onClick={() => {
                      setIsPrivate(true);
                      controllerRef.current?.setIsPrivate(true);
                    }}
                    disabled={isSubmitting}
                  >
                    <span className="github-create-vis-icon" aria-hidden="true">
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                      </svg>
                    </span>
                    <div className="github-create-vis-content">
                      <div className="github-create-vis-title-row">
                        <span className="github-create-vis-title">
                          {translate(locale, 'projects.github_create.private_label')}
                        </span>
                        {isPrivate && (
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="3"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            style={{ color: 'var(--accent-primary, #6366f1)' }}
                            aria-hidden="true"
                          >
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </div>
                      <span className="github-create-vis-desc">
                        {translate(locale, 'projects.github_create.private_desc')}
                      </span>
                    </div>
                  </button>
                </div>
              </div>

              {/* Options Stack: autoInit & cloneLocally */}
              <div className="github-create-options-stack">
                <label className="github-create-option-card">
                  <input
                    type="checkbox"
                    className="github-create-checkbox"
                    checked={autoInit}
                    onChange={(e) => {
                      const val = e.target.checked;
                      setAutoInit(val);
                      controllerRef.current?.setAutoInit(val);
                    }}
                    disabled={isSubmitting}
                  />
                  <div className="github-create-option-info">
                    <span className="github-create-option-title">
                      {translate(locale, 'projects.github_create.auto_init_label')}
                    </span>
                    <span className="github-create-option-desc">
                      {translate(locale, 'projects.github_create.auto_init_hint')}
                    </span>
                  </div>
                </label>

                <label className="github-create-option-card">
                  <input
                    type="checkbox"
                    className="github-create-checkbox"
                    checked={cloneLocally}
                    onChange={(e) => {
                      const val = e.target.checked;
                      setCloneLocally(val);
                      controllerRef.current?.setCloneLocally(val);
                    }}
                    disabled={isSubmitting}
                  />
                  <div className="github-create-option-info">
                    <span className="github-create-option-title">
                      {translate(locale, 'projects.github_create.clone_locally_label')}
                    </span>
                    <span className="github-create-option-desc">
                      {translate(locale, 'projects.github_create.clone_locally_hint')}
                    </span>
                  </div>
                </label>
              </div>

              {/* Destination Directory (only if cloneLocally) */}
              {cloneLocally && (
                <div className="github-clone-field">
                  <label htmlFor="github-create-dest-input" className="github-clone-label">
                    {translate(locale, 'projects.github_create.destination_label')}
                    <span style={{ color: '#ef4444', marginLeft: '4px' }}>*</span>
                  </label>
                  <div className="github-clone-dest-row">
                    <input
                      id="github-create-dest-input"
                      type="text"
                      className="github-clone-input github-clone-dest-input"
                      placeholder={translate(locale, 'projects.github_create.destination_placeholder')}
                      value={destinationPath}
                      onChange={handleDestChange}
                      disabled={isSubmitting}
                      required
                    />
                    <button
                      type="button"
                      className="github-clone-browse-btn"
                      onClick={() => setIsDestinationPickerOpen(true)}
                      disabled={isSubmitting}
                    >
                      {translate(locale, 'projects.github_create.browse')}
                    </button>
                  </div>
                </div>
              )}

              {/* Personal Access Token (for environments without gh CLI or override) */}
              {(!authStatus.authenticated || token) && (
                <div className="github-clone-field">
                  <div className="github-clone-label-row">
                    <label htmlFor="github-create-pat-input" className="github-clone-label">
                      {translate(locale, 'projects.github_create.pat_label')}
                    </label>
                    {token && (
                      <button
                        type="button"
                        className="github-clone-clear-pat-btn"
                        onClick={() => {
                          controllerRef.current?.clearToken();
                        }}
                        disabled={isSubmitting}
                      >
                        {translate(locale, 'projects.github_create.pat_clear')}
                      </button>
                    )}
                  </div>
                  <input
                    id="github-create-pat-input"
                    type="password"
                    className="github-clone-input"
                    placeholder={translate(locale, 'projects.github_create.pat_placeholder')}
                    value={token}
                    onChange={handleTokenChange}
                    disabled={isSubmitting}
                    autoComplete="off"
                  />
                  <span className="github-clone-hint">
                    {translate(locale, 'projects.github_create.pat_hint')}
                  </span>
                </div>
              )}
            </div>

            {/* Footer Actions */}
            <div className="github-clone-footer">
              <button
                type="button"
                className="github-clone-btn-cancel"
                onClick={onClose}
                disabled={isSubmitting}
              >
                {translate(locale, 'projects.github_create.cancel')}
              </button>
              <button
                type="submit"
                className="github-clone-btn-submit"
                disabled={isSubmitting || !name.trim() || (cloneLocally && !destinationPath.trim())}
              >
                {isSubmitting ? (
                  <span className="github-clone-spinner-text">
                    <span className="github-clone-spinner" aria-hidden="true" />
                    <span>{translate(locale, 'projects.github_create.creating')}</span>
                  </span>
                ) : (
                  translate(locale, 'projects.github_create.submit')
                )}
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* Destination Directory Picker Modal */}
      {isDestinationPickerOpen && (
        <FolderPickerModal
          isOpen={isDestinationPickerOpen}
          initialPath={destinationPath}
          locale={locale}
          onClose={() => setIsDestinationPickerOpen(false)}
          onSelectFolder={(selectedPath: string) => {
            setDestinationPath(selectedPath);
            controllerRef.current?.setDestinationPath(selectedPath);
            setIsDestinationPickerOpen(false);
          }}
        />
      )}
    </>
  );
};

export default GitHubCreateModal;
