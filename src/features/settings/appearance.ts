import {
  DEFAULT_THEME,
  getSystemPreferredTheme,
  resolveTheme,
  watchSystemTheme,
  type ResolvedTheme,
} from '@shared/theme';
import {
  computeCustomThemeVariables,
  DEFAULT_WORK_ANIMATION_PREFERENCES,
  isValidHexColor,
  validateCustomBackgroundPreferences,
  validateWorkAnimationPreferences,
  type AppearanceInput,
  type AppearancePreferences,
  type PreferencesController,
  type PreferencesSaveResult,
  type WorkAnimationPreferences,
} from '@infra/preferences';

export interface AppearanceDomTarget {
  setAttribute(name: string, value: string): void;
  removeAttribute?(name: string): void;
  style: {
    colorScheme: string;
    setProperty(name: string, value: string): void;
    removeProperty(name: string): void;
    getPropertyValue?(name: string): string;
  };
}

export const MANAGED_APPEARANCE_VARIABLES: readonly string[] = [
  '--accent-primary',
  '--accent-primary-hover',
  '--border-active',
  '--fg-default',
  '--text-primary',
  '--activity-badge-fg',
  '--activity-badge-border',
  '--activity-badge-bg',
  '--md-inline-code-fg',
  '--md-inline-code-border',
  '--tag-color',
  '--syntax-keyword',
  '--bg-canvas',
  '--bg-surface',
  '--bg-subtle',
  '--bg-chat-viewport',
  '--bg-prompt',
  '--bg-input',
  '--bg-elevated',
  '--activity-card-bg',
  '--bg-user-bubble',
  '--loader-color1',
  '--loader-color1-border',
  '--loader-color1-glow',
  '--loader-color2',
  '--loader-color2-border',
  '--loader-color2-glow',
] as const;

export interface ApplyAppearanceOptions {
  rootElement?: AppearanceDomTarget | null;
  targetWindow?: Window | Pick<Window, 'matchMedia'> | null;
  systemPreferred?: ResolvedTheme;
}

/**
 * Applies the appearance configuration to the target DOM root:
 * 1. Sets data-theme attribute and color-scheme CSS property.
 * 2. Computes and sets all active custom CSS properties.
 * 3. Strips all inactive managed CSS properties cleanly.
 */
export function applyAppearance(
  appearance: AppearancePreferences,
  options?: ApplyAppearanceOptions
): void {
  const root =
    options?.rootElement !== undefined
      ? options.rootElement
      : (typeof document !== 'undefined' ? document.documentElement : null);

  if (!root) {
    return;
  }

  const targetTheme = appearance.theme ?? DEFAULT_THEME;
  const sysPreferred =
    options?.systemPreferred ??
    (options?.targetWindow !== undefined
      ? getSystemPreferredTheme(options.targetWindow ?? undefined)
      : undefined);

  const resolved = resolveTheme(targetTheme, sysPreferred);
  root.setAttribute('data-theme', resolved);
  root.style.colorScheme = resolved === 'light' ? 'light' : 'dark';

  const nextVars = computeCustomThemeVariables(appearance);

  for (const varName of MANAGED_APPEARANCE_VARIABLES) {
    if (Object.prototype.hasOwnProperty.call(nextVars, varName)) {
      root.style.setProperty(varName, nextVars[varName]);
    } else {
      root.style.removeProperty(varName);
    }
  }

  // Handle any additional dynamic properties not listed in static array
  for (const [key, value] of Object.entries(nextVars)) {
    if (!MANAGED_APPEARANCE_VARIABLES.includes(key as any)) {
      root.style.setProperty(key, value);
    }
  }
}

/**
 * Removes all managed custom appearance CSS variables from the target DOM root.
 */
export function clearAppearanceCustomVariables(
  target?: AppearanceDomTarget | null
): void {
  const root =
    target !== undefined
      ? target
      : (typeof document !== 'undefined' ? document.documentElement : null);

  if (!root) {
    return;
  }

  for (const varName of MANAGED_APPEARANCE_VARIABLES) {
    root.style.removeProperty(varName);
  }
}

