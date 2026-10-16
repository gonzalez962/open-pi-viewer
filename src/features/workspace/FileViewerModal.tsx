import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { translate, type SupportedLocale, type TranslationKey } from '@shared/i18n';
import type { WorkspaceFileContent, WorkspaceFileDiff } from '@core/types/workspace';
import { getWorkspaceFileDiffPi } from '@infra/bridge';
import { formatFileSize } from '@shared/format';

export interface FileViewerModalProps {
  file: WorkspaceFileContent | null;
  workingDirectory?: string;
  onClose: () => void;
  locale: SupportedLocale;
}

export interface ParsedDiffLine {
  type: 'hunk' | 'add' | 'del' | 'context' | 'meta';
  text: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

/**
 * Parses unified diff text into clean, structured diff lines.
 * Filters out raw Git header noise (`diff --git`, `index`, `---`, `+++`)
 * and calculates precise original and new line numbers.
 */
export function parseUnifiedDiff(diffText: string): ParsedDiffLine[] {
  if (!diffText || !diffText.trim()) {
    return [];
  }

  const lines = diffText.split('\n');
  const result: ParsedDiffLine[] = [];

  let inHunk = false;
  let curOld = 1;
  let curNew = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect hunk header: @@ -oldStart[,oldCount] +newStart[,newCount] @@ [optional context]
    if (line.startsWith('@@')) {
      const match = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/);
      if (match) {
        inHunk = true;
        curOld = parseInt(match[1], 10);
        curNew = parseInt(match[3], 10);
        result.push({
          type: 'hunk',
          text: line.trim(),
        });
        continue;
      }
    }

    if (!inHunk) {
      // Discard git header metadata lines before the first hunk
      continue;
    }

    if (line.startsWith('+')) {
      result.push({
        type: 'add',
        text: line.slice(1),
        newLineNumber: curNew++,
      });
    } else if (line.startsWith('-')) {
      result.push({
        type: 'del',
        text: line.slice(1),
        oldLineNumber: curOld++,
      });
    } else if (line.startsWith(' ')) {
      result.push({
        type: 'context',
        text: line.slice(1),
        oldLineNumber: curOld++,
        newLineNumber: curNew++,
      });
    } else if (line.startsWith('\\')) {
      result.push({
        type: 'meta',
        text: line,
      });
    } else if (line === '' && i < lines.length - 1) {
      // Empty context line
      result.push({
        type: 'context',
        text: '',
        oldLineNumber: curOld++,
        newLineNumber: curNew++,
      });
    }
  }

  return result;
}

