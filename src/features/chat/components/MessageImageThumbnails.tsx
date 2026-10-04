import React from 'react';
import type { ImageContent } from '@core/types/messages';
import type { TranslationKey } from '@shared/i18n';
import { getSafePreviewImageSrc } from '@core/protocol';

export interface MessageImageThumbnailsProps {
  images?: ImageContent[];
  t?: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

export const getImageSrc = getSafePreviewImageSrc;

export const MessageImageThumbnails: React.FC<MessageImageThumbnailsProps> = ({
  images,
  t,
}) => {
  if (!images || images.length === 0) {
    return null;
  }

  const validPreviews = images
    .map((img, index) => {
      const src = getSafePreviewImageSrc(img);
      return src ? { src, index } : null;
    })
    .filter((item): item is { src: string; index: number } => item !== null);

  if (validPreviews.length === 0) {
    return null;
  }

  const groupLabel = t ? t('message.attached_images') : 'Attached images';

  return (
    <div
      className="message-image-thumbnails"
      role="group"
      aria-label={groupLabel}
    >
      {validPreviews.map(({ src, index }) => {
        const itemAlt = t
          ? t('message.attached_image', { index: index + 1 })
          : `Attached image ${index + 1}`;
        return (
          <div key={index} className="message-image-thumbnail-item">
            <img
              src={src}
              alt={itemAlt}
              className="message-image-thumbnail"
              loading="lazy"
            />
          </div>
        );
      })}
    </div>
  );
};
