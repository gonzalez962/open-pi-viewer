import React, { useEffect, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { translate, type SupportedLocale, type TranslationKey } from '@shared/i18n';
import type { WorkspaceBranchCommit } from '@core/types/workspace';
import { listWorkspaceBranchCommitsPi } from '@infra/bridge';
import { copyText } from '@shared/clipboard';

export interface BranchCommitsModalProps {
  isOpen: boolean;
  onClose: () => void;
  branchName: string | null;
  workingDirectory?: string;
  locale: SupportedLocale;
}

export const BranchCommitsModal: React.FC<BranchCommitsModalProps> = ({
  isOpen,
  onClose,
  branchName,
  workingDirectory,
  locale,
}) => {
  const [commits, setCommits] = useState<WorkspaceBranchCommit[]>([]);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isLoadingMore, setIsLoadingMore] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedHash, setCopiedHash] = useState<string | null>(null);

  const modalRef = useRef<HTMLDivElement>(null);

  const t = useCallback(
    (key: TranslationKey, params?: Record<string, string | number>) =>
      translate(locale, key, params),
    [locale]
  );

  const loadCommits = useCallback(
    async (branch: string, offset = 0, isMore = false) => {
      if (isMore) {
        setIsLoadingMore(true);
      } else {
        setIsLoading(true);
        setCommits([]);
      }
      setError(null);

      try {
        const result = await listWorkspaceBranchCommitsPi(branch, 10, offset, workingDirectory);
        setCommits((prev) => (isMore ? [...prev, ...result.commits] : result.commits));
        setHasMore(result.hasMore);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      } finally {
        setIsLoading(false);
        setIsLoadingMore(false);
      }
    },
    [workingDirectory]
  );

  useEffect(() => {
    if (isOpen && branchName) {
      void loadCommits(branchName, 0, false);
      setCopiedHash(null);
      setError(null);
    }
  }, [isOpen, branchName, loadCommits]);

  // Keyboard navigation: Escape closes modal and returns to branch manager
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, onClose]);

  const handleLoadMore = useCallback(() => {
    if (!branchName || isLoadingMore || !hasMore) return;
    void loadCommits(branchName, commits.length, true);
  }, [branchName, isLoadingMore, hasMore, commits.length, loadCommits]);

  const handleCopyCommitHash = useCallback(async (hash: string) => {
    const success = await copyText(hash);
    if (success) {
      setCopiedHash(hash);
      setTimeout(() => {
        setCopiedHash((curr) => (curr === hash ? null : curr));
      }, 2000);
    }
  }, []);

  if (!isOpen || !branchName) return null;

  const modalContent = (
    <div
      className="branch-commits-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="branch-commits-modal-title"
    >
      <div className="branch-commits-modal-container" ref={modalRef}>
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
              <circle cx="12" cy="12" r="4" />
              <line x1="1.05" y1="12" x2="7" y2="12" />
              <line x1="17.01" y1="12" x2="22.96" y2="12" />
            </svg>
            <h2 id="branch-commits-modal-title" className="branch-modal-title">
              {t('file_tree.branch_commits_modal_title', { branch: branchName })}
            </h2>
          </div>

          <button
            type="button"
            className="branch-modal-close"
            onClick={onClose}
            aria-label={t('file_tree.branch_commits_back')}
            title={t('file_tree.branch_commits_back')}
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
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>

        {/* Content Body */}
        <div className="branch-commits-modal-body">
          {isLoading ? (
            <div className="branch-commits-loading">
              <div className="sidebar-spinner" />
              <span>{t('file_tree.loading_commits')}</span>
            </div>
          ) : error ? (
            <div className="branch-modal-error" role="alert">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span>{error}</span>
            </div>
          ) : commits.length === 0 ? (
            <div className="branch-commits-empty">
              <span>{t('file_tree.no_commits_found')}</span>
            </div>
          ) : (
            <>
              <div className="branch-commits-list" role="list">
                {commits.map((commit) => (
                  <div key={commit.hash} className="branch-commit-item" role="listitem">
                    <div className="branch-commit-info">
                      <span className="branch-commit-subject" title={commit.subject}>
                        {commit.subject}
                      </span>
                      {commit.isUnpushed && (
                        <span
                          className="branch-commit-unpushed-arrow"
                          title={t('file_tree.commit_unpushed_title')}
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
                            <line x1="12" y1="19" x2="12" y2="5" />
                            <polyline points="5 12 12 5 19 12" />
                          </svg>
                        </span>
                      )}
                    </div>

                    <button
                      type="button"
                      className={`btn-branch-commit-hash ${copiedHash === commit.hash ? 'is-copied' : ''}`}
                      onClick={() => void handleCopyCommitHash(commit.hash)}
                      title={
                        copiedHash === commit.hash
                          ? t('file_tree.commit_hash_copied')
                          : t('file_tree.copy_commit_hash')
                      }
                      aria-label={t('file_tree.copy_commit_hash')}
                    >
                      <code>{commit.shortHash}</code>
                      {copiedHash === commit.hash ? (
                        <svg
                          width="11"
                          height="11"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      ) : (
                        <svg
                          width="11"
                          height="11"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                        </svg>
                      )}
                    </button>
                  </div>
                ))}
              </div>

              {hasMore && (
                <div className="branch-commits-load-more">
                  <button
                    type="button"
                    className="btn-branch-load-more-commits"
                    onClick={handleLoadMore}
                    disabled={isLoadingMore}
                  >
                    {isLoadingMore ? (
                      <>
                        <div className="sidebar-spinner" />
                        <span>{t('file_tree.loading_commits')}</span>
                      </>
                    ) : (
                      <span>{t('file_tree.load_more_commits')}</span>
                    )}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined' && document.body
    ? createPortal(modalContent, document.body)
    : modalContent;
};
