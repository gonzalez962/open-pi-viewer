import React from 'react';
import type { TranslationKey } from '@shared/i18n';
import {
  ACCENT_SWATCHES,
  TEXT_COLOR_SWATCHES,
  LABEL_COLOR_SWATCHES,
} from './presetData';

export interface ColorOverridesProps {
  accentColor?: string | null;
  textColor?: string | null;
  labelColor?: string | null;
  defaultAccent: string;
  defaultText: string;
  defaultLabel: string;
  onAccentChange: (hex: string | null) => void;
  onTextColorChange: (hex: string | null) => void;
  onLabelColorChange: (hex: string | null) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  idPrefix?: string;
}

export const ColorOverrides: React.FC<ColorOverridesProps> = ({
  accentColor,
  textColor,
  labelColor,
  defaultAccent,
  defaultText,
  defaultLabel,
  onAccentChange,
  onTextColorChange,
  onLabelColorChange,
  t,
  idPrefix = 'theme-customizer',
}) => {
  const accentPickerId = `${idPrefix}-accent-picker`;
  const textPickerId = `${idPrefix}-text-picker`;
  const labelPickerId = `${idPrefix}-label-picker`;

  const activeAccent = accentColor ?? '';
  const activeText = textColor ?? '';
  const activeLabel = labelColor ?? '';

  return (
    <>
      {/* Accent Color Section */}
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
              className={`accent-color-btn ${activeAccent === swatch.hex ? 'is-accent-active' : ''}`}
              style={{ backgroundColor: swatch.hex }}
              onClick={() => onAccentChange(swatch.hex)}
              title={swatch.name}
              aria-label={swatch.name}
            />
          ))}

          <div className="custom-hex-picker-wrap">
            <input
              type="color"
              id={accentPickerId}
              className="input-color-picker"
              value={activeAccent || defaultAccent}
              onChange={(e) => onAccentChange(e.target.value)}
              title={t('theme.custom_hex')}
              aria-label={t('theme.custom_hex')}
            />
            <label htmlFor={accentPickerId} className="custom-hex-label">
              {t('theme.custom_hex')}
            </label>
          </div>

          {activeAccent !== '' && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => onAccentChange(null)}
              style={{ marginLeft: 8 }}
            >
              ↺ {t('theme.color_reset')}
            </button>
          )}
        </div>
      </section>

      {/* Text Color Section */}
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
              className={`accent-color-btn ${activeText === swatch.hex ? 'is-accent-active' : ''}`}
              style={{ backgroundColor: swatch.hex }}
              onClick={() => onTextColorChange(swatch.hex)}
              title={swatch.name}
              aria-label={swatch.name}
            />
          ))}

          <div className="custom-hex-picker-wrap">
            <input
              type="color"
              id={textPickerId}
              className="input-color-picker"
              value={activeText || defaultText}
              onChange={(e) => onTextColorChange(e.target.value)}
              title={t('theme.custom_hex')}
              aria-label={t('theme.custom_hex')}
            />
            <label htmlFor={textPickerId} className="custom-hex-label">
              {t('theme.custom_hex')}
            </label>
          </div>

          {activeText !== '' && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => onTextColorChange(null)}
              style={{ marginLeft: 8 }}
            >
              ↺ {t('theme.color_reset')}
            </button>
          )}
        </div>
      </section>

      {/* Label / Tag Color Section */}
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
              className={`accent-color-btn ${activeLabel === swatch.hex ? 'is-accent-active' : ''}`}
              style={{ backgroundColor: swatch.hex }}
              onClick={() => onLabelColorChange(swatch.hex)}
              title={swatch.name}
              aria-label={swatch.name}
            />
          ))}

          <div className="custom-hex-picker-wrap">
            <input
              type="color"
              id={labelPickerId}
              className="input-color-picker"
              value={activeLabel || defaultLabel}
              onChange={(e) => onLabelColorChange(e.target.value)}
              title={t('theme.custom_hex')}
              aria-label={t('theme.custom_hex')}
            />
            <label htmlFor={labelPickerId} className="custom-hex-label">
              {t('theme.custom_hex')}
            </label>
          </div>

          {activeLabel !== '' && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => onLabelColorChange(null)}
              style={{ marginLeft: 8 }}
            >
              ↺ {t('theme.color_reset')}
            </button>
          )}
        </div>
      </section>
    </>
  );
};
