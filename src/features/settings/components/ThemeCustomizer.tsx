import React, { useState, useEffect, useMemo, useCallback } from 'react';
import type { AppTheme } from '@shared/theme';
import { applyTheme, resolveTheme } from '@shared/theme';
import type { TranslationKey } from '@shared/i18n';
import {
  type WorkAnimationPreferences,
  type CustomBackgroundPreferences,
  type BackgroundImageConfig,
  DEFAULT_WORK_ANIMATION_PREFERENCES,
  computeWorkAnimationStyles,
  hexToRgba,
  isValidHexColor,
} from '@infra/preferences';

export interface ThemeCustomizerProps {
  currentTheme: AppTheme;
  onThemeChange: (theme: AppTheme) => void;
  workAnimation?: WorkAnimationPreferences;
  onWorkAnimationChange?: (animation: WorkAnimationPreferences) => void;
  customTextColor?: string;
  customLabelColor?: string;
  onCustomThemeColorsChange?: (colors: { text?: string | null; label?: string | null }) => void;
  customBackground?: CustomBackgroundPreferences;
  onCustomBackgroundChange?: (bg: CustomBackgroundPreferences | null) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

interface ThemePresetMeta {
  id: AppTheme;
  name: string;
  tag: string;
  description: string;
  palette: {
    bg: string;
    surface: string;
    border: string;
    accent: string;
    text: string;
  };
}

export const THEME_PRESETS: ThemePresetMeta[] = [
  {
    id: 'DjRomoro',
    name: 'DjRomoro Cyberpunk',
    tag: 'Exclusivo',
    description: 'Estética futurista oscura con azul eléctrico y contrastes cian de alta intensidad.',
    palette: {
      bg: '#05080d',
      surface: '#07131d',
      border: '#245066',
      accent: '#00e5ff',
      text: '#e6f7ff',
    },
  },
  {
    id: 'Gentleman-Sexy-Djr',
    name: 'Gentleman Sexy Djr',
    tag: 'Elegante',
    description: 'Tono borgoña profundo y grafito con acentos terracota refinados y balance cálido.',
    palette: {
      bg: '#120c14',
      surface: '#1c121e',
      border: '#3d2642',
      accent: '#e06c75',
      text: '#f2e8f5',
    },
  },
  {
    id: 'arch-electric',
    name: 'Arch Electric',
    tag: 'Terminal',
    description: 'Vibra hacker terminal inspirada en Arch Linux con acentos cian y base ultra oscura.',
    palette: {
      bg: '#0a0e14',
      surface: '#0f141c',
      border: '#1f2937',
      accent: '#00d4ff',
      text: '#e5e7eb',
    },
  },
  {
    id: 'Minimalist-Ninja',
    name: 'Minimalist Ninja',
    tag: 'Ultra-Limpio',
    description: 'Negro puro OLED sin cajas ni marcos para el contenido. Solo encierra el prompt del usuario.',
    palette: {
      bg: '#000000',
      surface: '#000000',
      border: '#1f1f1f',
      accent: '#10b981',
      text: '#ececec',
    },
  },
  {
    id: 'dark',
    name: 'Dark Classic',
    tag: 'Estándar',
    description: 'Paleta nocturna balanceada basada en GitHub Dark para uso continuo y prolongado.',
    palette: {
      bg: '#0d1117',
      surface: '#161b22',
      border: '#30363d',
      accent: '#1f6feb',
      text: '#e6edf3',
    },
  },
  {
    id: 'light',
    name: 'Light Pro',
    tag: 'Luminoso',
    description: 'Diseño diurno limpio y de alto contraste para entornos de alta iluminación ambiental.',
    palette: {
      bg: '#ffffff',
      surface: '#f6f8fa',
      border: '#d0d7de',
      accent: '#0969da',
      text: '#1f2328',
    },
  },
  {
    id: 'system',
    name: 'System Auto',
    tag: 'Adaptativo',
    description: 'Sincroniza dinámicamente con el modo claro/oscuro de tu sistema operativo.',
    palette: {
      bg: '#161b22',
      surface: '#21262d',
      border: '#30363d',
      accent: '#58a6ff',
      text: '#f0f6fc',
    },
  },
];

export const ACCENT_SWATCHES = [
  { name: 'Cian Neón', hex: '#00e5ff' },
  { name: 'Azul Eléctrico', hex: '#1f6feb' },
  { name: 'Verde Esmeralda', hex: '#10b981' },
  { name: 'Terracota Gentleman', hex: '#e06c75' },
  { name: 'Ámbar Cálido', hex: '#f59e0b' },
  { name: 'Violeta Neón', hex: '#a855f7' },
  { name: 'Celeste Suave', hex: '#38bdf8' },
];

export const LOADER_PALETTE_SWATCHES = [
  { name: 'Verde Hacker', hex: '#00ff0a' },
  { name: 'Cian Neón', hex: '#00e5ff' },
  { name: 'Azul Eléctrico', hex: '#1f6feb' },
  { name: 'Verde Esmeralda', hex: '#10b981' },
  { name: 'Terracota Gentleman', hex: '#e06c75' },
  { name: 'Ámbar Cálido', hex: '#f59e0b' },
  { name: 'Violeta Neón', hex: '#a855f7' },
  { name: 'Rosa Neón', hex: '#ff007f' },
];

export const TEXT_COLOR_SWATCHES = [
  { name: 'Blanco Puro', hex: '#ffffff' },
  { name: 'Gris Claro OLED', hex: '#ececec' },
  { name: 'Gris GitHub Dark', hex: '#e6edf3' },
  { name: 'Cian Hielo', hex: '#e6f7ff' },
  { name: 'Verde Menta Suave', hex: '#a7f3d0' },
  { name: 'Ámbar Cálido', hex: '#fde68a' },
  { name: 'Rosa Pastel', hex: '#fbcfe8' },
  { name: 'Gris Muted', hex: '#9ca3af' },
];

export const LABEL_COLOR_SWATCHES = [
  { name: 'Verde Esmeralda', hex: '#10b981' },
  { name: 'Cian Neón', hex: '#00e5ff' },
  { name: 'Azul Eléctrico', hex: '#1f6feb' },
  { name: 'Terracota Gentleman', hex: '#e06c75' },
  { name: 'Ámbar Neón', hex: '#f59e0b' },
  { name: 'Violeta Neón', hex: '#a855f7' },
  { name: 'Rosa Neón', hex: '#ec4899' },
  { name: 'Verde Menta Neón', hex: '#34d399' },
];

export const ThemeCustomizer: React.FC<ThemeCustomizerProps> = ({
  currentTheme,
  onThemeChange,
  workAnimation,
  onWorkAnimationChange,
  customTextColor,
  customLabelColor,
  onCustomThemeColorsChange,
  customBackground,
  onCustomBackgroundChange,
  t,
}) => {
  const [draftTheme, setDraftTheme] = useState<AppTheme>(currentTheme);
  const [customAccent, setCustomAccent] = useState<string>('');
  const [draftTextColor, setDraftTextColor] = useState<string>(customTextColor || '');
  const [draftLabelColor, setDraftLabelColor] = useState<string>(customLabelColor || '');
  const [draftWorkAnimation, setDraftWorkAnimation] = useState<WorkAnimationPreferences>(
    () => workAnimation || { ...DEFAULT_WORK_ANIMATION_PREFERENCES }
  );
  const [draftBackground, setDraftBackground] = useState<CustomBackgroundPreferences>(
    () => (customBackground ? { ...customBackground } : {})
  );
  const [activeBgArea, setActiveBgArea] = useState<'canvas' | 'sidebar' | 'chat' | 'prompt' | 'cards'>('canvas');
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const [saveFeedback, setSaveFeedback] = useState<boolean>(false);

  // Synchronize draft if parent updates
  useEffect(() => {
    setDraftTheme(currentTheme);
  }, [currentTheme]);

  useEffect(() => {
    if (workAnimation) {
      setDraftWorkAnimation(workAnimation);
    }
  }, [workAnimation]);

  useEffect(() => {
    setDraftTextColor(customTextColor || '');
  }, [customTextColor]);

  useEffect(() => {
    setDraftLabelColor(customLabelColor || '');
  }, [customLabelColor]);

  useEffect(() => {
    setDraftBackground(customBackground ? { ...customBackground } : {});
  }, [customBackground]);

  // Clean up any uncommitted inline DOM overrides on unmount
  useEffect(() => {
    return () => {
      applyTheme(resolveTheme(currentTheme));
    };
  }, [currentTheme]);

  const hasUnsavedChanges = useMemo(() => {
    const themeChanged = draftTheme !== currentTheme || customAccent !== '';
    const baseAnim = workAnimation || DEFAULT_WORK_ANIMATION_PREFERENCES;
    const animChanged =
      draftWorkAnimation.mode !== baseAnim.mode ||
      draftWorkAnimation.color1 !== baseAnim.color1 ||
      draftWorkAnimation.color2 !== baseAnim.color2;
    const textChanged = draftTextColor !== (customTextColor || '');
    const labelChanged = draftLabelColor !== (customLabelColor || '');
    const bgChanged =
      JSON.stringify(draftBackground) !== JSON.stringify(customBackground || {});
    return themeChanged || animChanged || textChanged || labelChanged || bgChanged;
  }, [
    draftTheme,
    currentTheme,
    customAccent,
    draftWorkAnimation,
    workAnimation,
    draftTextColor,
    customTextColor,
    draftLabelColor,
    customLabelColor,
    draftBackground,
    customBackground,
  ]);

  // Preview theme immediately in DOM
  const handleSelectPreset = useCallback((themeId: AppTheme) => {
    setDraftTheme(themeId);
    setSaveFeedback(false);
    applyTheme(resolveTheme(themeId));
  }, []);

  // Apply custom accent color override live
  const handleSelectAccent = useCallback((hex: string) => {
    setCustomAccent(hex);
    setSaveFeedback(false);
    document.documentElement.style.setProperty('--accent-primary', hex);
    document.documentElement.style.setProperty('--border-active', hex);
  }, []);

  // Apply custom text color override live
  const handleSelectTextColor = useCallback((hex: string) => {
    setDraftTextColor(hex);
    setSaveFeedback(false);
    if (hex && isValidHexColor(hex)) {
      document.documentElement.style.setProperty('--fg-default', hex);
      document.documentElement.style.setProperty('--text-primary', hex);
    } else {
      document.documentElement.style.removeProperty('--fg-default');
      document.documentElement.style.removeProperty('--text-primary');
    }
  }, []);

  // Apply custom label / tags color override live
  const handleSelectLabelColor = useCallback((hex: string) => {
    setDraftLabelColor(hex);
    setSaveFeedback(false);
    if (hex && isValidHexColor(hex)) {
      document.documentElement.style.setProperty('--activity-badge-fg', hex);
      document.documentElement.style.setProperty('--activity-badge-border', hexToRgba(hex, 0.35));
      document.documentElement.style.setProperty('--activity-badge-bg', hexToRgba(hex, 0.12));
      document.documentElement.style.setProperty('--md-inline-code-fg', hex);
      document.documentElement.style.setProperty('--md-inline-code-border', hexToRgba(hex, 0.25));
      document.documentElement.style.setProperty('--tag-color', hex);
      document.documentElement.style.setProperty('--syntax-keyword', hex);
    } else {
      document.documentElement.style.removeProperty('--activity-badge-fg');
      document.documentElement.style.removeProperty('--activity-badge-border');
      document.documentElement.style.removeProperty('--activity-badge-bg');
      document.documentElement.style.removeProperty('--md-inline-code-fg');
      document.documentElement.style.removeProperty('--md-inline-code-border');
      document.documentElement.style.removeProperty('--tag-color');
      document.documentElement.style.removeProperty('--syntax-keyword');
    }
  }, []);

  // Confirm changes permanently
  const handleConfirmTheme = useCallback(() => {
    onThemeChange(draftTheme);
    if (customAccent) {
      try {
        localStorage.setItem('pi_viewer_custom_accent', customAccent);
      } catch {}
    }
    if (onWorkAnimationChange) {
      onWorkAnimationChange(draftWorkAnimation);
    }
    if (onCustomThemeColorsChange) {
      onCustomThemeColorsChange({
        text: draftTextColor || null,
        label: draftLabelColor || null,
      });
    }
    if (onCustomBackgroundChange) {
      const hasAny = Object.keys(draftBackground).length > 0;
      onCustomBackgroundChange(hasAny ? draftBackground : null);
    }
    setSaveFeedback(true);
    setTimeout(() => setSaveFeedback(false), 4000);
  }, [
    draftTheme,
    customAccent,
    onThemeChange,
    draftWorkAnimation,
    onWorkAnimationChange,
    draftTextColor,
    draftLabelColor,
    onCustomThemeColorsChange,
    draftBackground,
    onCustomBackgroundChange,
  ]);

  // Reset to original theme
  const handleResetTheme = useCallback(() => {
    setDraftTheme(currentTheme);
    setCustomAccent('');
    setDraftTextColor(customTextColor || '');
    setDraftLabelColor(customLabelColor || '');
    setDraftBackground(customBackground ? { ...customBackground } : {});
    if (workAnimation) {
      setDraftWorkAnimation(workAnimation);
    } else {
      setDraftWorkAnimation({ ...DEFAULT_WORK_ANIMATION_PREFERENCES });
    }
    document.documentElement.style.removeProperty('--accent-primary');
    document.documentElement.style.removeProperty('--border-active');

    if (customTextColor) {
      document.documentElement.style.setProperty('--fg-default', customTextColor);
      document.documentElement.style.setProperty('--text-primary', customTextColor);
    } else {
      document.documentElement.style.removeProperty('--fg-default');
      document.documentElement.style.removeProperty('--text-primary');
    }

    if (customLabelColor) {
      const lbl = customLabelColor;
      document.documentElement.style.setProperty('--activity-badge-fg', lbl);
      document.documentElement.style.setProperty('--activity-badge-border', hexToRgba(lbl, 0.35));
      document.documentElement.style.setProperty('--activity-badge-bg', hexToRgba(lbl, 0.12));
      document.documentElement.style.setProperty('--md-inline-code-fg', lbl);
      document.documentElement.style.setProperty('--md-inline-code-border', hexToRgba(lbl, 0.25));
      document.documentElement.style.setProperty('--tag-color', lbl);
      document.documentElement.style.setProperty('--syntax-keyword', lbl);
    } else {
      document.documentElement.style.removeProperty('--activity-badge-fg');
      document.documentElement.style.removeProperty('--activity-badge-border');
      document.documentElement.style.removeProperty('--activity-badge-bg');
      document.documentElement.style.removeProperty('--md-inline-code-fg');
      document.documentElement.style.removeProperty('--md-inline-code-border');
      document.documentElement.style.removeProperty('--tag-color');
      document.documentElement.style.removeProperty('--syntax-keyword');
    }

    applyTheme(resolveTheme(currentTheme));
    setSaveFeedback(false);
  }, [currentTheme, workAnimation, customTextColor, customLabelColor, customBackground]);

  const activePresetMeta = useMemo(() => {
    return THEME_PRESETS.find((p) => p.id === draftTheme) || THEME_PRESETS[0];
  }, [draftTheme]);

  const currentAreaConfig = useMemo(() => {
    const existing = draftBackground[activeBgArea];
    if (existing) return existing;
    const defaultColor =
      activeBgArea === 'canvas'
        ? activePresetMeta.palette.bg
        : activeBgArea === 'sidebar'
          ? activePresetMeta.palette.surface
          : activeBgArea === 'chat'
            ? activePresetMeta.palette.bg
            : activeBgArea === 'prompt'
              ? activePresetMeta.palette.surface
              : activePresetMeta.palette.surface;
    return { color: defaultColor, opacity: 1 };
  }, [draftBackground, activeBgArea, activePresetMeta]);

  const handleUpdateAreaOpacity = useCallback(
    (opacity: number) => {
      setDraftBackground((prev) => {
        const cur = prev[activeBgArea] || {
          color:
            activeBgArea === 'canvas'
              ? activePresetMeta.palette.bg
              : activeBgArea === 'sidebar'
                ? activePresetMeta.palette.surface
                : activeBgArea === 'chat'
                  ? activePresetMeta.palette.bg
                  : activeBgArea === 'prompt'
                    ? activePresetMeta.palette.surface
                    : activePresetMeta.palette.surface,
          opacity: 1,
        };
        const next = {
          ...prev,
          [activeBgArea]: { ...cur, opacity },
        };
        if (onCustomBackgroundChange) {
          onCustomBackgroundChange(next);
        }
        return next;
      });
    },
    [activeBgArea, activePresetMeta, onCustomBackgroundChange]
  );

  const handleUpdateAreaColor = useCallback(
    (color: string) => {
      setDraftBackground((prev) => {
        const cur = prev[activeBgArea] || { opacity: 1 };
        const next = {
          ...prev,
          [activeBgArea]: { ...cur, color },
        };
        if (onCustomBackgroundChange) {
          onCustomBackgroundChange(next);
        }
        return next;
      });
    },
    [activeBgArea, onCustomBackgroundChange]
  );

  const handleResetArea = useCallback(() => {
    setDraftBackground((prev) => {
      const next = { ...prev };
      delete next[activeBgArea];
      if (onCustomBackgroundChange) {
        onCustomBackgroundChange(Object.keys(next).length > 0 ? next : null);
      }
      return next;
    });
  }, [activeBgArea, onCustomBackgroundChange]);

  const handleImageFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const result = evt.target?.result;
      if (typeof result === 'string') {
        const applyOptimizedUrl = (finalUrl: string) => {
          setDraftBackground((prev) => {
            const next: CustomBackgroundPreferences = {
              ...prev,
              image: {
                ...(prev.image || {
                  enabled: true,
                  url: '',
                  fit: 'cover',
                  position: 'center',
                  repeat: false,
                  opacity: 0.5,
                  blur: 0,
                }),
                enabled: true,
                url: finalUrl,
              },
              chat: prev.chat || { opacity: 0 },
              prompt: prev.prompt || { opacity: 0.4 },
              canvas: prev.canvas || { opacity: 0 },
            };
            if (onCustomBackgroundChange) {
              onCustomBackgroundChange(next);
            }
            return next;
          });
        };

        // Resize large images in offscreen canvas to prevent localStorage QuotaExceededError
        if (typeof window !== 'undefined' && result.length > 500000) {
          const img = new Image();
          img.onload = () => {
            const maxDim = 1920;
            let width = img.width;
            let height = img.height;
            if (width > maxDim || height > maxDim) {
              if (width > height) {
                height = Math.round((height * maxDim) / width);
                width = maxDim;
              } else {
                width = Math.round((width * maxDim) / height);
                height = maxDim;
              }
            }
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(img, 0, 0, width, height);
              const compressed = canvas.toDataURL('image/jpeg', 0.85);
              applyOptimizedUrl(compressed);
            } else {
              applyOptimizedUrl(result);
            }
          };
          img.onerror = () => applyOptimizedUrl(result);
          img.src = result;
        } else {
          applyOptimizedUrl(result);
        }
      }
    };
    reader.readAsDataURL(file);
  }, [onCustomBackgroundChange]);

  const handleUpdateImageConfig = useCallback(
    (patch: Partial<BackgroundImageConfig>) => {
      setDraftBackground((prev) => {
        const next: CustomBackgroundPreferences = {
          ...prev,
          image: {
            ...(prev.image || {
              enabled: true,
              url: '',
              fit: 'cover',
              position: 'center',
              repeat: false,
              opacity: 0.5,
              blur: 0,
            }),
            ...patch,
          },
          // When enabling or setting a wallpaper, ensure chat & canvas don't occlude it
          chat: prev.chat || { opacity: 0 },
          prompt: prev.prompt || { opacity: 0.4 },
          canvas: prev.canvas || { opacity: 0 },
        };
        if (onCustomBackgroundChange) {
          onCustomBackgroundChange(next);
        }
        return next;
      });
    },
    [onCustomBackgroundChange]
  );

  const sandboxWorkStyles = useMemo(
    () => computeWorkAnimationStyles(draftWorkAnimation),
    [draftWorkAnimation]
  );

  return (
    <div className="theme-customizer-container">
      {/* Header Info */}
      <div className="theme-customizer-header">
        <div>
          <h2 className="theme-customizer-title">{t('theme.customizer_title')}</h2>
          <p className="theme-customizer-subtitle">{t('theme.customizer_subtitle')}</p>
        </div>
      </div>

      {/* Confirmation Module (Prominent Module) */}
      <section className={`theme-confirmation-card ${hasUnsavedChanges ? 'is-pending-save' : 'is-saved'}`}>
        <div className="confirmation-card-header">
          <div className="confirmation-title-group">
            <span className="confirmation-badge" aria-hidden="true">
              {hasUnsavedChanges ? '⚡' : '✓'}
            </span>
            <div>
              <h3 className="confirmation-title">{t('theme.confirmation_title')}</h3>
              <p className="confirmation-desc">
                {hasUnsavedChanges ? t('theme.notice_unsaved') : t('theme.confirmation_subtitle')}
              </p>
            </div>
          </div>

          <div className="confirmation-status-pill">
            <span
              className={`status-dot ${hasUnsavedChanges ? 'status-dot-pending' : 'status-dot-active'}`}
              aria-hidden="true"
            />
            <span>
              {hasUnsavedChanges
                ? `${t('theme.status_previewing')}: ${activePresetMeta.name}`
                : `${t('theme.status_active')}: ${activePresetMeta.name}`}
            </span>
          </div>
        </div>

        <div className="confirmation-actions-row">
          <button
            type="button"
            className="btn btn-primary btn-confirm-theme"
            onClick={handleConfirmTheme}
            disabled={!hasUnsavedChanges}
          >
            <span>✓ {t('theme.confirm_button')}</span>
          </button>

          {hasUnsavedChanges && (
            <button
              type="button"
              className="btn btn-secondary btn-reset-theme"
              onClick={handleResetTheme}
            >
              <span>↺ {t('theme.cancel_button')}</span>
            </button>
          )}

          {saveFeedback && (
            <span className="confirmation-saved-notice" role="status">
              ✓ {t('theme.notice_saved')}
            </span>
          )}
        </div>
      </section>

      {/* Presets Gallery */}
      <section className="theme-presets-section">
        <div className="section-title-wrap">
          <h3 className="theme-section-title">{t('theme.presets_title')}</h3>
          <p className="theme-section-subtitle">{t('theme.presets_subtitle')}</p>
        </div>

        <div className="theme-presets-grid" role="radiogroup" aria-label={t('theme.presets_title')}>
          {THEME_PRESETS.map((preset) => {
            const isDraftActive = draftTheme === preset.id;
            const isPersisted = currentTheme === preset.id;

            return (
              <div
                key={preset.id}
                role="radio"
                aria-checked={isDraftActive}
                tabIndex={0}
                className={`theme-card ${isDraftActive ? 'is-selected' : ''}`}
                onClick={() => handleSelectPreset(preset.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleSelectPreset(preset.id);
                  }
                }}
              >
                <div className="theme-card-top">
                  <div className="theme-card-badge-wrap">
                    <span className="theme-preset-tag">{preset.tag}</span>
                    {isPersisted && <span className="theme-active-tag">Activo</span>}
                  </div>
                  <h4 className="theme-card-name">{preset.name}</h4>
                  <p className="theme-card-desc">{preset.description}</p>
                </div>

                <div className="theme-card-swatches">
                  <div
                    className="swatch-item"
                    style={{ backgroundColor: preset.palette.bg }}
                    title="Fondo Canvas"
                  />
                  <div
                    className="swatch-item"
                    style={{ backgroundColor: preset.palette.surface }}
                    title="Superficie"
                  />
                  <div
                    className="swatch-item"
                    style={{ backgroundColor: preset.palette.border }}
                    title="Borde"
                  />
                  <div
                    className="swatch-item"
                    style={{ backgroundColor: preset.palette.accent }}
                    title="Acento Principal"
                  />
                  <div
                    className="swatch-item"
                    style={{ backgroundColor: preset.palette.text }}
                    title="Texto"
                  />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Quick Accent Color Overrides */}
      <section className="theme-accent-section">
        <div className="section-title-wrap">
          <h3 className="theme-section-title">{t('theme.accent_title')}</h3>
          <p className="theme-section-subtitle">{t('theme.accent_subtitle')}</p>
        </div>

        <div className="accent-swatches-row">
          {ACCENT_SWATCHES.map((swatch) => (
            <button
              key={swatch.hex}
              type="button"
              className={`accent-color-btn ${customAccent === swatch.hex ? 'is-accent-active' : ''}`}
              style={{ backgroundColor: swatch.hex }}
              onClick={() => handleSelectAccent(swatch.hex)}
              title={swatch.name}
              aria-label={swatch.name}
            />
          ))}

          <div className="custom-hex-picker-wrap">
            <input
              type="color"
              id="theme-custom-hex-picker"
              className="input-color-picker"
              value={customAccent || activePresetMeta.palette.accent}
              onChange={(e) => handleSelectAccent(e.target.value)}
              title={t('theme.custom_hex')}
              aria-label={t('theme.custom_hex')}
            />
            <label htmlFor="theme-custom-hex-picker" className="custom-hex-label">
              {t('theme.custom_hex')}
            </label>
          </div>
        </div>
      </section>

      {/* Quick Text Color Overrides */}
      <section className="theme-accent-section">
        <div className="section-title-wrap">
          <h3 className="theme-section-title">{t('theme.text_color_title')}</h3>
          <p className="theme-section-subtitle">{t('theme.text_color_subtitle')}</p>
        </div>

        <div className="accent-swatches-row">
          {TEXT_COLOR_SWATCHES.map((swatch) => (
            <button
              key={swatch.hex}
              type="button"
              className={`accent-color-btn ${draftTextColor === swatch.hex ? 'is-accent-active' : ''}`}
              style={{ backgroundColor: swatch.hex }}
              onClick={() => handleSelectTextColor(swatch.hex)}
              title={swatch.name}
              aria-label={swatch.name}
            />
          ))}

          <div className="custom-hex-picker-wrap">
            <input
              type="color"
              id="theme-custom-text-picker"
              className="input-color-picker"
              value={draftTextColor || activePresetMeta.palette.text}
              onChange={(e) => handleSelectTextColor(e.target.value)}
              title={t('theme.custom_hex')}
              aria-label={t('theme.custom_hex')}
            />
            <label htmlFor="theme-custom-text-picker" className="custom-hex-label">
              {t('theme.custom_hex')}
            </label>
          </div>

          {draftTextColor && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => handleSelectTextColor('')}
              style={{ marginLeft: 8 }}
            >
              ↺ {t('theme.color_reset')}
            </button>
          )}
        </div>
      </section>

      {/* Quick Label / Tag Color Overrides */}
      <section className="theme-accent-section">
        <div className="section-title-wrap">
          <h3 className="theme-section-title">{t('theme.label_color_title')}</h3>
          <p className="theme-section-subtitle">{t('theme.label_color_subtitle')}</p>
        </div>

        <div className="accent-swatches-row">
          {LABEL_COLOR_SWATCHES.map((swatch) => (
            <button
              key={swatch.hex}
              type="button"
              className={`accent-color-btn ${draftLabelColor === swatch.hex ? 'is-accent-active' : ''}`}
              style={{ backgroundColor: swatch.hex }}
              onClick={() => handleSelectLabelColor(swatch.hex)}
              title={swatch.name}
              aria-label={swatch.name}
            />
          ))}

          <div className="custom-hex-picker-wrap">
            <input
              type="color"
              id="theme-custom-label-picker"
              className="input-color-picker"
              value={draftLabelColor || activePresetMeta.palette.accent}
              onChange={(e) => handleSelectLabelColor(e.target.value)}
              title={t('theme.custom_hex')}
              aria-label={t('theme.custom_hex')}
            />
            <label htmlFor="theme-custom-label-picker" className="custom-hex-label">
              {t('theme.custom_hex')}
            </label>
          </div>

          {draftLabelColor && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => handleSelectLabelColor('')}
              style={{ marginLeft: 8 }}
            >
              ↺ {t('theme.color_reset')}
            </button>
          )}
        </div>
      </section>

      {/* Background & Transparency per Area Section */}
      <section className="theme-custom-bg-section">
        <div className="section-title-wrap">
          <h3 className="theme-section-title">{t('theme.background_heading')}</h3>
          <p className="theme-section-subtitle">{t('theme.background_subheading')}</p>
        </div>

        {/* Area selection pills */}
        <div className="area-selector-pills" role="radiogroup" aria-label={t('theme.background_heading')}>
          {(['canvas', 'sidebar', 'chat', 'prompt', 'cards'] as const).map((area) => (
            <button
              key={area}
              type="button"
              className={`area-selector-btn ${activeBgArea === area ? 'is-active' : ''}`}
              onClick={() => setActiveBgArea(area)}
            >
              <span>
                {area === 'canvas' && '🖥️ '}
                {area === 'sidebar' && '📁 '}
                {area === 'chat' && '💬 '}
                {area === 'prompt' && '⌨️ '}
                {area === 'cards' && '🗂️ '}
                {area === 'canvas' && t('theme.area_canvas')}
                {area === 'sidebar' && t('theme.area_sidebar')}
                {area === 'chat' && t('theme.area_chat')}
                {area === 'prompt' && t('theme.area_prompt')}
                {area === 'cards' && t('theme.area_cards')}
              </span>
            </button>
          ))}
        </div>

        {/* Controls for currently selected area */}
        <div className="bg-controls-grid">
          {/* Opacity slider */}
          <div className="bg-control-row">
            <span className="bg-control-label">{t('theme.area_opacity')}:</span>
            <div className="bg-slider-wrap">
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                className="bg-range-input"
                value={currentAreaConfig.opacity}
                onChange={(e) => handleUpdateAreaOpacity(parseFloat(e.target.value))}
              />
              <span className="bg-slider-value">
                {Math.round(currentAreaConfig.opacity * 100)}%
              </span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => handleUpdateAreaOpacity(0)}
              >
                0% ({t('theme.area_make_transparent')})
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => handleUpdateAreaOpacity(1)}
              >
                100%
              </button>
            </div>
          </div>

          {/* Area color */}
          <div className="bg-control-row">
            <span className="bg-control-label">{t('theme.area_color')}:</span>
            <div className="loader-swatches-wrap">
              {LOADER_PALETTE_SWATCHES.map((swatch) => (
                <button
                  key={`bg-color-${swatch.hex}`}
                  type="button"
                  className={`loader-swatch-btn ${currentAreaConfig.color === swatch.hex ? 'is-active' : ''}`}
                  style={{ backgroundColor: swatch.hex }}
                  onClick={() => handleUpdateAreaColor(swatch.hex)}
                  title={swatch.name}
                  aria-label={swatch.name}
                />
              ))}
              <div className="custom-hex-picker-wrap">
                <input
                  type="color"
                  id="area-color-picker"
                  className="input-color-picker"
                  value={currentAreaConfig.color || activePresetMeta.palette.bg}
                  onChange={(e) => handleUpdateAreaColor(e.target.value)}
                  title={t('theme.custom_hex')}
                  aria-label={t('theme.custom_hex')}
                />
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleResetArea}
                style={{ marginLeft: 8 }}
              >
                ↺ {t('theme.area_reset')}
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Background Image & Adjustment Section */}
      <section className="theme-custom-bg-section">
        <div className="section-title-wrap">
          <h3 className="theme-section-title">{t('theme.bg_image_heading')}</h3>
          <p className="theme-section-subtitle">{t('theme.bg_image_subheading')}</p>
        </div>

        {/* Enable toggle checkbox */}
        <div className="bg-control-row">
          <label className="checkbox-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={Boolean(draftBackground.image?.enabled)}
              onChange={(e) => handleUpdateImageConfig({ enabled: e.target.checked })}
            />
            <span className="checkbox-text" style={{ fontSize: 13, fontWeight: 600 }}>
              {t('theme.bg_image_enable')}
            </span>
          </label>
        </div>

        {draftBackground.image?.enabled && (
          <div className="bg-controls-grid">
            {/* Image source / file upload */}
            <div className="bg-control-row">
              <span className="bg-control-label">{t('theme.bg_image_url_label')}:</span>
              <div className="bg-file-upload-wrap">
                <input
                  type="text"
                  className="bg-url-input"
                  value={draftBackground.image.url}
                  onChange={(e) => handleUpdateImageConfig({ url: e.target.value })}
                  placeholder="https://... o data:image/..."
                />
                <input
                  type="file"
                  accept="image/*"
                  ref={fileInputRef}
                  style={{ display: 'none' }}
                  onChange={handleImageFileChange}
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => fileInputRef.current?.click()}
                >
                  📁 {t('theme.bg_image_upload_btn')}
                </button>
                {draftBackground.image.url && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      setDraftBackground((prev) => {
                        const next = {
                          ...prev,
                          image: {
                            ...(prev.image || {
                              enabled: true,
                              url: '',
                              fit: 'cover',
                              position: 'center',
                              repeat: false,
                              opacity: 0.4,
                              blur: 0,
                            }),
                            url: '',
                          },
                        };
                        if (onCustomBackgroundChange) {
                          onCustomBackgroundChange(next);
                        }
                        return next;
                      });
                    }}
                  >
                    ✕ {t('theme.bg_image_clear')}
                  </button>
                )}
              </div>
            </div>

            {/* Quick Presets / Fondos Rápidos */}
            <div className="bg-control-row">
              <span className="bg-control-label">Fondos Rápidos:</span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                  type="button"
                  className={`btn btn-sm ${draftBackground.image.url === '/wallpapers/minimalist-ninja-1080p.jpg' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => {
                    const next: CustomBackgroundPreferences = {
                      ...draftBackground,
                      image: {
                        ...(draftBackground.image || {
                          fit: 'cover',
                          position: 'center',
                          repeat: false,
                          opacity: 0.5,
                          blur: 0,
                        }),
                        enabled: true,
                        url: '/wallpapers/minimalist-ninja-1080p.jpg',
                        opacity: draftBackground.image?.opacity ?? 0.5,
                      },
                      chat: draftBackground.chat || { opacity: 0 },
                      prompt: draftBackground.prompt || { opacity: 0.4 },
                      canvas: draftBackground.canvas || { opacity: 0 },
                    };
                    setDraftBackground(next);
                    if (onCustomBackgroundChange) {
                      onCustomBackgroundChange(next);
                    }
                  }}
                  title="Fondo oficial de Ninja en Montaña Minimalista optimizado (1080p)"
                >
                  🥷 Ninja Minimalista (1080p)
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${draftBackground.image.url === '/wallpapers/minimalist-ninja.jpg' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => {
                    const next: CustomBackgroundPreferences = {
                      ...draftBackground,
                      image: {
                        ...(draftBackground.image || {
                          fit: 'cover',
                          position: 'center',
                          repeat: false,
                          opacity: 0.5,
                          blur: 0,
                        }),
                        enabled: true,
                        url: '/wallpapers/minimalist-ninja.jpg',
                        opacity: draftBackground.image?.opacity ?? 0.5,
                      },
                      chat: draftBackground.chat || { opacity: 0 },
                      prompt: draftBackground.prompt || { opacity: 0.4 },
                      canvas: draftBackground.canvas || { opacity: 0 },
                    };
                    setDraftBackground(next);
                    if (onCustomBackgroundChange) {
                      onCustomBackgroundChange(next);
                    }
                  }}
                  title="Fondo oficial de Ninja en Montaña Minimalista en resolución original 2.7K"
                >
                  🏔️ Ninja Ultra HD (2.7K)
                </button>
              </div>
            </div>

            {/* Fit mode (Acomodar imagen) */}
            <div className="bg-control-row">
              <span className="bg-control-label">{t('theme.bg_image_fit_label')}:</span>
              <div className="loader-mode-pills">
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
                    className={`loader-mode-btn ${draftBackground.image?.fit === fitOption.id ? 'is-active' : ''}`}
                    onClick={() =>
                      handleUpdateImageConfig({
                        fit: fitOption.id as any,
                        repeat: fitOption.id === 'repeat',
                      })
                    }
                  >
                    {fitOption.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Position */}
            <div className="bg-control-row">
              <span className="bg-control-label">{t('theme.bg_image_position_label')}:</span>
              <div className="loader-mode-pills">
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
                    className={`loader-mode-btn ${draftBackground.image?.position === posOption.id ? 'is-active' : ''}`}
                    onClick={() => handleUpdateImageConfig({ position: posOption.id as any })}
                  >
                    {posOption.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Opacity slider */}
            <div className="bg-control-row">
              <span className="bg-control-label">{t('theme.bg_image_opacity_label')}:</span>
              <div className="bg-slider-wrap">
                <input
                  type="range"
                  min="0.05"
                  max="1"
                  step="0.05"
                  className="bg-range-input"
                  value={draftBackground.image.opacity ?? 0.5}
                  onChange={(e) => handleUpdateImageConfig({ opacity: parseFloat(e.target.value) })}
                />
                <span className="bg-slider-value">
                  {Math.round((draftBackground.image.opacity ?? 0.5) * 100)}%
                </span>
              </div>
            </div>

            {/* Blur filter slider */}
            <div className="bg-control-row">
              <span className="bg-control-label">{t('theme.bg_image_blur_label')}:</span>
              <div className="bg-slider-wrap">
                <input
                  type="range"
                  min="0"
                  max="25"
                  step="1"
                  className="bg-range-input"
                  value={draftBackground.image.blur ?? 0}
                  onChange={(e) => handleUpdateImageConfig({ blur: parseInt(e.target.value, 10) })}
                />
                <span className="bg-slider-value">
                  {draftBackground.image.blur ?? 0}px
                </span>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Work Animation Customization Section */}
      <section className="theme-work-animation-section">
        <div className="section-title-wrap">
          <h3 className="theme-section-title">{t('theme.loader_heading')}</h3>
          <p className="theme-section-subtitle">{t('theme.loader_subheading')}</p>
        </div>

        {/* Mode selector pills */}
        <div className="loader-mode-pills" role="radiogroup" aria-label={t('theme.loader_mode_label')}>
          <button
            type="button"
            className={`loader-mode-btn ${draftWorkAnimation.mode === 'multicolor' ? 'is-active' : ''}`}
            onClick={() => setDraftWorkAnimation((prev) => ({ ...prev, mode: 'multicolor' }))}
          >
            <span>🌈 {t('theme.loader_mode_multicolor')}</span>
          </button>
          <button
            type="button"
            className={`loader-mode-btn ${draftWorkAnimation.mode === 'single' ? 'is-active' : ''}`}
            onClick={() => setDraftWorkAnimation((prev) => ({ ...prev, mode: 'single' }))}
          >
            <span>● {t('theme.loader_mode_single')}</span>
          </button>
          <button
            type="button"
            className={`loader-mode-btn ${draftWorkAnimation.mode === 'dual' ? 'is-active' : ''}`}
            onClick={() => setDraftWorkAnimation((prev) => ({ ...prev, mode: 'dual' }))}
          >
            <span>◐ {t('theme.loader_mode_dual')}</span>
          </button>
        </div>

        {/* Color pickers */}
        {draftWorkAnimation.mode !== 'multicolor' && (
          <div className="loader-color-pickers">
            {/* Color 1 */}
            <div className="loader-color-row">
              <span className="loader-color-label">
                {draftWorkAnimation.mode === 'dual' ? t('theme.loader_color1_label') : t('theme.loader_color_palette')}
              </span>
              <div className="loader-swatches-wrap">
                {LOADER_PALETTE_SWATCHES.map((swatch) => (
                  <button
                    key={`swatch-c1-${swatch.hex}`}
                    type="button"
                    className={`loader-swatch-btn ${draftWorkAnimation.color1 === swatch.hex ? 'is-active' : ''}`}
                    style={{ backgroundColor: swatch.hex }}
                    onClick={() => setDraftWorkAnimation((prev) => ({ ...prev, color1: swatch.hex }))}
                    title={swatch.name}
                    aria-label={swatch.name}
                  />
                ))}
                <div className="custom-hex-picker-wrap">
                  <input
                    type="color"
                    id="loader-color1-picker"
                    className="input-color-picker"
                    value={draftWorkAnimation.color1}
                    onChange={(e) => setDraftWorkAnimation((prev) => ({ ...prev, color1: e.target.value }))}
                    title={t('theme.custom_hex')}
                    aria-label={t('theme.custom_hex')}
                  />
                </div>
              </div>
            </div>

            {/* Color 2 (Dual mode only) */}
            {draftWorkAnimation.mode === 'dual' && (
              <div className="loader-color-row">
                <span className="loader-color-label">{t('theme.loader_color2_label')}</span>
                <div className="loader-swatches-wrap">
                  {LOADER_PALETTE_SWATCHES.map((swatch) => (
                    <button
                      key={`swatch-c2-${swatch.hex}`}
                      type="button"
                      className={`loader-swatch-btn ${draftWorkAnimation.color2 === swatch.hex ? 'is-active' : ''}`}
                      style={{ backgroundColor: swatch.hex }}
                      onClick={() => setDraftWorkAnimation((prev) => ({ ...prev, color2: swatch.hex }))}
                      title={swatch.name}
                      aria-label={swatch.name}
                    />
                  ))}
                  <div className="custom-hex-picker-wrap">
                    <input
                      type="color"
                      id="loader-color2-picker"
                      className="input-color-picker"
                      value={draftWorkAnimation.color2}
                      onChange={(e) => setDraftWorkAnimation((prev) => ({ ...prev, color2: e.target.value }))}
                      title={t('theme.custom_hex')}
                      aria-label={t('theme.custom_hex')}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Direct live preview inside section */}
        <div className="loader-preview-row">
          <section
            className={sandboxWorkStyles.className}
            style={sandboxWorkStyles.style as React.CSSProperties}
            aria-hidden="true"
          >
            <div className="loader">
              {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
                <div key={`pdot-1-${i}`} className="dot" style={{ '--i': i } as React.CSSProperties} />
              ))}
            </div>
            <h2>Working</h2>
            <div className="loader">
              {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
                <div key={`pdot-2-${i}`} className="dot" style={{ '--i': i } as React.CSSProperties} />
              ))}
            </div>
          </section>
          <span className="loader-preview-caption">
            {draftWorkAnimation.mode === 'multicolor'
              ? t('theme.loader_mode_multicolor')
              : draftWorkAnimation.mode === 'dual'
                ? `${draftWorkAnimation.color1} ➔ ${draftWorkAnimation.color2}`
                : draftWorkAnimation.color1}
          </span>
        </div>
      </section>

      {/* Live Preview Sandbox */}
      <section className="theme-preview-sandbox-section">
        <div className="section-title-wrap">
          <h3 className="theme-section-title">{t('theme.preview_title')}</h3>
          <p className="theme-section-subtitle">{t('theme.preview_subtitle')}</p>
        </div>

        <div
          className="sandbox-viewport"
          style={{
            backgroundColor: draftBackground.canvas
              ? draftBackground.canvas.opacity === 0
                ? 'transparent'
                : hexToRgba(
                    draftBackground.canvas.color || activePresetMeta.palette.bg,
                    draftBackground.canvas.opacity
                  )
              : undefined,
          }}
        >
          {draftBackground.image?.enabled && draftBackground.image?.url && (
            <div
              className="app-custom-background-layer"
              style={{
                backgroundImage: `url("${draftBackground.image.url}")`,
                backgroundSize: draftBackground.image.fit || 'cover',
                backgroundPosition: draftBackground.image.position || 'center',
                backgroundRepeat:
                  draftBackground.image.repeat || draftBackground.image.fit === 'repeat'
                    ? 'repeat'
                    : 'no-repeat',
                opacity: draftBackground.image.opacity ?? 0.4,
                filter: draftBackground.image.blur
                  ? `blur(${draftBackground.image.blur}px)`
                  : undefined,
              }}
              aria-hidden="true"
            />
          )}

          {/* Header Mock */}
          <div
            className="sandbox-header-mock"
            style={{
              position: 'relative',
              zIndex: 1,
              backgroundColor: draftBackground.sidebar
                ? draftBackground.sidebar.opacity === 0
                  ? 'transparent'
                  : hexToRgba(
                      draftBackground.sidebar.color || activePresetMeta.palette.surface,
                      draftBackground.sidebar.opacity
                    )
                : undefined,
            }}
          >
            <span className="sandbox-brand">PI-Viewer v0.2.0</span>
            <div className="sandbox-header-controls">
              <span className="sandbox-status-badge">● Conectado</span>
              <button type="button" className="btn btn-secondary btn-sm sandbox-btn">↻ Recargar</button>
            </div>
          </div>

          {/* Chat Mock */}
          <div
            className="sandbox-chat-area"
            style={{
              position: 'relative',
              zIndex: 1,
              backgroundColor: draftBackground.chat
                ? draftBackground.chat.opacity === 0
                  ? 'transparent'
                  : hexToRgba(
                      draftBackground.chat.color || activePresetMeta.palette.bg,
                      draftBackground.chat.opacity
                    )
                : undefined,
            }}
          >
            {/* User message */}
            <div
              className="sandbox-msg sandbox-msg-user"
              style={{
                backgroundColor: draftBackground.cards
                  ? draftBackground.cards.opacity === 0
                    ? 'transparent'
                    : hexToRgba(
                        draftBackground.cards.color || activePresetMeta.palette.surface,
                        draftBackground.cards.opacity
                      )
                  : undefined,
              }}
            >
              <div className="sandbox-msg-header">usuario • 10:24</div>
              <div className="sandbox-msg-body">{t('theme.sample_user_prompt')}</div>
            </div>

            {/* Assistant message with Code Card */}
            <div className="sandbox-msg sandbox-msg-assistant">
              <div className="sandbox-msg-header">
                <span>asistente • 10:25</span>
                <span className="odd-agent-oval agent-explore" style={{ marginLeft: 8 }}>
                  <span className="odd-agent-dot" />
                  <strong className="odd-agent-name">gentle-ai-explore</strong>
                </span>
                <span className="odd-agent-oval agent-verify" style={{ marginLeft: 4 }}>
                  <span className="odd-agent-dot" />
                  <strong className="odd-agent-name">gentle-ai-verify</strong>
                </span>
              </div>
              <div className="sandbox-msg-body" style={{ color: draftTextColor || undefined }}>
                <p>{t('theme.sample_assistant_response')}</p>
                <div
                  className="sandbox-code-card"
                  style={{
                    backgroundColor: draftBackground.cards
                      ? draftBackground.cards.opacity === 0
                        ? 'transparent'
                        : hexToRgba(
                            draftBackground.cards.color || activePresetMeta.palette.surface,
                            draftBackground.cards.opacity
                          )
                      : undefined,
                  }}
                >
                  <div className="sandbox-code-header">
                    <span>asm:risc_add.s</span>
                    <span
                      className="sandbox-code-badge"
                      style={{ color: draftLabelColor || undefined }}
                    >
                      assembly
                    </span>
                  </div>
                  <pre className="sandbox-code-pre">
                    <code>
                      <span style={{ color: draftLabelColor || 'var(--syntax-keyword)' }}>LOAD</span> R1, [0x1000]{'\n'}
                      <span style={{ color: draftLabelColor || 'var(--syntax-keyword)' }}>LOAD</span> R2, [0x1004]{'\n'}
                      <span style={{ color: 'var(--syntax-fn)' }}>ADD</span>  R3, R1, R2{'\n'}
                      <span style={{ color: draftLabelColor || 'var(--syntax-keyword)' }}>STORE</span> R3, [0x1008]
                    </code>
                  </pre>
                </div>
              </div>
            </div>

            {/* Status Pills Mock */}
            <div className="sandbox-pills-mock">
              <span className="session-status-badge status-working">⚡ Trabajando</span>
              <span className="session-status-badge status-completed">✓ Terminada</span>
              <span className="session-status-badge status-waiting">⚠ Pidiendo permiso</span>
            </div>

            {/* Prompt Loader Mock */}
            <div
              className="sandbox-prompt-mock"
              style={{
                backgroundColor: draftBackground.prompt
                  ? draftBackground.prompt.opacity === 0
                    ? 'transparent'
                    : hexToRgba(
                        draftBackground.prompt.color || activePresetMeta.palette.surface,
                        draftBackground.prompt.opacity
                      )
                  : undefined,
              }}
            >
              <span className="sandbox-prompt-label">PROMPT</span>
              <section
                className={sandboxWorkStyles.className}
                style={sandboxWorkStyles.style as React.CSSProperties}
                aria-hidden="true"
              >
                <div className="loader">
                  {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
                    <div key={`sdot-1-${i}`} className="dot" style={{ '--i': i } as React.CSSProperties} />
                  ))}
                </div>
                <h2>Working</h2>
                <div className="loader">
                  {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
                    <div key={`sdot-2-${i}`} className="dot" style={{ '--i': i } as React.CSSProperties} />
                  ))}
                </div>
              </section>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};
