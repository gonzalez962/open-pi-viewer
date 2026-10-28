import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { validateKanbanBoard, type KanbanBoard } from '../../src/core/types/kanban';

const MAX_BYTES = 24 * 1024 * 1024;

function projectRoot(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) {
    throw new Error('Invalid workingDirectory: an absolute project directory is required');
  }
  const root = fs.realpathSync(value);
  if (!fs.statSync(root).isDirectory()) throw new Error('Invalid workingDirectory: not a directory');
  return root;
}

/** Reject links, including dangling links, rather than following project metadata elsewhere. */
function safePath(target: string, directory = false): boolean {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  if (stat.isSymbolicLink()) throw new Error('Kanban storage symlink is not allowed (project containment)');
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error('Invalid Kanban storage path');
  return true;
}

function readBoard(root: string): KanbanBoard {
  if (!safePath(path.join(root, '.pi'), true)) return { cards: [] };
  const file = path.join(root, '.pi', 'kanban.json');
  if (!safePath(file)) return { cards: [] };
  if (fs.statSync(file).size > MAX_BYTES) throw new Error('Invalid Kanban JSON: file too large');
  try { return validateKanbanBoard(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch (error) { throw new Error(`Invalid Kanban JSON: ${String(error)}`); }
}

function atomicWrite(file: string, contents: string): void {
  const temp = `${file}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(temp, contents, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function ignoreContents(root: string): string | null {
  const file = path.join(root, '.gitignore');
  const exists = safePath(file);
  const previous = exists ? fs.readFileSync(file, 'utf8') : '';
  // An already ignored board does not need a new tracked ignore-file change.
  try {
    execFileSync('git', ['-C', root, 'check-ignore', '-q', '--', '.pi/kanban.json'], { stdio: 'ignore' });
    return null;
  } catch (error) {
    const failure = error as { status?: number; code?: string };
    const noGitRepository = failure.status === 128 || failure.code === 'ENOENT';
    if (noGitRepository && previous.split(/\r?\n/).includes('/.pi/kanban.json')) return null;
  }
  const eol = previous.includes('\r\n') ? '\r\n' : '\n';
  return previous + (previous && !previous.endsWith('\n') ? eol : '') + '/.pi/kanban.json' + eol;
}

export function handleGetProjectKanban(args: any = {}): KanbanBoard {
  return readBoard(projectRoot(args.payload?.workingDirectory));
}

/** Synchronous read/validate/write keeps one web process from interleaving saves. */
export function handleSaveProjectKanban(args: any = {}): KanbanBoard {
  const board = validateKanbanBoard(args.payload?.board);
  const root = projectRoot(args.payload?.workingDirectory);
  readBoard(root); // Never silently replace malformed stored data.
  const ignore = ignoreContents(root); // Check every target before creating anything.
  const directory = path.join(root, '.pi');
  if (!safePath(directory, true)) fs.mkdirSync(directory);
  if (ignore !== null) atomicWrite(path.join(root, '.gitignore'), ignore);
  atomicWrite(path.join(directory, 'kanban.json'), JSON.stringify(board, null, 2) + '\n');
  return board;
}