function areWorkAnimationsEqual(
  a?: WorkAnimationPreferences,
  b?: WorkAnimationPreferences
): boolean {
  const modeA = a?.mode ?? DEFAULT_WORK_ANIMATION_PREFERENCES.mode;
  const modeB = b?.mode ?? DEFAULT_WORK_ANIMATION_PREFERENCES.mode;
  const c1A = a?.color1 ?? DEFAULT_WORK_ANIMATION_PREFERENCES.color1;
  const c1B = b?.color1 ?? DEFAULT_WORK_ANIMATION_PREFERENCES.color1;
  const c2A = a?.color2 ?? DEFAULT_WORK_ANIMATION_PREFERENCES.color2;
  const c2B = b?.color2 ?? DEFAULT_WORK_ANIMATION_PREFERENCES.color2;

  if (modeA !== modeB) return false;
  if (modeA === 'single' && c1A !== c1B) return false;
  if (modeA === 'dual' && (c1A !== c1B || c2A !== c2B)) return false;
  return true;
}

/**
 * Pure helper to determine whether an active draft differs from saved preferences.
 */
export function isAppearanceDirty(
  saved: AppearancePreferences,
  draft: AppearanceInput | null
): boolean {
  if (!draft) {
    return false;
  }

  // Theme comparison
  if (draft.theme !== undefined && draft.theme !== (saved.theme ?? DEFAULT_THEME)) {
    return true;
  }

  // Accent comparison (null or empty string normalized to null/unset)
  if ('customAccent' in draft) {
    const savedAccent =
      saved.customAccent && isValidHexColor(saved.customAccent)
        ? saved.customAccent.trim()
        : null;
    const draftAccent =
      draft.customAccent && isValidHexColor(draft.customAccent)
        ? draft.customAccent.trim()
        : null;
    if (draftAccent !== savedAccent) {
      return true;
    }
  }

  // Text color comparison
  if ('customTextColor' in draft) {
    const savedText =
      saved.customTextColor && isValidHexColor(saved.customTextColor)
        ? saved.customTextColor.trim()
        : '';
    const draftText =
      draft.customTextColor && isValidHexColor(draft.customTextColor)
        ? draft.customTextColor.trim()
        : '';
    if (draftText !== savedText) {
      return true;
    }
  }

  // Label color comparison
  if ('customLabelColor' in draft) {
    const savedLabel =
      saved.customLabelColor && isValidHexColor(saved.customLabelColor)
        ? saved.customLabelColor.trim()
        : '';
    const draftLabel =
      draft.customLabelColor && isValidHexColor(draft.customLabelColor)
        ? draft.customLabelColor.trim()
        : '';
    if (draftLabel !== savedLabel) {
      return true;
    }
  }

  // Work animation comparison
  if ('workAnimation' in draft) {
    if (!areWorkAnimationsEqual(saved.workAnimation, draft.workAnimation ?? undefined)) {
      return true;
    }
  }

  // Background comparison
  if ('customBackground' in draft) {
    const savedBgStr = JSON.stringify(saved.customBackground ?? {});
    const draftBgStr = JSON.stringify(draft.customBackground ?? {});
    if (savedBgStr !== draftBgStr) {
      return true;
    }
  }

  return false;
}

/**
 * Derives the effective appearance merging saved appearance with active draft overrides.
 */
export function computeEffectiveAppearance(
  saved: AppearancePreferences,
  draft: AppearanceInput | null,
  isDrafting: boolean
): AppearancePreferences {
  if (!isDrafting || !draft) {
    return { ...saved };
  }

  const effective: AppearancePreferences = {
    theme: draft.theme !== undefined ? draft.theme : (saved.theme ?? DEFAULT_THEME),
  };

  if ('customAccent' in draft) {
    effective.customAccent = draft.customAccent;
  } else if (saved.customAccent !== undefined) {
    effective.customAccent = saved.customAccent;
  }

  if ('customTextColor' in draft) {
    if (draft.customTextColor) {
      effective.customTextColor = draft.customTextColor;
    }
  } else if (saved.customTextColor) {
    effective.customTextColor = saved.customTextColor;
  }

  if ('customLabelColor' in draft) {
    if (draft.customLabelColor) {
      effective.customLabelColor = draft.customLabelColor;
    }
  } else if (saved.customLabelColor) {
    effective.customLabelColor = saved.customLabelColor;
  }

  if ('workAnimation' in draft) {
    if (draft.workAnimation) {
      effective.workAnimation = draft.workAnimation;
    }
  } else if (saved.workAnimation) {
    effective.workAnimation = saved.workAnimation;
  }

  if ('customBackground' in draft) {
    if (draft.customBackground) {
      effective.customBackground = draft.customBackground;
    }
  } else if (saved.customBackground) {
    effective.customBackground = saved.customBackground;
  }

  return effective;
}

