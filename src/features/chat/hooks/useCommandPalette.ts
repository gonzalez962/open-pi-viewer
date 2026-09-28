import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  COMMANDS,
  matchCommands,
  movePaletteSelection,
  shouldShowPaletteQuery,
  type CommandSpec,
} from '@core/commands';

export interface UseCommandPaletteOptions {
  /** The live prompt textarea draft. */
  prompt: string;
  setPrompt: React.Dispatch<React.SetStateAction<string>>;
  /**
   * Catalog to match against: built-ins plus the user's custom commands (see
   * `buildCommandCatalog`). Defaults to the built-in `COMMANDS`.
   */
  commands?: readonly CommandSpec[];
}

export interface UseCommandPaletteResult {
  isOpen: boolean;
  filteredCommands: CommandSpec[];
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
  /** Autocompletes the draft to the selected command's name (`"/<name> "`) and closes it. */
  select: (command: CommandSpec) => void;
  /** Dismisses the palette for the current query without touching the draft text. */
  dismiss: () => void;
  /**
   * Routes a textarea keydown to the palette when it is open. Returns `true` when the key
   * was handled here (caller should `preventDefault` and skip its own handling, e.g. the
   * Enter-to-send binding), `false` otherwise.
   */
  handleKeyDown: (e: { key: string; preventDefault: () => void }) => boolean;
}

/**
 * Command palette state (Issue #9): open/query derivation, filtered/ranked matches, and
 * ↑/↓/Enter/Tab/Escape keyboard navigation. All actual matching/scoring and the pure
 * open/nav decisions live in `@core/commands` (`shouldShowPaletteQuery`,
 * `movePaletteSelection`, `matchCommands`) so that logic is unit-testable without React;
 * this hook only wires it to the live prompt draft and its own selection state.
 */
export function useCommandPalette({
  prompt,
  setPrompt,
  commands = COMMANDS,
}: UseCommandPaletteOptions): UseCommandPaletteResult {
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Tracks the query the user explicitly dismissed with Escape, so the palette stays
  // closed while they keep typing the same command token; typing further (or deleting
  // back to a different token) changes the query and reopens it.
  const [dismissedForQuery, setDismissedForQuery] = useState<string | null>(null);

  const rawOpen = shouldShowPaletteQuery(prompt);
  const query = rawOpen ? prompt.slice(1) : '';
  const isOpen = rawOpen && dismissedForQuery !== query;

  const filteredCommands = useMemo(
    () => (isOpen ? matchCommands(query, commands) : []),
    [isOpen, query, commands]
  );

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, isOpen]);

  const select = useCallback(
    (command: CommandSpec) => {
      setPrompt(`${command.name} `);
    },
    [setPrompt]
  );

  const dismiss = useCallback(() => {
    setDismissedForQuery(query);
  }, [query]);

  const handleKeyDown = useCallback(
    (e: { key: string; preventDefault: () => void }): boolean => {
      if (!isOpen) return false;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => movePaletteSelection(i, 1, filteredCommands.length));
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => movePaletteSelection(i, -1, filteredCommands.length));
        return true;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (filteredCommands.length === 0) return false;
        e.preventDefault();
        select(filteredCommands[selectedIndex] ?? filteredCommands[0]);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        dismiss();
        return true;
      }
      return false;
    },
    [isOpen, filteredCommands, selectedIndex, select, dismiss]
  );

  return {
    isOpen,
    filteredCommands,
    selectedIndex,
    setSelectedIndex,
    select,
    dismiss,
    handleKeyDown,
  };
}
