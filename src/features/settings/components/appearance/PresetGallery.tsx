import React from 'react';
import type { AppTheme } from '@shared/theme';
import type { TranslationKey } from '@shared/i18n';
import { THEME_PRESET_DEFINITIONS } from './presetData';

export interface PresetGalleryProps {
  activeTheme: AppTheme;
  savedTheme: AppTheme;
  onSelectPreset: (theme: AppTheme) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  idPrefix?: string;
}

export const PresetGallery: React.FC<PresetGalleryProps> = ({
  activeTheme,
  savedTheme,
  onSelectPreset,
  t,
}) => {
  return (
    <section className="theme-presets-section">
      <div className="section-title-wrap">
        <h3 className="theme-section-title">{t('theme.presets_title')}</h3>
        <p className="theme-section-subtitle">{t('theme.presets_subtitle')}</p>
      </div>

      <div
        className="theme-presets-grid"
        role="radiogroup"
        aria-label={t('theme.presets_title')}
      >
        {THEME_PRESET_DEFINITIONS.map((preset) => {
          const isSelected = activeTheme === preset.id;
          const isSaved = savedTheme === preset.id;
          const presetName = t(preset.nameKey);

          return (
            <div
              key={preset.id}
              role="radio"
              aria-checked={isSelected}
              tabIndex={0}
              className={`theme-card ${isSelected ? 'is-selected' : ''}`}
              onClick={() => onSelectPreset(preset.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelectPreset(preset.id);
                }
              }}
              aria-label={presetName}
            >
              <div className="theme-card-top">
                <div className="theme-card-badge-wrap">
                  <span className="theme-preset-tag">{t(preset.tagKey)}</span>
                  {isSaved && <span className="theme-active-tag">✓</span>}
                </div>
                <h4 className="theme-card-name">{presetName}</h4>
                <p className="theme-card-desc">{t(preset.descKey)}</p>
              </div>

              <div className="theme-card-swatches">
                <div
                  className="swatch-item"
                  style={{ backgroundColor: preset.palette.bg }}
                  title="Canvas"
                />
                <div
                  className="swatch-item"
                  style={{ backgroundColor: preset.palette.surface }}
                  title="Surface"
                />
                <div
                  className="swatch-item"
                  style={{ backgroundColor: preset.palette.border }}
                  title="Border"
                />
                <div
                  className="swatch-item"
                  style={{ backgroundColor: preset.palette.accent }}
                  title="Accent"
                />
                <div
                  className="swatch-item"
                  style={{ backgroundColor: preset.palette.text }}
                  title="Text"
                />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};
