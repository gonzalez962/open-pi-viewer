export interface WorkspaceEntry {
  name: string;
  relativePath: string;
  isDir: boolean;
  size?: number | null;
  extension?: string | null;
}

export type WorkspaceFileKind = 'text' | 'image' | 'video' | 'binary';

export interface WorkspaceFileContent {
  relativePath: string;
  name: string;
  content: string;
  size: number;
  isBinary: boolean;
  extension?: string | null;
  kind?: WorkspaceFileKind;
  mimeType?: string | null;
  mediaDataUrl?: string | null;
}

export interface ListWorkspaceDirPayload {
  workingDirectory?: string;
  relativePath?: string;
}

export interface ReadWorkspaceFilePayload {
  workingDirectory?: string;
  relativePath: string;
}

export interface WorkspaceGitStatus {
  isRepo: boolean;
  repoName?: string | null;
  branch?: string | null;
  modifiedFiles: string[];
  addedFiles: string[];
  untrackedFiles: string[];
}

export interface WorkspaceFileDiff {
  relativePath: string;
  hasDiff: boolean;
  diff: string;
}
