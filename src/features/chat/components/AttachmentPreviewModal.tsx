import { useEffect, useRef, useState } from 'react';
import type { TranslationKey } from '@shared/i18n';
import type { AttachedFile } from '../types';
import { getAttachmentPreviewSrc, getAttachmentPreviewText } from '../file-attachments';

function PreviewMedia({ file, t }: { file: AttachedFile; t: (key: TranslationKey) => string }) {
  const [error, setError] = useState(false);
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement>(null);
  const src = getAttachmentPreviewSrc(file);
  useEffect(() => {
    const media = mediaRef.current;
    return () => { media?.pause(); };
  }, []);
  return error || !src ? <p role="alert">{t('file_viewer.media_load_error')}</p> : file.type === 'image' ? <img src={src} alt={file.name} className="file-viewer-media-image" onError={() => setError(true)} /> : file.type === 'video' ? <video ref={mediaRef as React.RefObject<HTMLVideoElement>} src={src} controls preload="metadata" className="file-viewer-media-video" onError={() => setError(true)} /> : <audio ref={mediaRef as React.RefObject<HTMLAudioElement>} src={src} controls preload="metadata" onError={() => setError(true)} />;
}

export function AttachmentPreviewModal({ file, onClose, t, index = 0, count = 1, onNavigate = () => {} }: { file: AttachedFile; onClose: () => void; t: (key: TranslationKey) => string; index?: number; count?: number; onNavigate?: (direction: -1 | 1) => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const callbacks = useRef({ onClose, onNavigate, index, count });
  callbacks.current = { onClose, onNavigate, index, count };
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        callbacks.current.onClose();
        return;
      }
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.composedPath().some(target => target instanceof HTMLMediaElement)) return;
      const direction = event.key === 'ArrowLeft' ? -1 : 1;
      const { index, count, onNavigate } = callbacks.current;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (index + direction >= 0 && index + direction < count) onNavigate(direction);
    };
    window.addEventListener('keydown', keydown, true);
    return () => { window.removeEventListener('keydown', keydown, true); if (previous?.isConnected) previous.focus(); };
  }, []);
  const text = getAttachmentPreviewText(file);
  return <div className="file-viewer-overlay" role="dialog" aria-modal="true" aria-label={file.name}>
    <div className="file-viewer-container attachment-preview-dialog">
      <header className="file-viewer-header"><span className="file-viewer-path">{file.name}</span><button ref={closeRef} type="button" className="btn-file-close" onClick={onClose} aria-label={t('action.close')}>✕</button></header>
      <div className="attachment-preview-navigation">
        <button type="button" aria-label={t('attachment_preview.previous')} disabled={index === 0} onClick={() => onNavigate(-1)}>←</button>
        <span aria-live="polite">{index + 1} / {count}</span>
        <button type="button" aria-label={t('attachment_preview.next')} disabled={index === count - 1} onClick={() => onNavigate(1)}>→</button>
      </div>
      {text !== null ? <div className="file-viewer-body"><div className="file-viewer-code-container"><div className="file-viewer-line-numbers" aria-hidden="true">{text.split('\n').map((_, idx) => <span key={idx} className="line-number">{idx + 1}</span>)}</div><pre className="file-viewer-code wrapped"><code>{text}</code></pre></div></div> : <div className="file-viewer-body file-viewer-media-container"><PreviewMedia key={file.id} file={file} t={t} /></div>}
    </div>
  </div>;
}
