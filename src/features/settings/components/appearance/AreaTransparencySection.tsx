import React, { useState } from 'react';
import type { TranslationKey } from '@shared/i18n';
import type { CustomBackgroundPreferences } from '@infra/preferences';
import type { ThemePresetPalette } from './presetData';
import { LOADER_PALETTE_SWATCHES } from './presetData';

export type BackgroundAreaKey = 'canvas' | 'sidebar' | 'chat' | 'prompt' | 'cards';

export interface AreaTransparencySectionProps {
  backgroundConfig?: CustomBackgroundPreferences;
  activePresetPalette: ThemePresetPalette;
  onUpdateAreaOpacity: (area: BackgroundAreaKey, opacity: number) => void;
  onUpdateAreaColor: (area: BackgroundAreaKey, color: string) => void;
  onResetArea: (area: BackgroundAreaKey) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  idPrefix?: string;
}

const AREAS: readonly { key: BackgroundAreaKey; icon: string; labelKey: TranslationKey }[] = [
  { key: 'canvas', icon: '🖥️ ', labelKey: 'theme.area_canvas' },
  { key: 'sidebar', icon: '📁 ', labelKey: 'theme.area_sidebar' },
  { key: 'chat', icon: '💬 ', labelKey: 'theme.area_chat' },
  { key: 'prompt', icon: '⌨️ ', labelKey: 'theme.area_prompt' },
  { key: 'cards', icon: '🗂️ ', labelKey: 'theme.area_cards' },
] as const;

export const AreaTransparencySection: React.FC<AreaTransparencySectionProps> = ({
  backgroundConfig = {},
  activePresetPalette,
  onUpdateAreaOpacity,
  onUpdateAreaColor,
  onResetArea,
  t,
  idPrefix = 'theme-customizer',
}) => {
  const [activeArea, setActiveArea] = useState<BackgroundAreaKey>('canvas');

  const currentArea = backgroundConfig[activeArea] || {
    color:
      activeArea === 'canvas' || activeArea === 'chat'
        ? activePresetPalette.bg
        : activePresetPalette.surface,
    opacity: 1,
  };

  const areaColorPickerId = `${idPrefix}-area-color-picker`;
  const areaOpacitySliderId = `${idPrefix}-area-opacity-slider`;

  return (
    <section className="theme-custom-bg-section">
      <div className="section-title-wrap">
        <h3 className="theme-section-title">{t('theme.background_heading')}</h3>
        <p className="theme-section-subtitle">{t('theme.background_subheading')}</p>
      </div>

      <div className="area-selector-pills" role="tablist" aria-label={t('theme.background_heading')}>
        {AREAS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={activeArea === item.key}
            className={`area-selector-btn ${activeArea === item.key ? 'is-active' : ''}`}
            onClick={() => setActiveArea(item.key)}
          >
            <span>
              {item.icon}
              {t(item.labelKey)}
            </span>
          </button>
        ))}
      </div>

      <div className="bg-controls-grid">
        {/* Opacity slider */}
        <div className="bg-control-row">
          <label htmlFor={areaOpacitySliderId} className="bg-control-label">
            {t('theme.area_opacity')}:
          </label>
          <div className="bg-slider-wrap">
            <input
              id={areaOpacitySliderId}
              type="range"
              min="0"
              max="1"
              step="0.05"
              className="bg-range-input"
              value={currentArea.opacity}
              onChange={(e) => onUpdateAreaOpacity(activeArea, parseFloat(e.target.value))}
            />
            <span className="bg-slider-value">
              {Math.round(currentArea.opacity * 100)}%
            </span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => onUpdateAreaOpacity(activeArea, 0)}
            >
              0% ({t('theme.area_make_transparent')})
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => onUpdateAreaOpacity(activeArea, 1)}
            >
              100%
            </button>
          </div>
        </div>

        {/* Color picker */}
        <div className="bg-control-row">
          <label htmlFor={areaColorPickerId} className="bg-control-label">
            {t('theme.area_color')}:
          </label>
          <div className="loader-swatches-wrap">
            {LOADER_PALETTE_SWATCHES.map((swatch) => (
              <button
                key={`bg-color-${swatch.hex}`}
                type="button"
                className={`loader-swatch-btn ${currentArea.color === swatch.hex ? 'is-active' : ''}`}
                style={{ backgroundColor: swatch.hex }}
                onClick={() => onUpdateAreaColor(activeArea, swatch.hex)}
                title={swatch.name}
                aria-label={swatch.name}
              />
            ))}
            <div className="custom-hex-picker-wrap">
              <input
                type="color"
                id={areaColorPickerId}
                className="input-color-picker"
                value={currentArea.color || activePresetPalette.bg}
                onChange={(e) => onUpdateAreaColor(activeArea, e.target.value)}
                title={t('theme.custom_hex')}
                aria-label={t('theme.custom_hex')}
              />
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => onResetArea(activeArea)}
              style={{ marginLeft: 8 }}
            >
              ↺ {t('theme.area_reset')}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
};
