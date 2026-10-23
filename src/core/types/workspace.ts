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

export interface CreateWorkspaceDirPayload {
  workingDirectory?: string;
  name: string;
}

export interface DeleteWorkspaceDirPayload {
  workingDirectory: string;
  name: string;
  confirmationName: string;
}

export interface DeleteWorkspaceDirResult {
  success: boolean;
  name: string;
  relativePath: string;
}

export interface WorkspaceGitStatus {
  isRepo: boolean;
  repoName?: string | null;
  branch?: string | null;
  upstreamBranch?: string | null;
  modifiedFiles: string[];
  addedFiles: string[];
  untrackedFiles: string[];
}

export interface WorkspaceBranch {
  name: string;
  isCurrent: boolean;
  upstream?: string | null;
}

export interface WorkspaceBranchList {
  current: string | null;
  defaultBranch?: string | null;
  branches: WorkspaceBranch[];
  allBases: string[];
}

export interface ListWorkspaceBranchesPayload {
  workingDirectory?: string;
}

export interface SwitchWorkspaceBranchPayload {
  workingDirectory?: string;
  branch: string;
}

export interface DeleteWorkspaceBranchPayload {
  workingDirectory?: string;
  branch: string;
}

export interface PublishWorkspaceBranchPayload {
  workingDirectory?: string;
  branch: string;
  remote?: string;
}

export interface CreateWorkspaceBranchPayload {
  workingDirectory?: string;
  name: string;
  baseBranch?: string;
  leaveChangesInBase?: boolean;
}

export interface BranchOperationResult {
  success: boolean;
  branch: string;
  message?: string;
}

export interface WorkspaceFileDiff {
  relativePath: string;
  hasDiff: boolean;
  diff: string;
}

export interface WorkspaceBranchCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
  isUnpushed: boolean;
}

export interface WorkspaceBranchCommitsResult {
  branch: string;
  commits: WorkspaceBranchCommit[];
  hasMore: boolean;
  total?: number;
}

export interface ListWorkspaceBranchCommitsPayload {
  workingDirectory?: string;
  branch: string;
  limit?: number;
  offset?: number;
}

