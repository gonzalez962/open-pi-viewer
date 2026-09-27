import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { ModelInfo, ThinkingLevel, SessionStats } from '@core/types/models';
import type { ProfileSummary } from '@core/types/profiles';
import type { McpServerConfig } from '@core/types/mcp';
import type { PiResourceEntry } from '@core/types/extensions';
import type { TranslationKey } from '@shared/i18n';
import type { EngramCloudStatus } from '@infra/bridge';
import type { AttachedFile, FileAttachmentType } from './types';
import {
  formatTokens,
  getContextUsageLevel,
  formatCost,
  formatPercent,
  handleDoubleEscCancel,
  getSupportedAttachmentCategories,
  modelSupportsFiles,
  modelSupportsInputModality,
  calculateContextMetrics,
} from '@core/prompt-controls-utils';
import { PopoverSearchBar } from './components/PopoverSearchBar';

export { modelSupportsFiles, modelSupportsInputModality };

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

export interface PromptControlsProps {
  modelInfo: ModelInfo | null;
  availableModels: ModelInfo[];
  isChangingModel: boolean;
  thinkingLevel: ThinkingLevel | null;
  defaultThinkingLevel?: ThinkingLevel | null;
  availableThinkingLevels: ThinkingLevel[];
  sessionStats: SessionStats | null;
  isHighContext?: boolean;
  isConnected: boolean;
  isBusy: boolean;
  canSend?: boolean;
  onSend?: () => void;
  onAbort?: () => void;
  onSelectModel: (provider: string, modelId: string) => Promise<void>;
  onSelectThinkingLevel: (level: ThinkingLevel) => Promise<void>;
  profiles?: ProfileSummary[];
  activeProfileName?: string | null;
  effectiveScope?: 'project' | 'global' | null;
  isChangingProfile?: boolean;
  onSelectProfile?: (profile: ProfileSummary | null) => Promise<void> | void;
  onCreateProfile?: () => void;
  mcpServers?: McpServerConfig[];
  mcpActiveCount?: number;
  mcpTotalCount?: number;
  onToggleMcpServer?: (server: McpServerConfig, enabled: boolean) => Promise<void>;
  piResources?: PiResourceEntry[];
  piActiveCount?: number;
  piTotalCount?: number;
  onTogglePiResource?: (resource: PiResourceEntry, enabled: boolean) => Promise<void>;
  engramProject?: string | null;
  cloudStatus?: EngramCloudStatus | null;
  isCheckingCloud?: boolean;
  onCheckCloudStatus?: () => Promise<EngramCloudStatus | null> | void;
  isEnrolling?: boolean;
  onEnrollProject?: () => Promise<boolean> | boolean;
  defaultCloudPopoverOpen?: boolean;
  defaultEnrollConfirmOpen?: boolean;
  attachedFiles?: AttachedFile[];
  onAttachFiles?: (files: AttachedFile[]) => void;
  supportsFiles?: boolean;
  defaultFileAttachOpen?: boolean;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

export const PromptControls: React.FC<PromptControlsProps> = ({
  modelInfo,
  availableModels,
  isChangingModel,
  thinkingLevel,
  defaultThinkingLevel,
  availableThinkingLevels,
  sessionStats,
  isHighContext: isHighContextProp,
  isConnected,
  isBusy,
  canSend = false,
  onSend,
  onAbort,
  onSelectModel,
  onSelectThinkingLevel,
  profiles,
  activeProfileName,
  effectiveScope,
  isChangingProfile = false,
  onSelectProfile,
  onCreateProfile,
  mcpServers,
  mcpActiveCount,
  mcpTotalCount,
  onToggleMcpServer,
  piResources,
  piActiveCount,
  piTotalCount,
  onTogglePiResource,
  engramProject,
  cloudStatus,
  isCheckingCloud = false,
  onCheckCloudStatus,
  isEnrolling = false,
  onEnrollProject,
  defaultCloudPopoverOpen = false,
  defaultEnrollConfirmOpen = false,
  attachedFiles: _attachedFiles,
  onAttachFiles,
  supportsFiles: supportsFilesProp,
  defaultFileAttachOpen = false,
  t,
}) => {
  const [isModelOpen, setIsModelOpen] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isFileAttachOpen, setIsFileAttachOpen] = useState(defaultFileAttachOpen);
  const [isMcpOpen, setIsMcpOpen] = useState(false);
  const [isExtOpen, setIsExtOpen] = useState(false);
  const [isThinkingOpen, setIsThinkingOpen] = useState(false);
  const [isStatsOpen, setIsStatsOpen] = useState(false);
  const [isCloudPopoverOpen, setIsCloudPopoverOpen] = useState(defaultCloudPopoverOpen);
  const [showEnrollConfirm, setShowEnrollConfirm] = useState(defaultEnrollConfirmOpen);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [modelFilter, setModelFilter] = useState('');
  const [profileFilter, setProfileFilter] = useState('');
  const [mcpFilter, setMcpFilter] = useState('');
  const [extFilter, setExtFilter] = useState('');
  const [togglingServerName, setTogglingServerName] = useState<string | null>(null);
  const [togglingResourceId, setTogglingResourceId] = useState<string | null>(null);
  const [isConfirmingCancel, setIsConfirmingCancel] = useState(false);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const modelRef = useRef<HTMLDivElement>(null);
  const profileRef = useRef<HTMLDivElement>(null);
  const fileAttachRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mcpRef = useRef<HTMLDivElement>(null);
  const extRef = useRef<HTMLDivElement>(null);
  const thinkingRef = useRef<HTMLDivElement>(null);
  const statsRef = useRef<HTMLDivElement>(null);
  const engramRef = useRef<HTMLDivElement>(null);

