import React, { useEffect, useState } from 'react';
import { formatLocalizedDiagnostic, type SupportedLocale, type TranslationKey } from '@shared/i18n';
import type { UiPreferences } from '@infra/preferences';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationPreferences,
} from '@core/notifications';
import {
  playNotificationSound,
  getNotificationPermission,
  requestNotificationPermission,
  showDesktopNotification,
} from '@infra/notifications';
import type { AppTheme } from '@shared/theme';
import type { ConnectConfig } from '@core/types/connection';
import type { CustomProviderConfig } from '@core/types/providers';
import { detectGentleShellPi, pickDirectoryPi, type DetectGentleShellPayload, type DetectGentleShellResult } from '@infra/bridge';
import type { AppearanceLifecycleController } from '@features/settings/appearance';
import { SettingsSelect } from './components/SettingsSelect';
import { WebPushEnrollmentModal } from './components/WebPushEnrollmentModal';
import { CustomCommandsSection } from './components/CustomCommandsSection';
import { ThemeCustomizer } from './components/ThemeCustomizer';
import { COMMANDS, type CustomCommand } from '@core/commands';
import { discoverBaseBinaryPaths } from './reset-binary-paths';
import type { NotificationPermissionStatus } from '@infra/notification-delivery';

export interface SettingsViewProps {
  config: ConnectConfig;
  settingsDraft: ConnectConfig;
  setSettingsDraft: React.Dispatch<React.SetStateAction<ConnectConfig>>;
  preferences: UiPreferences;
  onThemeChange: (theme: AppTheme) => void;
  onLanguageChange: (lang: SupportedLocale) => void;
  onNotificationsChange?: (partial: Partial<NotificationPreferences>) => void;
  onSystemNotificationsToggle?: (enabled: boolean) => Promise<void>;
  onEnrollBrowser?: () => Promise<void>;
  webPushStatus?: 'unsupported' | 'unavailable' | 'denied' | 'subscribed' | 'unsubscribed' | 'error';
  /** Persists the user's custom slash commands (Issue #9 T7). Section hidden when absent. */
  onCustomCommandsChange?: (commands: CustomCommand[]) => void;
  /** Persists the ids of commands hidden from the palette and "/help" (Issue #9 T8). */
  onHiddenCommandIdsChange?: (ids: string[]) => void;
  settingsError: string | null;
  settingsStorageNotice: string | null;
  isBusy: boolean;
  onSaveAndApply: (e: React.FormEvent) => Promise<void> | void;
  onClose: () => void;
  initialTab?: 'general' | 'theme' | 'profiles' | 'providers' | 'mcp' | 'extensions';
  appearanceController?: AppearanceLifecycleController;
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
  onSystemNotificationsToggle,
  onEnrollBrowser,
  webPushStatus,
  onCustomCommandsChange,
  onHiddenCommandIdsChange,
  settingsError,
  settingsStorageNotice,
  isBusy,
  onSaveAndApply,
  onClose,
  initialTab = 'general',
  appearanceController,
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
  const [activeTab, setActiveTab] = useState<'general' | 'theme' | 'profiles' | 'providers' | 'mcp' | 'extensions'>(initialTab);
  const [customProviders, setCustomProviders] = useState<CustomProviderConfig[]>([]);
  const [isDetectingShell, setIsDetectingShell] = useState(false);
  const [gentleShellNotice, setGentleShellNotice] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const [isResettingPaths, setIsResettingPaths] = useState(false);
  const [binaryPathsNotice, setBinaryPathsNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const binaryDiscoveryBusy = isBusy || isDetectingShell || isResettingPaths;

  const handleResetBinaryPaths = async () => {
    setIsResettingPaths(true);
    setBinaryPathsNotice(null);
    try {
      const paths = await discoverBaseBinaryPaths(settingsDraft.workingDirectory);
      setSettingsDraft(prev => ({ ...prev, ...paths }));
      setGentleShellNotice(null);
      setBinaryPathsNotice({ type: 'success', message: t('settings.reset_binary_paths_success') });
    } catch (error) {
      setBinaryPathsNotice({ type: 'error', message: t('settings.reset_binary_paths_error', {
        error: error instanceof Error ? error.message : String(error),
      }) });
    } finally {
      setIsResettingPaths(false);
    }
  };

  const notifications = preferences.notifications ?? DEFAULT_NOTIFICATION_PREFERENCES;
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermissionStatus>('default');
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [notificationNotice, setNotificationNotice] = useState<string | null>(null);
  const [enrollmentOpen, setEnrollmentOpen] = useState(false);
  const [enrollmentError, setEnrollmentError] = useState<string | null>(null);
  const canEnrollBrowser = Boolean(onSystemNotificationsToggle && webPushStatus &&
    webPushStatus !== 'unsupported' && webPushStatus !== 'subscribed');
  const openEnrollment = () => { setEnrollmentError(null); setEnrollmentOpen(true); };

  useEffect(() => {
    let active = true;
    const refresh = () => { void getNotificationPermission().then(value => { if (active) setNotificationPermission(value); }); };
    refresh();
    window.addEventListener('focus', refresh);
    return () => { active = false; window.removeEventListener('focus', refresh); };
  }, []);

  const handleNotificationsToggle = async (enabled: boolean) => {
    if (enabled && canEnrollBrowser) { openEnrollment(); return; }
    onNotificationsChange?.({ enabled });
    setNotificationBusy(true);
    setNotificationNotice(null);
    try {
      if (enabled) setNotificationPermission(await requestNotificationPermission());
      await onSystemNotificationsToggle?.(enabled);
    } catch (error) {
      setNotificationNotice(error instanceof Error ? error.message : String(error));
    } finally { setNotificationBusy(false); }
  };

  const handleCancelWebPush = async () => {
    setNotificationBusy(true);
    setNotificationNotice(null);
    try {
      await onSystemNotificationsToggle?.(false);
    } catch (error) {
      setNotificationNotice(error instanceof Error ? error.message : String(error));
    } finally { setNotificationBusy(false); }
  };

  const handleEnrollBrowser = async () => {
    setNotificationBusy(true);
    setEnrollmentError(null);
    try {
      // Confirmation is the explicit permission/enrollment gesture.
      setNotificationPermission(await requestNotificationPermission());
      if (onEnrollBrowser) await onEnrollBrowser();
      else await onSystemNotificationsToggle?.(true);
      onNotificationsChange?.({ enabled: true });
      setEnrollmentOpen(false);
    } catch (error) {
      setEnrollmentError(error instanceof Error ? error.message : String(error));
    } finally { setNotificationBusy(false); }
  };

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
    setNotificationBusy(true);
    setNotificationNotice(null);
    try {
      // Testing is also an explicit user gesture: recover an enabled preference
      // whose system permission has not yet been granted.
      setNotificationPermission(await requestNotificationPermission());
      const delivered = await showDesktopNotification({
        title: t('settings.notifications_test_title'),
        body: t('settings.notifications_test_body'),
      });
      setNotificationPermission(await getNotificationPermission());
      if (delivered && notifications.sound) {
        // Browser popups are silent; native desktop sounds are controlled by the OS.
        const { getNotificationDelivery } = await import('@infra/notification-delivery');
        if (getNotificationDelivery().platform === 'web') playNotificationSound('complete');
      }
      setNotificationNotice(t(delivered ? 'settings.notifications_test_sent' : 'settings.notifications_test_failed'));
    } finally { setNotificationBusy(false); }
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
            aria-selected={activeTab === 'theme'}
            className={activeTab === 'theme' ? 'settings-tab-btn active' : 'settings-tab-btn'}
            onClick={() => setActiveTab('theme')}
          >
            {t('settings.tab_theme')}
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
                  { value: 'DjRomoro', label: t('settings.theme_djromoro') },
                  { value: 'arch-electric', label: t('settings.theme_arch_electric') },
                  { value: 'Gentleman-Sexy-Djr', label: t('settings.theme_gentleman_sexy_djr') },
                  { value: 'Minimalist-Ninja', label: t('settings.theme_minimalist_ninja') },
                ]}
                aria-label={t('settings.theme_label')}
              />
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                style={{ marginTop: 8 }}
                onClick={() => setActiveTab('theme')}
              >
                🎨 {t('theme.customizer_title')} →
              </button>
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
              <div className="notifications-header-actions">
                <label className="notification-switch-label">
                  <input
                    type="checkbox"
                    role="switch"
                    aria-checked={notifications.enabled}
                    aria-label={t('settings.notifications_request_permission')}
                    disabled={notificationBusy}
                    className="notification-switch"
                    checked={notifications.enabled}
                    onChange={(e) => { void handleNotificationsToggle(e.target.checked); }}
                  />
                  <span>{t('settings.notifications_request_permission')}</span>
                </label>
                {onSystemNotificationsToggle && webPushStatus && webPushStatus !== 'unsupported' && (
                  <>
                    {webPushStatus === 'subscribed' ? (
                      <button type="button" className="btn btn-secondary btn-sm" data-testid="web-push-cancel"
                        disabled={notificationBusy}
                        onClick={() => { void handleCancelWebPush(); }}>
                        {t('settings.web_push_cancel_button')}
                      </button>
                    ) : notifications.enabled && (
                      <button type="button" className="btn btn-secondary btn-sm" data-testid="web-push-enroll"
                        disabled={notificationBusy} onClick={openEnrollment}>
                        {t('settings.web_push_enroll_button')}
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>

          <p role="status" aria-live="polite">
            {t('settings.notifications_permission_label')}: {t(`settings.notifications_permission_${notificationPermission}`)}
          </p>
          <p className="field-subtext">{t('settings.notifications_permission_help')}</p>
          {webPushStatus && webPushStatus !== 'unsubscribed' && (
            <p role="status" aria-live="polite">{t(`settings.web_push_${webPushStatus}`)}</p>
          )}
          {notificationNotice && <p role="status" aria-live="polite">{notificationNotice}</p>}

          <div className="notifications-grid">
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
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleTestNotification}
                disabled={!notifications.enabled || notificationBusy}
                title={t('settings.notifications_test_btn')}
              >
                <span>{t('settings.notifications_test_btn')}</span>
              </button>
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

          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={handleResetBinaryPaths}
            disabled={binaryDiscoveryBusy}
            title={t('settings.reset_binary_paths_title')}
          >
            {isResettingPaths ? t('settings.reset_binary_paths_detecting') : t('settings.reset_binary_paths')}
          </button>
          {binaryPathsNotice && (
            <p
              className={binaryPathsNotice.type === 'error' ? 'field-subtext field-subtext-error' : 'field-subtext field-subtext-success'}
              role={binaryPathsNotice.type === 'error' ? 'alert' : 'status'}
              aria-live="polite"
            >
              {binaryPathsNotice.message}
            </p>
          )}

          <form
            className="connection-form"
            onSubmit={onSaveAndApply}
          >
            <div className="connection-fields-grid">
              <div className="field-group">
                <label htmlFor="settings-node-path-input" className="field-label">
                  {t('settings.node_path_label')}
                </label>
                <input
                  id="settings-node-path-input"
                  type="text"
                  className="field-input"
                  value={settingsDraft.nodePath}
                  disabled={isResettingPaths}
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
                    disabled={isResettingPaths}
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
                    disabled={binaryDiscoveryBusy}
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
                    required
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
                disabled={binaryDiscoveryBusy}
                aria-disabled={binaryDiscoveryBusy}
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

        {/* Section: Custom slash commands (Issue #9 T7), last section of the General tab (T8) */}
        {onCustomCommandsChange && (
          <CustomCommandsSection
            customCommands={preferences.customCommands ?? []}
            builtInCommands={COMMANDS}
            hiddenCommandIds={preferences.hiddenCommandIds ?? []}
            language={preferences.language}
            onChange={onCustomCommandsChange}
            onHiddenCommandIdsChange={onHiddenCommandIdsChange ?? (() => {})}
            t={t}
          />
        )}
          </div>
        </div>
      )}

      {activeTab === 'theme' && (
        <div className="settings-tab-pane" role="tabpanel" aria-label={t('settings.tab_theme')}>
          <div className="settings-view-body">
            <ThemeCustomizer
              controller={appearanceController}
              currentTheme={preferences.theme}
              onThemeChange={onThemeChange}
              workAnimation={preferences.workAnimation}
              customTextColor={preferences.customTextColor}
              customLabelColor={preferences.customLabelColor}
              customBackground={preferences.customBackground}
              t={t}
            />
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

      <WebPushEnrollmentModal isOpen={enrollmentOpen} pending={notificationBusy} error={enrollmentError}
        t={t} onConfirm={() => { void handleEnrollBrowser(); }} onCancel={() => setEnrollmentOpen(false)} />

      {activeTab === 'extensions' && renderExtensions && (
        <div className="settings-tab-pane" role="tabpanel" aria-label={t('settings.tab_extensions')}>
          {renderExtensions(() => setActiveTab('general'))}
        </div>
      )}
    </div>
  );
};
