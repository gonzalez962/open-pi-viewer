import React, { useState, useRef, useEffect } from 'react';
import type { TranslationKey } from '@shared/i18n';

export interface CreateFolderFormProps {
  onSubmit: (name: string) => Promise<void> | void;
  onCancel: () => void;
  isLoading?: boolean;
  error?: string | null;
  t?: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

export const CreateFolderForm: React.FC<CreateFolderFormProps> = ({
  onSubmit,
  onCancel,
  isLoading = false,
  error = null,
  t,
}) => {
  const [folderName, setFolderName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown);
    };
  }, [onCancel]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;
    const trimmed = folderName.trim();
    if (!trimmed) return;
    void onSubmit(trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  const placeholderText = t
    ? t('file_tree.folder_name_placeholder')
    : 'Folder name...';
  const submitText = t ? t('file_tree.create_folder_submit') : 'Create';
  const cancelText = t ? t('file_tree.create_folder_cancel') : 'Cancel';

  return (
    <form
      className="create-folder-form"
      onSubmit={handleSubmit}
      onKeyDown={handleKeyDown}
      role="form"
      aria-label="Create folder form"
    >
      <div className="create-folder-row">
        <input
          ref={inputRef}
          type="text"
          className="create-folder-input"
          value={folderName}
          onChange={(e) => setFolderName(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholderText}
          aria-label={placeholderText}
          disabled={isLoading}
          autoFocus
        />
        <button
          type="submit"
          className="btn-create-folder-submit"
          disabled={isLoading || !folderName.trim()}
          title={submitText}
          aria-label={submitText}
        >
          {submitText}
        </button>
        <button
          type="button"
          className="btn-create-folder-cancel"
          onClick={onCancel}
          disabled={isLoading}
          title={cancelText}
          aria-label={cancelText}
        >
          {cancelText}
        </button>
      </div>
      {error && (
        <div className="create-folder-error" role="alert">
          {error}
        </div>
      )}
    </form>
  );
};
