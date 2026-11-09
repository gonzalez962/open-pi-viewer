import { invoke } from '@tauri-apps/api/core';
import { isDesktopTauriEnvironment } from './conversation-export';

export type WorkspaceDownloadSource = { sourcePath: string } | { workingDirectory: string; relativePath: string };
export interface WorkspaceDownloadOptions {
  invokeFn?: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  desktop?: boolean;
  fetchFn?: typeof fetch;
  initiate?: (blob: Blob, filename: string) => void;
}

/** Browser success means initiation only; native success means the copy completed. */
export async function downloadWorkspaceFile(source: WorkspaceDownloadSource, options: WorkspaceDownloadOptions = {}) {
  if (options.desktop ?? isDesktopTauriEnvironment()) {
    const path = await (options.invokeFn ?? invoke)<string | null>('download_workspace_file', { payload: source });
    return path ? { outcome: 'saved' as const, path } : { outcome: 'cancelled' as const };
  }
  const response = await (options.fetchFn ?? fetch)('/api/download', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(source), credentials: 'same-origin',
  });
  if (!response.ok) {
    let message = 'Download failed';
    try { message = (await response.json()).error || message; } catch { /* non-JSON error */ }
    throw new Error(message);
  }
  const disposition = response.headers.get('content-disposition') || '';
  const encodedName = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const filename = encodedName ? decodeURIComponent(encodedName) : 'download';
  const blob = await response.blob();
  if (options.initiate) options.initiate(blob, filename);
  else {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = filename;
    document.body.appendChild(anchor);
    try { anchor.click(); } finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
  return { outcome: 'initiated' as const };
}