export const FileViewerModal: React.FC<FileViewerModalProps> = ({
  file,
  workingDirectory,
  onClose,
  locale,
}) => {
  const [copied, setCopied] = useState(false);
  const [isLineWrap, setIsLineWrap] = useState(true);
  const [activeTab, setActiveTab] = useState<'content' | 'diff'>('content');
  const [diffData, setDiffData] = useState<WorkspaceFileDiff | null>(null);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);
  const [mediaError, setMediaError] = useState(false);

  // Reset media error and active tab state on file change
  useEffect(() => {
    setMediaError(false);
    setActiveTab('content');
  }, [file?.relativePath]);

  const t = useCallback(
    (key: TranslationKey, params?: Record<string, string | number>) =>
      translate(locale, key, params),
    [locale]
  );

  // Keyboard shortcut: Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Fetch git diff for this file
  useEffect(() => {
    if (!file || file.isBinary) {
      setDiffData(null);
      return;
    }

    let isMounted = true;
    setIsLoadingDiff(true);

    getWorkspaceFileDiffPi(file.relativePath, workingDirectory)
      .then((res) => {
        if (isMounted) {
          setDiffData(res);
          if (res.hasDiff) {
            setActiveTab('diff');
          } else {
            setActiveTab('content');
          }
        }
      })
      .catch(() => {
        if (isMounted) {
          setDiffData(null);
        }
      })
      .finally(() => {
        if (isMounted) {
          setIsLoadingDiff(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [file, workingDirectory]);

  const parsedDiff = useMemo(() => {
    if (!diffData?.diff) return [];
    return parseUnifiedDiff(diffData.diff);
  }, [diffData?.diff]);

  if (!file) return null;

  const currentTextToCopy =
    activeTab === 'diff' && diffData?.diff ? diffData.diff : file.content;

  const handleCopy = async () => {
    if (file.isBinary || !currentTextToCopy) return;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(currentTextToCopy);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      // Ignore clipboard failure
    }
  };

  const contentLines = file.isBinary ? [] : file.content.split('\n');

  return (
    <div
      className="file-viewer-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={file.name}
    >
      <div
        className="file-viewer-container"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="file-viewer-header">
          <div className="file-viewer-info">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="file-viewer-icon"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <span className="file-viewer-path" title={file.relativePath}>
              {file.relativePath}
            </span>
            <span className="file-viewer-size">{formatFileSize(file.size)}</span>
          </div>

          {/* View mode toggle: Content vs Diff */}
          {!file.isBinary && (
            <div className="file-viewer-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'content'}
                className={`viewer-tab-btn ${activeTab === 'content' ? 'active' : ''}`}
                onClick={() => setActiveTab('content')}
              >
                {t('file_viewer.tab_content')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'diff'}
                className={`viewer-tab-btn ${activeTab === 'diff' ? 'active' : ''}`}
                onClick={() => setActiveTab('diff')}
              >
                {t('file_viewer.tab_diff')}
                {diffData?.hasDiff && <span className="diff-indicator-dot" />}
              </button>
            </div>
          )}

          <div className="file-viewer-actions">
            {/* Wrap toggle button */}
            {!file.isBinary && (
              <button
                type="button"
                className={`btn-file-toggle-wrap ${isLineWrap ? 'active' : ''}`}
                onClick={() => setIsLineWrap((prev) => !prev)}
                title={t('file_viewer.toggle_wrap')}
                aria-label={t('file_viewer.toggle_wrap')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="17 10 21 14 17 18" />
                  <path d="M3 6h18" />
                  <path d="M3 18h6" />
                  <path d="M21 14H8a4 4 0 0 1 0-8h1" />
                </svg>
              </button>
            )}

            {!file.isBinary && (
              <button
                type="button"
                className="btn-file-copy"
                onClick={handleCopy}
                title={copied ? t('action.copied') : t('action.copy')}
                aria-label={copied ? t('action.copied') : t('action.copy')}
              >
                {copied ? (
                  <>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    <span>{t('action.copied')}</span>
                  </>
                ) : (
                  <>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                    <span>{t('action.copy')}</span>
                  </>
                )}
              </button>
            )}

            <button
              type="button"
              className="btn-file-close"
              onClick={onClose}
              title={t('action.close')}
              aria-label={t('action.close')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </header>

        {/* Content Body */}
        <main className="file-viewer-body">
          {file.kind === 'image' && file.mediaDataUrl ? (
            <div className="file-viewer-media-container">
              {mediaError ? (
                <div className="file-viewer-media-error">
                  <p>{t('file_viewer.media_load_error')}</p>
                </div>
              ) : (
                <img
                  src={file.mediaDataUrl}
                  alt={file.name}
                  className="file-viewer-media-image"
                  onError={() => setMediaError(true)}
                />
              )}
            </div>
          ) : file.kind === 'video' && file.mediaDataUrl ? (
            <div className="file-viewer-media-container">
              {mediaError ? (
                <div className="file-viewer-media-error">
                  <p>{t('file_viewer.media_load_error')}</p>
                </div>
              ) : (
                <video
                  controls
                  preload="metadata"
                  className="file-viewer-media-video"
                  onError={() => setMediaError(true)}
                >
                  <source src={file.mediaDataUrl} type={file.mimeType || undefined} />
                  {t('file_viewer.video_unsupported')}
                </video>
              )}
            </div>
          ) : file.isBinary ? (
            <div className="file-viewer-binary">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="9" y1="13" x2="15" y2="13" />
                <line x1="9" y1="17" x2="15" y2="17" />
              </svg>
              <p className="binary-notice-title">{t('file_viewer.binary_title')}</p>
              <p className="binary-notice-desc">{t('file_viewer.binary_desc')}</p>
            </div>
          ) : activeTab === 'diff' ? (
            /* Diff View */
            <div className="file-viewer-diff-container">
              {isLoadingDiff ? (
                <div className="sidebar-loading">
                  <div className="sidebar-spinner" />
                  <span>{t('file_tree.loading')}</span>
                </div>
              ) : !diffData?.hasDiff || parsedDiff.length === 0 ? (
                <div className="file-viewer-no-diff">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <p>{t('file_viewer.no_diff')}</p>
                </div>
              ) : (
                <div className="file-diff-lines">
                  {parsedDiff.map((line, idx) => {
                    if (line.type === 'hunk') {
                      return (
                        <div key={idx} className="diff-hunk-row" role="separator">
                          <span className="diff-hunk-text">{line.text}</span>
                        </div>
                      );
                    }

                    return (
                      <div
                        key={idx}
                        className={`diff-line diff-line-${line.type} ${isLineWrap ? 'wrapped' : 'nowrap'}`}
                      >
                        <div className="diff-line-numbers" aria-hidden="true">
                          <span className="diff-line-num old-num">
                            {line.oldLineNumber != null ? line.oldLineNumber : ''}
                          </span>
                          <span className="diff-line-num new-num">
                            {line.newLineNumber != null ? line.newLineNumber : ''}
                          </span>
                        </div>
                        <span className="diff-line-marker" aria-hidden="true">
                          {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
                        </span>
                        <span className="diff-line-text">{line.text}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            /* Standard File Content View with Wrap */
            <div className="file-viewer-code-container">
              <div className="file-viewer-line-numbers" aria-hidden="true">
                {contentLines.map((_, idx) => (
                  <span key={idx} className="line-number">
                    {idx + 1}
                  </span>
                ))}
              </div>
              <pre className={`file-viewer-code ${isLineWrap ? 'wrapped' : 'nowrap'}`}>
                <code>{file.content}</code>
              </pre>
            </div>
          )}
        </main>
      </div>
    </div>
  );
};
