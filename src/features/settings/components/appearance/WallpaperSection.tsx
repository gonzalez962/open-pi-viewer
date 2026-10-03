import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { TranslationKey } from '@shared/i18n';
import type {
  BackgroundImageConfig,
  BackgroundImageFit,
  BackgroundImagePosition,
} from '@infra/preferences';
import {
  BUILTIN_WALLPAPERS,
  isRemoteImageUrl,
  mapWallpaperErrorToTranslationKey,
  processWallpaperFile,
  WallpaperProcessCoordinator,
  WallpaperProcessingError,
  type WallpaperBrowserAdapter,
} from '@features/settings/wallpaper';
import { isSafeImageUrl } from '@infra/preferences';

export interface WallpaperSectionProps {
  imageConfig?: BackgroundImageConfig;
  onUpdateImage: (patch: Partial<BackgroundImageConfig>) => void;
  onClearImage: () => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  idPrefix?: string;
  adapter?: WallpaperBrowserAdapter;
  coordinator?: WallpaperProcessCoordinator;
  lifecycleRevision?: number;
}

export const WallpaperSection: React.FC<WallpaperSectionProps> = ({
  imageConfig,
  onUpdateImage,
  onClearImage,
  t,
  idPrefix = 'theme-wallpaper',
  adapter,
  coordinator,
  lifecycleRevision,
}) => {
  const isEnabled = Boolean(imageConfig?.enabled);
  const currentUrl = imageConfig?.url || '';

  const [stagedUrl, setStagedUrl] = useState(currentUrl);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const localCoordinatorRef = useRef<WallpaperProcessCoordinator | null>(null);
  if (!localCoordinatorRef.current) {
    localCoordinatorRef.current = new WallpaperProcessCoordinator();
  }
  const activeCoordinator = coordinator || localCoordinatorRef.current;

  // Synchronize staged URL when active image URL changes externally (cancel, reset, built-in)
  useEffect(() => {
    setStagedUrl(currentUrl);
  }, [currentUrl]);

  // Subscribe to coordinator to mirror processing state and handle external cancellations
  useEffect(() => {
    const unsubscribe = activeCoordinator.subscribe((state) => {
      setIsProcessing(state.isProcessing);
    });
    return unsubscribe;
  }, [activeCoordinator]);

  // Synchronize and cancel on lifecycle revision transitions (confirm, cancel, reset)
  useEffect(() => {
    activeCoordinator.cancel();
    setIsProcessing(false);
    setErrorMessage(null);
  }, [lifecycleRevision, activeCoordinator]);

  // Clean up any pending in-flight processing on unmount
  useEffect(() => {
    return () => {
      activeCoordinator.cancel();
    };
  }, [activeCoordinator]);

  const handleToggleEnabled = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      // Competing intent: cancel pending upload immediately
      activeCoordinator.cancel();
      setIsProcessing(false);
      setErrorMessage(null);
      onUpdateImage({ enabled: e.target.checked });
    },
    [activeCoordinator, onUpdateImage]
  );

  const handleApplyStagedUrl = useCallback(() => {
    // Competing intent: cancel pending upload immediately
    activeCoordinator.cancel();
    setIsProcessing(false);

    const trimmed = stagedUrl.trim();
    if (!trimmed) {
      // Empty input treated as clear
      setErrorMessage(null);
      onUpdateImage({ url: '' });
      return;
    }

    if (!isSafeImageUrl(trimmed)) {
      // Failed new input preserves prior draft config, shows localized error
      setErrorMessage(t('theme.bg_image_error_invalid_url'));
      return;
    }

    setErrorMessage(null);
    onUpdateImage({ url: trimmed, enabled: true });
  }, [activeCoordinator, stagedUrl, onUpdateImage, t]);

  const handleSelectBuiltin = useCallback(
    (presetUrl: string) => {
      // Competing intent: cancel pending upload immediately
      activeCoordinator.cancel();
      setIsProcessing(false);
      setErrorMessage(null);
      setStagedUrl(presetUrl);
      onUpdateImage({ url: presetUrl, enabled: true });
    },
    [activeCoordinator, onUpdateImage]
  );

  const handleClearImage = useCallback(() => {
    // Competing intent: cancel pending upload immediately
    activeCoordinator.cancel();
    setIsProcessing(false);
    setErrorMessage(null);
    setStagedUrl('');
    onClearImage();
  }, [activeCoordinator, onClearImage]);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // Reset input value so re-selecting same file triggers change
      e.target.value = '';
      if (!file) return;

      const { generation, signal } = activeCoordinator.start();
      setIsProcessing(true);
      setErrorMessage(null);

      try {
        const result = await processWallpaperFile(file, { adapter, signal });

        if (activeCoordinator.isActive(generation)) {
          activeCoordinator.finish(generation);
          setIsProcessing(false);
          setStagedUrl(result.dataUrl);
          onUpdateImage({ url: result.dataUrl, enabled: true });
        }
      } catch (err: unknown) {
        if (activeCoordinator.isActive(generation)) {
          activeCoordinator.finish(generation);
          setIsProcessing(false);
          if (err instanceof WallpaperProcessingError && err.code === 'aborted') {
            return;
          }
          const errorKey = mapWallpaperErrorToTranslationKey(err);
          setErrorMessage(t(errorKey));
        }
      }
    },
    [activeCoordinator, adapter, onUpdateImage, t]
  );

  const handleFitChange = useCallback(
    (fit: BackgroundImageFit) => {
      onUpdateImage({ fit, repeat: fit === 'repeat' });
    },
    [onUpdateImage]
  );

  const handlePositionChange = useCallback(
    (position: BackgroundImagePosition) => {
      onUpdateImage({ position });
    },
    [onUpdateImage]
  );

  const handleOpacityChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const opacity = parseFloat(e.target.value);
      if (Number.isFinite(opacity)) {
        onUpdateImage({ opacity: Math.max(0, Math.min(1, opacity)) });
      }
    },
    [onUpdateImage]
  );

  const handleBlurChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const blur = parseInt(e.target.value, 10);
      if (Number.isFinite(blur)) {
        onUpdateImage({ blur: Math.max(0, Math.min(30, blur)) });
      }
    },
    [onUpdateImage]
  );

  const currentFit = imageConfig?.fit || 'cover';
  const currentPosition = imageConfig?.position || 'center';
  const currentOpacity = imageConfig?.opacity ?? 0.4;
  const currentBlur = imageConfig?.blur ?? 0;
  const showRemoteWarning = isRemoteImageUrl(currentUrl) || isRemoteImageUrl(stagedUrl);

  return (
    <section className="theme-custom-bg-section" aria-label={t('theme.bg_image_heading')}>
      <div className="section-title-wrap">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 className="theme-section-title">🖼️ {t('theme.bg_image_heading')}</h3>
          <span className={`wallpaper-status-badge ${isEnabled && currentUrl ? 'is-active' : 'is-disabled'}`}>
            {isEnabled && currentUrl ? t('theme.bg_image_active_badge') : t('theme.bg_image_disabled_badge')}
          </span>
        </div>
        <p className="theme-section-subtitle">{t('theme.bg_image_subheading')}</p>
      </div>

      {/* Enable toggle checkbox */}
      <div className="bg-control-row">
        <label
          htmlFor={`${idPrefix}-enable-toggle`}
          className="checkbox-label"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
        >
          <input
            type="checkbox"
            id={`${idPrefix}-enable-toggle`}
            checked={isEnabled}
            onChange={handleToggleEnabled}
          />
          <span className="checkbox-text" style={{ fontSize: 13, fontWeight: 600 }}>
            {t('theme.bg_image_enable')}
          </span>
        </label>
      </div>

      {/* Visible error banner on processing or validation failure */}
      {errorMessage && (
        <div className="wallpaper-error-banner" role="alert" style={{ marginBottom: 12 }}>
          ⚠️ {errorMessage}
        </div>
      )}

      {/* Visible loading indicator during local bounded processing */}
      {isProcessing && (
        <div className="wallpaper-processing-notice" role="status" style={{ marginBottom: 12 }}>
          ⏳ {t('theme.bg_image_processing')}
        </div>
      )}

      {isEnabled && (
        <div className="bg-controls-grid">
          {/* Staged URL Input and Actions */}
          <div className="bg-control-row">
            <label htmlFor={`${idPrefix}-url-input`} className="bg-control-label">
              {t('theme.bg_image_url_label')}:
            </label>
            <div className="bg-file-upload-wrap">
              <input
                type="text"
                id={`${idPrefix}-url-input`}
                className="bg-url-input"
                value={stagedUrl}
                onChange={(e) => setStagedUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleApplyStagedUrl();
                  }
                }}
                placeholder={t('theme.bg_image_url_placeholder')}
                aria-label={t('theme.bg_image_url_label')}
              />
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleApplyStagedUrl}
              >
                {t('theme.bg_image_apply_url')}
              </button>
              <input
                type="file"
                id={`${idPrefix}-file-input`}
                ref={fileInputRef}
                accept="image/jpeg,image/png,image/webp,image/gif"
                style={{ display: 'none' }}
                onChange={handleFileChange}
                aria-label={t('theme.bg_image_upload_btn')}
              />
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => fileInputRef.current?.click()}
              >
                📁 {t('theme.bg_image_upload_btn')}
              </button>
              {currentUrl && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm btn-clear-wallpaper"
                  onClick={handleClearImage}
                >
                  ✕ {t('theme.bg_image_clear')}
                </button>
              )}
            </div>
          </div>

          {/* Remote image warning banner */}
          {showRemoteWarning && (
            <div className="wallpaper-remote-warning" role="note" style={{ fontSize: 12, color: 'var(--status-amber)' }}>
              ℹ️ {t('theme.bg_image_remote_warning')}
            </div>
          )}

          {/* Built-in Wallpaper Presets */}
          <div className="bg-control-row">
            <span className="bg-control-label">{t('theme.bg_image_presets_label')}:</span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {BUILTIN_WALLPAPERS.map((preset) => {
                const isSelected = currentUrl === preset.url;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    className={`btn btn-sm ${isSelected ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => handleSelectBuiltin(preset.url)}
                  >
                    {t(preset.nameKey as any)}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Fit Mode Selector */}
          <div className="bg-control-row">
            <span className="bg-control-label">{t('theme.bg_image_fit_label')}:</span>
            <div
              className="loader-mode-pills"
              role="radiogroup"
              aria-label={t('theme.bg_image_fit_label')}
            >
              {[
                { id: 'cover', label: t('theme.bg_image_fit_cover') },
                { id: 'contain', label: t('theme.bg_image_fit_contain') },
                { id: '100% 100%', label: t('theme.bg_image_fit_stretch') },
                { id: 'repeat', label: t('theme.bg_image_fit_repeat') },
                { id: 'auto', label: t('theme.bg_image_fit_auto') },
              ].map((fitOption) => (
                <button
                  key={fitOption.id}
                  type="button"
                  role="radio"
                  aria-checked={currentFit === fitOption.id}
                  className={`loader-mode-btn ${currentFit === fitOption.id ? 'is-active' : ''}`}
                  onClick={() => handleFitChange(fitOption.id as BackgroundImageFit)}
                >
                  {fitOption.label}
                </button>
              ))}
            </div>
          </div>

          {/* Position Selector */}
          <div className="bg-control-row">
            <span className="bg-control-label">{t('theme.bg_image_position_label')}:</span>
            <div
              className="loader-mode-pills"
              role="radiogroup"
              aria-label={t('theme.bg_image_position_label')}
            >
              {[
                { id: 'center', label: t('theme.bg_image_pos_center') },
                { id: 'top', label: t('theme.bg_image_pos_top') },
                { id: 'bottom', label: t('theme.bg_image_pos_bottom') },
                { id: 'left', label: t('theme.bg_image_pos_left') },
                { id: 'right', label: t('theme.bg_image_pos_right') },
              ].map((posOption) => (
                <button
                  key={posOption.id}
                  type="button"
                  role="radio"
                  aria-checked={currentPosition === posOption.id}
                  className={`loader-mode-btn ${currentPosition === posOption.id ? 'is-active' : ''}`}
                  onClick={() => handlePositionChange(posOption.id as BackgroundImagePosition)}
                >
                  {posOption.label}
                </button>
              ))}
            </div>
          </div>

          {/* Opacity Slider */}
          <div className="bg-control-row">
            <label htmlFor={`${idPrefix}-opacity-slider`} className="bg-control-label">
              {t('theme.bg_image_opacity_label')}:
            </label>
            <div className="bg-slider-wrap">
              <input
                type="range"
                id={`${idPrefix}-opacity-slider`}
                min="0"
                max="1"
                step="0.05"
                className="bg-range-input"
                value={currentOpacity}
                onChange={handleOpacityChange}
                aria-label={t('theme.bg_image_opacity_label')}
              />
              <span className="bg-slider-value">{Math.round(currentOpacity * 100)}%</span>
            </div>
          </div>

          {/* Blur Slider */}
          <div className="bg-control-row">
            <label htmlFor={`${idPrefix}-blur-slider`} className="bg-control-label">
              {t('theme.bg_image_blur_label')}:
            </label>
            <div className="bg-slider-wrap">
              <input
                type="range"
                id={`${idPrefix}-blur-slider`}
                min="0"
                max="30"
                step="1"
                className="bg-range-input"
                value={currentBlur}
                onChange={handleBlurChange}
                aria-label={t('theme.bg_image_blur_label')}
              />
              <span className="bg-slider-value">{currentBlur}px</span>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
