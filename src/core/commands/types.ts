/**
 * Where a slash command originates. Drives the origin badge shown in the command palette
 * (Issue #9): 'gentle-ai' groups the SDD / Gentle AI workflow commands, 'gentle-shell'
 * groups Gentle Shell's client-local helpers, 'pi-core' groups Pi's own built-ins, and
 * 'custom' marks commands the user registered in Settings (always forwarded to Pi).
 */
export type CommandOrigin = 'gentle-ai' | 'gentle-shell' | 'pi-core' | 'custom';

/**
 * Where a command actually executes. 'client' commands run entirely inside the GUI
 * (no round-trip to Pi); 'agent' commands are forwarded to Pi unchanged, exactly as the
 * user typed them.
 */
export type CommandExecution = 'client' | 'agent';

/** Bilingual command description shown in the palette. */
export interface CommandDescription {
  es: string;
  en: string;
}

/** A single slash command entry in the registry. */
export interface CommandSpec {
  /** Stable identifier, independent of display name (e.g. 'clear'). */
  id: string;
  /** Canonical display/typed name, always including the leading '/' (e.g. '/clear'). */
  name: string;
  /** Alternate typed forms, each including the leading '/' (e.g. ['/reset']). */
  aliases?: string[];
  description: CommandDescription;
  origin: CommandOrigin;
  execution: CommandExecution;
  /** Optional hint for expected arguments, shown next to the name (e.g. '[all]'). */
  argumentHint?: string;
}

/** Result of parsing a prompt draft that starts with a slash command. */
export interface ParsedCommandInput {
  /** The leading command token as typed, including its leading '/' (e.g. '/clear'). */
  command: string;
  /** Everything after the command token and its separating whitespace, trimmed. */
  args: string;
}
