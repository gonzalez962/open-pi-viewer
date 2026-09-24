import React, { useEffect, useState } from 'react';
import { formatLocalizedDiagnostic, type SupportedLocale, type TranslationKey } from '@shared/i18n';
import type { UiPreferences } from '@infra/preferences';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationPreferences,
} from '@core/notifications';
import {
  playNotificationSound,
  requestNotificationPermission,
  showDesktopNotification,
} from '@infra/notifications';
import type { AppTheme } from '@shared/theme';
import type { ConnectConfig } from '@core/types/connection';
import type { CustomProviderConfig } from '@core/types/providers';
import { detectGentleShellPi, pickDirectoryPi, type DetectGentleShellPayload, type DetectGentleShellResult } from '@infra/bridge';
import { SettingsSelect } from './components/SettingsSelect';

export interface SettingsViewProps {
  config: ConnectConfig;
  settingsDraft: ConnectConfig;
  setSettingsDraft: React.Dispatch<React.SetStateAction<ConnectConfig>>;
  preferences: UiPreferences;
  onThemeChange: (theme: AppTheme) => void;
  onLanguageChange: (lang: SupportedLocale) => void;
  onNotificationsChange?: (partial: Partial<NotificationPreferences>) => void;
  settingsError: string | null;
  settingsStorageNotice: string | null;
  isBusy: boolean;
  onSaveAndApply: (e: React.FormEvent) => Promise<void> | void;
  onClose: () => void;
  initialTab?: 'general' | 'profiles' | 'providers' | 'mcp' | 'extensions';
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  loadCustomProviders: () => Promise<CustomProviderConfig[]>;
  renderProviders: (onBackToSettings: () => void) => React.ReactNode;
  renderProfiles?: (onBackToSettings: () => void) => React.ReactNode;
  renderMcp?: (onBackToSettings: () => void) => React.ReactNode;
  renderExtensions?: (onBackToSettings: () => void) => React.ReactNode;
  activeProfileName?: string | null;
  activeProfileScope?: 'project' | 'global' | null | undefined;
  pickDirectoryFn?: (defaultPath?: string) => Promise<string | null>;
  detectGentleShellFn?: (payload?: DetectGentleShellPayload) => Promise<DetectGentleShellResult>;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  settingsDraft,
  setSettingsDraft,
  preferences,
  onThemeChange,
  onLanguageChange,
  onNotificationsChange,
  settingsError,
  settingsStorageNotice,
  isBusy,
  onSaveAndApply,
  onClose,
  initialTab = 'general',
  t,
  loadCustomProviders,
  renderProviders,
  renderProfiles,
  renderMcp,
  renderExtensions,
  activeProfileName,
  activeProfileScope,
  pickDirectoryFn,
  detectGentleShellFn,
}) => {
  const [activeTab, setActiveTab] = useState<'general' | 'profiles' | 'providers' | 'mcp' | 'extensions'>(initialTab);
  const [customProviders, setCustomProviders] = useState<CustomProviderConfig[]>([]);
  const [isDetectingShell, setIsDetectingShell] = useState(false);
  const [gentleShellNotice, setGentleShellNotice] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const notifications = preferences.notifications ?? DEFAULT_NOTIFICATION_PREFERENCES;

  const handleDetectGentleShell = async () => {
    setIsDetectingShell(true);
    setGentleShellNotice(null);
    try {
      const detectFn = detectGentleShellFn || detectGentleShellPi;
      const cwd = settingsDraft.workingDirectory?.trim() || undefined;
      const result = await detectFn({ cwd, workingDirectory: cwd });

      if (result.status === 'discovered' && result.path) {
        setSettingsDraft((prev) => ({
          ...prev,
          piEntrypoint: result.path!,
        }));
        setGentleShellNotice({
          type: 'success',
          message: t('settings.detect_gentle_shell_success', { path: result.path }),
        });
      } else if (result.status === 'ambiguous') {
        const candidatesStr = result.candidates?.join(', ') || '';
        setGentleShellNotice({
          type: 'error',
          message: t('settings.detect_gentle_shell_ambiguous', { candidates: candidatesStr }),
        });
      } else {
        setGentleShellNotice({
          type: 'error',
          message: t('settings.detect_gentle_shell_missing'),
        });
      }
    } catch (err) {
      setGentleShellNotice({
        type: 'error',
        message: t('settings.detect_gentle_shell_error', {
          error: err instanceof Error ? err.message : String(err),
        }),
      });
    } finally {
      setIsDetectingShell(false);
    }
  };

  const handleBrowseCwd = async () => {
    const pickFn = pickDirectoryFn || pickDirectoryPi;
    const selected = await pickFn(settingsDraft.workingDirectory || undefined);
    if (selected) {
      setSettingsDraft((prev) => ({
        ...prev,
        workingDirectory: selected,
      }));
    }
  };

  const handleTestNotification = async () => {
    if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
      await requestNotificationPermission();
    }
    playNotificationSound('complete');
    showDesktopNotification({
      title: t('settings.notifications_test_title'),
      body: t('settings.notifications_test_body'),
    });
  };

  useEffect(() => {
    let isMounted = true;
    loadCustomProviders()
      .then((providers) => {
        if (isMounted) {
          setCustomProviders(providers);
        }
      })
      .catch(() => {});
    return () => {
      isMounted = false;
    };
    // Dependency list intentionally limited to activeTab: it preserves the pre-T4 re-fetch timing.
    // loadCustomProviders is a fresh closure on every parent render, so including it would refetch on each render.
  }, [activeTab]);

  return (
    <div className="settings-view" role="region" aria-label={t('settings.title')}>
      {/* Header with Navigation Tabs */}
      <header className="settings-view-header">
        <div className="settings-view-header-left">
          <div className="settings-view-header-titles">
            <h1 className="settings-view-title">{t('settings.title')}</h1>
            <p className="settings-view-subtitle">{t('settings.view_subtitle')}</p>
          </div>
        </div>

        {/* Navigation Tabs */}
        <nav className="settings-nav-tabs" role="tablist" aria-label={t('settings.nav_aria')}>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'general'}
            className={activeTab === 'general' ? 'settings-tab-btn active' : 'settings-tab-btn'}
            onClick={() => setActiveTab('general')}
          >
            {t('settings.tab_general')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'profiles'}
            className={activeTab === 'profiles' ? 'settings-tab-btn active' : 'settings-tab-btn'}
            onClick={() => setActiveTab('profiles')}
          >
            {t('settings.tab_profiles')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'providers'}
            className={activeTab === 'providers' ? 'settings-tab-btn active' : 'settings-tab-btn'}
            onClick={() => setActiveTab('providers')}
          >
            {t('settings.tab_providers')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'mcp'}
            className={activeTab === 'mcp' ? 'settings-tab-btn active' : 'settings-tab-btn'}
            onClick={() => setActiveTab('mcp')}
          >
            {t('settings.tab_mcp')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'extensions'}
            className={activeTab === 'extensions' ? 'settings-tab-btn active' : 'settings-tab-btn'}
            onClick={() => setActiveTab('extensions')}
          >
            {t('settings.tab_extensions')}
          </button>
        </nav>

        <div className="settings-view-header-right">
          <button
            type="button"
            className="btn btn-icon btn-close-settings"
            onClick={onClose}
            aria-label={t('action.close')}
            title={t('action.close')}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </header>

      {/* Scrollable Body */}
      {activeTab === 'general' && (
        <div className="settings-tab-pane" role="tabpanel" aria-label={t('settings.tab_general')}>
          <div className="settings-view-body">
        {settingsError && (
          <div className="validation-error-banner" role="alert">
            <span>{formatLocalizedDiagnostic(settingsError, preferences.language)}</span>
          </div>
        )}

        {settingsStorageNotice && (
          <div className="storage-warning-banner" role="status">
            <span>{formatLocalizedDiagnostic(settingsStorageNotice, preferences.language)}</span>
          </div>
        )}

        {/* Section 1: Appearance & Language */}
        <section className="settings-card-section">
          <div className="settings-section-header">
            <h2 className="settings-section-title">
              {t('settings.preferences_heading')}
            </h2>
            <span className="prompt-hint">
              {t('settings.preferences_hint')}
            </span>
          </div>

          <div className="preferences-grid">
            <div className="field-group">
              <label htmlFor="settings-theme-select" className="field-label">
                {t('settings.theme_label')}
              </label>
              <SettingsSelect
                id="settings-theme-select"
                value={preferences.theme}
                onChange={(val) =>
                  onThemeChange(val as AppTheme)
                }
                options={[
                  { value: 'dark', label: t('settings.theme_dark') },
                  { value: 'light', label: t('settings.theme_light') },
                  { value: 'system', label: t('settings.theme_system') },
                ]}
                aria-label={t('settings.theme_label')}
              />
            </div>

            <div className="field-group">
              <label htmlFor="settings-language-select" className="field-label">
                {t('settings.language_label')}
              </label>
              <SettingsSelect
                id="settings-language-select"
                value={preferences.language}
                onChange={(val) =>
                  onLanguageChange(val as SupportedLocale)
                }
                options={[
                  { value: 'en', label: t('settings.language_en') },
                  { value: 'es', label: t('settings.language_es') },
                ]}
                aria-label={t('settings.language_label')}
              />
            </div>
          </div>
        </section>

        {/* Section: Notifications */}
        <section className="settings-card-section">
          <div className="settings-section-header">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', width: '100%' }}>
              <div>
                <h2 className="settings-section-title">
                  {t('settings.notifications_heading')}
                </h2>
                <span className="prompt-hint">
                  {t('settings.notifications_hint')}
                </span>
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleTestNotification}
                title={t('settings.notifications_test_btn')}
              >
                <span>{t('settings.notifications_test_btn')}</span>
              </button>
            </div>
          </div>

          <div className="notifications-grid">
            <div className="checkbox-group">
              <label className="checkbox-label" htmlFor="settings-notifications-enable">
                <input
                  id="settings-notifications-enable"
                  type="checkbox"
                  className="field-checkbox"
                  checked={notifications.enabled}
                  onChange={(e) =>
                    onNotificationsChange?.({ enabled: e.target.checked })
                  }
                />
                <span className="checkbox-text">
                  {t('settings.notifications_enable')}
                </span>
              </label>
            </div>

            <div
              className="notifications-controls-group"
              style={{
                opacity: notifications.enabled ? 1 : 0.5,
                pointerEvents: notifications.enabled ? 'auto' : 'none',
              }}
            >
              <div className="checkbox-group">
                <label className="checkbox-label" htmlFor="settings-notifications-sound">
                  <input
                    id="settings-notifications-sound"
                    type="checkbox"
                    className="field-checkbox"
                    disabled={!notifications.enabled}
                    checked={notifications.sound}
                    onChange={(e) =>
                      onNotificationsChange?.({ sound: e.target.checked })
                    }
                  />
                  <span className="checkbox-text">
                    {t('settings.notifications_sound')}
                  </span>
                </label>
              </div>

              <div className="checkbox-group">
                <label className="checkbox-label" htmlFor="settings-notifications-suppress-focused">
                  <input
                    id="settings-notifications-suppress-focused"
                    type="checkbox"
                    className="field-checkbox"
                    disabled={!notifications.enabled}
                    checked={notifications.suppressWhenFocused}
                    onChange={(e) =>
                      onNotificationsChange?.({ suppressWhenFocused: e.target.checked })
                    }
                  />
                  <span className="checkbox-text">
                    {t('settings.notifications_suppress_focused')}
                  </span>
                </label>
                <span className="field-subtext">
                  {t('settings.notifications_suppress_focused_hint')}
                </span>
              </div>

              <div className="checkbox-group">
                <label className="checkbox-label" htmlFor="settings-notifications-on-task-complete">
                  <input
                    id="settings-notifications-on-task-complete"
                    type="checkbox"
                    className="field-checkbox"
                    disabled={!notifications.enabled}
                    checked={notifications.onTaskComplete}
                    onChange={(e) =>
                      onNotificationsChange?.({ onTaskComplete: e.target.checked })
                    }
                  />
                  <span className="checkbox-text">
                    {t('settings.notifications_on_task_complete')}
                  </span>
                </label>
                <span className="field-subtext">
                  {t('settings.notifications_on_task_complete_hint')}
                </span>
              </div>

              <div className="checkbox-group">
                <label className="checkbox-label" htmlFor="settings-notifications-on-waiting-input">
                  <input
                    id="settings-notifications-on-waiting-input"
                    type="checkbox"
                    className="field-checkbox"
                    disabled={!notifications.enabled}
                    checked={notifications.onWaitingInput}
                    onChange={(e) =>
                      onNotificationsChange?.({ onWaitingInput: e.target.checked })
                    }
                  />
                  <span className="checkbox-text">
                    {t('settings.notifications_on_waiting_input')}
                  </span>
                </label>
                <span className="field-subtext">
                  {t('settings.notifications_on_waiting_input_hint')}
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* Section: SDD Profiles & Subagents */}
        <section className="settings-card-section">
          <div className="settings-section-header">
            <h2 className="settings-section-title">
              {t('settings.profiles_heading')}
            </h2>
            <span className="prompt-hint">
              {t('settings.profiles_hint')}
            </span>
          </div>

          <div className="settings-provider-summary">
            <div className="provider-summary-info">
              <span className="provider-summary-title">
                {t('settings.profiles_summary_title')}
              </span>
              <div className="provider-summary-tags">
                <span className="provider-summary-tag">
                  <strong>{activeProfileName || t('settings.profiles_none_active')}</strong>
                  {activeProfileScope && (
                    <span className="provider-summary-tag-count">
                      ({activeProfileScope === 'project' ? t('settings.profiles_scope_project') : t('settings.profiles_scope_global')})
                    </span>
                  )}
                </span>
              </div>
              <p className="prompt-hint" style={{ marginTop: '0.5rem', marginBottom: 0 }}>
                {t('settings.profiles_attribution')}
              </p>
            </div>

            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setActiveTab('profiles')}
            >
              <span>{t('settings.btn_open_profiles')}</span>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          </div>
        </section>

        {/* Section 2: Model Providers */}
        <section className="settings-card-section">
          <div className="settings-section-header">
            <h2 className="settings-section-title">
              {t('settings.providers_heading')}
            </h2>
            <span className="prompt-hint">
              {t('settings.providers_hint')}
            </span>
          </div>

          <div className="settings-provider-summary">
            <div className="provider-summary-info">
              <span className="provider-summary-title">
                {t('settings.providers_summary_title')}
              </span>
              {customProviders.length > 0 ? (
                <div className="provider-summary-tags">
                  {customProviders.map((p) => (
                    <span key={p.id} className="provider-summary-tag">
                      <strong>{p.name || p.id}</strong>
                      <span className="provider-summary-tag-count">
                        ({p.models.length} {t('settings.providers_models_count')})
                      </span>
                    </span>
                  ))}
                </div>
              ) : (
                <span className="prompt-hint">
                  {t('settings.providers_none_configured')}
                </span>
              )}
            </div>

            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setActiveTab('providers')}
            >
              <span>{t('settings.btn_open_providers')}</span>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          </div>
        </section>

        {/* Section 3: Connection Configuration */}
        <section className="settings-card-section">
          <div className="settings-section-header">
            <h2 className="settings-section-title">
              {t('settings.connection_heading')}
            </h2>
            <span className="prompt-hint">
              {t('settings.connection_hint')}
            </span>
          </div>

          <form
            className="connection-form"
            onSubmit={onSaveAndApply}
          >
            <div className="connection-fields-grid">
              <div className="field-group" style={{ gridColumn: '1 / -1' }}>
                <label htmlFor="settings-connection-type-select" className="field-label">
                  {t('settings.connection_type_label')}
                </label>
                <SettingsSelect
                  id="settings-connection-type-select"
                  value={settingsDraft.connectionType ?? 'local'}
                  onChange={(val) =>
                    setSettingsDraft((prev) => ({
                      ...prev,
                      connectionType: val as 'local' | 'mesh',
                      meshCoordinatorUrl: val === 'mesh' ? (prev.meshCoordinatorUrl || 'http://localhost:8080') : prev.meshCoordinatorUrl,
                    }))
                  }
                  options={[
                    { value: 'local', label: t('settings.connection_type_local') },
                    { value: 'mesh', label: t('settings.connection_type_mesh') },
                  ]}
                  aria-label={t('settings.connection_type_label')}
                />
              </div>

              {settingsDraft.connectionType === 'mesh' ? (
                <>
                  <div className="field-group">
                    <label htmlFor="settings-mesh-url-input" className="field-label">
                      {t('settings.mesh_url_label')}
                    </label>
                    <input
                      id="settings-mesh-url-input"
                      type="text"
                      className="field-input"
                      value={settingsDraft.meshCoordinatorUrl ?? ''}
                      onChange={(e) =>
                        setSettingsDraft((prev) => ({
                          ...prev,
                          meshCoordinatorUrl: e.target.value,
                        }))
                      }
                      placeholder={t('settings.mesh_url_placeholder')}
                      title={t('settings.mesh_url_title')}
                      required
                    />
                  </div>

                  <div className="field-group">
                    <label htmlFor="settings-mesh-token-input" className="field-label">
                      {t('settings.mesh_token_label')}
                    </label>
                    <input
                      id="settings-mesh-token-input"
                      type="password"
                      className="field-input"
                      value={settingsDraft.meshToken ?? ''}
                      onChange={(e) =>
                        setSettingsDraft((prev) => ({
                          ...prev,
                          meshToken: e.target.value,
                        }))
                      }
                      placeholder={t('settings.mesh_token_placeholder')}
                      title={t('settings.mesh_token_title')}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="field-group">
                    <label htmlFor="settings-node-path-input" className="field-label">
                      {t('settings.node_path_label')}
                    </label>
                    <input
                      id="settings-node-path-input"
                      type="text"
                      className="field-input"
                      value={settingsDraft.nodePath}
                      onChange={(e) =>
                        setSettingsDraft((prev) => ({
                          ...prev,
                          nodePath: e.target.value,
                        }))
                      }
                      placeholder={t('settings.node_path_placeholder')}
                      title={t('settings.node_path_title')}
                      required
                    />
                  </div>

                  <div className="field-group">
                    <label htmlFor="settings-pi-entry-input" className="field-label">
                      {t('settings.pi_entry_label')}
                    </label>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <input
                        id="settings-pi-entry-input"
                        type="text"
                        className="field-input"
                        style={{ flex: 1 }}
                        value={settingsDraft.piEntrypoint}
                        onChange={(e) => {
                          setSettingsDraft((prev) => ({
                            ...prev,
                            piEntrypoint: e.target.value,
                          }));
                          if (gentleShellNotice) {
                            setGentleShellNotice(null);
                          }
                        }}
                        placeholder={t('settings.pi_entry_placeholder')}
                        title={t('settings.pi_entry_title')}
                        required
                      />
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={handleDetectGentleShell}
                        disabled={isDetectingShell || isBusy}
                        title={t('settings.btn_detect_gentle_shell_title')}
                      >
                        {isDetectingShell
                          ? t('settings.btn_detect_gentle_shell_detecting')
                          : t('settings.btn_detect_gentle_shell')}
                      </button>
                    </div>
                    {gentleShellNotice && (
                      <span
                        className={
                          gentleShellNotice.type === 'success'
                            ? 'field-subtext field-subtext-success'
                            : 'field-subtext field-subtext-error'
                        }
                        role={gentleShellNotice.type === 'error' ? 'alert' : 'status'}
                        aria-live="polite"
                        style={{
                          display: 'block',
                          marginTop: '4px',
                          color:
                            gentleShellNotice.type === 'success'
                              ? 'var(--color-success, #22c55e)'
                              : 'var(--color-danger, #ef4444)',
                        }}
                      >
                        {gentleShellNotice.message}
                      </span>
                    )}
                  </div>
                </>
              )}

              <div className="field-group">
                <label htmlFor="settings-cwd-input" className="field-label">
                  {t('settings.cwd_label')}
                </label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    id="settings-cwd-input"
                    type="text"
                    className="field-input"
                    style={{ flex: 1 }}
                    value={settingsDraft.workingDirectory}
                    onChange={(e) =>
                      setSettingsDraft((prev) => ({
                        ...prev,
                        workingDirectory: e.target.value,
                      }))
                    }
                    placeholder={t('settings.cwd_placeholder')}
                    title={t('settings.cwd_title')}
                    required={settingsDraft.connectionType !== 'mesh'}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={handleBrowseCwd}
                    title={t('settings.btn_browse_cwd')}
                  >
                    {t('settings.btn_browse_cwd')}
                  </button>
                </div>
              </div>
            </div>

            <div className="connection-actions">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={isBusy}
                aria-disabled={isBusy}
                title={
                  isBusy
                    ? t('settings.save_apply_busy_title')
                    : t('settings.save_apply_title')
                }
              >
                {t('settings.save_apply')}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={onClose}
              >
                {t('action.cancel')}
              </button>
            </div>
          </form>
        </section>

        {/* Section 3: Workspace File Explorer */}
        <section className="settings-card-section">
          <div className="settings-section-header">
            <h2 className="settings-section-title">
              {t('settings.file_tree_heading')}
            </h2>
            <span className="prompt-hint">
              {t('settings.file_tree_hint')}
            </span>
          </div>

          <div className="preferences-grid">
            <div className="field-group">
              <label htmlFor="settings-file-tree-interval-select" className="field-label">
                {t('settings.file_tree_interval_label')}
              </label>
              <SettingsSelect
                id="settings-file-tree-interval-select"
                value={String(settingsDraft.fileTreeRefreshInterval ?? 15)}
                onChange={(val) =>
                  setSettingsDraft((prev) => ({
                    ...prev,
                    fileTreeRefreshInterval: Number(val),
                  }))
                }
                options={[
                  { value: '0', label: t('settings.file_tree_interval_disabled') },
                  { value: '5', label: t('settings.file_tree_interval_5s') },
                  { value: '10', label: t('settings.file_tree_interval_10s') },
                  { value: '15', label: t('settings.file_tree_interval_15s') },
                  { value: '30', label: t('settings.file_tree_interval_30s') },
                  { value: '60', label: t('settings.file_tree_interval_60s') },
                ]}
                aria-label={t('settings.file_tree_interval_label')}
              />
              <span className="field-subtext">{t('settings.file_tree_interval_subtext')}</span>
            </div>
          </div>
        </section>
          </div>
        </div>
      )}

      {activeTab === 'profiles' && renderProfiles && (
        <div className="settings-tab-pane" role="tabpanel" aria-label={t('settings.tab_profiles')}>
          {renderProfiles(() => setActiveTab('general'))}
        </div>
      )}

      {activeTab === 'providers' && (
        <div className="settings-tab-pane" role="tabpanel" aria-label={t('settings.tab_providers')}>
          {renderProviders ? renderProviders(() => setActiveTab('general')) : null}
        </div>
      )}

      {activeTab === 'mcp' && renderMcp && (
        <div className="settings-tab-pane" role="tabpanel" aria-label={t('settings.tab_mcp')}>
          {renderMcp(() => setActiveTab('general'))}
        </div>
      )}

      {activeTab === 'extensions' && renderExtensions && (
        <div className="settings-tab-pane" role="tabpanel" aria-label={t('settings.tab_extensions')}>
          {renderExtensions(() => setActiveTab('general'))}
        </div>
      )}
    </div>
  );
};