  const startConfirmTimer = useCallback(() => {
    setIsConfirmingCancel(true);
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current);
    }
    confirmTimerRef.current = setTimeout(() => {
      setIsConfirmingCancel(false);
      confirmTimerRef.current = null;
    }, 3500);
  }, []);

  const handleConfirmedAbort = useCallback(() => {
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
    setIsConfirmingCancel(false);
    onAbort?.();
  }, [onAbort]);

  const onConfirmStart = startConfirmTimer;

  const handleCancelClick = () => {
    if (!isConfirmingCancel) {
      startConfirmTimer();
    } else {
      handleConfirmedAbort();
    }
  };

  // Reset confirmation state when Pi is not busy
  useEffect(() => {
    if (!isBusy) {
      if (confirmTimerRef.current) {
        clearTimeout(confirmTimerRef.current);
        confirmTimerRef.current = null;
      }
      setIsConfirmingCancel(false);
    }
  }, [isBusy]);

  // Clean up confirmation timer on unmount
  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) {
        clearTimeout(confirmTimerRef.current);
        confirmTimerRef.current = null;
      }
    };
  }, []);

  // Close menus on outside click or handle Escape cancellation
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (modelRef.current && !modelRef.current.contains(target)) {
        setIsModelOpen(false);
      }
      if (profileRef.current && !profileRef.current.contains(target)) {
        setIsProfileOpen(false);
      }
      if (fileAttachRef.current && !fileAttachRef.current.contains(target)) {
        setIsFileAttachOpen(false);
      }
      if (mcpRef.current && !mcpRef.current.contains(target)) {
        setIsMcpOpen(false);
      }
      if (extRef.current && !extRef.current.contains(target)) {
        setIsExtOpen(false);
      }
      if (thinkingRef.current && !thinkingRef.current.contains(target)) {
        setIsThinkingOpen(false);
      }
      if (statsRef.current && !statsRef.current.contains(target)) {
        setIsStatsOpen(false);
      }
      if (engramRef.current && !engramRef.current.contains(target)) {
        setIsCloudPopoverOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showEnrollConfirm) {
          setShowEnrollConfirm(false);
          setEnrollError(null);
          return;
        }
        if (isModelOpen || isProfileOpen || isFileAttachOpen || isMcpOpen || isExtOpen || isThinkingOpen || isStatsOpen || isCloudPopoverOpen) {
          setIsModelOpen(false);
          setIsProfileOpen(false);
          setIsFileAttachOpen(false);
          setIsMcpOpen(false);
          setIsExtOpen(false);
          setIsThinkingOpen(false);
          setIsStatsOpen(false);
          setIsCloudPopoverOpen(false);
          return;
        }
      }

      const hasOverlay =
        typeof document !== 'undefined' &&
        Boolean(document.querySelector('.file-viewer-overlay, .settings-card'));

      handleDoubleEscCancel(e, {
        isBusy,
        isConfirming: isConfirmingCancel,
        hasOpenOverlay: hasOverlay,
        onConfirmStart,
        onAbort: handleConfirmedAbort,
      });
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    isModelOpen,
    isProfileOpen,
    isFileAttachOpen,
    isMcpOpen,
    isExtOpen,
    isThinkingOpen,
    isStatsOpen,
    isCloudPopoverOpen,
    showEnrollConfirm,
    isBusy,
    isConfirmingCancel,
    onConfirmStart,
    handleConfirmedAbort,
  ]);

  useEffect(() => {
    if (!isCloudPopoverOpen) {
      setShowEnrollConfirm(false);
      setEnrollError(null);
    }
  }, [isCloudPopoverOpen]);

  const handleConfirmEnroll = useCallback(async () => {
    if (!onEnrollProject || isEnrolling) return;
    setEnrollError(null);
    try {
      const ok = await onEnrollProject();
      if (ok) {
        setShowEnrollConfirm(false);
      } else {
        setEnrollError('No se pudo inscribir el proyecto en Engram Cloud.');
      }
    } catch (err) {
      setEnrollError(err instanceof Error ? err.message : 'Error al inscribir el proyecto.');
    }
  }, [onEnrollProject, isEnrolling]);

  const activeModelId = modelInfo?.id || '';
  const matchedModel = availableModels.find(
    (m) => m.id === activeModelId && (m.provider === modelInfo?.provider || !modelInfo?.provider)
  );
  const effectiveModel = matchedModel
    ? {
        ...matchedModel,
        ...modelInfo,
        input_modalities: modelInfo?.input_modalities ?? matchedModel.input_modalities,
      }
    : modelInfo;

  const activeModelName = effectiveModel?.name || effectiveModel?.id || t('prompt_controls.default_model');
  const supportsFiles = supportsFilesProp ?? modelSupportsFiles(effectiveModel);
  const supportedCategories = getSupportedAttachmentCategories(effectiveModel);
  const supportsReasoning = Boolean(
    effectiveModel?.reasoning ||
    (availableThinkingLevels.length > 0 && !(availableThinkingLevels.length === 1 && availableThinkingLevels[0] === 'off'))
  );
  const effectiveThinkingLevel = thinkingLevel || defaultThinkingLevel || 'medium';

  const filteredModels = availableModels.filter((m) => {
    if (!modelFilter.trim()) return true;
    const q = modelFilter.toLowerCase();
    return (
      (m.name && m.name.toLowerCase().includes(q)) ||
      (m.id && m.id.toLowerCase().includes(q)) ||
      (m.provider && m.provider.toLowerCase().includes(q))
    );
  });

  const filteredProfiles = useMemo(() => {
    if (!profiles) return [];
    const trimmed = profileFilter.trim().toLowerCase();
    if (!trimmed) return profiles;
    return profiles.filter((p) => {
      if (p.name.toLowerCase().includes(trimmed)) return true;
      if (p.description && p.description.toLowerCase().includes(trimmed)) return true;
      if (p.default_model && p.default_model.toLowerCase().includes(trimmed)) return true;
      return false;
    });
  }, [profiles, profileFilter]);

  // Calculate context metrics
  const { contextTokens, contextWindow, usagePercent, isHighContext: calculatedIsHighContext } = calculateContextMetrics(
    sessionStats,
    effectiveModel ?? modelInfo,
    availableModels
  );
  const isHighContext = isHighContextProp ?? calculatedIsHighContext;
  const usageLevel = getContextUsageLevel(usagePercent);

  const handleModelClick = async (m: ModelInfo) => {
    if (!m.id || !m.provider) return;
    setIsModelOpen(false);
    setModelFilter('');
    await onSelectModel(m.provider, m.id);
  };

  const handleThinkingClick = async (level: ThinkingLevel) => {
    setIsThinkingOpen(false);
    await onSelectThinkingLevel(level);
  };

  const handleTriggerFileInput = (category: FileAttachmentType) => {
    if (!fileInputRef.current) return;
    if (category === 'image') {
      fileInputRef.current.accept = 'image/png,image/jpeg,image/webp,image/gif,image/*';
    } else if (category === 'video') {
      fileInputRef.current.accept = 'video/mp4,video/webm,video/quicktime,video/*';
    } else if (category === 'audio') {
      fileInputRef.current.accept = 'audio/mpeg,audio/wav,audio/ogg,audio/aac,audio/m4a,audio/*';
    } else if (category === 'code') {
      fileInputRef.current.accept = '.ts,.tsx,.js,.jsx,.py,.rs,.go,.json,.md,.txt,.html,.css,.yaml,.yml,.toml,text/*';
    } else {
      fileInputRef.current.accept = '*/*';
    }
    fileInputRef.current.click();
    setIsFileAttachOpen(false);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const processed: AttachedFile[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const isImage = file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg)$/i.test(file.name);
      const isVideo = file.type.startsWith('video/') || /\.(mp4|webm|mov|mkv|avi)$/i.test(file.name);
      const isAudio = file.type.startsWith('audio/') || /\.(mp3|wav|ogg|aac|m4a|flac)$/i.test(file.name);

      if (isImage) {
        const dataUrl = await readFileAsDataUrl(file);
        const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
        processed.push({
          id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
          name: file.name,
          size: file.size,
          type: 'image',
          mimeType: file.type || 'image/png',
          data: base64,
          previewUrl: dataUrl,
        });
      } else if (isVideo) {
        const dataUrl = await readFileAsDataUrl(file);
        const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
        processed.push({
          id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
          name: file.name,
          size: file.size,
          type: 'video',
          mimeType: file.type || 'video/mp4',
          data: base64,
          previewUrl: dataUrl,
        });
      } else if (isAudio) {
        const dataUrl = await readFileAsDataUrl(file);
        const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
        processed.push({
          id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
          name: file.name,
          size: file.size,
          type: 'audio',
          mimeType: file.type || 'audio/mpeg',
          data: base64,
        });
      } else {
        try {
          const text = await readFileAsText(file);
          if (/[\x00-\x08\x0E-\x1F]/.test(text)) {
            const dataUrl = await readFileAsDataUrl(file);
            const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
            processed.push({
              id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
              name: file.name,
              size: file.size,
              type: 'file',
              mimeType: file.type || 'application/octet-stream',
              data: base64,
            });
          } else {
            processed.push({
              id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
              name: file.name,
              size: file.size,
              type: 'text',
              mimeType: file.type || 'text/plain',
              content: text,
            });
          }
        } catch {
          const dataUrl = await readFileAsDataUrl(file);
          const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
          processed.push({
            id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
            name: file.name,
            size: file.size,
            type: 'file',
            mimeType: file.type || 'application/octet-stream',
            data: base64,
          });
        }
      }
    }

    if (onAttachFiles && processed.length > 0) {
      onAttachFiles(processed);
    }
    e.target.value = '';
  };

  return (
    <div className="prompt-controls-bar" role="toolbar" aria-label={t('prompt_controls.toolbar_aria')}>
      {/* 0. Unified Action Button (Send / Cancel / Confirm). While busy, the abort button
          stays available; a queue-send button joins it only when there is draft text ready
          to queue as a followUp, so the idle layout is unaffected. */}
      {isBusy ? (
        <>
          <button
            type="button"
            className={`prompt-action-btn btn-cancel${isConfirmingCancel ? ' btn-confirming' : ''}`}
            onClick={handleCancelClick}
            title={isConfirmingCancel ? t('prompt.confirm_cancel_title') : t('prompt.stop_title')}
          >
            {isConfirmingCancel ? t('prompt.confirm_cancel') : t('action.stop')}
          </button>
          {canSend && (
            <button
              type="submit"
              className="prompt-action-btn btn-send"
              title={t('prompt.queue_title')}
              onClick={onSend ? (e) => { e.preventDefault(); onSend(); } : undefined}
            >
              {t('action.queue')}
            </button>
          )}
        </>
      ) : (
        <button
          type="submit"
          className="prompt-action-btn btn-send"
          disabled={!canSend}
          aria-disabled={!canSend}
          title={t('prompt.send_title')}
          onClick={onSend ? (e) => { e.preventDefault(); onSend(); } : undefined}
        >
          {t('action.send')}
        </button>
      )}

      {/* File Attachment Selector */}
      {supportsFiles && (
        <div className="prompt-control-wrapper file-attach-wrapper" ref={fileAttachRef}>
          <input
            type="file"
            ref={fileInputRef}
            multiple
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
          <button
            type="button"
            className="prompt-control-btn file-attach-btn"
            onClick={() => {
              setIsFileAttachOpen(!isFileAttachOpen);
              setIsModelOpen(false);
              setIsProfileOpen(false);
              setIsMcpOpen(false);
              setIsExtOpen(false);
              setIsThinkingOpen(false);
              setIsStatsOpen(false);
              setIsCloudPopoverOpen(false);
            }}
            disabled={!isConnected || isBusy}
            aria-expanded={isFileAttachOpen}
            aria-haspopup="menu"
            title={t('prompt_controls.attach_file_title')}
          >
            <svg className="control-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
            <span className="control-text text-fg-default">{t('prompt_controls.attach_file')}</span>
            <span className="chevron-icon" aria-hidden="true">▾</span>
          </button>

          {isFileAttachOpen && (
            <div className="prompt-popover file-attach-popover" role="menu">
              <div className="popover-header">
                {t('prompt_controls.select_file_type')}
              </div>
              <div className="file-type-list">
                {supportedCategories.includes('image') && (
                  <button
                    type="button"
                    className="file-type-option"
                    role="menuitem"
                    onClick={() => handleTriggerFileInput('image')}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <polyline points="21 15 16 10 5 21" />
                    </svg>
                    <div className="file-type-info">
                      <span className="file-type-title">{t('prompt_controls.file_type_images')}</span>
                      <span className="file-type-desc">{t('prompt_controls.file_type_images_desc')}</span>
                    </div>
                  </button>
                )}
                {supportedCategories.includes('video') && (
                  <button
                    type="button"
                    className="file-type-option"
                    role="menuitem"
                    onClick={() => handleTriggerFileInput('video')}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="23 7 16 12 23 17 23 7" />
                      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                    </svg>
                    <div className="file-type-info">
                      <span className="file-type-title">{t('prompt_controls.file_type_videos')}</span>
                      <span className="file-type-desc">{t('prompt_controls.file_type_videos_desc')}</span>
                    </div>
                  </button>
                )}
                {supportedCategories.includes('audio') && (
                  <button
                    type="button"
                    className="file-type-option"
                    role="menuitem"
                    onClick={() => handleTriggerFileInput('audio')}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 18V5l12-2v13" />
                      <circle cx="6" cy="18" r="3" />
                      <circle cx="18" cy="16" r="3" />
                    </svg>
                    <div className="file-type-info">
                      <span className="file-type-title">{t('prompt_controls.file_type_audio')}</span>
                      <span className="file-type-desc">{t('prompt_controls.file_type_audio_desc')}</span>
                    </div>
                  </button>
                )}
                {supportedCategories.includes('code') && (
                  <button
                    type="button"
                    className="file-type-option"
                    role="menuitem"
                    onClick={() => handleTriggerFileInput('code')}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="16 18 22 12 16 6" />
                      <polyline points="8 6 2 12 8 18" />
                    </svg>
                    <div className="file-type-info">
                      <span className="file-type-title">{t('prompt_controls.file_type_documents')}</span>
                      <span className="file-type-desc">{t('prompt_controls.file_type_documents_desc')}</span>
                    </div>
                  </button>
                )}
                {supportedCategories.includes('all') && (
                  <button
                    type="button"
                    className="file-type-option"
                    role="menuitem"
                    onClick={() => handleTriggerFileInput('all')}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    <div className="file-type-info">
                      <span className="file-type-title">{t('prompt_controls.file_type_all')}</span>
                      <span className="file-type-desc">{t('prompt_controls.file_type_all_desc')}</span>
                    </div>
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 1. Profile Selector */}
      <div className="prompt-control-wrapper" ref={profileRef}>
        <button
          type="button"
          className={`prompt-control-btn profile-btn ${isChangingProfile ? 'loading' : ''}`}
          onClick={() => {
            setIsProfileOpen(!isProfileOpen);
            setIsModelOpen(false);
            setIsFileAttachOpen(false);
            setIsMcpOpen(false);
            setIsExtOpen(false);
            setIsThinkingOpen(false);
            setIsStatsOpen(false);
            setIsCloudPopoverOpen(false);
          }}
          disabled={!isConnected || isBusy || isChangingProfile}
          aria-expanded={isProfileOpen}
          aria-haspopup="listbox"
          title={t('prompt_controls.select_profile_title')}
        >
          <svg
            className="control-icon"
            viewBox="0 0 16 16"
            width="13"
            height="13"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M7 14s-1 0-1-1 1-4 5-4 5 3 5 4-1 1-1 1H7zm4-6a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm-5.784 6A2.238 2.238 0 0 1 5 13c0-1.355.68-2.75 1.936-3.72A6.325 6.325 0 0 0 5 9c-4 0-5 3-5 4s1 1 1 1h4.216zM4.5 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z" />
          </svg>
          <span className="control-text profile-name">
            {activeProfileName || t('prompt_controls.profiles_none_global')}
          </span>
          <span className="profile-scope-tag">
            {effectiveScope === 'project'
              ? t('prompt_controls.profile_scope_project_tag')
              : activeProfileName
                ? t('prompt_controls.profile_scope_global_tag')
                : t('prompt_controls.profile_scope_default_tag')}
          </span>
          <span className="chevron-icon" aria-hidden="true">▾</span>
        </button>

        {isProfileOpen && (
          <div className="prompt-popover profile-popover" role="listbox" aria-label={t('prompt_controls.profiles_title')}>
            <div className="popover-header">
              <span>{t('prompt_controls.profiles_title')}</span>
            </div>

            {/* Option: Modelo global por defecto */}
            <div className="profile-inherit-section">
              <button
                type="button"
                className={`profile-option inherit-option ${!activeProfileName ? 'selected' : ''}`}
                role="option"
                aria-selected={!activeProfileName}
                disabled={isBusy || isChangingProfile}
                onClick={() => {
                  if (isBusy || isChangingProfile) return;
                  if (onSelectProfile) {
                    void onSelectProfile(null);
                  }
                  setIsProfileOpen(false);
                }}
              >
                <div className="profile-option-main">
                  <span className="profile-option-name">
                    {t('prompt_controls.global_model_default')}
                  </span>
                  <span className="profile-badge-scope profile-badge-global">
                    {t('prompt_controls.scope_global_badge')}
                  </span>
                </div>
                <div className="profile-option-meta">
                  {!activeProfileName && (
                    <span className="selected-check" aria-hidden="true">✓</span>
                  )}
                </div>
              </button>
            </div>

            {(!profiles || profiles.length === 0) ? (
              <div className="profile-empty-item">
                {t('prompt_controls.no_profiles_configured_hint')}
              </div>
            ) : (
              <>
                {profiles.length > 5 && (
                  <PopoverSearchBar
                    placeholder={t('prompt_controls.search_profiles_placeholder')}
                    value={profileFilter}
                    onChange={setProfileFilter}
                    clearAriaLabel={t('sidebar.clear_search')}
                    autoFocus
                  />
                )}

                <div className="profile-list">
                  {filteredProfiles.length === 0 ? (
                    <div className="profile-empty-item">
                      {t('prompt_controls.no_profiles_found')}
                    </div>
                  ) : (
                    filteredProfiles.map((p) => {
                      const isSelected = p.name === activeProfileName;
                      return (
                        <button
                          key={`${p.scope}-${p.name}`}
                          type="button"
                          className={`profile-option ${isSelected ? 'selected' : ''}`}
                          role="option"
                          aria-selected={isSelected}
                          disabled={isBusy || isChangingProfile}
                          onClick={() => {
                            if (isBusy || isChangingProfile) return;
                            if (onSelectProfile) {
                              void onSelectProfile(p);
                            }
                            setIsProfileOpen(false);
                          }}
                        >
                          <div className="profile-option-main">
                            <span className="profile-option-name">{p.name}</span>
                            {p.default_model && (
                              <span className="profile-model-badge" title={p.default_model}>
                                {p.default_model.split('/').pop() || p.default_model}
                              </span>
                            )}
                            <span className="profile-agent-count">
                              {p.agent_count} {t('prompt_controls.profile_agents_count')}
                            </span>
                            <span className={`profile-badge-scope profile-badge-${p.scope}`}>
                              {p.scope === 'project'
                                ? t('prompt_controls.scope_project_badge')
                                : t('prompt_controls.scope_global_badge')}
                            </span>
                          </div>
                          <div className="profile-option-meta">
                            {isSelected && (
                              <span className="selected-check" aria-hidden="true">✓</span>
                            )}
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </>
            )}

            <div className="profile-popover-footer">
              <button
                type="button"
                className="btn btn-primary btn-sm profile-create-btn"
                onClick={() => {
                  setIsProfileOpen(false);
                  if (onCreateProfile) {
                    onCreateProfile();
                  }
                }}
              >
                <span>+ {t('prompt_controls.create_project_profile')}</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 1.5 Model Selector */}
      <div className="prompt-control-wrapper" ref={modelRef}>
        <button
          type="button"
          className={`prompt-control-btn model-btn ${isChangingModel ? 'loading' : ''}`}
          onClick={() => {
            setIsModelOpen(!isModelOpen);
            setIsProfileOpen(false);
            setIsFileAttachOpen(false);
            setIsMcpOpen(false);
            setIsExtOpen(false);
            setIsThinkingOpen(false);
            setIsStatsOpen(false);
            setIsCloudPopoverOpen(false);
          }}
          disabled={!isConnected || isBusy || isChangingModel}
          aria-expanded={isModelOpen}
          aria-haspopup="listbox"
          title={t('prompt_controls.select_model_title')}
        >
          <svg className="control-icon" viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true">
            <path d="M8 1a2 2 0 0 1 2 2v1h3.5a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-7A1.5 1.5 0 0 1 2.5 4H6V3a2 2 0 0 1 2-2zm-2 4H2.5a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5h11a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.5-.5H10v1a1 1 0 0 1-2 0V5H6V4zm2-2a1 1 0 0 0-1 1v1h2V3a1 1 0 0 0-1-1z" />
            <circle cx="5.5" cy="8.5" r="1" />
            <circle cx="10.5" cy="8.5" r="1" />
          </svg>
          <span className="control-text model-name">{activeModelName}</span>
          <span className="chevron-icon" aria-hidden="true">▾</span>
        </button>

        {isModelOpen && (
          <div className="prompt-popover model-popover" role="listbox" aria-label={t('prompt_controls.available_models')}>
            {availableModels.length > 5 && (
              <PopoverSearchBar
                placeholder={t('prompt_controls.search_models_placeholder')}
                value={modelFilter}
                onChange={setModelFilter}
                clearAriaLabel={t('sidebar.clear_search')}
                autoFocus
              />
            )}
            <div className="model-list">
              {filteredModels.length === 0 ? (
                <div className="model-empty-item">{t('prompt_controls.no_models_found')}</div>
              ) : (
                filteredModels.map((m) => {
                  const isSelected = m.id === activeModelId;
                  return (
                    <button
                      key={`${m.provider}-${m.id}`}
                      type="button"
                      className={`model-option ${isSelected ? 'selected' : ''}`}
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => void handleModelClick(m)}
                    >
                      <div className="model-option-main">
                        <span className="model-option-name">{m.name || m.id}</span>
                        {m.provider && <span className="model-provider-badge">{m.provider}</span>}
                      </div>
                      <div className="model-option-meta">
                        {m.reasoning && (
                          <span className="model-feature-badge reasoning" title={t('prompt_controls.reasoning_supported')}>
                            ⚡
                          </span>
                        )}
                        {m.contextWindow && (
                          <span className="model-context-badge">
                            {formatTokens(m.contextWindow)}
                          </span>
                        )}
                        {isSelected && <span className="selected-check" aria-hidden="true">✓</span>}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>

      {/* 2. Thinking / Reasoning Level Selector */}
      {supportsReasoning && (
        <div className="prompt-control-wrapper" ref={thinkingRef}>
          <button
            type="button"
            className="prompt-control-btn thinking-btn"
            onClick={() => {
              setIsThinkingOpen(!isThinkingOpen);
              setIsModelOpen(false);
              setIsProfileOpen(false);
              setIsFileAttachOpen(false);
              setIsMcpOpen(false);
              setIsExtOpen(false);
              setIsStatsOpen(false);
              setIsCloudPopoverOpen(false);
            }}
            disabled={!isConnected || isBusy}
            aria-expanded={isThinkingOpen}
            aria-haspopup="listbox"
            title={t('prompt_controls.select_thinking_title')}
          >
            <span className="control-icon-emoji" aria-hidden="true">⚡</span>
            <span className="control-text thinking-label">
              {effectiveThinkingLevel
                ? t(`thinking_level.${effectiveThinkingLevel}` as TranslationKey)
                : t('thinking_level.medium')}
            </span>
            <span className="chevron-icon" aria-hidden="true">▾</span>
          </button>

          {isThinkingOpen && (
            <div className="prompt-popover thinking-popover" role="listbox" aria-label={t('prompt_controls.thinking_levels')}>
              <div className="popover-header">{t('prompt_controls.reasoning_effort_header')}</div>
              <div className="thinking-list">
                {(availableThinkingLevels.length > 0
                  ? availableThinkingLevels
                  : (['off', 'low', 'medium', 'high'] as ThinkingLevel[])
                ).map((lvl) => {
                  const isSelected = effectiveThinkingLevel === lvl;
                  const isDefault = defaultThinkingLevel === lvl;
                  return (
                    <button
                      key={lvl}
                      type="button"
                      className={`thinking-option ${isSelected ? 'selected' : ''}`}
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => void handleThinkingClick(lvl)}
                    >
                      <span className="thinking-option-name">
                        {t(`thinking_level.${lvl}` as TranslationKey)}
                        {isDefault && (
                          <span className="thinking-default-badge">
                            {' '}· {t('prompt_controls.default_badge')}
                          </span>
                        )}
                      </span>
                      {isSelected && <span className="selected-check" aria-hidden="true">✓</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 3. Context & Token Usage Meter */}
      <div className="prompt-control-wrapper" ref={statsRef}>
        <button
          type="button"
          className={`prompt-control-btn stats-btn level-${usageLevel} ${isHighContext ? 'context-pulse-red' : ''}`}
          onClick={() => {
            setIsStatsOpen(!isStatsOpen);
            setIsModelOpen(false);
            setIsProfileOpen(false);
            setIsFileAttachOpen(false);
            setIsMcpOpen(false);
            setIsExtOpen(false);
            setIsThinkingOpen(false);
            setIsCloudPopoverOpen(false);
          }}
          disabled={!isConnected}
          aria-expanded={isStatsOpen}
          aria-haspopup="dialog"
          title={t('prompt_controls.context_meter_title')}
        >
          {/* Mini progress ring or bar */}
          <span className="context-mini-bar" aria-hidden="true">
            <span
              className="context-mini-fill"
              style={{ width: `${Math.min(100, Math.max(0, usagePercent))}%` }}
            />
          </span>
          <span className="control-text stats-text">
            {contextWindow > 0 ? (
              <>
                <span className="stats-tokens">{formatTokens(contextTokens)}</span>
                <span className="stats-separator">/</span>
                <span className="stats-limit">{formatTokens(contextWindow)}</span>
                <span className="stats-percent">({formatPercent(usagePercent)}%)</span>
              </>
            ) : (
              <span>{formatTokens(contextTokens)} tokens</span>
            )}
          </span>
        </button>

        {isStatsOpen && (
          <div className="prompt-popover stats-popover" role="dialog" aria-label={t('prompt_controls.session_stats')}>
            <div className="stats-header">
              <span className="stats-title">{t('prompt_controls.context_details_title')}</span>
              <span className={`stats-badge level-${usageLevel} ${isHighContext ? 'context-pulse-red' : ''}`}>{formatPercent(usagePercent)}%</span>
            </div>

            <div className="stats-meter-large">
              <div
                className={`stats-meter-fill level-${usageLevel} ${isHighContext ? 'context-pulse-red' : ''}`}
                style={{ width: `${Math.min(100, Math.max(0, usagePercent))}%` }}
              />
            </div>

            <div className="stats-metrics-grid">
              <div className="metric-row">
                <span className="metric-label">{t('prompt_controls.context_used')}</span>
                <span className="metric-value">
                  {formatTokens(contextTokens)} / {formatTokens(contextWindow)} tokens
                </span>
              </div>
              <div className="metric-row">
                <span className="metric-label">{t('prompt_controls.input_tokens')}</span>
                <span className="metric-value">{formatTokens(sessionStats?.tokens?.input ?? 0)}</span>
              </div>
              <div className="metric-row">
                <span className="metric-label">{t('prompt_controls.output_tokens')}</span>
                <span className="metric-value">{formatTokens(sessionStats?.tokens?.output ?? 0)}</span>
              </div>
              {(sessionStats?.tokens?.cacheRead != null && sessionStats.tokens.cacheRead > 0) && (
                <div className="metric-row">
                  <span className="metric-label">{t('prompt_controls.cache_read_tokens')}</span>
                  <span className="metric-value">{formatTokens(sessionStats.tokens.cacheRead)}</span>
                </div>
              )}
              {(sessionStats?.tokens?.cacheWrite != null && sessionStats.tokens.cacheWrite > 0) && (
                <div className="metric-row">
                  <span className="metric-label">{t('prompt_controls.cache_write_tokens')}</span>
                  <span className="metric-value">{formatTokens(sessionStats.tokens.cacheWrite)}</span>
                </div>
              )}
              <div className="metric-row total-row">
                <span className="metric-label">{t('prompt_controls.total_session_tokens')}</span>
                <span className="metric-value">{formatTokens(sessionStats?.tokens?.total ?? 0)}</span>
              </div>
              {sessionStats?.cost != null && sessionStats.cost > 0 && (
                <div className="metric-row cost-row">
                  <span className="metric-label">{t('prompt_controls.estimated_cost')}</span>
                  <span className="metric-value">{formatCost(sessionStats.cost)}</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 4. MCP Server Selector */}
      <div className="prompt-control-wrapper" ref={mcpRef}>
        <button
          type="button"
          className="prompt-control-btn mcp-btn"
          onClick={() => {
            setIsMcpOpen(!isMcpOpen);
            setIsModelOpen(false);
            setIsProfileOpen(false);
            setIsFileAttachOpen(false);
            setIsThinkingOpen(false);
            setIsStatsOpen(false);
            setIsExtOpen(false);
            setIsCloudPopoverOpen(false);
          }}
          disabled={!isConnected}
          aria-expanded={isMcpOpen}
          aria-haspopup="dialog"
          title={t('prompt_controls.mcp_title', {
            active: mcpActiveCount ?? 0,
            total: mcpTotalCount ?? 0,
          })}
        >
          <svg
            className="control-icon"
            viewBox="0 0 24 24"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
            <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
            <line x1="6" y1="6" x2="6.01" y2="6" />
            <line x1="6" y1="18" x2="6.01" y2="18" />
          </svg>
          <span className="control-text mcp-label">
            MCP {mcpActiveCount ?? 0}/{mcpTotalCount ?? 0}
          </span>
          <span className="chevron-icon" aria-hidden="true">▾</span>
        </button>

        {isMcpOpen && (
          <div
            className="prompt-popover mcp-popover"
            role="dialog"
            aria-label={t('prompt_controls.mcp_title', {
              active: mcpActiveCount ?? 0,
              total: mcpTotalCount ?? 0,
            })}
          >
            <div className="popover-header">
              {t('mcp.popover_header', {
                active: mcpActiveCount ?? 0,
                total: mcpTotalCount ?? 0,
              })}
            </div>
            {(mcpServers || []).length > 4 && (
              <PopoverSearchBar
                placeholder={t('mcp.search_placeholder')}
                value={mcpFilter}
                onChange={setMcpFilter}
                clearAriaLabel={t('sidebar.clear_search')}
                autoFocus
              />
            )}
            <div className="mcp-popover-list">
              {(mcpServers || []).length === 0 ? (
                <div className="mcp-empty-item">{t('mcp.empty_title')}</div>
              ) : (() => {
                const q = mcpFilter.trim().toLowerCase();
                const filtered = (mcpServers || []).filter((s) => {
                  if (!q) return true;
                  return (
                    s.name.toLowerCase().includes(q) ||
                    (s.command && s.command.toLowerCase().includes(q)) ||
                    (s.args && s.args.some((a) => a.toLowerCase().includes(q))) ||
                    (s.url && s.url.toLowerCase().includes(q))
                  );
                });
                if (filtered.length === 0) {
                  return <div className="mcp-empty-item">{t('sidebar.no_search_results')}</div>;
                }
                return filtered.map((server) => {
                  const isToggling = togglingServerName === server.name;
                  return (
                    <div
                      key={`${server.scope}-${server.name}`}
                      className="mcp-popover-item"
                    >
                      <div className="mcp-popover-item-main">
                        <span
                          className={`mcp-status-dot ${server.enabled ? 'active' : 'inactive'}`}
                          aria-hidden="true"
                        />
                        <span className="mcp-popover-name" title={server.name}>
                          {server.name}
                        </span>
                      </div>
                      <div className="mcp-popover-item-action">
                        <label
                          className={`mcp-popover-toggle ${isToggling ? 'toggling' : ''}`}
                          title={server.enabled ? t('mcp.action_disable') : t('mcp.action_enable')}
                        >
                          <input
                            type="checkbox"
                            className="mcp-toggle-checkbox"
                            checked={server.enabled}
                            disabled={isToggling}
                            aria-label={server.enabled ? t('mcp.action_disable') : t('mcp.action_enable')}
                            onChange={async (e) => {
                              e.stopPropagation();
                              if (!onToggleMcpServer) return;
                              setTogglingServerName(server.name);
                              try {
                                await onToggleMcpServer(server, !server.enabled);
                              } catch (err) {
                                console.error('Failed to toggle MCP server:', err);
                              } finally {
                                setTogglingServerName(null);
                              }
                            }}
                          />
                          <span className="mcp-popover-toggle-slider" aria-hidden="true" />
                        </label>
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        )}
      </div>

      {/* 5. Extensions & Packages Selector */}
      <div className="prompt-control-wrapper" ref={extRef}>
        <button
          type="button"
          className="prompt-control-btn ext-btn"
          onClick={() => {
            setIsExtOpen(!isExtOpen);
            setIsModelOpen(false);
            setIsProfileOpen(false);
            setIsFileAttachOpen(false);
            setIsThinkingOpen(false);
            setIsStatsOpen(false);
            setIsMcpOpen(false);
            setIsCloudPopoverOpen(false);
          }}
          disabled={!isConnected}
          aria-expanded={isExtOpen}
          aria-haspopup="dialog"
          aria-label={t('prompt_controls.select_ext_title')}
          title={t('prompt_controls.ext_title', {
            active: piActiveCount ?? 0,
            total: piTotalCount ?? 0,
          })}
        >
          <svg
            className="control-icon"
            viewBox="0 0 24 24"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M20.5 11H19V7a2 2 0 0 0-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4a2 2 0 0 0-2 2v3.8h1.5a2.5 2.5 0 0 1 0 5H2V20a2 2 0 0 0 2 2h3.8v-1.5a2.5 2.5 0 0 1 5 0V22H17a2 2 0 0 0 2-2v-4h1.5a2.5 2.5 0 0 0 0-5z" />
          </svg>
          <span className="control-text ext-label">
            Ext {piActiveCount ?? 0}/{piTotalCount ?? 0}
          </span>
          <span className="chevron-icon" aria-hidden="true">▾</span>
        </button>

        {isExtOpen && (
          <div
            className="prompt-popover ext-popover"
            role="dialog"
            aria-label={t('prompt_controls.ext_title', {
              active: piActiveCount ?? 0,
              total: piTotalCount ?? 0,
            })}
          >
            <div className="popover-header">
              {t('extensions.popover_header', {
                active: piActiveCount ?? 0,
                total: piTotalCount ?? 0,
              })}
            </div>
            {(piResources || []).length > 4 && (
              <PopoverSearchBar
                placeholder={t('extensions.search_placeholder')}
                value={extFilter}
                onChange={setExtFilter}
                clearAriaLabel={t('sidebar.clear_search')}
                autoFocus
              />
            )}
            <div className="ext-popover-list">
              {(piResources || []).length === 0 ? (
                <div className="ext-empty-item">{t('extensions.empty_title')}</div>
              ) : (() => {
                const q = extFilter.trim().toLowerCase();
                const filtered = (piResources || []).filter((r) => {
                  if (!q) return true;
                  return (
                    r.name.toLowerCase().includes(q) ||
                    r.source.toLowerCase().includes(q)
                  );
                });
                if (filtered.length === 0) {
                  return <div className="ext-empty-item">{t('sidebar.no_search_results')}</div>;
                }
                return filtered.map((resource) => {
                  const isToggling = togglingResourceId === resource.id;
                  const kindBadge = resource.kind === 'extension' ? 'ext' : 'pkg';
                  const scopeBadge = resource.hasProjectOverride
                    ? 'Override'
                    : resource.scope === 'project'
                      ? 'Project'
                      : 'Global';

                  return (
                    <div key={resource.id} className="ext-popover-item">
                      <div className="ext-popover-item-main">
                        <span
                          className={`ext-status-dot ${resource.enabled ? 'active' : 'inactive'}`}
                          aria-hidden="true"
                        />
                        <span className="ext-popover-name" title={resource.name}>
                          {resource.name}
                        </span>
                        <div className="ext-popover-badges">
                          <span className={`ext-popover-badge ext-popover-badge-${resource.kind}`}>
                            {kindBadge}
                          </span>
                          <span
                            className={`ext-popover-badge ext-popover-badge-${
                              resource.hasProjectOverride
                                ? 'override'
                                : resource.scope
                            }`}
                          >
                            {scopeBadge}
                          </span>
                        </div>
                      </div>
                      <div className="ext-popover-item-action">
                        <label
                          className={`ext-popover-toggle ${isToggling ? 'toggling' : ''}`}
                          title={
                            resource.enabled
                              ? t('extensions.action_disable')
                              : t('extensions.action_enable')
                          }
                        >
                          <input
                            type="checkbox"
                            className="ext-toggle-checkbox"
                            checked={resource.enabled}
                            disabled={isToggling}
                            aria-label={
                              resource.enabled
                                ? t('extensions.action_disable')
                                : t('extensions.action_enable')
                            }
                            onChange={async (e) => {
                              e.stopPropagation();
                              if (!onTogglePiResource) return;
                              setTogglingResourceId(resource.id);
                              try {
                                await onTogglePiResource(
                                  resource,
                                  !resource.enabled
                                );
                              } catch (err) {
                                console.error('Failed to toggle Pi resource:', err);
                              } finally {
                                setTogglingResourceId(null);
                              }
                            }}
                          />
                          <span
                            className="ext-popover-toggle-slider"
                            aria-hidden="true"
                          />
                        </label>
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        )}
      </div>

      {/* Engram Project Indicator */}
      {engramProject && (
        <div className="prompt-control-wrapper engram-project-wrapper" ref={engramRef}>
          <button
            type="button"
            className="prompt-control-btn engram-project-badge"
            onClick={() => {
              const next = !isCloudPopoverOpen;
              setIsCloudPopoverOpen(next);
              if (next) {
                setIsModelOpen(false);
                setIsProfileOpen(false);
                setIsFileAttachOpen(false);
                setIsMcpOpen(false);
                setIsExtOpen(false);
                setIsThinkingOpen(false);
                setIsStatsOpen(false);
                if (onCheckCloudStatus) {
                  void onCheckCloudStatus();
                }
              }
            }}
            title={`Engram: ${engramProject}`}
            aria-label={`Engram: ${engramProject}`}
            aria-expanded={isCloudPopoverOpen}
            aria-haspopup="dialog"
          >
            <span className="control-icon-emoji" aria-hidden="true">🧠</span>
            <span className="control-text engram-project-name">{engramProject}</span>
            {cloudStatus?.configured && (
              <span
                className={`engram-cloud-dot ${
                  cloudStatus.enrolled && cloudStatus.cloudPermitted === false
                    ? 'forbidden'
                    : cloudStatus.enrolled
                      ? 'enrolled'
                      : 'configured'
                }`}
                aria-hidden="true"
              />
            )}
          </button>

          {isCloudPopoverOpen && (
            <div className="prompt-popover engram-cloud-popover" role="dialog" aria-label="Engram Cloud Sync">
              <div className="popover-header engram-cloud-header">
                <div className="engram-cloud-title">
                  <span className="control-icon-emoji" aria-hidden="true">🧠</span>
                  <span>Engram Cloud Sync</span>
                </div>
                <button
                  type="button"
                  className="engram-refresh-btn"
                  onClick={() => {
                    if (onCheckCloudStatus) {
                      void onCheckCloudStatus();
                    }
                  }}
                  disabled={isCheckingCloud}
                  title="Actualizar estado de sincronización"
                  aria-label="Actualizar estado de sincronización"
                >
                  <span className={`engram-refresh-icon ${isCheckingCloud ? 'spinning' : ''}`} aria-hidden="true">
                    ⟳
                  </span>
                </button>
              </div>

              <div className="engram-cloud-body">
                {isCheckingCloud && !cloudStatus && (
                  <div className="engram-cloud-loading">
                    <span>Verificando estado...</span>
                  </div>
                )}

                <div className="engram-cloud-grid">
                  <div className="engram-row">
                    <span className="engram-label">Proyecto:</span>
                    <span className="engram-value font-mono">{engramProject}</span>
                  </div>
                  <div className="engram-row">
                    <span className="engram-label">Cloud Status:</span>
                    <span className={`engram-value status-badge ${cloudStatus?.configured ? 'status-ok' : 'status-muted'}`}>
                      {cloudStatus?.configured ? 'Configurado' : 'No configurado'}
                    </span>
                  </div>
                  {cloudStatus?.serverUrl && (
                    <div className="engram-row">
                      <span className="engram-label">Servidor:</span>
                      <span className="engram-value font-mono engram-url" title={cloudStatus.serverUrl}>
                        {cloudStatus.serverUrl}
                      </span>
                    </div>
                  )}
                  <div className="engram-row">
                    <span className="engram-label">Inscripción:</span>
                    {cloudStatus?.enrolled === false ? (
                      <button
                        type="button"
                        className="engram-value status-badge status-warn engram-enroll-trigger"
                        onClick={() => {
                          setShowEnrollConfirm(true);
                          setEnrollError(null);
                        }}
                        title="Inscribir proyecto en Engram Cloud"
                      >
                        No inscrito (+ Inscribir)
                      </button>
                    ) : (
                      <span className={`engram-value status-badge ${cloudStatus?.enrolled ? 'status-ok' : 'status-muted'}`}>
                        {cloudStatus?.enrolled ? 'Inscrito' : 'No verificado'}
                      </span>
                    )}
                  </div>
                  {cloudStatus?.enrolled === true && (
                    <div className="engram-row">
                      <span className="engram-label">Permisos Cloud:</span>
                      <span className={`engram-value status-badge ${
                        cloudStatus.cloudPermitted === true
                          ? 'status-ok'
                          : cloudStatus.cloudPermitted === false
                            ? 'status-error'
                            : 'status-muted'
                      }`}>
                        {cloudStatus.cloudPermitted === true
                          ? 'Permitido'
                          : cloudStatus.cloudPermitted === false
                            ? 'No permitido (403)'
                            : isCheckingCloud
                              ? 'Verificando...'
                              : 'No verificado'}
                      </span>
                    </div>
                  )}
                  <div className="engram-row">
                    <span className="engram-label">Daemon Local:</span>
                    <span className={`engram-value status-badge ${cloudStatus?.daemonRunning ? 'status-ok' : 'status-muted'}`}>
                      {cloudStatus?.daemonRunning
                        ? `Activo${cloudStatus.daemonPort ? ` (puerto ${cloudStatus.daemonPort})` : ''}`
                        : 'Inactivo'}
                    </span>
                  </div>
                  {cloudStatus?.phase && (
                    <div className="engram-row">
                      <span className="engram-label">Fase Sync:</span>
                      <span className={`engram-value status-badge ${cloudStatus.phase === 'synced' ? 'status-ok' : cloudStatus.phase === 'syncing' ? 'status-info' : 'status-warn'}`}>
                        {cloudStatus.phase}
                      </span>
                    </div>
                  )}
                  {cloudStatus?.lastSyncAt && (
                    <div className="engram-row">
                      <span className="engram-label">Último Sync:</span>
                      <span className="engram-value">{cloudStatus.lastSyncAt}</span>
                    </div>
                  )}
                  {!(
                    cloudStatus?.reasonCode === 'policy_forbidden' ||
                    cloudStatus?.cloudPermitted === false ||
                    Boolean(cloudStatus?.lastError?.toLowerCase().includes('policy_forbidden'))
                  ) && (cloudStatus?.reasonCode || cloudStatus?.lastError) && (
                    <div className="engram-error-block">
                      {cloudStatus?.reasonCode && (
                        <div className="engram-error-code">
                          <span className="error-tag">Error:</span> {cloudStatus.reasonCode}
                        </div>
                      )}
                      {cloudStatus?.lastError && (
                        <div className="engram-error-message">
                          {cloudStatus.lastError}
                        </div>
                      )}
                    </div>
                  )}
                  {(cloudStatus?.cloudPermitted === false || cloudStatus?.reasonCode === 'policy_forbidden') && (
                    <div className="engram-permission-alert">
                      <div className="permission-alert-title">⚠️ Proyecto no permitido en el servidor</div>
                      <div className="permission-alert-desc">
                        {cloudStatus.cloudPermissionMessage || 'Acceso denegado por política del servidor (403 Forbidden). Verifique ENGRAM_CLOUD_ALLOWED_PROJECTS en el servidor Cloud.'}
                      </div>
                    </div>
                  )}
                </div>

                {showEnrollConfirm && (
                  <div className="engram-confirm-box">
                    <div className="engram-confirm-text">
                      ¿Inscribir {engramProject} en Engram Cloud para sincronización?
                    </div>
                    {enrollError && (
                      <div className="engram-confirm-error">
                        {enrollError}
                      </div>
                    )}
                    <div className="engram-confirm-actions">
                      <button
                        type="button"
                        className="btn-engram-confirm"
                        disabled={isEnrolling}
                        onClick={() => void handleConfirmEnroll()}
                      >
                        {isEnrolling ? 'Inscribiendo...' : 'Confirmar e Inscribir'}
                      </button>
                      <button
                        type="button"
                        className="btn-engram-cancel"
                        disabled={isEnrolling}
                        onClick={() => {
                          setShowEnrollConfirm(false);
                          setEnrollError(null);
                        }}
                      >
                        Cancelar
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
