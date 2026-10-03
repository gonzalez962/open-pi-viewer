import React from 'react';
import type { TranslationKey } from '@shared/i18n';

export interface WallpaperPlaceholderProps {
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

export const WallpaperPlaceholder: React.FC<WallpaperPlaceholderProps> = ({ t }) => {
  return (
    <section className="theme-wallpaper-disabled" aria-label={t('theme.bg_image_heading')}>
      <div className="wallpaper-disabled-header">
        <h3 className="theme-section-title" style={{ margin: 0 }}>
          🖼️ {t('theme.bg_image_heading')}
        </h3>
        <span className="wallpaper-disabled-badge">
          {t('theme.bg_image_disabled_badge')}
        </span>
      </div>
      <p className="theme-section-subtitle">
        {t('theme.bg_image_subheading')}
      </p>
      <p className="wallpaper-disabled-notice">
        ℹ️ {t('theme.bg_image_t5_notice')}
      </p>
    </section>
  );
};
