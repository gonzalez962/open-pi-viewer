import React from 'react';
import type { TranslationKey } from '@shared/i18n';
import type { McpServerScope, SaveMcpServerPayload } from '@core/types/mcp';
import type { UseMcpModalFormResult } from '../hooks/useMcpModalForm';
import { McpFormField } from './McpFormField';
import { McpRadioCards, type McpRadioOption } from './McpRadioCards';
import { McpKeyValueEditor } from './McpKeyValueEditor';

export interface McpModalProps {
  modalForm: UseMcpModalFormResult;
  onSave: (payload: SaveMcpServerPayload) => Promise<boolean>;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  cwd?: string;
}

export const McpModal: React.FC<McpModalProps> = ({
  modalForm,
  onSave,
  t,
  cwd,
}) => {
  if (!modalForm.isModalOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void modalForm.handleSave(onSave, t, cwd);
  };

  const isStdio = modalForm.formData.serverType === 'stdio';

  const scopeOptions: McpRadioOption<McpServerScope>[] = [
    {
      value: 'global',
      title: t('mcp.scope_global'),
      desc: t('mcp.scope_global_desc'),
      disabled: modalForm.isEditing || modalForm.isSaving,
    },
    {
      value: 'project',
      title: t('mcp.scope_project'),
      desc: t('mcp.scope_project_desc'),
      disabled: modalForm.isEditing || modalForm.isSaving,
    },
  ];

  const transportOptions: McpRadioOption<'stdio' | 'sse'>[] = [
    {
      value: 'stdio',
      title: t('mcp.type_stdio'),
    },
    {
      value: 'sse',
      title: t('mcp.type_sse'),
    },
  ];

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-mcp-title"
    >
      <div className="modal-container mcp-modal">
        <header className="modal-header">
          <h2 id="modal-mcp-title" className="modal-title">
            {modalForm.isEditing
              ? t('mcp.modal_edit_title', { name: modalForm.formData.name })
              : t('mcp.modal_add_title')}
          </h2>
          <button
            type="button"
            className="modal-close-btn"
            onClick={modalForm.closeModal}
            title={t('action.cancel')}
          >
            ✕
          </button>
        </header>

        <form onSubmit={handleSubmit} className="modal-form">
          <div className="modal-scrollable-body">
            {modalForm.formError && (
              <div className="validation-error-banner" role="alert">
                <span>{modalForm.formError}</span>
              </div>
            )}

            {/* Section 1: General Information */}
            <fieldset className="form-fieldset">
              <legend className="form-legend">
                {t('mcp.section_general')}
              </legend>

              {/* Row 1: Name and Enabled toggle */}
              <div className="form-row-grid">
                <McpFormField
                  id="mcp-input-name"
                  label={t('mcp.field_name')}
                  required
                  subtext={t('mcp.field_name_hint')}
                >
                  <input
                    id="mcp-input-name"
                    type="text"
                    className="field-input"
                    value={modalForm.formData.name}
                    onChange={(e) =>
                      modalForm.updateFormField('name', e.target.value)
                    }
                    placeholder="my-mcp-server"
                    autoFocus={!modalForm.isEditing}
                    disabled={modalForm.isEditing || modalForm.isSaving}
                    required
                  />
                </McpFormField>

                <McpFormField className="mcp-enabled-field">
                  <span
                    className="field-label mcp-field-label-spacer"
                    aria-hidden="true"
                  >
                    &nbsp;
                  </span>
                  <label
                    className={`mcp-checkbox-card${
                      modalForm.formData.enabled ? ' checked' : ''
                    }${modalForm.isSaving ? ' disabled' : ''}`}
                    htmlFor="mcp-input-enabled"
                  >
                    <input
                      id="mcp-input-enabled"
                      type="checkbox"
                      checked={modalForm.formData.enabled}
                      onChange={(e) =>
                        modalForm.updateFormField('enabled', e.target.checked)
                      }
                      disabled={modalForm.isSaving}
                    />
                    <div className="mcp-checkbox-card-content">
                      <span className="mcp-checkbox-card-title">
                        {t('mcp.field_enabled')}
                      </span>
                      <span className="mcp-checkbox-card-desc">
                        {t('mcp.field_enabled_hint')}
                      </span>
                    </div>
                  </label>
                </McpFormField>
              </div>

              {/* Row 2: Scope selection */}
              {cwd ? (
                <McpRadioCards
                  name="mcp-scope"
                  label={t('mcp.field_scope')}
                  options={scopeOptions}
                  selectedValue={modalForm.formData.scope}
                  onChange={(val) => modalForm.updateFormField('scope', val)}
                  disabled={modalForm.isEditing || modalForm.isSaving}
                />
              ) : null}

              {/* Row 3: Transport type selection */}
              <McpRadioCards
                name="mcp-type"
                label={t('mcp.field_type')}
                options={transportOptions}
                selectedValue={modalForm.formData.serverType}
                onChange={(val) => modalForm.updateFormField('serverType', val)}
                disabled={modalForm.isSaving}
              />
            </fieldset>

            {/* Section 2: Transport Configuration */}
            <fieldset className="form-fieldset">
              <legend className="form-legend">
                {isStdio
                  ? t('mcp.section_transport_stdio')
                  : t('mcp.section_transport_sse')}
              </legend>

              {isStdio ? (
                <>
                  <McpFormField
                    id="mcp-input-command"
                    label={t('mcp.field_command')}
                    required
                    subtext={t('mcp.field_command_hint')}
                  >
                    <input
                      id="mcp-input-command"
                      type="text"
                      className="field-input"
                      value={modalForm.formData.command}
                      onChange={(e) =>
                        modalForm.updateFormField('command', e.target.value)
                      }
                      placeholder="npx, python, node, uvx..."
                      disabled={modalForm.isSaving}
                      required
                    />
                  </McpFormField>

                  <McpFormField
                    id="mcp-input-args"
                    label={t('mcp.field_args')}
                    subtext={t('mcp.field_args_hint')}
                  >
                    <textarea
                      id="mcp-input-args"
                      className="field-textarea mcp-args-input"
                      rows={2}
                      value={modalForm.formData.argsText}
                      onChange={(e) =>
                        modalForm.updateFormField('argsText', e.target.value)
                      }
                      placeholder={modalForm.originalServer?.argsConfigured ? '•••••••• (configured)' : '-y @modelcontextprotocol/server-postgres'}
                      disabled={modalForm.isSaving}
                    />
                  </McpFormField>

                  <McpKeyValueEditor
                    title={t('mcp.field_env')}
                    addButtonLabel={t('mcp.btn_add_env')}
                    keyPlaceholder={t('mcp.env_key_placeholder')}
                    valuePlaceholder={modalForm.originalServer?.envKeys?.length ? '•••••••• (configured)' : t('mcp.env_value_placeholder')}
                    keyColumnLabel={t('mcp.kv_col_key')}
                    valueColumnLabel={t('mcp.kv_col_value')}
                    emptyNotice={t('mcp.kv_env_empty')}
                    entries={modalForm.formData.envEntries}
                    onAdd={modalForm.addEnvEntry}
                    onUpdate={modalForm.updateEnvEntry}
                    onRemove={modalForm.removeEnvEntry}
                    disabled={modalForm.isSaving}
                    removeButtonTitle={t('action.delete')}
                  />
                </>
              ) : (
                <>
                  <McpFormField
                    id="mcp-input-url"
                    label={t('mcp.field_url')}
                    required
                    subtext={t('mcp.field_url_hint')}
                  >
                    <input
                      id="mcp-input-url"
                      type="url"
                      className="field-input"
                      value={modalForm.formData.url}
                      onChange={(e) =>
                        modalForm.updateFormField('url', e.target.value)
                      }
                      placeholder={modalForm.originalServer?.urlConfigured ? '•••••••• (configured)' : 'https://example.com/sse'}
                      disabled={modalForm.isSaving}
                      required={!modalForm.originalServer?.urlConfigured}
                    />
                  </McpFormField>

                  <McpKeyValueEditor
                    title={t('mcp.field_headers')}
                    addButtonLabel={t('mcp.btn_add_header')}
                    keyPlaceholder={t('mcp.header_key_placeholder')}
                    valuePlaceholder={modalForm.originalServer?.headersConfigured ? '•••••••• (configured)' : t('mcp.header_value_placeholder')}
                    keyColumnLabel={t('mcp.kv_col_header')}
                    valueColumnLabel={t('mcp.kv_col_value')}
                    emptyNotice={t('mcp.kv_headers_empty')}
                    entries={modalForm.formData.headersEntries}
                    onAdd={modalForm.addHeaderEntry}
                    onUpdate={modalForm.updateHeaderEntry}
                    onRemove={modalForm.removeHeaderEntry}
                    disabled={modalForm.isSaving}
                    removeButtonTitle={t('action.delete')}
                  />
                </>
              )}
            </fieldset>
          </div>

          <footer className="modal-footer">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={modalForm.closeModal}
              disabled={modalForm.isSaving}
            >
              {t('action.cancel')}
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={modalForm.isSaving}
            >
              {modalForm.isSaving
                ? t('action.saving')
                : t('mcp.btn_save_server')}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
};
