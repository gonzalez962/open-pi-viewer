import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppearanceLifecycleController,
  type AppearanceDomTarget,
  type AppearanceLifecycleState,
} from '@features/settings/appearance';
import type {
  AppearanceInput,
  AppearancePreferences,
  PreferencesSaveResult,
} from '@infra/preferences';

export interface UseAppearanceDraftOptions {
  controller?: AppearanceLifecycleController | null;
  getSavedAppearance?: () => AppearancePreferences;
  commitAppearance?: (candidate: AppearanceInput) => PreferencesSaveResult;
  resetAppearance?: () => PreferencesSaveResult;
  rootElement?: AppearanceDomTarget | null;
  targetWindow?: Window | Pick<Window, 'matchMedia'> | null;
}

export interface UseAppearanceDraftResult {
  draft: AppearanceInput | null;
  saved: AppearancePreferences;
  effectiveAppearance: AppearancePreferences;
  isDrafting: boolean;
  isDirty: boolean;
  systemPreferred: 'dark' | 'light';
  error: string | null;
  begin: (initialDraft?: AppearanceInput) => void;
  update: (partial: AppearanceInput) => void;
  confirm: () => PreferencesSaveResult;
  cancel: () => void;
  resetAppearance: () => PreferencesSaveResult;
  controller: AppearanceLifecycleController;
}

/**
 * Thin React hook connecting UI customizer components to the AppearanceLifecycleController.
 * Ensures preview styles never persist, cancel/unmount restores latest saved appearance,
 * and component state reacts deterministically to lifecycle updates.
 */
export function useAppearanceDraft(
  controllerOrOptions?: AppearanceLifecycleController | UseAppearanceDraftOptions
): UseAppearanceDraftResult {
  const isExternalInstance =
    controllerOrOptions instanceof AppearanceLifecycleController;

  const passedExternalController = isExternalInstance
    ? controllerOrOptions
    : (controllerOrOptions as UseAppearanceDraftOptions | undefined)?.controller ?? null;

  const isOwned = !passedExternalController;

  // Options ref keeps owned controller callbacks synced without recreating controller across re-renders
  const optionsRef = useRef<UseAppearanceDraftOptions | undefined>(
    !isExternalInstance ? (controllerOrOptions as UseAppearanceDraftOptions | undefined) : undefined
  );
  optionsRef.current = !isExternalInstance
    ? (controllerOrOptions as UseAppearanceDraftOptions | undefined)
    : undefined;

  const ownedControllerRef = useRef<AppearanceLifecycleController | null>(null);
  if (isOwned && !ownedControllerRef.current) {
    ownedControllerRef.current = new AppearanceLifecycleController({
      getSavedAppearance: () => optionsRef.current?.getSavedAppearance?.() ?? ({ theme: 'dark' }),
      commitAppearance: (c) => optionsRef.current?.commitAppearance?.(c) ?? {
        success: false,
        error: 'No commitAppearance handler configured',
      },
      resetAppearance: () => optionsRef.current?.resetAppearance?.() ?? {
        success: false,
        error: 'No resetAppearance handler configured',
      },
      rootElement: optionsRef.current?.rootElement,
      targetWindow: optionsRef.current?.targetWindow,
    });
  }

  const controller = passedExternalController ?? ownedControllerRef.current!;
  const [state, setState] = useState<AppearanceLifecycleState>(() => controller.getState());

  useEffect(() => {
    // Owned controller is activated inside this effect; external controllers are managed by their owner
    if (isOwned) {
      controller.start();
    }

    // Initial resync after activation
    setState(controller.getState());

    // Synchronize React state with controller state updates
    const unsubscribe = controller.subscribe((nextState) => {
      setState(nextState);
    });

    return () => {
      unsubscribe();
      if (isOwned) {
        // Stop owned controller: tears down watcher and restores saved appearance
        controller.stop();
      } else if (controller.getState().isDrafting) {
        // Discard unconfirmed preview on unmount to restore persisted appearance without stopping external watcher
        controller.cancel();
      }
    };
  }, [controller, isOwned]);

  const begin = useCallback((initialDraft?: AppearanceInput) => {
    controller.begin(initialDraft);
  }, [controller]);

  const update = useCallback((partial: AppearanceInput) => {
    controller.update(partial);
  }, [controller]);

  const confirm = useCallback((): PreferencesSaveResult => {
    return controller.confirm();
  }, [controller]);

  const cancel = useCallback(() => {
    controller.cancel();
  }, [controller]);

  const resetAppearance = useCallback((): PreferencesSaveResult => {
    return controller.resetAppearance();
  }, [controller]);

  return {
    draft: state.draft,
    saved: state.saved,
    effectiveAppearance: state.effectiveAppearance,
    isDrafting: state.isDrafting,
    isDirty: state.isDirty,
    systemPreferred: state.systemPreferred,
    error: state.error,
    begin,
    update,
    confirm,
    cancel,
    resetAppearance,
    controller,
  };
}
