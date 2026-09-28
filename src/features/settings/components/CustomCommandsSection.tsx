import React, { useState } from 'react';
import {
  CUSTOM_COMMAND_DESCRIPTION_MAX_LENGTH,
  CUSTOM_COMMAND_NAME_MAX_LENGTH,
  toggleHiddenCommandId,
  validateCustomCommandDraft,
  type CommandSpec,
  type CustomCommand,
  type CustomCommandDraft,
  type CustomCommandError,
  type CustomCommandField,
} from '@core/commands';
import type { SupportedLocale, TranslationKey } from '@shared/i18n';

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

export interface CustomCommandsSectionProps {
  customCommands: readonly CustomCommand[];
  /** Built-in catalog, shown read-only for reference and used for duplicate checks. */
  builtInCommands: readonly CommandSpec[];
  /** Ids of commands hidden from the palette and "/help" (Issue #9 T8). */
  hiddenCommandIds: readonly string[];
  language: SupportedLocale;
  onChange: (commands: CustomCommand[]) => void;
  onHiddenCommandIdsChange: (ids: string[]) => void;
  /** Initial state of both list disclosures. Collapsed (false) by default to save space. */
  defaultExpanded?: boolean;
  t: Translate;
}

const EMPTY_DRAFT: CustomCommandDraft = { name: '', description: '', aliases: '' };

/** Maps a pure validator error to its localized message. */
export function formatCustomCommandError(error: CustomCommandError, t: Translate): string {
  const max =
    error.field === 'description'
      ? CUSTOM_COMMAND_DESCRIPTION_MAX_LENGTH
      : CUSTOM_COMMAND_NAME_MAX_LENGTH;
  const prefix = error.field === 'aliases' ? 'alias' : error.field;
  const key = `settings.commands_error_${prefix}_${error.code}` as TranslationKey;
  return t(key, { max, alias: error.value ?? '' });
}

function errorsFor(errors: readonly CustomCommandError[], field: CustomCommandField) {
  return errors.filter((e) => e.field === field);
}

interface CommandsDisclosureProps {
  title: string;
  count: number;
  isOpen: boolean;
  onToggle: () => void;
  panelId: string;
}

/** Collapsible list header (button + `aria-expanded`) showing the list's item count. */
const CommandsDisclosure: React.FC<CommandsDisclosureProps> = ({
  title,
  count,
  isOpen,
  onToggle,
  panelId,
}) => (
  <button
    type="button"
    className="custom-commands-disclosure"
    onClick={onToggle}
    aria-expanded={isOpen}
    aria-controls={panelId}
  >
    <svg
      className={`custom-commands-chevron${isOpen ? ' custom-commands-chevron-open' : ''}`}
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M6.22 4.47a.75.75 0 0 1 1.06 0l3 3a.75.75 0 0 1 0 1.06l-3 3a.75.75 0 0 1-1.06-1.06L8.69 8 6.22 5.53a.75.75 0 0 1 0-1.06Z" />
    </svg>
    <span className="provider-summary-title">{`${title} (${count})`}</span>
  </button>
);

/**
 * Settings "Commands" section (Issue #9 T7): lets the user register slash commands that a
 * Pi extension or skill added, so they show up in the command palette. The app does not
 * implement them; they are forwarded to Pi verbatim. Validation is the pure
 * `validateCustomCommandDraft` from `@core/commands`.
 *
 * T8: every command (built-in or custom) has a Hide/Show toggle that only affects the
 * palette and "/help" (typing a hidden command still works). Both lists are collapsed by
 * default behind disclosures showing their count; the add/edit form lives inside the
 * "Your commands" disclosure so the collapsed section is just two header rows.
 */
