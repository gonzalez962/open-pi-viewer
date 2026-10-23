import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { translate, type SupportedLocale, type TranslationKey } from '@shared/i18n';
import type { WorkspaceBranch } from '@core/types/workspace';
import {
  listWorkspaceBranchesPi,
  switchWorkspaceBranchPi,
  createWorkspaceBranchPi,
  deleteWorkspaceBranchPi,
  publishWorkspaceBranchPi,
} from '@infra/bridge';
import { BranchCommitsModal } from './BranchCommitsModal';

export interface BranchManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  workingDirectory?: string;
  currentBranch?: string | null;
  upstreamBranch?: string | null;
  isAgentWorking?: boolean;
  hasUncommittedChanges?: boolean;
  locale: SupportedLocale;
  onBranchSwitched?: (branch: string) => void;
  onError?: (err: string) => void;
}

/**
 * Sanitizes candidate branch name:
 * - Replaces whitespace with hyphens (-)
 * - Removes hyphens adjacent to slashes ('/-' and '-/' become '/')
 * - Collapses consecutive slashes and trims leading/trailing hyphens/slashes/dots
 */
export function sanitizeBranchName(name: string): string {
  if (!name || typeof name !== 'string') return '';
  let sanitized = name.trim();
  sanitized = sanitized.replace(/\s+/g, '-');
  sanitized = sanitized.replace(/-+\/+/g, '/');
  sanitized = sanitized.replace(/\/+-+/g, '/');
  sanitized = sanitized.replace(/\/+/g, '/');
  sanitized = sanitized.replace(/^[-/.]+|[-/.]+$/g, '');
  return sanitized;
}

/**
 * Sorts branches so that 'main' is always first, followed by defaultBranch, then alphabetically.
 */
export function sortBranchesMainFirst(
  branches: WorkspaceBranch[],
  defaultBranch?: string | null
): WorkspaceBranch[] {
  return [...branches].sort((a, b) => {
    if (a.name === 'main') return -1;
    if (b.name === 'main') return 1;
    if (defaultBranch && a.name === defaultBranch) return -1;
    if (defaultBranch && b.name === defaultBranch) return 1;
    return a.name.localeCompare(b.name);
  });
}

