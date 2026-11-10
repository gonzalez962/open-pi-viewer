import { useState } from 'react';
import type { TranslationKey } from '@shared/i18n';
import type { AttachedFile } from '../types';
import { getAttachmentPreviewSrc, getAttachmentPreviewText } from '../file-attachments';
import { AttachmentPreviewModal } from './AttachmentPreviewModal';

export function PendingAttachments({ files, onRemove, t }: { files: AttachedFile[]; onRemove: (id: string) => void; t: (key: TranslationKey) => string; draftKey: string }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const mediaFiles = files.filter(file => file.type === 'image' || file.type === 'video' || file.type === 'audio' || getAttachmentPreviewText(file) !== null);
  const index = mediaFiles.findIndex(file => file.id === selectedId);
  const selected = mediaFiles[index];
  return <>
    {files.length > 0 && <div className="prompt-attachments-list">{files.map(file => {
      const media = mediaFiles.includes(file);
      const src = file.type === 'image' ? getAttachmentPreviewSrc(file) : null;
      const label = <>{src && <img src={src} alt="" className="attachment-thumb" />}<span className="attachment-name" title={file.name}>{file.name}</span></>;
      return <div key={file.id} className="prompt-attachment-chip">
        {media ? <button type="button" className="attachment-preview-trigger" onClick={() => setSelectedId(file.id)}>{label}</button> : label}
        <button type="button" className="btn-remove-attachment" onClick={() => { if (selectedId === file.id) setSelectedId(null); onRemove(file.id); }} title={t('prompt_controls.remove_attachment')} aria-label={`${t('prompt_controls.remove_attachment')}: ${file.name}`}>✕</button>
      </div>;
    })}</div>}
    {selected && <AttachmentPreviewModal file={selected} index={index} count={mediaFiles.length} onNavigate={direction => { const next = mediaFiles[index + direction]; if (next) setSelectedId(next.id); }} onClose={() => setSelectedId(null)} t={t} />}
  </>;
}
