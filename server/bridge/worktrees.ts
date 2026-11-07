import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export interface ProjectWorktree {
  path: string;
  branch: string;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (result.error) throw new Error(`Git failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error((result.stderr || 'Git command failed').trim());
  return result.stdout;
}

function projectDirectory(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error('A Git repository path is required');
  }
  const cwd = path.resolve(value);
  try {
    git(cwd, ['rev-parse', '--show-toplevel']);
  } catch (error) {
    throw new Error(`Cannot access Git repository: ${error instanceof Error ? error.message : String(error)}`);
  }
  return cwd;
}

export function listProjectWorktrees(payload: { projectPath: string }): ProjectWorktree[] {
  const cwd = projectDirectory(payload?.projectPath);
  const records = git(cwd, ['worktree', 'list', '--porcelain', '-z']).split('\0');
  const worktrees: ProjectWorktree[] = [];
  let current: ProjectWorktree | undefined;
  for (const record of records) {
    if (record.startsWith('worktree ')) {
      current = { path: record.slice(9), branch: '' };
      worktrees.push(current);
    } else if (current && record.startsWith('branch refs/heads/')) {
      current.branch = record.slice('branch refs/heads/'.length);
    }
  }
  return worktrees;
}

export function createProjectWorktree(payload: { projectPath: string; branch: string; destinationPath?: string }): ProjectWorktree {
  const cwd = projectDirectory(payload?.projectPath);
  const branch = payload?.branch;
  if (typeof branch !== 'string' || !branch || branch.startsWith('-') || branch.includes('\0')) {
    throw new Error('Invalid branch name');
  }
  try {
    git(cwd, ['check-ref-format', '--branch', branch]);
  } catch {
    throw new Error('Invalid branch name');
  }
  // check-ref-format --branch accepts shorthand such as @{-1}; require a literal ref name.
  if (branch.startsWith('@{') || branch.includes('@{')) throw new Error('Invalid branch name');

  const destination = payload?.destinationPath;
  if (destination !== undefined && (typeof destination !== 'string' || destination.includes('\0'))) {
    throw new Error('Invalid destination path');
  }
  let target: string;
  if (destination?.trim()) {
    target = path.resolve(destination);
  } else {
    const label = branch.replace(/[\\/:*?"<>|\x00-\x1f]/g, '-');
    if (!label || /^[. ]+$/.test(label) || /[. ]$/.test(label) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(label)) {
      throw new Error('Reserved or unusable destination label');
    }
    const primary = listProjectWorktrees({ projectPath: cwd })[0];
    if (!primary) throw new Error('Primary worktree is unavailable');
    target = path.join(primary.path, label);
  }
  try {
    fs.lstatSync(target);
    throw new Error('Destination already exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    if (!fs.statSync(path.dirname(target)).isDirectory()) throw new Error('Destination parent is not a directory');
  } catch (error) {
    throw new Error(`Destination parent directory is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const existing = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  if (existing.error) throw new Error(`Git failed: ${existing.error.message}`);
  if (existing.status === 0) throw new Error('Branch already exists');
  if (existing.status !== 1) throw new Error((existing.stderr || 'Unable to check branch').trim());
  git(cwd, ['worktree', 'add', '-b', branch, '--', target, 'HEAD']);
  return { path: target, branch };
}
