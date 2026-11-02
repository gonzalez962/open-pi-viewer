import { useCallback, useState } from 'react';
import type {
  McpServerConfig,
  McpServerScope,
  SaveMcpServerPayload,
} from '@core/types/mcp';
import type { TranslationKey } from '@shared/i18n';
import {
  EMPTY_MCP_FORM,
  type McpFormData,
  createUniqueKvId,
  formDataToSavePayload,
  serverConfigToFormData,
} from '../types';

/**
 * Validates MCP Form input data against naming, transport, and URL constraints.
 */
export function validateMcpForm(
  formData: McpFormData,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  urlConfigured = false
): string | null {
  const trimmedName = formData.name.trim();
  if (!trimmedName) {
    return t('mcp.error_name_required');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(trimmedName)) {
    return t('mcp.error_name_invalid');
  }

  if (formData.serverType === 'stdio') {
    if (!formData.command.trim()) {
      return t('mcp.error_command_required');
    }
  } else {
    const trimmedUrl = formData.url.trim();
    if (!trimmedUrl) {
      return urlConfigured ? null : t('mcp.error_url_required');
    }
    try {
      const parsed = new URL(trimmedUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return t('mcp.error_url_invalid');
      }
    } catch {
      return t('mcp.error_url_invalid');
    }
  }

  return null;
}

export interface UseMcpModalFormResult {
  isModalOpen: boolean;
  isEditing: boolean;
  isSaving: boolean;
  originalServer: McpServerConfig | null;
  formData: McpFormData;
  formError: string | null;
  setFormData: React.Dispatch<React.SetStateAction<McpFormData>>;
  setFormError: (error: string | null) => void;
  openAddModal: (defaultScope?: McpServerScope) => void;
  openEditModal: (server: McpServerConfig) => void;
  closeModal: () => void;
  updateFormField: <K extends keyof McpFormData>(
    field: K,
    value: McpFormData[K]
  ) => void;
  addEnvEntry: () => void;
  updateEnvEntry: (id: string, field: 'key' | 'value', value: string) => void;
  removeEnvEntry: (id: string) => void;
  addHeaderEntry: () => void;
  updateHeaderEntry: (id: string, field: 'key' | 'value', value: string) => void;
  removeHeaderEntry: (id: string) => void;
  handleSave: (
    saveFn: (payload: SaveMcpServerPayload) => Promise<boolean>,
    t: (key: TranslationKey, params?: Record<string, string | number>) => string,
    cwd?: string
  ) => Promise<boolean>;
}

export function useMcpModalForm(): UseMcpModalFormResult {
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [originalServer, setOriginalServer] = useState<McpServerConfig | null>(
    null
  );
  const [formData, setFormData] = useState<McpFormData>(EMPTY_MCP_FORM);
  const [formError, setFormError] = useState<string | null>(null);

  const openAddModal = useCallback((defaultScope: McpServerScope = 'global') => {
    setFormData({
      ...EMPTY_MCP_FORM,
      scope: defaultScope,
    });
    setOriginalServer(null);
    setIsEditing(false);
    setFormError(null);
    setIsModalOpen(true);
  }, []);

  const openEditModal = useCallback((server: McpServerConfig) => {
    setFormData(serverConfigToFormData(server));
    setOriginalServer(server);
    setIsEditing(true);
    setFormError(null);
    setIsModalOpen(true);
  }, []);

  const closeModal = useCallback(() => {
    setIsModalOpen(false);
    setFormError(null);
    setOriginalServer(null);
    setIsSaving(false);
  }, []);

  const updateFormField = useCallback(
    <K extends keyof McpFormData>(field: K, value: McpFormData[K]) => {
      setFormData((prev) => ({
        ...prev,
        [field]: value,
      }));
      setFormError(null);
    },
    []
  );

  const addEnvEntry = useCallback(() => {
    setFormData((prev) => ({
      ...prev,
      envEntries: [
        ...prev.envEntries,
        { id: createUniqueKvId(), key: '', value: '' },
      ],
    }));
  }, []);

  const updateEnvEntry = useCallback(
    (id: string, field: 'key' | 'value', value: string) => {
      setFormData((prev) => ({
        ...prev,
        envEntries: prev.envEntries.map((entry) =>
          entry.id === id ? { ...entry, [field]: value } : entry
        ),
      }));
    },
    []
  );

  const removeEnvEntry = useCallback((id: string) => {
    setFormData((prev) => ({
      ...prev,
      envEntries: prev.envEntries.filter((entry) => entry.id !== id),
    }));
  }, []);

  const addHeaderEntry = useCallback(() => {
    setFormData((prev) => ({
      ...prev,
      headersEntries: [
        ...prev.headersEntries,
        { id: createUniqueKvId(), key: '', value: '' },
      ],
    }));
  }, []);

  const updateHeaderEntry = useCallback(
    (id: string, field: 'key' | 'value', value: string) => {
      setFormData((prev) => ({
        ...prev,
        headersEntries: prev.headersEntries.map((entry) =>
          entry.id === id ? { ...entry, [field]: value } : entry
        ),
      }));
    },
    []
  );

  const removeHeaderEntry = useCallback((id: string) => {
    setFormData((prev) => ({
      ...prev,
      headersEntries: prev.headersEntries.filter((entry) => entry.id !== id),
    }));
  }, []);

  const handleSave = useCallback(
    async (
      saveFn: (payload: SaveMcpServerPayload) => Promise<boolean>,
      t: (key: TranslationKey, params?: Record<string, string | number>) => string,
      cwd?: string
    ): Promise<boolean> => {
      const validationError = validateMcpForm(formData, t, Boolean(originalServer?.urlConfigured));
      if (validationError) {
        setFormError(validationError);
        return false;
      }

      setIsSaving(true);
      setFormError(null);

      try {
        const payload = formDataToSavePayload(
          formData,
          originalServer?.name,
          cwd,
          originalServer
        );
        const success = await saveFn(payload);
        if (success) {
          closeModal();
          return true;
        } else {
          setFormError(t('mcp.error_save_failed'));
          return false;
        }
      } catch (err) {
        setFormError(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setIsSaving(false);
      }
    },
    [formData, originalServer, closeModal]
  );

  return {
    isModalOpen,
    isEditing,
    isSaving,
    originalServer,
    formData,
    formError,
    setFormData,
    setFormError,
    openAddModal,
    openEditModal,
    closeModal,
    updateFormField,
    addEnvEntry,
    updateEnvEntry,
    removeEnvEntry,
    addHeaderEntry,
    updateHeaderEntry,
    removeHeaderEntry,
    handleSave,
  };
}