export interface AppearanceLifecycleState {
  isDrafting: boolean;
  isDirty: boolean;
  draft: AppearanceInput | null;
  saved: AppearancePreferences;
  effectiveAppearance: AppearancePreferences;
  systemPreferred: 'dark' | 'light';
  error: string | null;
}

export interface AppearanceLifecycleControllerOptions {
  getSavedAppearance: () => AppearancePreferences;
  commitAppearance?: (candidate: AppearanceInput) => PreferencesSaveResult;
  resetAppearance?: () => PreferencesSaveResult;
  preferencesController?: PreferencesController;
  rootElement?: AppearanceDomTarget | null;
  targetWindow?: Window | Pick<Window, 'matchMedia'> | null;
  systemPreferred?: ResolvedTheme;
  onStateChange?: (state: AppearanceLifecycleState) => void;
}

/**
 * Production lifecycle controller orchestrating appearance draft sessions,
 * live preview without storage writes, cancel/unmount restoration, system theme events,
 * and atomic confirmation via PreferencesController.
 */
export class AppearanceLifecycleController {
  private state: AppearanceLifecycleState;
  private unwatchSystem: (() => void) | null = null;
  private listeners: Set<(state: AppearanceLifecycleState) => void> = new Set();
  private isDisposed = false;
  private isActive = false;

  constructor(private readonly options: AppearanceLifecycleControllerOptions) {
    const initialSaved = options.getSavedAppearance();
    const initialSysPreferred =
      (options.systemPreferred === 'light' || options.systemPreferred === 'dark')
        ? options.systemPreferred
        : getSystemPreferredTheme(options.targetWindow ?? undefined);

    this.state = {
      isDrafting: false,
      isDirty: false,
      draft: null,
      saved: { ...initialSaved },
      effectiveAppearance: { ...initialSaved },
      systemPreferred: initialSysPreferred,
      error: null,
    };

    if (options.onStateChange) {
      this.listeners.add(options.onStateChange);
    }
    // Constructor is pure: no DOM mutations and no global listeners attached here
  }

  /**
   * Activates the controller within an effect lifecycle:
   * Attaches the media-query system watcher and applies current appearance to the DOM.
   * Idempotent and StrictMode-safe.
   */
  start(): this {
    if (this.isDisposed || this.isActive) {
      return this;
    }
    this.isActive = true;

    this.setupSystemWatcher();
    this.applyToDom(this.state.effectiveAppearance);
    return this;
  }

  activate(): this {
    return this.start();
  }

  /**
   * Deactivates the controller without terminal disposal:
   * Tears down system media-query listeners and restores saved appearance to DOM if drafting.
   * Can be re-activated safely across React StrictMode effect setup/cleanup cycles.
   */
  stop(): void {
    if (this.isDisposed || !this.isActive) {
      return;
    }

    if (this.state.isDrafting) {
      this.applyToDom(this.state.saved);
    }

    this.isActive = false;

    if (this.unwatchSystem) {
      this.unwatchSystem();
      this.unwatchSystem = null;
    }
  }

  deactivate(): void {
    this.stop();
  }

  get isControllerActive(): boolean {
    return this.isActive;
  }

  private setupSystemWatcher(): void {
    if (this.unwatchSystem) {
      this.unwatchSystem();
      this.unwatchSystem = null;
    }

    this.unwatchSystem = watchSystemTheme((systemTheme) => {
      if (this.isDisposed) return;
      this.state.systemPreferred = systemTheme;

      const currentEffective = this.getEffectiveAppearance();
      const currentTheme = currentEffective.theme ?? DEFAULT_THEME;

      if (currentTheme === 'system') {
        this.applyToDom(currentEffective);
      }

      this.notify();
    }, this.options.targetWindow as Window | undefined);
  }

