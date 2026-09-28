import type { CommandSpec } from './types';
import type { CustomCommand } from './custom';

/**
 * Command visibility (Issue #9 T8). Hiding a command is purely visual: hidden commands are
 * left out of the command palette and the "/help" guide, but dispatch keeps using the full
 * catalog, so typing a hidden command still runs it locally (client built-ins) or forwards
 * it to Pi verbatim (everything else). Nothing is ever removed from Pi.
 */

const CUSTOM_ID_PREFIX = 'custom:';

/** Defensive parse of stored hidden ids: non-array -> [], drops non-strings/blanks, dedupes. */
export function sanitizeHiddenCommandIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  for (const entry of input) {
    if (typeof entry !== 'string' || entry.trim().length === 0) continue;
    seen.add(entry);
  }
  return [...seen];
}

/** The catalog minus hidden commands, preserving catalog order. */
export function filterVisibleCommands(
  catalog: readonly CommandSpec[],
  hiddenIds: readonly string[]
): CommandSpec[] {
  if (hiddenIds.length === 0) return [...catalog];
  const hidden = new Set(hiddenIds);
  return catalog.filter((command) => !hidden.has(command.id));
}

/** Adds `id` when it is not hidden yet, removes it otherwise. */
export function toggleHiddenCommandId(hiddenIds: readonly string[], id: string): string[] {
  return hiddenIds.includes(id)
    ? hiddenIds.filter((hiddenId) => hiddenId !== id)
    : [...hiddenIds, id];
}

/**
 * Drops hidden ids that belong to custom commands no longer registered (e.g. after a delete).
 * Built-in ids are kept untouched.
 */
export function pruneHiddenCommandIds(
  hiddenIds: readonly string[],
  customCommands: readonly CustomCommand[]
): string[] {
  const customIds = new Set(customCommands.map((command) => command.id));
  return hiddenIds.filter((id) => !id.startsWith(CUSTOM_ID_PREFIX) || customIds.has(id));
}
