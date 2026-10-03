import React, { useState, useEffect, useCallback } from 'react';
import {
  browseFilesystemPi,
  pickDirectoryPi,
  type BrowseFolderItem,
  type BrowseShortcutItem,
} from '@infra/bridge';
import { isTauri } from '@tauri-apps/api/core';
import { deriveProjectBasename } from '../projects';
import { translate, type SupportedLocale } from '@shared/i18n';

export interface FolderPickerModalProps {
  isOpen: boolean;
  initialPath?: string;
  onClose: () => void;
  onSelectFolder: (folderPath: string, customName?: string) => void;
  locale: SupportedLocale;
}

export const FolderPickerModal: React.FC<FolderPickerModalProps> = ({
  isOpen,
  initialPath,
  onClose,
  onSelectFolder,
  locale,
}) => {
  const [currentPath, setCurrentPath] = useState<string>(initialPath || '');
  const [pathInput, setPathInput] = useState<string>(initialPath || '');
  const [selectedFolder, setSelectedFolder] = useState<string>(initialPath || '');
  const [projectName, setProjectName] = useState<string>('');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [windowsPath, setWindowsPath] = useState<string | null>(null);
  const [folders, setFolders] = useState<BrowseFolderItem[]>([]);
  const [shortcuts, setshortcuts] = useState<BrowseShortcutItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [searchFilter, setSearchFilter] = useState<string>('');

  const loadDirectory = useCallback(async (dirToLoad: string) => {
    setIsLoading(true);
    try {
      const res = await browseFilesystemPi(dirToLoad);
      setCurrentPath(res.currentPath);
      setPathInput(res.windowsPath || res.currentPath);
      setSelectedFolder(res.windowsPath || res.currentPath);
      setParentPath(res.parentPath);
      setWindowsPath(res.windowsPath);
      setFolders(res.folders || []);
      if (res.shortcuts && res.shortcuts.length > 0) {
        setshortcuts(res.shortcuts);
      }
      setSearchFilter('');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      void loadDirectory(initialPath || '');
    }
  }, [isOpen, initialPath, loadDirectory]);

  if (!isOpen) return null;

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

  const handleConfirm = () => {
    const finalPath = selectedFolder || pathInput || currentPath;
    if (!finalPath) return;
    const finalName = projectName.trim() || deriveProjectBasename(finalPath) || undefined;
    onSelectFolder(finalPath, finalName);
    onClose();
  };

  const filteredFolders = folders.filter((f) =>
    f.name.toLowerCase().includes(searchFilter.trim().toLowerCase())
  );

  return (
    <div className="folder-picker-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="folder-picker-card" onClick={(e) => e.stopPropagation()}>
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
          {isTauri() && (
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
        </div>

        {/* Folders List View */}
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
                    <div className="folder-item-icon">📁</div>
                    <div className="folder-item-info">
                      <span className="folder-item-name">{folder.name}</span>
                      {folder.windowsPath && (
                        <span className="folder-item-winpath">{folder.windowsPath}</span>
                      )}
                    </div>
                    <button
                      type="button"
                      className="folder-item-enter-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleFolderClick(folder);
                      }}
                      title="Entrar a esta carpeta"
                    >
                      ➔
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Selected Summary & Project Name */}
        <div className="folder-picker-selection-footer">
          <div className="folder-picker-selected-row">
            <span className="folder-picker-label">
              {translate(locale, 'projects.folder_picker_selected')}:
            </span>
            <code className="folder-picker-selected-path">
              {selectedFolder}
              {windowsPath && selectedFolder !== windowsPath ? ` (${windowsPath})` : ''}
            </code>
          </div>

          <div className="folder-picker-name-row">
            <label htmlFor="folder-picker-custom-name" className="folder-picker-label">
              {translate(locale, 'projects.folder_picker_name')}:
            </label>
            <input
              id="folder-picker-custom-name"
              type="text"
              className="folder-picker-name-input"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder={deriveProjectBasename(selectedFolder) || 'Mi Proyecto'}
            />
          </div>
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
      </div>
    </div>
  );
};
