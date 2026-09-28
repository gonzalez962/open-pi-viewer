import type { CommandSpec, ParsedCommandInput } from './types';
import { COMMANDS } from './registry';

export * from './types';
export { COMMANDS } from './registry';

function stripSlash(value: string): string {
  return value.startsWith('/') ? value.slice(1) : value;
}

/**
 * Parses a prompt draft into a leading command token and its trailing arguments.
 * Returns `null` when the text does not start with `/` (a leading whitespace before the
 * slash disqualifies it too, since it is no longer the first character typed).
 */
export function parseCommandInput(text: string): ParsedCommandInput | null {
  if (typeof text !== 'string' || !text.startsWith('/')) {
    return null;
  }

  let splitIndex = -1;
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) {
      splitIndex = i;
      break;
    }
  }

  if (splitIndex === -1) {
    return { command: text, args: '' };
  }

  return {
    command: text.slice(0, splitIndex),
    args: text.slice(splitIndex + 1).trim(),
  };
}

const SCORE_EXACT_NAME = 100;
const SCORE_PREFIX_NAME = 80;
const SCORE_EXACT_ALIAS = 70;
const SCORE_PREFIX_ALIAS = 60;
const SCORE_SUBSTRING = 40;

/**
 * Scores a single command against a normalized (lowercased, slash-stripped) query.
 * Returns 0 when the command does not match at all.
 */
function scoreCommand(query: string, command: CommandSpec): number {
  const name = stripSlash(command.name).toLowerCase();
  const aliases = (command.aliases ?? []).map((a) => stripSlash(a).toLowerCase());

  if (name === query) return SCORE_EXACT_NAME;
  if (name.startsWith(query)) return SCORE_PREFIX_NAME;
  if (aliases.includes(query)) return SCORE_EXACT_ALIAS;
  if (aliases.some((a) => a.startsWith(query))) return SCORE_PREFIX_ALIAS;

  const haystacks = [
    name,
    ...aliases,
    command.description.en.toLowerCase(),
    command.description.es.toLowerCase(),
  ];
  if (haystacks.some((h) => h.includes(query))) return SCORE_SUBSTRING;

  return 0;
}

/**
 * Filters and ranks `commands` against `query` (with or without a leading '/'). Scoring
 * order: exact name match > name prefix > exact alias match > alias prefix > substring
 * match anywhere in the name, aliases, or bilingual description. Ties preserve the
 * original catalog order (stable sort). An empty query returns the full, unranked list —
 * this is what the palette shows right after the user types a bare '/'.
 */
export function matchCommands(
  query: string,
  commands: readonly CommandSpec[]
): CommandSpec[] {
  const normalized = stripSlash(query.trim().toLowerCase());
  if (normalized.length === 0) {
    return [...commands];
  }

  return commands
    .map((command) => ({ command, score: scoreCommand(normalized, command) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.command);
}

/**
 * Whether the command palette should be shown for the given prompt draft. True only while
 * the draft is still a bare command token being composed: it must start with '/' and
 * contain no whitespace yet. As soon as the user types a space (starting arguments) or the
 * draft stops being a command, the palette closes — this keeps the palette scoped to
 * command discovery/autocompletion rather than staying open while typing arguments.
 */
export function shouldShowPaletteQuery(draft: string): boolean {
  return typeof draft === 'string' && draft.startsWith('/') && !/\s/.test(draft);
}

/**
 * Pure ↑/↓ navigation step for the command palette's selected index. Wraps around both
 * ends of a `length`-sized list; returns 0 for an empty list rather than dividing by zero.
 */
export function movePaletteSelection(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return ((current + delta) % length + length) % length;
}

/** Outcome of resolving a submitted prompt draft against the command catalog. */
export interface CommandDispatchDecision {
  /**
   * 'not-a-command': plain text, forward as an ordinary prompt.
   * 'client': a recognized command whose `execution` is 'client' — run it locally, do not
   * send anything to Pi.
   * 'agent': a recognized command whose `execution` is 'agent', or an unrecognized
   * "/whatever" — forward to Pi unchanged (Pi owns unknown/agent-only commands).
   */
  kind: 'not-a-command' | 'client' | 'agent';
  /** The resolved catalog entry, or `null` for plain text and unrecognized commands. */
  command: CommandSpec | null;
  /** Trailing arguments after the command token, trimmed (empty string when there are none). */
  args: string;
}

/**
 * Resolves a submitted prompt draft (the full, as-typed text) into a dispatch decision:
 * whether it is a command at all, and if so whether it should execute client-side or be
 * forwarded to Pi. Matching is case-insensitive against both canonical names and aliases;
 * an unrecognized "/xxx" command falls back to 'agent' so Pi still receives it unchanged
 * rather than the GUI silently swallowing an unknown command.
 */
export function decideCommandDispatch(
  text: string,
  commands: readonly CommandSpec[] = COMMANDS
): CommandDispatchDecision {
  const parsed = parseCommandInput(text);
  if (!parsed) {
    return { kind: 'not-a-command', command: null, args: '' };
  }

  const token = stripSlash(parsed.command).toLowerCase();
  const command =
    commands.find((c) => stripSlash(c.name).toLowerCase() === token) ??
    commands.find((c) => (c.aliases ?? []).some((a) => stripSlash(a).toLowerCase() === token)) ??
    null;

  if (!command) {
    return { kind: 'agent', command: null, args: parsed.args };
  }

  return { kind: command.execution, command, args: parsed.args };
}
