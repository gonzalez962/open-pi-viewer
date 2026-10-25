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
import { detectGentleShellPi, pickDirectoryPi, getGitHubAuthStatusPi, type DetectGentleShellPayload, type DetectGentleShellResult } from '@infra/bridge';
import type { AppearanceLifecycleController } from '@features/settings/appearance';
import { SettingsSelect } from './components/SettingsSelect';
import { WebPushEnrollmentModal } from './components/WebPushEnrollmentModal';
import { CustomCommandsSection } from './components/CustomCommandsSection';
import { ThemeCustomizer } from './components/ThemeCustomizer';
import { SpeechSettingsSection } from './components/SpeechSettingsSection';
import { COMMANDS, type CustomCommand } from '@core/commands';
import { discoverBaseBinaryPaths } from './reset-binary-paths';
import type { NotificationPermissionStatus } from '@infra/notification-delivery';
import {
  getSavedGitHubPat,
  saveGitHubPat,
  clearSavedGitHubPat,
  probeGitHubPatUser,
} from '@features/projects/github-clone';

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
  /** Persists speech preferences. */
  onSpeechPreferencesChange?: (speech: Partial<any>) => void;
  /** Persists the default projects directory for browsing and cloning. */
  onDefaultProjectsDirectoryChange?: (directory: string | null) => void;
  settingsError: string | null;
  settingsStorageNotice: string | null;
  isBusy: boolean;
  onSaveAndApply: (e: React.FormEvent) => Promise<void> | void;
  onClose: () => void;
  initialTab?: 'general' | 'theme' | 'speech' | 'profiles' | 'providers' | 'mcp' | 'extensions';
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
  onDefaultProjectsDirectoryChange,
  onSpeechPreferencesChange,
  settingsError,
  settingsStorageNotice,
  isBusy,
  onSaveAndApply,
  onClose,
  initialTab = 'general',
  appearanceController,
  t,
  renderProviders,
  renderProfiles,
  renderMcp,
  renderExtensions,
  pickDirectoryFn,
  detectGentleShellFn,
}) => {
  const [activeTab, setActiveTab] = useState<'general' | 'theme' | 'speech' | 'profiles' | 'providers' | 'mcp' | 'extensions'>(initialTab);
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
  const [gitHubPat, setGitHubPat] = useState(() => getSavedGitHubPat());
  const [gitHubPatUser, setGitHubPatUser] = useState<string | null>(null);
  const [gitHubCliUser, setGitHubCliUser] = useState<string | null>(null);
  const [gitHubPatSaving, setGitHubPatSaving] = useState(false);
  const [gitHubPatSuccess, setGitHubPatSuccess] = useState(false);
  const [showGitHubPat, setShowGitHubPat] = useState(false);

  const [defaultProjectsDirDraft, setDefaultProjectsDirDraft] = useState(() => preferences.defaultProjectsDirectory || '');
  const [defaultProjectsDirSavedNotice, setDefaultProjectsDirSavedNotice] = useState(false);
  const [defaultProjectsDirCopied, setDefaultProjectsDirCopied] = useState(false);

  useEffect(() => {
    setDefaultProjectsDirDraft(preferences.defaultProjectsDirectory || '');
  }, [preferences.defaultProjectsDirectory]);

  useEffect(() => {
    const saved = getSavedGitHubPat();
    if (saved) {
      void probeGitHubPatUser(saved).then((user) => {
        if (user) setGitHubPatUser(user);
      });
    }
    void getGitHubAuthStatusPi()
      .then((status) => {
        if (status.authenticated && status.username) {
          setGitHubCliUser(status.username);
        }
      })
      .catch(() => {});
  }, []);

  const handleSaveGitHubPat = async () => {
    setGitHubPatSaving(true);
    setGitHubPatSuccess(false);
    const clean = gitHubPat.trim();
    saveGitHubPat(clean);
    if (clean) {
      const user = await probeGitHubPatUser(clean);
      setGitHubPatUser(user || null);
    } else {
      setGitHubPatUser(null);
    }
    setGitHubPatSaving(false);
    setGitHubPatSuccess(true);
    setTimeout(() => setGitHubPatSuccess(false), 2500);
  };

  const handleClearGitHubPat = () => {
    clearSavedGitHubPat();
    setGitHubPat('');
    setGitHubPatUser(null);
    setGitHubPatSuccess(false);
  };
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

  const handleBrowseDefaultProjectsDirectory = async () => {
    const pickFn = pickDirectoryFn || pickDirectoryPi;
    const selected = await pickFn(defaultProjectsDirDraft || preferences.defaultProjectsDirectory || undefined);
    if (selected) {
      setDefaultProjectsDirDraft(selected);
      onDefaultProjectsDirectoryChange?.(selected);
      setDefaultProjectsDirSavedNotice(true);
      setTimeout(() => setDefaultProjectsDirSavedNotice(false), 2500);
    }
  };

  const handleSaveDefaultProjectsDirectory = () => {
    const clean = defaultProjectsDirDraft.trim();
    onDefaultProjectsDirectoryChange?.(clean ? clean : null);
    setDefaultProjectsDirDraft(clean);
    setDefaultProjectsDirSavedNotice(true);
    setTimeout(() => setDefaultProjectsDirSavedNotice(false), 2500);
  };

  const handleClearDefaultProjectsDirectory = () => {
    onDefaultProjectsDirectoryChange?.(null);
    setDefaultProjectsDirDraft('');
    setDefaultProjectsDirSavedNotice(true);
    setTimeout(() => setDefaultProjectsDirSavedNotice(false), 2500);
  };

  const handleResetDefaultProjectsDirectory = () => {
    setDefaultProjectsDirDraft(preferences.defaultProjectsDirectory || '');
  };

  const handleCopyDefaultProjectsDirectory = async () => {
    const text = defaultProjectsDirDraft || preferences.defaultProjectsDirectory || '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setDefaultProjectsDirCopied(true);
      setTimeout(() => setDefaultProjectsDirCopied(false), 2000);
    } catch {
      // fallback
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
            aria-selected={activeTab === 'speech'}
            className={activeTab === 'speech' ? 'settings-tab-btn active' : 'settings-tab-btn'}
            onClick={() => setActiveTab('speech')}
          >
            Voz (TTS/STT)
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

        {/* Section 3: Connection Configuration */}
        <section className="settings-card-section connection-settings-card">
          <div className="connection-section-header">
            <div className="connection-section-header-titles">
              <h2 className="settings-section-title">
                {t('settings.connection_heading')}
              </h2>
              <span className="prompt-hint">
                {t('settings.connection_hint')}
              </span>
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm connection-reset-btn"
              onClick={handleResetBinaryPaths}
              disabled={binaryDiscoveryBusy}
              title={t('settings.reset_binary_paths_title')}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
              </svg>
              <span>{isResettingPaths ? t('settings.reset_binary_paths_detecting') : t('settings.reset_binary_paths')}</span>
            </button>
          </div>

          {binaryPathsNotice && (
            <div
              className={`connection-notice-banner ${binaryPathsNotice.type === 'error' ? 'is-error' : 'is-success'}`}
              role={binaryPathsNotice.type === 'error' ? 'alert' : 'status'}
              aria-live="polite"
            >
              <span className="connection-notice-icon" aria-hidden="true">
                {binaryPathsNotice.type === 'error' ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="12" y1="8" x2="12" y2="12"/>
                    <line x1="12" y1="16" x2="12.01" y2="16"/>
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                )}
              </span>
              <span className="connection-notice-message">{binaryPathsNotice.message}</span>
            </div>
          )}

          <form
            className="connection-form"
            onSubmit={onSaveAndApply}
          >
            <div className="connection-fields-grid">
              <div className="field-group connection-field-item">
                <div className="connection-field-header">
                  <label htmlFor="settings-node-path-input" className="field-label">
                    {t('settings.node_path_label')}
                  </label>
                  <span className="connection-field-tag">Runtime</span>
                </div>
                <div className="connection-input-wrapper">
                  <input
                    id="settings-node-path-input"
                    type="text"
                    className="field-input connection-input"
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
                <span className="field-subtext connection-field-hint">
                  {t('settings.node_path_title')}
                </span>
              </div>

              <div className="field-group connection-field-item">
                <div className="connection-field-header">
                  <label htmlFor="settings-pi-entry-input" className="field-label">
                    {t('settings.pi_entry_label')}
                  </label>
                  <span className="connection-field-tag">CLI</span>
                </div>
                <div className="connection-input-with-action">
                  <input
                    id="settings-pi-entry-input"
                    type="text"
                    className="field-input connection-input"
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
                    className="btn btn-secondary btn-sm connection-action-btn"
                    onClick={handleDetectGentleShell}
                    disabled={binaryDiscoveryBusy}
                    title={t('settings.btn_detect_gentle_shell_title')}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="11" cy="11" r="8"/>
                      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                    <span>
                      {isDetectingShell
                        ? t('settings.btn_detect_gentle_shell_detecting')
                        : t('settings.btn_detect_gentle_shell')}
                    </span>
                  </button>
                </div>
                {gentleShellNotice ? (
                  <span
                    className={`field-subtext ${
                      gentleShellNotice.type === 'success'
                        ? 'field-subtext-success'
                        : 'field-subtext-error'
                    }`}
                    role={gentleShellNotice.type === 'error' ? 'alert' : 'status'}
                    aria-live="polite"
                  >
                    {gentleShellNotice.message}
                  </span>
                ) : (
                  <span className="field-subtext connection-field-hint">
                    {t('settings.pi_entry_title')}
                  </span>
                )}
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

        {/* Section: Default Projects Directory */}
        <section className="settings-card-section">
          <div className="settings-projects-dir-header-row">
            <div className="settings-projects-dir-title-group">
              <span className="settings-projects-dir-icon" aria-hidden="true">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
              </span>
              <div>
                <h2 className="settings-section-title">
                  {t('settings.default_projects_dir_heading')}
                </h2>
                <span className="prompt-hint">
                  {t('settings.default_projects_dir_hint')}
                </span>
              </div>
            </div>

            {preferences.defaultProjectsDirectory ? (
              <div className="settings-projects-dir-status-badge is-configured">
                <span className="settings-projects-dir-status-dot" aria-hidden="true" />
                <span>{t('settings.default_projects_dir_status_configured')}</span>
              </div>
            ) : (
              <div className="settings-projects-dir-status-badge is-not-configured">
                <span>{t('settings.default_projects_dir_status_not_configured')}</span>
              </div>
            )}
          </div>

          <div className="field-group" style={{ marginTop: '12px' }}>
            <label htmlFor="settings-default-projects-dir-input" className="field-label">
              {t('projects.default_directory_label')}
            </label>

            <div className="settings-projects-dir-actions-row">
              <div className="settings-projects-dir-input-wrapper">
                <span className="settings-projects-dir-input-icon" aria-hidden="true">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                </span>
                <input
                  id="settings-default-projects-dir-input"
                  type="text"
                  className="field-input settings-projects-dir-input"
                  value={defaultProjectsDirDraft}
                  onChange={(e) => {
                    setDefaultProjectsDirDraft(e.target.value);
                    setDefaultProjectsDirSavedNotice(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleSaveDefaultProjectsDirectory();
                    }
                  }}
                  placeholder={t('projects.default_directory_placeholder')}
                  title={t('projects.default_directory_hint')}
                  spellCheck={false}
                  autoComplete="off"
                />
                {(defaultProjectsDirDraft.trim() || preferences.defaultProjectsDirectory) && (
                  <button
                    type="button"
                    className="settings-projects-dir-copy-btn"
                    onClick={handleCopyDefaultProjectsDirectory}
                    title={defaultProjectsDirCopied ? t('settings.default_projects_dir_copied') : t('settings.default_projects_dir_copy')}
                    aria-label={defaultProjectsDirCopied ? t('settings.default_projects_dir_copied') : t('settings.default_projects_dir_copy')}
                  >
                    {defaultProjectsDirCopied ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--status-green, #4ade80)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                    )}
                  </button>
                )}
              </div>

              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleBrowseDefaultProjectsDirectory}
                title={t('projects.default_directory_browse')}
              >
                {t('projects.default_directory_browse')}
              </button>

              {defaultProjectsDirDraft.trim() !== (preferences.defaultProjectsDirectory || '').trim() && (
                <>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={handleSaveDefaultProjectsDirectory}
                    title={t('settings.default_projects_dir_save')}
                  >
                    {t('settings.default_projects_dir_save')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={handleResetDefaultProjectsDirectory}
                    title={t('settings.default_projects_dir_reset')}
                  >
                    {t('settings.default_projects_dir_reset')}
                  </button>
                </>
              )}

              {(preferences.defaultProjectsDirectory || defaultProjectsDirDraft.trim()) &&
                defaultProjectsDirDraft.trim() === (preferences.defaultProjectsDirectory || '').trim() && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={handleClearDefaultProjectsDirectory}
                    title={t('projects.default_directory_clear')}
                  >
                    {t('projects.default_directory_clear')}
                  </button>
                )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '6px', flexWrap: 'wrap', gap: '8px' }}>
              <span className="field-subtext">{t('projects.default_directory_hint')}</span>
              {defaultProjectsDirSavedNotice && (
                <span
                  role="status"
                  aria-live="polite"
                  style={{
                    color: 'var(--status-green, #4ade80)',
                    fontSize: '12px',
                    fontWeight: 500,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  {t('settings.default_projects_dir_saved')}
                </span>
              )}
              {defaultProjectsDirDraft.trim() !== (preferences.defaultProjectsDirectory || '').trim() && !defaultProjectsDirSavedNotice && (
                <span
                  style={{
                    color: 'var(--status-warning, #f59e0b)',
                    fontSize: '12px',
                    fontWeight: 500,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                  }}
                >
                  ● {t('settings.default_projects_dir_unsaved')}
                </span>
              )}
            </div>

            <div className="settings-projects-dir-helper-box">
              <span>{t('settings.default_projects_dir_helper')}</span>
            </div>
          </div>
        </section>

        {/* Section: GitHub Integration (Personal Access Token) */}
        <section className="settings-card-section">
          <div className="settings-github-header-row">
            <div className="settings-github-title-group">
              <span className="settings-github-icon" aria-hidden="true">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
                  <path d="M9 18c-4.51 2-5-2-7-2" />
                </svg>
              </span>
              <div>
                <h2 className="settings-section-title">
                  {t('settings.github_heading')}
                </h2>
                <span className="prompt-hint">
                  {t('settings.github_hint')}
                </span>
              </div>
            </div>

            {gitHubPat.trim() && gitHubPatUser ? (
              <div className="settings-github-status-badge is-connected">
                <span className="settings-github-status-dot" aria-hidden="true" />
                <span>{t('settings.github_pat_authenticated', { user: gitHubPatUser })}</span>
              </div>
            ) : !gitHubPat.trim() && gitHubCliUser ? (
              <div className="settings-github-status-badge is-connected is-cli">
                <span className="settings-github-status-dot" aria-hidden="true" />
                <span>{t('settings.github_gh_authenticated', { user: gitHubCliUser })}</span>
              </div>
            ) : (
              <div className="settings-github-status-badge is-disconnected">
                <span>{t('settings.github_status_disconnected')}</span>
              </div>
            )}
          </div>

          <div className="field-group" style={{ marginTop: '4px' }}>
            <label htmlFor="settings-github-pat-input" className="field-label">
              {t('settings.github_pat_label')}
            </label>

            <div className="settings-github-actions-row">
              <div className="settings-github-input-wrapper">
                <span className="settings-github-input-icon" aria-hidden="true">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="7.5" cy="15.5" r="5.5" />
                    <path d="m21 2-9.6 9.6" />
                    <path d="m15.5 7.5 3 3L22 7l-3-3" />
                  </svg>
                </span>
                <input
                  id="settings-github-pat-input"
                  type={showGitHubPat ? 'text' : 'password'}
                  className="field-input settings-github-input"
                  style={{ width: '100%' }}
                  value={gitHubPat}
                  onChange={(e) => {
                    setGitHubPat(e.target.value);
                    setGitHubPatSuccess(false);
                  }}
                  placeholder={t('settings.github_pat_placeholder')}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="settings-github-visibility-btn"
                  onClick={() => setShowGitHubPat((prev) => !prev)}
                  title={showGitHubPat ? t('settings.github_pat_toggle_hide') : t('settings.github_pat_toggle_show')}
                  aria-label={showGitHubPat ? t('settings.github_pat_toggle_hide') : t('settings.github_pat_toggle_show')}
                >
                  {showGitHubPat ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                      <line x1="2" y1="2" x2="22" y2="22" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </div>

              <button
                type="button"
                className="btn btn-primary"
                onClick={handleSaveGitHubPat}
                disabled={gitHubPatSaving || !gitHubPat.trim()}
                title={t('settings.github_pat_save')}
              >
                {gitHubPatSaving ? '...' : t('settings.github_pat_save')}
              </button>

              {gitHubPat && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleClearGitHubPat}
                  disabled={gitHubPatSaving}
                  title={t('settings.github_pat_clear')}
                >
                  {t('settings.github_pat_clear')}
                </button>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '6px' }}>
              <a
                href="https://github.com/settings/tokens/new?scopes=repo&description=Open+Pi+Viewer"
                target="_blank"
                rel="noreferrer noopener"
                className="settings-github-generate-link"
              >
                <span>{t('settings.github_pat_generate')}</span>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </a>
            </div>

            {gitHubPatSuccess && (
              <span className="field-subtext" style={{ color: 'var(--status-green, #4ade80)', fontWeight: 500, marginTop: '4px' }}>
                ✓ {t('settings.github_pat_saved')}
              </span>
            )}
          </div>
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

      {activeTab === 'speech' && (
        <div className="settings-tab-pane" role="tabpanel" aria-label="Speech">
          <div className="settings-view-body">
            <SpeechSettingsSection
              preferences={preferences.speech || {
                ttsEnabled: false,
                sttEnabled: false,
                selectedTtsPackId: 'es_MX-claude-high',
                selectedSttPackId: 'es-kroko-64l',
              }}
              onSpeechPreferencesChange={(partial) => {
                onSpeechPreferencesChange?.(partial);
              }}
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
