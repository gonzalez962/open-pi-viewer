import type { WorkspaceDownloadSource } from '@infra/workspace-download';

// This is routing, not authorization: the server checks filesystem containment.
export function fileReferenceDownloadSource(sourcePath: string, workingDirectory: string | undefined, desktop: boolean): WorkspaceDownloadSource {
  const fallback = { sourcePath };
  if (desktop || !workingDirectory) return fallback;
  const parse = (value: string) => {
    const windows = /^[a-zA-Z]:[\\/]/.test(value);
    if (!windows && (!value.startsWith('/') || value.startsWith('//') || value.includes('\\'))) return null;
    const normalized = windows ? value.replace(/\\/g, '/') : value;
    const parts = normalized.split('/');
    if (parts.some((part, i) => part === '.' || part === '..' || (part === '' && i !== 0 && i !== parts.length - 1))) return null;
    if (parts[parts.length - 1] === '') parts.pop();
    return { windows, parts };
  };
  const root = parse(workingDirectory), file = parse(sourcePath);
  if (!root || !file || root.windows !== file.windows || file.parts.length <= root.parts.length) return fallback;
  if (!root.parts.every((part, i) => root.windows ? part.toLowerCase() === file.parts[i].toLowerCase() : part === file.parts[i])) return fallback;
  return { workingDirectory, relativePath: file.parts.slice(root.parts.length).join('/') };
}
