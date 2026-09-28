import React, { useEffect, useRef } from 'react';
import type { CommandOrigin, CommandSpec } from '@core/commands';
import type { SupportedLocale, TranslationKey } from '@shared/i18n';

export interface CommandPalettePopoverProps {
  commands: CommandSpec[];
  selectedIndex: number;
  onSelect: (command: CommandSpec) => void;
  onHoverIndex: (index: number) => void;
  /** Selects which half of each command's bilingual description to display. */
  language: SupportedLocale;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

const ORIGIN_LABEL_KEYS: Record<CommandOrigin, TranslationKey> = {
  'gentle-ai': 'command_palette.origin_gentle_ai',
  'gentle-shell': 'command_palette.origin_gentle_shell',
  'pi-core': 'command_palette.origin_pi_core',
  custom: 'command_palette.origin_custom',
};

/**
 * Slash command palette (Issue #9): shown above the prompt while the draft is a bare `/`
 * command token being composed. Purely presentational — open/close, filtering, and
 * keyboard navigation state all live in `useCommandPalette`
 * (`src/features/chat/hooks/useCommandPalette.ts`); this component only renders the
 * ranked list, the origin badges, and keeps the selected row scrolled into view.
 */
export const CommandPalettePopover: React.FC<CommandPalettePopoverProps> = ({
  commands,
  selectedIndex,
  onSelect,
  onHoverIndex,
  language,
  t,
}) => {
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    const selected = itemRefs.current[selectedIndex];
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  return (
    <div
      id="command-palette-listbox"
      className="prompt-popover command-palette-popover"
      role="listbox"
      aria-label={t('command_palette.aria_label')}
    >
      <div className="command-palette-list" ref={listRef}>
        {commands.length === 0 ? (
          <div className="command-palette-empty">{t('command_palette.empty')}</div>
        ) : (
          commands.map((command, index) => {
            const isSelected = index === selectedIndex;
            return (
              <button
                key={command.id}
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
                type="button"
                className={`command-palette-item ${isSelected ? 'selected' : ''}`}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => onHoverIndex(index)}
                onClick={() => onSelect(command)}
              >
                <div className="command-palette-item-main">
                  <span className="command-palette-name">
                    {command.name}
                    {command.argumentHint && (
                      <span className="command-palette-argument-hint">
                        {' '}
                        {command.argumentHint}
                      </span>
                    )}
                  </span>
                  <span className="command-palette-description">
                    {command.description[language]}
                  </span>
                </div>
                <span
                  className={`command-palette-origin-badge command-palette-origin-${command.origin}`}
                >
                  {t(ORIGIN_LABEL_KEYS[command.origin])}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
};
