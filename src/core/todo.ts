import type { TodoSnapshot, TodoTask } from './types/todo';

/** Reject malformed or unreasonably large optional extension payloads as a whole. */
export function parseTodo(value: unknown): TodoSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.tasks) || raw.tasks.length > 1000 || !Number.isSafeInteger(raw.nextId) || (raw.nextId as number) < 1 ||
      !(raw.updatedTurn == null || (Number.isSafeInteger(raw.updatedTurn) && (raw.updatedTurn as number) >= 0))) return null;
  const tasks: TodoTask[] = [];
  const ids = new Set<number>();
  for (const item of raw.tasks) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const task = item as Record<string, unknown>;
    if (!Number.isSafeInteger(task.id) || (task.id as number) < 1 || ids.has(task.id as number) ||
        typeof task.title !== 'string' || !task.title.trim() || task.title.length > 4096 ||
        !['pending', 'in_progress', 'blocked', 'done', 'dropped'].includes(task.status as string) ||
        (task.note !== undefined && (typeof task.note !== 'string' || task.note.length > 4096)) ||
        (task.status === 'blocked' && (typeof task.note !== 'string' || !task.note.trim()))) return null;
    ids.add(task.id as number);
    tasks.push({ id: task.id as number, title: task.title, status: task.status as TodoTask['status'], ...(typeof task.note === 'string' ? { note: task.note } : {}) });
  }
  return { tasks, nextId: raw.nextId as number, updatedTurn: (raw.updatedTurn as number | null | undefined) ?? null };
}

/** Last compatible successful todo result, including an empty snapshot that clears the list. */
export function todoFromHistory(messages: unknown[]): TodoSnapshot | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as any;
    if (!msg || msg.role !== 'toolResult' || msg.toolName !== 'todo' || msg.isError === true || msg.details?.error) continue;
    const parsed = parseTodo(msg.details?.gentleTodo);
    if (parsed) return parsed;
  }
  return null;
}