  private applyToDom(appearance: AppearancePreferences): void {
    if (!this.isActive) return;
    applyAppearance(appearance, {
      rootElement: this.options.rootElement,
      targetWindow: this.options.targetWindow,
      systemPreferred: this.state.systemPreferred,
    });
  }

  private notify(): void {
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Safe dispatch: errors in listeners must not corrupt lifecycle state
      }
    }
  }

  getState(): AppearanceLifecycleState {
    return {
      ...this.state,
      saved: { ...this.state.saved },
      draft: this.state.draft ? { ...this.state.draft } : null,
      effectiveAppearance: { ...this.state.effectiveAppearance },
    };
  }

  getEffectiveAppearance(): AppearancePreferences {
    return computeEffectiveAppearance(
      this.state.saved,
      this.state.draft,
      this.state.isDrafting
    );
  }

  subscribe(listener: (state: AppearanceLifecycleState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Updates saved appearance reference.
   * If an active draft preview is running, DOM is NOT overwritten to protect the user's preview.
   * If no draft is active, DOM is updated immediately to reflect saved changes.
   */
  setSavedAppearance(nextSaved: AppearancePreferences): void {
    if (this.isDisposed) return;
    this.state.saved = { ...nextSaved };

    if (!this.state.isDrafting) {
      this.state.effectiveAppearance = { ...this.state.saved };
      this.state.isDirty = false;
      this.applyToDom(this.state.effectiveAppearance);
    } else {
      this.state.isDirty = isAppearanceDirty(this.state.saved, this.state.draft);
      this.state.effectiveAppearance = this.getEffectiveAppearance();
    }

    this.notify();
  }

  /**
   * Begins a draft preview session. Does NOT persist to storage.
   */
  begin(initialDraft?: AppearanceInput): void {
    if (this.isDisposed) return;

    this.state.isDrafting = true;
    this.state.error = null;
    this.state.draft = initialDraft
      ? { ...initialDraft }
      : { ...this.state.saved };

    this.state.isDirty = isAppearanceDirty(this.state.saved, this.state.draft);
    this.state.effectiveAppearance = this.getEffectiveAppearance();

    this.applyToDom(this.state.effectiveAppearance);
    this.notify();
  }

  /**
   * Updates the active draft preview.
   * Merges partial changes while strictly preserving explicit null accent semantics.
   * Applies preview variables to DOM immediately without writing to storage.
   */
  update(partial: AppearanceInput): void {
    if (this.isDisposed) return;

    if (!this.state.isDrafting) {
      this.state.isDrafting = true;
      this.state.draft = { ...this.state.saved };
    }

    const currentDraft: AppearanceInput = this.state.draft ? { ...this.state.draft } : {};

    if (partial.theme !== undefined) {
      currentDraft.theme = partial.theme;
    }

    if ('customAccent' in partial) {
      if (partial.customAccent === null || partial.customAccent === '') {
        currentDraft.customAccent = null;
      } else if (isValidHexColor(partial.customAccent)) {
        currentDraft.customAccent = partial.customAccent.trim();
      } else {
        currentDraft.customAccent = null;
      }
    }

    if ('customTextColor' in partial) {
      if (partial.customTextColor === null || partial.customTextColor === '') {
        delete currentDraft.customTextColor;
      } else if (isValidHexColor(partial.customTextColor)) {
        currentDraft.customTextColor = partial.customTextColor.trim();
      } else {
        delete currentDraft.customTextColor;
      }
    }

    if ('customLabelColor' in partial) {
      if (partial.customLabelColor === null || partial.customLabelColor === '') {
        delete currentDraft.customLabelColor;
      } else if (isValidHexColor(partial.customLabelColor)) {
        currentDraft.customLabelColor = partial.customLabelColor.trim();
      } else {
        delete currentDraft.customLabelColor;
      }
    }

    if ('workAnimation' in partial) {
      if (partial.workAnimation === null) {
        delete currentDraft.workAnimation;
      } else if (partial.workAnimation !== undefined) {
        currentDraft.workAnimation = validateWorkAnimationPreferences(partial.workAnimation);
      }
    }

    if ('customBackground' in partial) {
      if (partial.customBackground === null) {
        delete currentDraft.customBackground;
      } else if (partial.customBackground !== undefined) {
        const validatedBg = validateCustomBackgroundPreferences(partial.customBackground);
        if (validatedBg) {
          currentDraft.customBackground = validatedBg;
        } else {
          delete currentDraft.customBackground;
        }
      }
    }

    this.state.draft = currentDraft;
    this.state.isDirty = isAppearanceDirty(this.state.saved, this.state.draft);
    this.state.effectiveAppearance = this.getEffectiveAppearance();

    this.applyToDom(this.state.effectiveAppearance);
    this.notify();
  }

  /**
   * Confirms and persists the active draft using the atomic commit API once.
   * On failure: retains draft state and preview in DOM; reports honest error.
   * On success: aligns saved appearance with committed values, closes draft, and updates DOM.
   */
  confirm(): PreferencesSaveResult {
    if (this.isDisposed) {
      return { success: false, error: 'Controller is disposed' };
    }

    if (!this.state.isDrafting || !this.state.draft) {
      return { success: true };
    }

    const candidate: AppearanceInput = { ...this.state.draft };

    const commitFn =
      this.options.commitAppearance ??
      (this.options.preferencesController
        ? (c) => this.options.preferencesController!.commitAppearance(c)
        : undefined);

    if (!commitFn) {
      const err = 'No commitAppearance handler configured';
      this.state.error = err;
      this.notify();
      return { success: false, error: err };
    }

    const result = commitFn(candidate);

    if (!result.success) {
      this.state.error = result.error ?? 'Failed to persist appearance';
      this.notify();
      return result;
    }

    // Commit succeeded: align base and close draft
    this.state.error = null;
    this.state.isDrafting = false;
    this.state.draft = null;
    this.state.isDirty = false;

    // Pull latest saved state
    this.state.saved = { ...this.options.getSavedAppearance() };
    this.state.effectiveAppearance = { ...this.state.saved };

    this.applyToDom(this.state.effectiveAppearance);
    this.notify();
    return result;
  }

  /**
   * Cancels the active draft session.
   * Discards all uncommitted draft changes and restores the latest saved appearance,
   * cleanly removing all preview-only inline custom CSS variables from the DOM.
   */
  cancel(): void {
    if (this.isDisposed) return;

    this.state.isDrafting = false;
    this.state.draft = null;
    this.state.isDirty = false;
    this.state.error = null;

    // Revert to latest saved appearance
    this.state.effectiveAppearance = { ...this.state.saved };
    this.applyToDom(this.state.effectiveAppearance);
    this.notify();
  }

  /**
   * Atomically resets visual customizations to defaults.
   * Distinct from cancel: this calls the atomic resetAppearance API to persist defaults.
   */
  resetAppearance(): PreferencesSaveResult {
    if (this.isDisposed) {
      return { success: false, error: 'Controller is disposed' };
    }

    const resetFn =
      this.options.resetAppearance ??
      (this.options.preferencesController
        ? () => this.options.preferencesController!.resetAppearance()
        : undefined);

    if (!resetFn) {
      const err = 'No resetAppearance handler configured';
      this.state.error = err;
      this.notify();
      return { success: false, error: err };
    }

    const result = resetFn();

    if (!result.success) {
      this.state.error = result.error ?? 'Failed to reset appearance';
      this.notify();
      return result;
    }

    this.state.error = null;
    this.state.isDrafting = false;
    this.state.draft = null;
    this.state.isDirty = false;

    this.state.saved = { ...this.options.getSavedAppearance() };
    this.state.effectiveAppearance = { ...this.state.saved };

    this.applyToDom(this.state.effectiveAppearance);
    this.notify();
    return result;
  }

  /**
   * Disposes the controller idempotently:
   * Restores latest saved appearance to DOM if a draft preview was active,
   * unregisters the system media query watcher, and unsubscribes all listeners.
   */
  dispose(): void {
    if (this.isDisposed) return;
    this.stop();
    this.isDisposed = true;

    if (this.state.isDrafting) {
      this.state.isDrafting = false;
      this.state.draft = null;
      this.state.isDirty = false;
    }

    this.listeners.clear();
  }
}
