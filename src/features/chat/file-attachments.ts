import type { ModelInfo } from '@core/types/models';
import { modelSupportsInputModality } from '@core/prompt-controls-utils';
import type { AttachedFile } from './types';
import { getSafePreviewImageSrc } from '@core/protocol';
import { classifyWorkspaceFile, MAX_TEXT_FILE_BYTES } from '@core/workspace/file-kind';

export function getAttachmentPreviewText(file: AttachedFile): string | null {
  if (file.type !== 'text' && file.type !== 'file') return null;
  if (file.size > MAX_TEXT_FILE_BYTES || classifyWorkspaceFile(file.name).kind !== 'text') return null;
  if (file.previewText !== undefined) return file.previewText;
  // Legacy text drafts have no original bytes; validate their stored content conservatively.
  if (file.type !== 'text' || file.content === undefined || file.content.includes('\ufffd')) return null;
  const bytes = new TextEncoder().encode(file.content);
  return bytes.length <= MAX_TEXT_FILE_BYTES && classifyWorkspaceFile(file.name, bytes).kind === 'text' ? file.content : null;
}

export function getAttachmentPreviewSrc(file: AttachedFile): string | null {
  if (file.type === 'image') return getSafePreviewImageSrc(file);
  if (file.type !== 'audio' && file.type !== 'video') return null;
  const mime = file.mimeType.trim().toLowerCase().split(';')[0];
  if (!new RegExp(`^${file.type}/[a-z0-9.+_-]+$`).test(mime) || !file.data) return null;
  const data = file.data.trim().replace(/\s+/g, '');
  if (!/^[a-z0-9+/]+={0,2}$/i.test(data)) return null;
  return `data:${mime};base64,${data}`;
}

export function getTransferFiles(transfer: Pick<DataTransfer, 'files' | 'items'>): File[] {
  if (transfer.files.length) return Array.from(transfer.files);
  return Array.from(transfer.items).filter(item => item.kind === 'file')
    .map(item => item.getAsFile()).filter((file): file is File => file !== null);
}

function mediaType(file: File): 'image' | 'video' | 'audio' | null {
  if (file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg)$/i.test(file.name)) return 'image';
  if (file.type.startsWith('video/') || /\.(mp4|webm|mov|mkv|avi)$/i.test(file.name)) return 'video';
  if (file.type.startsWith('audio/') || /\.(mp3|wav|ogg|aac|m4a|flac)$/i.test(file.name)) return 'audio';
  return null;
}

function dataUrl(file: File): Promise<string> {
  // FileReader is available in browsers; arrayBuffer also makes processing testable in Node.
  return file.arrayBuffer().then(buffer => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return `data:${file.type || 'application/octet-stream'};base64,${btoa(binary)}`;
  });
}

export async function prepareAttachments(files: File[], model: ModelInfo | null) {
  const accepted: AttachedFile[] = [];
  const rejected: string[] = [];
  const failed: string[] = [];
  const supports = (modality: string) => modelSupportsInputModality(model, modality);
  for (const file of files) {
    const media = mediaType(file);
    if (!model || (media ? !supports(media) : !supports('text') && !supports('file'))) {
      rejected.push(file.name);
      continue;
    }
    try {
      const base = { id: crypto.randomUUID(), name: file.name, size: file.size };
      if (media) {
        const url = await dataUrl(file);
        const fallback = { image: 'image/png', video: 'video/mp4', audio: 'audio/mpeg' }[media];
        accepted.push({ ...base, type: media, mimeType: file.type || fallback, data: url.split(',')[1], ...(media !== 'audio' ? { previewUrl: url } : {}) });
      } else {
        const text = await file.text();
        let previewText: string | null = null;
        if (file.size <= MAX_TEXT_FILE_BYTES && classifyWorkspaceFile(file.name).kind === 'text') {
          try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            if (classifyWorkspaceFile(file.name, bytes).kind === 'text') previewText = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
          } catch { /* Preview failures must not alter attachment ingestion. */ }
        }
        const binary = /[\x00-\x08\x0E-\x1F\uFFFD]/.test(text) || (file.type && !file.type.startsWith('text/') && !/\.(ts|tsx|js|jsx|py|rs|go|json|md|txt|html|css|yaml|yml|toml)$/i.test(file.name) && !/json|xml|javascript/.test(file.type));
        if (binary) {
          if (!supports('file')) { rejected.push(file.name); continue; }
          accepted.push({ ...base, type: 'file', mimeType: file.type || 'application/octet-stream', data: (await dataUrl(file)).split(',')[1], previewText });
        } else accepted.push({ ...base, type: 'text', mimeType: file.type || 'text/plain', content: text, previewText });
      }
    } catch { failed.push(file.name); }
  }
  return { files: accepted, rejected, failed };
}
