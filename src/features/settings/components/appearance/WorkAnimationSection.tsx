import React, { useMemo } from 'react';
import type { TranslationKey } from '@shared/i18n';
import {
  computeWorkAnimationStyles,
  DEFAULT_WORK_ANIMATION_PREFERENCES,
  type WorkAnimationPreferences,
} from '@infra/preferences';
import { LOADER_PALETTE_SWATCHES } from './presetData';

export interface WorkAnimationSectionProps {
  animationConfig?: WorkAnimationPreferences;
  onChangeAnimation: (config: WorkAnimationPreferences) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  idPrefix?: string;
}

export const WorkAnimationSection: React.FC<WorkAnimationSectionProps> = ({
  animationConfig,
  onChangeAnimation,
  t,
  idPrefix = 'theme-customizer',
}) => {
  const current = animationConfig ?? DEFAULT_WORK_ANIMATION_PREFERENCES;
  const c1PickerId = `${idPrefix}-loader-color1-picker`;
  const c2PickerId = `${idPrefix}-loader-color2-picker`;

  const previewStyles = useMemo(
    () => computeWorkAnimationStyles(current),
    [current]
  );

  return (
    <section className="theme-work-animation-section">
      <div className="section-title-wrap">
        <h3 className="theme-section-title">{t('theme.loader_heading')}</h3>
        <p className="theme-section-subtitle">{t('theme.loader_subheading')}</p>
      </div>

      <div
        className="loader-mode-pills"
        role="radiogroup"
        aria-label={t('theme.loader_mode_label')}
      >
        <button
          type="button"
          role="radio"
          aria-checked={current.mode === 'multicolor'}
          className={`loader-mode-btn ${current.mode === 'multicolor' ? 'is-active' : ''}`}
          onClick={() => onChangeAnimation({ ...current, mode: 'multicolor' })}
        >
          <span>🌈 {t('theme.loader_mode_multicolor')}</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={current.mode === 'single'}
          className={`loader-mode-btn ${current.mode === 'single' ? 'is-active' : ''}`}
          onClick={() => onChangeAnimation({ ...current, mode: 'single' })}
        >
          <span>● {t('theme.loader_mode_single')}</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={current.mode === 'dual'}
          className={`loader-mode-btn ${current.mode === 'dual' ? 'is-active' : ''}`}
          onClick={() => onChangeAnimation({ ...current, mode: 'dual' })}
        >
          <span>◐ {t('theme.loader_mode_dual')}</span>
        </button>
      </div>

      {current.mode !== 'multicolor' && (
        <div className="loader-color-pickers">
          {/* Color 1 */}
          <div className="loader-color-row">
            <label htmlFor={c1PickerId} className="loader-color-label">
              {current.mode === 'dual'
                ? t('theme.loader_color1_label')
                : t('theme.loader_color_palette')}
            </label>
            <div className="loader-swatches-wrap">
              {LOADER_PALETTE_SWATCHES.map((swatch) => (
                <button
                  key={`c1-${swatch.hex}`}
                  type="button"
                  className={`loader-swatch-btn ${current.color1 === swatch.hex ? 'is-active' : ''}`}
                  style={{ backgroundColor: swatch.hex }}
                  onClick={() => onChangeAnimation({ ...current, color1: swatch.hex })}
                  title={swatch.name}
                  aria-label={swatch.name}
                />
              ))}
              <div className="custom-hex-picker-wrap">
                <input
                  type="color"
                  id={c1PickerId}
                  className="input-color-picker"
                  value={current.color1}
                  onChange={(e) => onChangeAnimation({ ...current, color1: e.target.value })}
                  title={t('theme.custom_hex')}
                  aria-label={t('theme.custom_hex')}
                />
              </div>
            </div>
          </div>

          {/* Color 2 (Dual only) */}
          {current.mode === 'dual' && (
            <div className="loader-color-row">
              <label htmlFor={c2PickerId} className="loader-color-label">
                {t('theme.loader_color2_label')}
              </label>
              <div className="loader-swatches-wrap">
                {LOADER_PALETTE_SWATCHES.map((swatch) => (
                  <button
                    key={`c2-${swatch.hex}`}
                    type="button"
                    className={`loader-swatch-btn ${current.color2 === swatch.hex ? 'is-active' : ''}`}
                    style={{ backgroundColor: swatch.hex }}
                    onClick={() => onChangeAnimation({ ...current, color2: swatch.hex })}
                    title={swatch.name}
                    aria-label={swatch.name}
                  />
                ))}
                <div className="custom-hex-picker-wrap">
                  <input
                    type="color"
                    id={c2PickerId}
                    className="input-color-picker"
                    value={current.color2}
                    onChange={(e) => onChangeAnimation({ ...current, color2: e.target.value })}
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
          className={previewStyles.className}
          style={previewStyles.style as React.CSSProperties}
          aria-hidden="true"
        >
          <div className="loader">
            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
              <div
                key={`pdot-1-${i}`}
                className="dot"
                style={{ '--i': i } as React.CSSProperties}
              />
            ))}
          </div>
          <h2>Working</h2>
          <div className="loader">
            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
              <div
                key={`pdot-2-${i}`}
                className="dot"
                style={{ '--i': i } as React.CSSProperties}
              />
            ))}
          </div>
        </section>
        <span className="loader-preview-caption">
          {current.mode === 'multicolor'
            ? t('theme.loader_mode_multicolor')
            : current.mode === 'dual'
              ? `${current.color1} ➔ ${current.color2}`
              : current.color1}
        </span>
      </div>
    </section>
  );
};