export const CustomCommandsSection: React.FC<CustomCommandsSectionProps> = ({
  customCommands,
  builtInCommands,
  hiddenCommandIds,
  language,
  onChange,
  onHiddenCommandIdsChange,
  defaultExpanded = false,
  t,
}) => {
  const [isCustomOpen, setIsCustomOpen] = useState(defaultExpanded);
  const [isBuiltInOpen, setIsBuiltInOpen] = useState(defaultExpanded);
  const [draft, setDraft] = useState<CustomCommandDraft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [errors, setErrors] = useState<CustomCommandError[]>([]);

  const editing = customCommands.find((c) => c.id === editingId) ?? null;

  const updateDraft = (field: keyof CustomCommandDraft, value: string) => {
    setDraft((prev) => ({ ...prev, [field]: value }));
    if (errors.length > 0) setErrors([]);
  };

  const resetForm = () => {
    setDraft(EMPTY_DRAFT);
    setEditingId(null);
    setErrors([]);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const result = validateCustomCommandDraft(draft, {
      builtIns: builtInCommands,
      existing: customCommands,
      editingId: editing?.id,
    });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    const next = editing
      ? customCommands.map((c) => (c.id === editing.id ? result.command : c))
      : [...customCommands, result.command];
    onChange(next);
    resetForm();
  };

  const handleEdit = (command: CustomCommand) => {
    setEditingId(command.id);
    setDraft({
      name: command.name,
      description: command.description,
      aliases: (command.aliases ?? []).join(', '),
    });
    setErrors([]);
  };

  const handleDelete = (command: CustomCommand) => {
    // The preferences controller prunes the deleted command's hidden id in the same write.
    onChange(customCommands.filter((c) => c.id !== command.id));
    if (editingId === command.id) resetForm();
  };

  const isHidden = (id: string) => hiddenCommandIds.includes(id);

  const itemClassName = (id: string) =>
    isHidden(id) ? 'custom-command-item custom-command-item-hidden' : 'custom-command-item';

  const renderHiddenBadge = (id: string) =>
    isHidden(id) ? (
      <span className="custom-command-hidden-badge">{t('settings.commands_hidden_badge')}</span>
    ) : null;

  const renderVisibilityToggle = (id: string, name: string) => {
    const hidden = isHidden(id);
    return (
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={() => onHiddenCommandIdsChange(toggleHiddenCommandId(hiddenCommandIds, id))}
        aria-label={t(hidden ? 'settings.commands_show_aria' : 'settings.commands_hide_aria', {
          name,
        })}
      >
        {t(hidden ? 'settings.commands_show' : 'settings.commands_hide')}
      </button>
    );
  };

  const renderAliases = (aliases: readonly string[] | undefined) =>
    aliases && aliases.length > 0 ? (
      <span className="custom-command-aliases">
        {t('settings.commands_aliases_display', { aliases: aliases.join(', ') })}
      </span>
    ) : null;

  const renderFieldErrors = (field: CustomCommandField, id: string) => {
    const fieldErrors = errorsFor(errors, field);
    if (fieldErrors.length === 0) return null;
    return (
      <span id={id} className="field-subtext custom-command-error" role="alert">
        {fieldErrors.map((err) => formatCustomCommandError(err, t)).join(' ')}
      </span>
    );
  };

  const nameErrorId = 'custom-command-name-error';
  const descriptionErrorId = 'custom-command-description-error';
  const aliasesErrorId = 'custom-command-aliases-error';
  const hasError = (field: CustomCommandField) => errorsFor(errors, field).length > 0;

  return (
    <section className="settings-card-section" aria-labelledby="settings-commands-heading">
      <div className="settings-section-header">
        <h2 id="settings-commands-heading" className="settings-section-title">
          {t('settings.commands_heading')}
        </h2>
        <span className="prompt-hint">{t('settings.commands_hint')}</span>
        <span className="prompt-hint">{t('settings.commands_visibility_hint')}</span>
      </div>

      <div className="custom-commands-group">
        <CommandsDisclosure
          title={t('settings.commands_custom_title')}
          count={customCommands.length}
          isOpen={isCustomOpen}
          onToggle={() => setIsCustomOpen((prev) => !prev)}
          panelId="custom-commands-panel"
        />
        {isCustomOpen && (
          <div id="custom-commands-panel" className="custom-commands-panel">
            {customCommands.length === 0 ? (
              <span className="prompt-hint">{t('settings.commands_empty')}</span>
            ) : (
              <ul className="custom-commands-list">
                {customCommands.map((command) => (
                  <li key={command.id} className={itemClassName(command.id)}>
                    <div className="custom-command-info">
                      <code className="custom-command-name">{command.name}</code>
                      {renderHiddenBadge(command.id)}
                      <span className="custom-command-description">{command.description}</span>
                      {renderAliases(command.aliases)}
                    </div>
                    <div className="custom-command-actions">
                      {renderVisibilityToggle(command.id, command.name)}
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => handleEdit(command)}
                        aria-label={t('settings.commands_edit_aria', { name: command.name })}
                      >
                        {t('action.edit')}
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => handleDelete(command)}
                        aria-label={t('settings.commands_delete_aria', { name: command.name })}
                      >
                        {t('action.delete')}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <form className="custom-command-form" onSubmit={handleSubmit} noValidate>
              <h3 className="provider-summary-title">
                {editing
                  ? t('settings.commands_form_edit_title', { name: editing.name })
                  : t('settings.commands_form_title')}
              </h3>
              <div className="custom-command-form-grid">
                <div className="field-group">
                  <label htmlFor="custom-command-name-input" className="field-label">
                    {t('settings.commands_name_label')}
                  </label>
                  <input
                    id="custom-command-name-input"
                    type="text"
                    className="field-input"
                    value={draft.name}
                    onChange={(e) => updateDraft('name', e.target.value)}
                    placeholder={t('settings.commands_name_placeholder')}
                    aria-invalid={hasError('name')}
                    aria-describedby={hasError('name') ? nameErrorId : undefined}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <span className="field-subtext">{t('settings.commands_name_hint')}</span>
                  {renderFieldErrors('name', nameErrorId)}
                </div>

                <div className="field-group">
                  <label htmlFor="custom-command-description-input" className="field-label">
                    {t('settings.commands_description_label')}
                  </label>
                  <input
                    id="custom-command-description-input"
                    type="text"
                    className="field-input"
                    value={draft.description}
                    onChange={(e) => updateDraft('description', e.target.value)}
                    placeholder={t('settings.commands_description_placeholder')}
                    aria-invalid={hasError('description')}
                    aria-describedby={hasError('description') ? descriptionErrorId : undefined}
                  />
                  {renderFieldErrors('description', descriptionErrorId)}
                </div>

                <div className="field-group">
                  <label htmlFor="custom-command-aliases-input" className="field-label">
                    {t('settings.commands_aliases_label')}
                  </label>
                  <input
                    id="custom-command-aliases-input"
                    type="text"
                    className="field-input"
                    value={draft.aliases}
                    onChange={(e) => updateDraft('aliases', e.target.value)}
                    placeholder={t('settings.commands_aliases_placeholder')}
                    aria-invalid={hasError('aliases')}
                    aria-describedby={hasError('aliases') ? aliasesErrorId : undefined}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {renderFieldErrors('aliases', aliasesErrorId)}
                </div>
              </div>

              <div className="connection-actions">
                <button type="submit" className="btn btn-primary btn-sm">
                  {editing ? t('settings.commands_save_edit') : t('settings.commands_add')}
                </button>
                {editing && (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={resetForm}>
                    {t('action.cancel')}
                  </button>
                )}
              </div>
            </form>
          </div>
        )}
      </div>

      <div className="custom-commands-group">
        <CommandsDisclosure
          title={t('settings.commands_builtin_title')}
          count={builtInCommands.length}
          isOpen={isBuiltInOpen}
          onToggle={() => setIsBuiltInOpen((prev) => !prev)}
          panelId="builtin-commands-panel"
        />
        {isBuiltInOpen && (
          <ul
            id="builtin-commands-panel"
            className="custom-commands-list custom-commands-builtin-list"
          >
            {builtInCommands.map((command) => (
              <li key={command.id} className={itemClassName(command.id)}>
                <div className="custom-command-info">
                  <code className="custom-command-name">{command.name}</code>
                  {renderHiddenBadge(command.id)}
                  <span className="custom-command-description">
                    {command.description[language]}
                  </span>
                  {renderAliases(command.aliases)}
                </div>
                <div className="custom-command-actions">
                  {renderVisibilityToggle(command.id, command.name)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
};
