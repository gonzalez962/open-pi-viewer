import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  browseFilesystemPi,
  pickDirectoryPi,
  createWorkspaceDirPi,
  deleteWorkspaceDirPi,
  type BrowseFolderItem,
  type BrowseShortcutItem,
} from '@infra/bridge';
import { isTauri } from '@tauri-apps/api/core';
import { isWebShim } from '@infra/web-oauth-access';
import { deriveProjectBasename } from '../projects';
import { translate, type SupportedLocale } from '@shared/i18n';

export interface FolderPickerModalProps {
  isOpen: boolean;
  initialPath?: string;
  initialFolders?: BrowseFolderItem[];
  initialFolderToDelete?: BrowseFolderItem | null;
  onClose: () => void;
  onSelectFolder: (folderPath: string, customName?: string) => void;
  locale: SupportedLocale;
}

export const FolderPickerModal: React.FC<FolderPickerModalProps> = ({
  isOpen,
  initialPath,
  initialFolders,
  initialFolderToDelete,
  onClose,
  onSelectFolder,
  locale,
}) => {
  const [currentPath, setCurrentPath] = useState<string>(initialPath || '');
  const [pathInput, setPathInput] = useState<string>(initialPath || '');
  const [selectedFolder, setSelectedFolder] = useState<string>(initialPath || '');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [folders, setFolders] = useState<BrowseFolderItem[]>(initialFolders || []);
  const [shortcuts, setshortcuts] = useState<BrowseShortcutItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [searchFilter, setSearchFilter] = useState<string>('');

  // Inline folder creation state
  const [isCreatingFolder, setIsCreatingFolder] = useState<boolean>(false);
  const [isSubmittingFolder, setIsSubmittingFolder] = useState<boolean>(false);
  const [createFolderError, setCreateFolderError] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState<string>('');

  // Folder deletion state
  const [folderToDelete, setFolderToDelete] = useState<BrowseFolderItem | null>(
    initialFolderToDelete || null
  );
  const [deleteConfirmationName, setDeleteConfirmationName] = useState<string>('');
  const [isDeletingFolder, setIsDeletingFolder] = useState<boolean>(false);
  const [deleteFolderError, setDeleteFolderError] = useState<string | null>(null);

  const cardRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const isCreatingFolderRef = useRef<boolean>(false);
  isCreatingFolderRef.current = isCreatingFolder;
  const folderToDeleteRef = useRef<BrowseFolderItem | null>(null);
  folderToDeleteRef.current = folderToDelete;
  const activePathRef = useRef<string>(currentPath);
  activePathRef.current = currentPath;
  const folderNameInputRef = useRef<HTMLInputElement>(null);
  const deleteNameInputRef = useRef<HTMLInputElement>(null);

  // Focus management, focus trap, and Escape key handling
  useEffect(() => {
    if (!isOpen) return;

    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      previousFocusRef.current = document.activeElement;
    }

    const timer = setTimeout(() => {
      if (closeBtnRef.current && typeof closeBtnRef.current.focus === 'function') {
        closeBtnRef.current.focus();
      }
    }, 20);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (folderToDeleteRef.current) {
          setFolderToDelete(null);
          setDeleteConfirmationName('');
          setIsDeletingFolder(false);
          setDeleteFolderError(null);
          return;
        }
        if (isCreatingFolderRef.current) {
          setIsCreatingFolder(false);
          setIsSubmittingFolder(false);
          setCreateFolderError(null);
          setNewFolderName('');
          return;
        }
        onClose();
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
  }, [isOpen, onClose]);

  // Autofocus name input when create folder form opens
  useEffect(() => {
    if (isCreatingFolder) {
      const timer = setTimeout(() => {
        folderNameInputRef.current?.focus();
      }, 30);
      return () => clearTimeout(timer);
    }
  }, [isCreatingFolder]);

  // Autofocus confirmation input when delete folder confirmation modal opens
  useEffect(() => {
    if (folderToDelete) {
      const timer = setTimeout(() => {
        deleteNameInputRef.current?.focus();
      }, 30);
      return () => clearTimeout(timer);
    }
  }, [folderToDelete]);

  // Session / request generation token to guard async lifecycle and prevent stale completions
  const generationRef = useRef<number>(0);
  const isOpenRef = useRef<boolean>(isOpen);
  isOpenRef.current = isOpen;
  const currentPathRef = useRef<string>(currentPath);
  currentPathRef.current = currentPath;

  const loadDirectory = useCallback(async (dirToLoad: string) => {
    // Invalidate prior generations synchronously at navigation start
    const navGen = ++generationRef.current;

    // Synchronously reset folder creation and deletion state on navigation
    setIsCreatingFolder(false);
    setIsSubmittingFolder(false);
    setCreateFolderError(null);
    setNewFolderName('');
    setFolderToDelete(null);
    setDeleteConfirmationName('');
    setIsDeletingFolder(false);
    setDeleteFolderError(null);
    setIsLoading(true);

    try {
      const res = await browseFilesystemPi(dirToLoad);

      // Stale guard: do not apply if generation changed or modal was closed
      if (generationRef.current !== navGen || !isOpenRef.current) {
        return;
      }

      setCurrentPath(res.currentPath);
      currentPathRef.current = res.currentPath;
      setPathInput(res.windowsPath || res.currentPath);
      setSelectedFolder(res.windowsPath || res.currentPath);
      setParentPath(res.parentPath);
      setFolders(res.folders && res.folders.length > 0 ? res.folders : (initialFolders || []));
      if (res.shortcuts && res.shortcuts.length > 0) {
        setshortcuts(res.shortcuts);
      }
      setSearchFilter('');
    } finally {
      if (generationRef.current === navGen) {
        setIsLoading(false);
      }
    }
  }, [initialFolders]);

  useEffect(() => {
    if (isOpen) {
      generationRef.current++;
      setIsCreatingFolder(false);
      setIsSubmittingFolder(false);
      setCreateFolderError(null);
      setNewFolderName('');
      setFolderToDelete(null);
      setDeleteConfirmationName('');
      setIsDeletingFolder(false);
      setDeleteFolderError(null);
      void loadDirectory(initialPath || '');
    } else {
      generationRef.current++;
      setIsCreatingFolder(false);
      setIsSubmittingFolder(false);
      setCreateFolderError(null);
      setNewFolderName('');
      setFolderToDelete(null);
      setDeleteConfirmationName('');
      setIsDeletingFolder(false);
      setDeleteFolderError(null);
    }
    return () => {
      generationRef.current++;
    };
  }, [isOpen, initialPath, loadDirectory]);

  const handleNavigateUp = () => {
    if (parentPath) {
      void loadDirectory(parentPath);
    }
  };

  const handleFolderClick = (folder: BrowseFolderItem) => {
    void loadDirectory(folder.fullPath);
  };

  const handleShortcutClick = (shortcut: BrowseShortcutItem) => {
    void loadDirectory(shortcut.path);
  };

  const handlePathSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pathInput.trim()) {
      void loadDirectory(pathInput.trim());
    }
  };

  const handleNativeOsPicker = async () => {
    const picked = await pickDirectoryPi(currentPath);
    if (picked) {
      void loadDirectory(picked);
    }
  };

  const handleCancelCreateFolder = useCallback(() => {
    setIsCreatingFolder(false);
    setIsSubmittingFolder(false);
    setCreateFolderError(null);
    setNewFolderName('');
  }, []);

  const handleCreateFolder = useCallback(
    async (e?: React.FormEvent) => {
      if (e) {
        e.preventDefault();
      }
      if (isSubmittingFolder) return;
      const trimmed = newFolderName.trim();
      if (!trimmed) {
        setCreateFolderError(
          translate(locale, 'file_tree.folder_name_required') || 'Folder name is required'
        );
        return;
      }

      const targetDir = currentPath;
      const createGen = generationRef.current;
      setIsSubmittingFolder(true);
      setCreateFolderError(null);

      try {
        await createWorkspaceDirPi({
          workingDirectory: targetDir,
          name: trimmed,
        });

        // Guard against navigation or close while create was in flight
        if (
          generationRef.current !== createGen ||
          !isOpenRef.current ||
          currentPathRef.current !== targetDir
        ) {
          return;
        }

        setIsCreatingFolder(false);
        setNewFolderName('');
        setCreateFolderError(null);

        // Reload current directory
        const res = await browseFilesystemPi(targetDir);
        if (
          generationRef.current !== createGen ||
          !isOpenRef.current ||
          currentPathRef.current !== targetDir
        ) {
          return;
        }

        setCurrentPath(res.currentPath);
        currentPathRef.current = res.currentPath;
        setParentPath(res.parentPath);
        const newFolders = res.folders || [];
        setFolders(newFolders);
        if (res.shortcuts && res.shortcuts.length > 0) {
          setshortcuts(res.shortcuts);
        }
        setSearchFilter('');

        // Ensure newly created folder is selected and path stays coherent
        const createdItem = newFolders.find((f) => f.name === trimmed);
        if (createdItem) {
          const itemPath = createdItem.windowsPath || createdItem.fullPath;
          setSelectedFolder(itemPath);
          setPathInput(itemPath);
        } else {
          setSelectedFolder(res.windowsPath || res.currentPath);
          setPathInput(res.windowsPath || res.currentPath);
        }
      } catch (err) {
        if (
          generationRef.current !== createGen ||
          !isOpenRef.current ||
          currentPathRef.current !== targetDir
        ) {
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        setCreateFolderError(msg);
      } finally {
        if (generationRef.current === createGen) {
          setIsSubmittingFolder(false);
        }
      }
    },
    [currentPath, isSubmittingFolder, newFolderName, locale]
  );

  const handleOpenDeleteConfirmation = (folder: BrowseFolderItem) => {
    setFolderToDelete(folder);
    setDeleteConfirmationName('');
    setDeleteFolderError(null);
    setIsDeletingFolder(false);
  };

  const handleCancelDeleteFolder = useCallback(() => {
    setFolderToDelete(null);
    setDeleteConfirmationName('');
    setDeleteFolderError(null);
    setIsDeletingFolder(false);
  }, []);

  const handleConfirmDeleteFolder = useCallback(
    async (e?: React.FormEvent) => {
      if (e) {
        e.preventDefault();
      }
      if (isDeletingFolder || !folderToDelete) return;

      const trimmedConfirm = deleteConfirmationName.trim();
      if (trimmedConfirm !== folderToDelete.name) {
        setDeleteFolderError(
          translate(locale, 'projects.delete_folder_mismatch_error') ||
            'Folder name does not match confirmation'
        );
        return;
      }

      const targetDir = currentPath;
      const targetFolderName = folderToDelete.name;
      const targetFolderPath = folderToDelete.windowsPath || folderToDelete.fullPath;
      const deleteGen = generationRef.current;
      setIsDeletingFolder(true);
      setDeleteFolderError(null);

      try {
        await deleteWorkspaceDirPi({
          workingDirectory: targetDir,
          name: targetFolderName,
          confirmationName: trimmedConfirm,
        });

        // Guard against navigation or close while delete was in flight
        if (
          generationRef.current !== deleteGen ||
          !isOpenRef.current ||
          currentPathRef.current !== targetDir
        ) {
          return;
        }

        setFolderToDelete(null);
        setDeleteConfirmationName('');
        setDeleteFolderError(null);

        // Clear stale selection if deleted folder was selected
        if (
          selectedFolder === targetFolderPath ||
          selectedFolder === folderToDelete.fullPath ||
          (folderToDelete.windowsPath && selectedFolder === folderToDelete.windowsPath) ||
          pathInput === targetFolderPath
        ) {
          setSelectedFolder('');
          setPathInput(targetDir);
        }

        // Reload current directory
        const res = await browseFilesystemPi(targetDir);
        if (
          generationRef.current !== deleteGen ||
          !isOpenRef.current ||
          currentPathRef.current !== targetDir
        ) {
          return;
        }

        setCurrentPath(res.currentPath);
        currentPathRef.current = res.currentPath;
        setParentPath(res.parentPath);
        const newFolders = res.folders || [];
        setFolders(newFolders);
        if (res.shortcuts && res.shortcuts.length > 0) {
          setshortcuts(res.shortcuts);
        }
      } catch (err) {
        if (
          generationRef.current !== deleteGen ||
          !isOpenRef.current ||
          currentPathRef.current !== targetDir
        ) {
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        setDeleteFolderError(msg);
      } finally {
        if (generationRef.current === deleteGen) {
          setIsDeletingFolder(false);
        }
      }
    },
    [
      currentPath,
      isDeletingFolder,
      folderToDelete,
      deleteConfirmationName,
      selectedFolder,
      pathInput,
      locale,
    ]
  );

  const handleConfirm = () => {
    const finalPath = selectedFolder || pathInput || currentPath;
    if (!finalPath) return;
    const finalName = deriveProjectBasename(finalPath) || undefined;
    onSelectFolder(finalPath, finalName);
    onClose();
  };

  const filteredFolders = folders.filter((f) =>
    f.name.toLowerCase().includes(searchFilter.trim().toLowerCase())
  );

  if (!isOpen) return null;

  return (
    <div className="folder-picker-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div ref={cardRef} className="folder-picker-card" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="folder-picker-header">
          <div className="folder-picker-title-group">
            <span className="folder-picker-icon" aria-hidden="true">📁</span>
            <div>
              <h3 className="folder-picker-title">
                {translate(locale, 'projects.folder_picker_title')}
              </h3>
              <p className="folder-picker-subtitle">
                {translate(locale, 'projects.folder_picker_subtitle')}
              </p>
            </div>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            className="folder-picker-close-btn"
            onClick={onClose}
            aria-label={translate(locale, 'projects.cancel')}
          >
            ✕
          </button>
        </div>

        {/* Shortcuts Bar */}
        {shortcuts.length > 0 && (
          <div className="folder-picker-shortcuts-bar">
            <span className="folder-picker-shortcuts-label">
              {translate(locale, 'projects.folder_picker_shortcuts')}:
            </span>
            <div className="folder-picker-shortcuts-list">
              {shortcuts.map((sc) => (
                <button
                  key={sc.path}
                  type="button"
                  className={`folder-picker-shortcut-pill ${currentPath === sc.path ? 'is-active' : ''}`}
                  onClick={() => handleShortcutClick(sc)}
                >
                  {sc.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Path Bar & Up button */}
        <form className="folder-picker-path-form" onSubmit={handlePathSubmit}>
          <button
            type="button"
            className="folder-picker-btn-up"
            onClick={handleNavigateUp}
            disabled={!parentPath || isLoading}
            title={translate(locale, 'projects.folder_picker_up')}
          >
            ⬆ {translate(locale, 'projects.folder_picker_up')}
          </button>
          <input
            type="text"
            className="folder-picker-path-input"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            placeholder={translate(locale, 'projects.folder_picker_path_placeholder')}
            aria-label={translate(locale, 'projects.folder_picker_path')}
          />
          <button
            type="submit"
            className="btn btn-secondary folder-picker-btn-go"
            disabled={isLoading}
          >
            {translate(locale, 'projects.folder_picker_go')}
          </button>
          {isTauri() && !isWebShim() && (
            <button
              type="button"
              className="btn btn-secondary folder-picker-btn-native"
              onClick={handleNativeOsPicker}
              title="Explorador nativo del SO"
            >
              📂 {translate(locale, 'projects.folder_picker_native')}
            </button>
          )}
        </form>

        {/* Search filter inside folder list */}
        <div className="folder-picker-filter-wrap">
          <input
            type="text"
            className="folder-picker-filter-input"
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            placeholder={translate(locale, 'projects.folder_picker_filter')}
          />
          <button
            type="button"
            className="folder-picker-btn-create-folder btn-tree-create-folder"
            onClick={() => {
              setIsCreatingFolder((prev) => {
                if (!prev) {
                  setCreateFolderError(null);
                  setNewFolderName('');
                }
                return !prev;
              });
            }}
            title={translate(locale, 'file_tree.create_folder')}
            aria-label={translate(locale, 'file_tree.create_folder')}
            disabled={isLoading || isSubmittingFolder}
          >
            {translate(locale, 'file_tree.create_folder')}
          </button>
        </div>

        {/* Inline Create Folder Form */}
        {isCreatingFolder && (
          <form
            className="create-folder-form folder-picker-create-form"
            onSubmit={handleCreateFolder}
            role="form"
            aria-label="Create folder form"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                handleCancelCreateFolder();
              }
            }}
          >
            <div className="create-folder-row">
              <input
                ref={folderNameInputRef}
                type="text"
                className="create-folder-input"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder={translate(locale, 'file_tree.folder_name_placeholder') || 'Folder name...'}
                aria-label={translate(locale, 'file_tree.folder_name_placeholder') || 'Folder name...'}
                disabled={isSubmittingFolder}
                autoFocus
              />
              <button
                type="submit"
                className="btn-create-folder-submit"
                disabled={isSubmittingFolder || !newFolderName.trim()}
                title={translate(locale, 'file_tree.create_folder_submit') || 'Create'}
                aria-label={translate(locale, 'file_tree.create_folder_submit') || 'Create'}
              >
                {translate(locale, 'file_tree.create_folder_submit') || 'Create'}
              </button>
              <button
                type="button"
                className="btn-create-folder-cancel"
                onClick={handleCancelCreateFolder}
                disabled={isSubmittingFolder}
                title={translate(locale, 'file_tree.create_folder_cancel') || 'Cancel'}
                aria-label={translate(locale, 'file_tree.create_folder_cancel') || 'Cancel'}
              >
                {translate(locale, 'file_tree.create_folder_cancel') || 'Cancel'}
              </button>
            </div>
            {createFolderError && (
              <div className="create-folder-error" role="alert">
                {createFolderError}
              </div>
            )}
          </form>
        )}

        {/* Folder icon grid */}
        <div className="folder-picker-list-area">
          {isLoading ? (
            <div className="folder-picker-loading">
              <span className="spin">↻</span> {translate(locale, 'status.connecting')}...
            </div>
          ) : filteredFolders.length === 0 ? (
            <div className="folder-picker-empty">
              <span>{translate(locale, 'projects.folder_picker_empty')}</span>
            </div>
          ) : (
            <div className="folder-picker-grid">
              {filteredFolders.map((folder) => {
                const isItemChosen =
                  selectedFolder === folder.fullPath ||
                  (folder.windowsPath && selectedFolder === folder.windowsPath);
                return (
                  <div
                    key={folder.fullPath}
                    className={`folder-picker-item ${isItemChosen ? 'is-selected' : ''}`}
                    onClick={() => {
                      setSelectedFolder(folder.windowsPath || folder.fullPath);
                      setPathInput(folder.windowsPath || folder.fullPath);
                    }}
                    onDoubleClick={() => handleFolderClick(folder)}
                    role="button"
                    tabIndex={0}
                  >
                    <button
                      type="button"
                      className="folder-item-trash-btn"
                      title={`${translate(locale, 'projects.delete_folder') || 'Delete folder'}: ${folder.name}`}
                      aria-label={`${translate(locale, 'projects.delete_folder') || 'Delete folder'} ${folder.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleOpenDeleteConfirmation(folder);
                      }}
                      disabled={isLoading || isDeletingFolder || isSubmittingFolder}
                    >
                      🗑️
                    </button>
                    <div className="folder-item-icon" aria-hidden="true">📁</div>
                    <span className="folder-item-name" title={folder.name}>{folder.name}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="folder-picker-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
          >
            {translate(locale, 'projects.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleConfirm}
            disabled={!selectedFolder}
          >
            ✓ {translate(locale, 'projects.folder_picker_confirm')}
          </button>
        </div>

        {/* Delete Folder Confirmation Dialog */}
        {folderToDelete && (
          <div
            className="folder-picker-delete-overlay"
            onClick={handleCancelDeleteFolder}
            role="presentation"
          >
            <div
              className="folder-picker-delete-modal"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-label={translate(locale, 'projects.delete_folder_title') || 'Delete folder permanently'}
            >
              <div className="folder-picker-delete-header">
                <span className="delete-modal-warning-icon" aria-hidden="true">⚠️</span>
                <h4 className="folder-picker-delete-title">
                  {translate(locale, 'projects.delete_folder_title') || 'Delete folder permanently'}
                </h4>
              </div>

              <div className="folder-picker-delete-body">
                <p className="delete-folder-warning-text">
                  {translate(locale, 'projects.delete_folder_warning') ||
                    'Warning: This action is permanent and irreversible. All files and subfolders inside will be permanently deleted.'}
                </p>

                <div className="delete-folder-info-card">
                  <div className="delete-info-row">
                    <span className="delete-info-label">Folder:</span>
                    <span className="delete-folder-name" title={folderToDelete.name}>
                      {folderToDelete.name}
                    </span>
                  </div>
                  <div className="delete-info-row">
                    <span className="delete-info-label">
                      {translate(locale, 'projects.delete_folder_path') || 'Path'}:
                    </span>
                    <span
                      className="delete-folder-path"
                      title={folderToDelete.windowsPath || folderToDelete.fullPath}
                    >
                      {folderToDelete.windowsPath || folderToDelete.fullPath}
                    </span>
                  </div>
                </div>

                <form
                  className="folder-picker-delete-form"
                  onSubmit={handleConfirmDeleteFolder}
                  role="form"
                  aria-label="Confirm folder deletion form"
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      handleCancelDeleteFolder();
                    }
                  }}
                >
                  <label htmlFor="delete-folder-confirm-input" className="delete-folder-prompt-label">
                    {translate(locale, 'projects.delete_folder_confirm_prompt', {
                      name: folderToDelete.name,
                    }) || `Type "${folderToDelete.name}" to confirm deletion:`}
                  </label>
                  <input
                    id="delete-folder-confirm-input"
                    ref={deleteNameInputRef}
                    type="text"
                    className="delete-folder-input"
                    value={deleteConfirmationName}
                    onChange={(e) => setDeleteConfirmationName(e.target.value)}
                    placeholder={folderToDelete.name}
                    disabled={isDeletingFolder}
                    autoFocus
                  />

                  {deleteFolderError && (
                    <div className="delete-folder-error" role="alert">
                      {deleteFolderError}
                    </div>
                  )}

                  <div className="folder-picker-delete-actions">
                    <button
                      type="button"
                      className="btn btn-secondary btn-delete-folder-cancel"
                      onClick={handleCancelDeleteFolder}
                      disabled={isDeletingFolder}
                    >
                      {translate(locale, 'projects.delete_folder_cancel_button') || 'Cancel'}
                    </button>
                    <button
                      type="submit"
                      className="btn btn-danger btn-delete-folder-confirm"
                      disabled={isDeletingFolder || deleteConfirmationName.trim() !== folderToDelete.name}
                    >
                      {translate(locale, 'projects.delete_folder_confirm_button') || 'Permanently Delete'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