export const BranchManagerModal: React.FC<BranchManagerModalProps> = ({
  isOpen,
  onClose,
  workingDirectory,
  currentBranch,
  upstreamBranch: _upstreamBranch,
  isAgentWorking = false,
  hasUncommittedChanges = false,
  locale,
  onBranchSwitched,
  onError,
}) => {
  void _upstreamBranch;
  const [branches, setBranches] = useState<WorkspaceBranch[]>([]);
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null);
  const [allBases, setAllBases] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isSwitching, setIsSwitching] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState<boolean>(false);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);
  const [isPublishing, setIsPublishing] = useState<boolean>(false);
  const [showCreateForm, setShowCreateForm] = useState<boolean>(false);
  const [newBranchName, setNewBranchName] = useState<string>('');
  const [selectedBaseBranch, setSelectedBaseBranch] = useState<string>('');
  const [filterTerm, setFilterTerm] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [pendingSwitchBranch, setPendingSwitchBranch] = useState<string | null>(null);
  const [pendingDeleteBranch, setPendingDeleteBranch] = useState<string | null>(null);
  const [pendingPublishBranch, setPendingPublishBranch] = useState<string | null>(null);
  const [pendingUncommittedConfig, setPendingUncommittedConfig] = useState<{
    name: string;
    baseBranch?: string;
  } | null>(null);
  const [selectedCommitsBranch, setSelectedCommitsBranch] = useState<string | null>(null);
  const [expandedActionsBranch, setExpandedActionsBranch] = useState<string | null>(null);

  const modalRef = useRef<HTMLDivElement>(null);
  const newBranchInputRef = useRef<HTMLInputElement>(null);

  const t = useCallback(
    (key: TranslationKey, params?: Record<string, string | number>) =>
      translate(locale, key, params),
    [locale]
  );

  const loadBranches = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await listWorkspaceBranchesPi(workingDirectory);
      setBranches(data.branches || []);
      setDefaultBranch(data.defaultBranch || null);
      setAllBases(data.allBases || []);
      if (!selectedBaseBranch && (currentBranch || data.current)) {
        setSelectedBaseBranch(currentBranch || data.current || '');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      onError?.(msg);
    } finally {
      setIsLoading(false);
    }
  }, [workingDirectory, currentBranch, selectedBaseBranch, onError]);

  useEffect(() => {
    if (isOpen) {
      void loadBranches();
      setShowCreateForm(false);
      setNewBranchName('');
      setFilterTerm('');
      setError(null);
      setPendingSwitchBranch(null);
      setPendingDeleteBranch(null);
      setPendingPublishBranch(null);
      setPendingUncommittedConfig(null);
      setSelectedCommitsBranch(null);
      setExpandedActionsBranch(null);
    }
  }, [isOpen, loadBranches]);

  useEffect(() => {
    if (showCreateForm && newBranchInputRef.current) {
      newBranchInputRef.current.focus();
    }
  }, [showCreateForm]);

  // Keyboard navigation: Escape closes modal or cancels confirmation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (pendingPublishBranch) {
          setPendingPublishBranch(null);
        } else if (pendingDeleteBranch) {
          setPendingDeleteBranch(null);
        } else if (pendingUncommittedConfig) {
          setPendingUncommittedConfig(null);
        } else if (pendingSwitchBranch) {
          setPendingSwitchBranch(null);
        } else if (showCreateForm) {
          setShowCreateForm(false);
          setError(null);
        } else {
          onClose();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, pendingPublishBranch, pendingDeleteBranch, pendingUncommittedConfig, pendingSwitchBranch, showCreateForm, onClose]);

  const executeSwitch = useCallback(
    async (targetBranch: string) => {
      setIsSwitching(targetBranch);
      setError(null);
      try {
        await switchWorkspaceBranchPi(targetBranch, workingDirectory);
        onBranchSwitched?.(targetBranch);
        onClose();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        onError?.(msg);
      } finally {
        setIsSwitching(null);
        setPendingSwitchBranch(null);
      }
    },
    [workingDirectory, onBranchSwitched, onClose, onError]
  );

  const handleRequestSwitch = useCallback(
    (targetBranch: string) => {
      if (targetBranch === currentBranch) return;

      // If the agent is currently working, prompt confirmation
      if (isAgentWorking) {
        setPendingSwitchBranch(targetBranch);
        return;
      }

      void executeSwitch(targetBranch);
    },
    [currentBranch, isAgentWorking, executeSwitch]
  );

  const handleDeleteBranch = useCallback(
    async (branchToDelete: string) => {
      setIsDeleting(true);
      setError(null);
      try {
        await deleteWorkspaceBranchPi(branchToDelete, workingDirectory);
        setPendingDeleteBranch(null);
        await loadBranches();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        onError?.(msg);
      } finally {
        setIsDeleting(false);
      }
    },
    [workingDirectory, loadBranches, onError]
  );

  const handlePublishBranch = useCallback(
    async (branchToPublish: string) => {
      setIsPublishing(true);
      setError(null);
      try {
        await publishWorkspaceBranchPi(branchToPublish, undefined, workingDirectory);
        setPendingPublishBranch(null);
        await loadBranches();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        onError?.(msg);
      } finally {
        setIsPublishing(false);
      }
    },
    [workingDirectory, loadBranches, onError]
  );

  const doCreateBranch = useCallback(
    async (name: string, baseBranch?: string, leaveChangesInBase?: boolean) => {
      setIsCreating(true);
      setError(null);
      setPendingUncommittedConfig(null);
      try {
        await createWorkspaceBranchPi(
          name,
          baseBranch,
          leaveChangesInBase,
          workingDirectory
        );
        onBranchSwitched?.(name);
        onClose();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        onError?.(msg);
      } finally {
        setIsCreating(false);
      }
    },
    [workingDirectory, onBranchSwitched, onClose, onError]
  );

  const handleCreateBranch = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const sanitized = sanitizeBranchName(newBranchName);
      if (!sanitized) {
        setError(t('file_tree.branch_name_required'));
        return;
      }

      // If uncommitted changes exist, ask user if they want to carry or leave them
      if (hasUncommittedChanges) {
        setPendingUncommittedConfig({
          name: sanitized,
          baseBranch: selectedBaseBranch || undefined,
        });
        return;
      }

      await doCreateBranch(sanitized, selectedBaseBranch || undefined, false);
    },
    [newBranchName, selectedBaseBranch, hasUncommittedChanges, doCreateBranch, t]
  );

  const filteredBranches = useMemo(() => {
    const q = filterTerm.trim().toLowerCase();
    const matched = q ? branches.filter((b) => b.name.toLowerCase().includes(q)) : branches;
    return sortBranchesMainFirst(matched, defaultBranch);
  }, [branches, filterTerm, defaultBranch]);

  const uniqueBases = useMemo(() => {
    const localNames = new Set(branches.map((b) => b.name));
    const set = new Set<string>();
    const list: string[] = [];

    for (const base of allBases) {
      const trimmed = base.trim();
      if (!trimmed) continue;
      // Skip bare remote names without slash and /HEAD
      if (!trimmed.includes('/') && !localNames.has(trimmed)) {
        continue;
      }
      if (trimmed.endsWith('/HEAD')) {
        continue;
      }
      // If it's a remote branch like origin/main and local main already exists, skip remote counterpart
      if (trimmed.includes('/')) {
        const branchPart = trimmed.slice(trimmed.indexOf('/') + 1);
        if (localNames.has(branchPart)) {
          continue;
        }
      }
      if (!set.has(trimmed)) {
        set.add(trimmed);
        list.push(trimmed);
      }
    }

    list.sort((a, b) => {
      if (a === 'main') return -1;
      if (b === 'main') return 1;
      if (defaultBranch && a === defaultBranch) return -1;
      if (defaultBranch && b === defaultBranch) return 1;
      return a.localeCompare(b);
    });

    return list;
  }, [allBases, branches, defaultBranch]);

  if (!isOpen) return null;

  const modalContent = (
    <div
      className="branch-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="branch-modal-title"
    >
      <div
        className="branch-modal-container"
        ref={modalRef}
      >
        {/* Header */}
        <header className="branch-modal-header">
          <div className="branch-modal-title-area">
            <svg
              className="branch-modal-icon"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
            <h2 id="branch-modal-title" className="branch-modal-title">
              {t('file_tree.manage_branches')}
            </h2>
          </div>

          <button
            type="button"
            className="branch-modal-close"
            onClick={onClose}
            aria-label={t('action.cancel')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>

        {/* Action Toolbar */}
        <div className="branch-modal-toolbar">
          <input
            type="text"
            className="branch-filter-input"
            placeholder={t('file_tree.search_branches')}
            value={filterTerm}
            onChange={(e) => setFilterTerm(e.target.value)}
          />

          <button
            type="button"
            className={`btn-branch-new ${showCreateForm ? 'active' : ''}`}
            onClick={() => {
              setShowCreateForm((prev) => !prev);
              setError(null);
            }}
          >
            {t('file_tree.create_branch_btn')}
          </button>
        </div>

        {/* Error Alert */}
        {error && (
          <div className="branch-modal-error" role="alert">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>{error}</span>
          </div>
        )}

        {/* Create Branch Form */}
        {showCreateForm && (
          <form className="branch-create-form" onSubmit={handleCreateBranch}>
            <div className="branch-create-row">
              <div className="branch-field">
                <label htmlFor="new-branch-name" className="branch-field-label">
                  {t('file_tree.branch_name_placeholder')}
                </label>
                <input
                  id="new-branch-name"
                  ref={newBranchInputRef}
                  type="text"
                  className="branch-input"
                  placeholder="feature/new-branch"
                  value={newBranchName}
                  onChange={(e) => setNewBranchName(e.target.value)}
                  onBlur={() => {
                    if (newBranchName.trim()) {
                      setNewBranchName(sanitizeBranchName(newBranchName));
                    }
                  }}
                  disabled={isCreating}
                />
              </div>

              <div className="branch-field">
                <label htmlFor="base-branch-select" className="branch-field-label">
                  {t('file_tree.base_branch_label')}:
                </label>
                <select
                  id="base-branch-select"
                  className="branch-select"
                  value={selectedBaseBranch}
                  onChange={(e) => setSelectedBaseBranch(e.target.value)}
                  disabled={isCreating}
                >
                  {uniqueBases.map((base) => (
                    <option key={base} value={base}>
                      {base} {base === currentBranch ? `(${t('file_tree.current_branch')})` : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="branch-create-actions">
              <button
                type="button"
                className="btn-branch-cancel"
                onClick={() => {
                  setShowCreateForm(false);
                  setError(null);
                }}
                disabled={isCreating}
              >
                {t('action.cancel')}
              </button>
              <button
                type="submit"
                className="btn-branch-submit"
                disabled={isCreating || !newBranchName.trim()}
              >
                {isCreating ? '...' : t('file_tree.create_branch_submit')}
              </button>
            </div>
          </form>
        )}

        {/* Uncommitted Changes Disposition Consultation */}
        {pendingUncommittedConfig && (
          <div className="branch-confirm-box" role="alertdialog">
            <div className="branch-confirm-header">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="warning-icon">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <h3 className="branch-confirm-title">{t('file_tree.uncommitted_changes_title')}</h3>
            </div>
            <p className="branch-confirm-msg">
              {t('file_tree.uncommitted_changes_msg')}
            </p>
            <div className="branch-confirm-actions">
              <button
                type="button"
                className="btn-branch-confirm-cancel"
                onClick={() => setPendingUncommittedConfig(null)}
                disabled={isCreating}
              >
                {t('action.cancel')}
              </button>
              <button
                type="button"
                className="btn-branch-confirm-leave"
                onClick={() =>
                  void doCreateBranch(
                    pendingUncommittedConfig.name,
                    pendingUncommittedConfig.baseBranch,
                    true
                  )
                }
                disabled={isCreating}
              >
                {isCreating ? '...' : t('file_tree.leave_changes_btn')}
              </button>
              <button
                type="button"
                className="btn-branch-confirm-accept"
                onClick={() =>
                  void doCreateBranch(
                    pendingUncommittedConfig.name,
                    pendingUncommittedConfig.baseBranch,
                    false
                  )
                }
                disabled={isCreating}
              >
                {isCreating ? '...' : t('file_tree.carry_changes_btn')}
              </button>
            </div>
          </div>
        )}

        {/* Confirmation Overlay: Publish Branch */}
        {pendingPublishBranch && (
          <div className="branch-confirm-box" role="alertdialog">
            <div className="branch-confirm-header publish">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
                <path d="M12 12v9" />
                <path d="m16 16-4-4-4 4" />
              </svg>
              <h3 className="branch-confirm-title">
                {t('file_tree.publish_confirm_title', { branch: pendingPublishBranch })}
              </h3>
            </div>
            <p className="branch-confirm-msg">
              {t('file_tree.publish_confirm_msg', { branch: pendingPublishBranch })}
            </p>
            <div className="branch-confirm-actions">
              <button
                type="button"
                className="btn-branch-confirm-cancel"
                onClick={() => setPendingPublishBranch(null)}
                disabled={isPublishing}
              >
                {t('action.cancel')}
              </button>
              <button
                type="button"
                className="btn-branch-confirm-publish"
                onClick={() => void handlePublishBranch(pendingPublishBranch)}
                disabled={isPublishing}
              >
                {isPublishing ? '...' : t('file_tree.publish_branch_action')}
              </button>
            </div>
          </div>
        )}

        {/* Confirmation Overlay: Delete Branch */}
        {pendingDeleteBranch && (
          <div className="branch-confirm-box" role="alertdialog">
            <div className="branch-confirm-header danger">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="danger-icon">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
              <h3 className="branch-confirm-title">
                {t('file_tree.delete_confirm_title', { branch: pendingDeleteBranch })}
              </h3>
            </div>
            <p className="branch-confirm-msg">
              {t('file_tree.delete_confirm_msg', { branch: pendingDeleteBranch })}
            </p>
            <div className="branch-confirm-actions">
              <button
                type="button"
                className="btn-branch-confirm-cancel"
                onClick={() => setPendingDeleteBranch(null)}
                disabled={isDeleting}
              >
                {t('action.cancel')}
              </button>
              <button
                type="button"
                className="btn-branch-confirm-danger"
                onClick={() => void handleDeleteBranch(pendingDeleteBranch)}
                disabled={isDeleting}
              >
                {isDeleting ? '...' : t('file_tree.delete_branch_action')}
              </button>
            </div>
          </div>
        )}

        {/* Confirmation Overlay: Agent Working */}
        {pendingSwitchBranch && (
          <div className="branch-confirm-box" role="alertdialog">
            <div className="branch-confirm-header">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="warning-icon">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <h3 className="branch-confirm-title">{t('file_tree.switch_confirm_title')}</h3>
            </div>
            <p className="branch-confirm-msg">
              {t('file_tree.switch_confirm_msg', { branch: pendingSwitchBranch })}
            </p>
            <div className="branch-confirm-actions">
              <button
                type="button"
                className="btn-branch-confirm-cancel"
                onClick={() => setPendingSwitchBranch(null)}
                disabled={isSwitching !== null}
              >
                {t('action.cancel')}
              </button>
              <button
                type="button"
                className="btn-branch-confirm-accept"
                onClick={() => void executeSwitch(pendingSwitchBranch)}
                disabled={isSwitching !== null}
              >
                {isSwitching ? '...' : t('file_tree.switch_confirm_action')}
              </button>
            </div>
          </div>
        )}

        {/* Branch List */}
        <div className="branch-list" role="list">
          {isLoading && branches.length === 0 ? (
            <div className="branch-loading">
              <div className="sidebar-spinner" />
              <span>{t('file_tree.loading')}</span>
            </div>
          ) : filteredBranches.length === 0 ? (
            <div className="branch-empty">
              <span>{t('file_tree.no_branches_found')}</span>
            </div>
          ) : (
            filteredBranches.map((b) => {
              const isCurrent = b.isCurrent || b.name === currentBranch;
              const isDefault =
                b.name === defaultBranch ||
                (!defaultBranch && (b.name === 'main' || b.name === 'master'));
              const isThisSwitching = isSwitching === b.name;
              const isActionsOpen = expandedActionsBranch === b.name;

              return (
                <div
                  key={b.name}
                  className={`branch-item ${isCurrent ? 'is-active' : ''} ${isActionsOpen ? 'actions-open' : ''}`}
                  role="listitem"
                >
                  <div className="branch-item-left">
                    <svg
                      className="branch-item-icon"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="6" y1="3" x2="6" y2="15" />
                      <circle cx="18" cy="6" r="3" />
                      <circle cx="6" cy="18" r="3" />
                      <path d="M18 9a9 9 0 0 1-9 9" />
                    </svg>

                    <div className="branch-item-details">
                      <span className="branch-item-name" title={b.name}>
                        {b.name}
                      </span>
                      {isDefault && (
                        <span className="badge-branch-default">
                          {t('file_tree.default_branch_badge')}
                        </span>
                      )}
                      {b.upstream && (
                        <span
                          className="branch-item-upstream"
                          title={`${t('file_tree.tracking')}: ${b.upstream}`}
                        >
                          <span className="branch-upstream-arrow">&rarr;</span>
                          <span className="branch-upstream-name">{b.upstream}</span>
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="branch-item-actions-wrapper">
                    <div className={`branch-item-actions-drawer ${isActionsOpen ? 'is-expanded' : ''}`}>
                      {!b.upstream && (
                        <button
                          type="button"
                          className="btn-branch-publish"
                          onClick={() => setPendingPublishBranch(b.name)}
                          disabled={isSwitching !== null || isDeleting || isPublishing}
                          title={t('file_tree.publish_branch_btn')}
                          aria-label={t('file_tree.publish_branch_btn')}
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
                          >
                            <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
                            <path d="M12 12v9" />
                            <path d="m16 16-4-4-4 4" />
                          </svg>
                          <span>{t('file_tree.publish_branch_action')}</span>
                        </button>
                      )}

                      {isCurrent ? (
                        <span className="badge-branch-current">
                          {t('file_tree.current_branch')}
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="btn-branch-switch"
                          onClick={() => handleRequestSwitch(b.name)}
                          disabled={isSwitching !== null || isDeleting || isPublishing}
                        >
                          {isThisSwitching ? '...' : t('file_tree.switch_branch_btn')}
                        </button>
                      )}

                      <button
                        type="button"
                        className={`btn-branch-commits ${selectedCommitsBranch === b.name ? 'is-active' : ''}`}
                        onClick={() => setSelectedCommitsBranch(b.name)}
                        title={t('file_tree.view_commits_btn')}
                        aria-label={t('file_tree.view_commits_btn')}
                      >
                        {t('file_tree.view_commits_btn')}
                      </button>

                      {!isCurrent && !isDefault && (
                        <button
                          type="button"
                          className="btn-branch-delete"
                          onClick={() => setPendingDeleteBranch(b.name)}
                          disabled={isSwitching !== null || isDeleting || isPublishing}
                          title={t('file_tree.delete_branch_btn')}
                          aria-label={t('file_tree.delete_branch_btn')}
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
                          >
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      )}
                    </div>

                    <button
                      type="button"
                      className={`btn-branch-actions-toggle ${isActionsOpen ? 'is-active' : ''}`}
                      onClick={() => setExpandedActionsBranch((prev) => (prev === b.name ? null : b.name))}
                      title={t('file_tree.branch_actions_toggle')}
                      aria-label={t('file_tree.branch_actions_toggle')}
                      aria-expanded={isActionsOpen}
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
                      >
                        <circle cx="12" cy="12" r="1.5" />
                        <circle cx="19" cy="12" r="1.5" />
                        <circle cx="5" cy="12" r="1.5" />
                      </svg>
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Dedicated Branch Commits Modal */}
        <BranchCommitsModal
          isOpen={selectedCommitsBranch !== null}
          branchName={selectedCommitsBranch}
          workingDirectory={workingDirectory}
          locale={locale}
          onClose={() => setSelectedCommitsBranch(null)}
        />
      </div>
    </div>
  );

  return typeof document !== 'undefined' && document.body
    ? createPortal(modalContent, document.body)
    : modalContent;
};
