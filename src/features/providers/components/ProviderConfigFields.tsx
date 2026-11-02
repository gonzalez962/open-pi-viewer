import React from 'react';
import type { TranslationKey } from '@shared/i18n';
import { SUPPORTED_API_PROTOCOLS } from '../providers';
import type { ProviderFormData } from '../types';
import { ProviderSelect } from './ProviderSelect';

export interface ProviderConfigFieldsProps {
  formData: ProviderFormData;
  setFormData: React.Dispatch<React.SetStateAction<ProviderFormData>>;
  isEditing: boolean;
  showApiKey: boolean;
  setShowApiKey: React.Dispatch<React.SetStateAction<boolean>>;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

export const ProviderConfigFields: React.FC<ProviderConfigFieldsProps> = ({
  formData,
  setFormData,
  isEditing,
  showApiKey,
  setShowApiKey,
  t,
}) => {
  return (
    <fieldset className="form-fieldset">
      <legend className="form-legend">{t('providers.section_general')}</legend>

      <div className="form-row-grid">
        <div className="field-group">
          <label htmlFor="provider-id-input" className="field-label">
            {t('providers.field_id')} *
          </label>
          <input
            id="provider-id-input"
            type="text"
            className="field-input"
            value={formData.id}
            disabled={isEditing}
            onChange={(e) =>
              setFormData((prev) => ({ ...prev, id: e.target.value }))
            }
            placeholder={t('providers.field_id_placeholder')}
            required
          />
          <span className="field-subtext">{t('providers.field_id_subtext')}</span>
        </div>

        <div className="field-group">
          <label htmlFor="provider-name-input" className="field-label">
            {t('providers.field_name')}
          </label>
          <input
            id="provider-name-input"
            type="text"
            className="field-input"
            value={formData.name}
            onChange={(e) =>
              setFormData((prev) => ({ ...prev, name: e.target.value }))
            }
            placeholder={t('providers.field_name_placeholder')}
          />
          <span className="field-subtext">{t('providers.field_name_subtext')}</span>
        </div>
      </div>

      <div className="form-row-grid">
        <div className="field-group">
          <label htmlFor="provider-url-input" className="field-label">
            {t('providers.field_base_url')} *
          </label>
          <input
            id="provider-url-input"
            type="text"
            className="field-input"
            value={formData.baseUrl}
            onChange={(e) =>
              setFormData((prev) => ({ ...prev, baseUrl: e.target.value }))
            }
            placeholder="http://localhost:11434/v1"
            required
          />
          <span className="field-subtext">{t('providers.field_base_url_subtext')}</span>
        </div>

        <div className="field-group">
          <label htmlFor="provider-api-select" className="field-label">
            {t('providers.field_api')} *
          </label>
          <ProviderSelect
            id="provider-api-select"
            value={formData.api}
            onChange={(val) =>
              setFormData((prev) => ({ ...prev, api: val }))
            }
            options={SUPPORTED_API_PROTOCOLS.map((proto) => ({
              value: proto.value,
              label: proto.label,
            }))}
            aria-label={t('providers.field_api')}
          />
          <span className="field-subtext">{t('providers.field_api_subtext')}</span>
        </div>
      </div>

      <div className="field-group">
        <label htmlFor="provider-key-input" className="field-label">
          {t('providers.field_api_key')}
        </label>
        <div className="input-password-wrapper">
          <input
            id="provider-key-input"
            type={showApiKey ? 'text' : 'password'}
            className="field-input"
            value={formData.apiKey}
            onChange={(e) =>
              setFormData((prev) => ({ ...prev, apiKey: e.target.value }))
            }
            placeholder={t('providers.field_api_key_placeholder')}
          />
          <button
            type="button"
            className="btn-toggle-password"
            onClick={() => setShowApiKey((prev) => !prev)}
            title={showApiKey ? t('providers.hide_key') : t('providers.show_key')}
          >
            {showApiKey ? '🙈' : '👁️'}
          </button>
        </div>
        {formData.apiKeyConfigured && (
          <div className="provider-api-key-status">
            <span>API key configured</span>
            <label>
              <input type="checkbox" checked={!!formData.deleteApiKey} onChange={e => setFormData(prev => ({ ...prev, deleteApiKey: e.target.checked }))} /> Delete configured API key
            </label>
          </div>
        )}
        <span className="field-subtext">{t('providers.field_api_key_subtext')}</span>
      </div>
      {(formData.headerKeys || []).map(key => <div className="field-group" key={key}>
        <label>{key} (configured)<input type="password" value={formData.headerEdits?.[key] || ''} onChange={e => setFormData(prev => ({ ...prev, headerEdits: { ...prev.headerEdits, [key]: e.target.value } }))} placeholder="Replace header value" /></label>
        <label><input type="checkbox" checked={formData.headerEdits?.[key] === null} onChange={e => setFormData(prev => ({ ...prev, headerEdits: { ...prev.headerEdits, [key]: e.target.checked ? null : '' } }))} /> Delete header</label>
      </div>)}
    </fieldset>
  );
};
