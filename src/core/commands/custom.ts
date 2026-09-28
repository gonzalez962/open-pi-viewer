import type { CommandSpec } from './types';
import { COMMANDS } from './registry';

/**
 * A slash command registered by the user in Settings (Issue #9 T7), typically one added by
 * a Pi extension or skill the user installed. The GUI does not implement it: it is only
 * listed in the palette / "/help", and submitting it forwards the text verbatim to Pi.
 * `description` is a single user-provided string used for every UI language.
 */
export interface CustomCommand {
  /** Derived from the name (`custom:<name-without-slash, lowercased>`), never user-typed. */
  id: string;
  /** Canonical name, always with the leading '/' (e.g. '/deploy'). */
  name: string;
  description: string;
  /** Alternate names, each with the leading '/'. Omitted when there are none. */
  aliases?: string[];
}

/** Raw form input for adding/editing a custom command; aliases are comma-separated. */
export interface CustomCommandDraft {
  name: string;
  description: string;
  aliases: string;
}

export type CustomCommandField = 'name' | 'description' | 'aliases';
export type CustomCommandErrorCode = 'required' | 'whitespace' | 'too_long' | 'duplicate';

export interface CustomCommandError {
  field: CustomCommandField;
  code: CustomCommandErrorCode;
  /** The offending alias, for alias errors. */
  value?: string;
}

export type CustomCommandValidation =
  | { ok: true; command: CustomCommand }
  | { ok: false; errors: CustomCommandError[] };

export interface CustomCommandValidationContext {
  builtIns: readonly CommandSpec[];
  /** Custom commands already registered. */
  existing: readonly CustomCommand[];
  /** Id of the command being edited, excluded from the duplicate check. */
  editingId?: string;
}

/** Max length of a command name or alias, including the leading '/'. */
export const CUSTOM_COMMAND_NAME_MAX_LENGTH = 64;
export const CUSTOM_COMMAND_DESCRIPTION_MAX_LENGTH = 200;

/**
 * Trims the input and prefixes the leading '/' when the user omitted it, so "deploy" and
 * "/deploy" register the same command. Blank input normalizes to ''.
 */
export function normalizeCommandName(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/** Splits a comma-separated alias field, dropping blanks and normalizing each alias. */
export function parseAliasList(raw: string): string[] {
  return raw
    .split(',')
    .map(normalizeCommandName)
    .filter((alias) => alias.length > 0);
}

function key(name: string): string {
  return name.toLowerCase();
}

function customCommandId(name: string): string {
  return `custom:${key(name.slice(1))}`;
}

function nameError(name: string): CustomCommandErrorCode | null {
  if (name.length <= 1) return 'required';
  if (/\s/.test(name)) return 'whitespace';
  if (name.length > CUSTOM_COMMAND_NAME_MAX_LENGTH) return 'too_long';
  return null;
}

function takenNames(context: CustomCommandValidationContext): Set<string> {
  const taken = new Set<string>();
  for (const c of context.builtIns) {
    taken.add(key(c.name));
    for (const a of c.aliases ?? []) taken.add(key(a));
  }
  for (const c of context.existing) {
    if (c.id === context.editingId) continue;
    taken.add(key(c.name));
    for (const a of c.aliases ?? []) taken.add(key(a));
  }
  return taken;
}

/**
 * Validates already-normalized fields. Names and aliases must be '/' plus at least one
 * non-whitespace character, at most `CUSTOM_COMMAND_NAME_MAX_LENGTH` long, and unique
 * (case-insensitively) across built-in names/aliases, other custom commands, and the
 * command's own name/aliases.
 */
function validateFields(
  name: string,
  rawDescription: string,
  aliases: readonly string[],
  context: CustomCommandValidationContext
): CustomCommandValidation {
  const errors: CustomCommandError[] = [];
  const taken = takenNames(context);

  const nameCode = nameError(name);
  if (nameCode) {
    errors.push({ field: 'name', code: nameCode });
  } else if (taken.has(key(name))) {
    errors.push({ field: 'name', code: 'duplicate' });
  }

  const description = rawDescription.trim();
  if (description.length === 0) {
    errors.push({ field: 'description', code: 'required' });
  } else if (description.length > CUSTOM_COMMAND_DESCRIPTION_MAX_LENGTH) {
    errors.push({ field: 'description', code: 'too_long' });
  }

  const seen = new Set<string>([key(name)]);
  for (const alias of aliases) {
    const aliasCode = nameError(alias);
    if (aliasCode) {
      errors.push({ field: 'aliases', code: aliasCode, value: alias });
    } else if (taken.has(key(alias)) || seen.has(key(alias))) {
      errors.push({ field: 'aliases', code: 'duplicate', value: alias });
    }
    seen.add(key(alias));
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    command: {
      id: customCommandId(name),
      name,
      description,
      ...(aliases.length > 0 ? { aliases: [...aliases] } : {}),
    },
  };
}

/** Validates and normalizes the Settings form input for a custom command. */
export function validateCustomCommandDraft(
  draft: CustomCommandDraft,
  context: CustomCommandValidationContext
): CustomCommandValidation {
  return validateFields(
    normalizeCommandName(draft.name),
    draft.description,
    parseAliasList(draft.aliases),
    context
  );
}

/**
 * Defensive parser for stored custom commands (untrusted data from localStorage). Keeps
 * only well-formed entries that pass the same validation as the Settings form, in order;
 * an entry clashing with a built-in or an earlier entry is dropped. Non-string aliases are
 * ignored. Ids are re-derived from the name rather than trusted.
 */
export function sanitizeCustomCommands(
  input: unknown,
  builtIns: readonly CommandSpec[] = COMMANDS
): CustomCommand[] {
  if (!Array.isArray(input)) return [];

  const accepted: CustomCommand[] = [];
  for (const entry of input) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== 'string' || typeof record.description !== 'string') continue;

    const aliases = Array.isArray(record.aliases)
      ? record.aliases
          .filter((a): a is string => typeof a === 'string')
          .map(normalizeCommandName)
          .filter((a) => a.length > 0)
      : [];

    const result = validateFields(
      normalizeCommandName(record.name),
      record.description,
      aliases,
      { builtIns, existing: accepted }
    );
    if (result.ok) accepted.push(result.command);
  }
  return accepted;
}

/**
 * Maps a custom command to a catalog entry: origin 'custom', always executed by Pi
 * ('agent', forwarded verbatim), same description for every language.
 */
export function customCommandToSpec(command: CustomCommand): CommandSpec {
  return {
    id: command.id,
    name: command.name,
    ...(command.aliases && command.aliases.length > 0 ? { aliases: [...command.aliases] } : {}),
    description: { en: command.description, es: command.description },
    origin: 'custom',
    execution: 'agent',
  };
}

/**
 * Catalog used by the palette, the dispatcher, and "/help": built-ins first (they keep
 * precedence), then the user's custom commands. Custom entries clashing with a built-in
 * name/alias or with an earlier custom entry are dropped.
 */
export function buildCommandCatalog(
  custom: readonly CustomCommand[],
  builtIns: readonly CommandSpec[] = COMMANDS
): CommandSpec[] {
  return [...builtIns, ...sanitizeCustomCommands(custom, builtIns).map(customCommandToSpec)];
}
