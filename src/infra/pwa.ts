import { isTauri } from '@tauri-apps/api/core';

export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{
    outcome: 'accepted' | 'dismissed';
    platform: string;
  }>;
  prompt(): Promise<void>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const installListeners = new Set<(canInstall: boolean) => void>();

export function isPwaSupported(nav?: Navigator): boolean {
  if (isTauri()) return false;
  const currentNav = nav ?? (typeof navigator !== 'undefined' ? navigator : undefined);
  return Boolean(currentNav && 'serviceWorker' in currentNav);
}

export function registerPwaServiceWorker(options?: {
  navigatorObj?: Navigator;
  windowObj?: Window;
}): void {
  const currentWin = options?.windowObj ?? (typeof window !== 'undefined' ? window : undefined);
  const currentNav = options?.navigatorObj ?? (typeof navigator !== 'undefined' ? navigator : undefined);

  if (!currentWin || !currentNav) return;
  if (isTauri()) return;
  if (!('serviceWorker' in currentNav)) return;

  const register = () => {
    try {
      void currentNav.serviceWorker.register('/push-sw.js', { scope: '/' }).catch((err) => {
        // Safe logging for non-critical PWA registration failures (e.g. self-signed SSL or unsupported context)
        console.warn('PWA service worker registration failed:', err);
      });
    } catch (err) {
      console.warn('PWA service worker registration error:', err);
    }
  };

  if (currentWin.document && currentWin.document.readyState === 'complete') {
    register();
  } else if (typeof currentWin.addEventListener === 'function') {
    currentWin.addEventListener('load', register, { once: true });
  }

  if (typeof currentWin.addEventListener === 'function') {
    currentWin.addEventListener('beforeinstallprompt', (e: Event) => {
      // Prevent automatic mini-infobar on mobile if necessary and save deferred prompt
      deferredPrompt = e as BeforeInstallPromptEvent;
      for (const listener of installListeners) {
        try {
          listener(true);
        } catch {
          // Ignore listener error
        }
      }
    });

    currentWin.addEventListener('appinstalled', () => {
      deferredPrompt = null;
      for (const listener of installListeners) {
        try {
          listener(false);
        } catch {
          // Ignore listener error
        }
      }
    });
  }
}

export function getDeferredInstallPrompt(): BeforeInstallPromptEvent | null {
  return deferredPrompt;
}

export async function promptPwaInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!deferredPrompt) return 'unavailable';
  try {
    await deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    deferredPrompt = null;
    return choice.outcome;
  } catch {
    deferredPrompt = null;
    return 'unavailable';
  }
}

export function subscribePwaInstallAvailability(callback: (canInstall: boolean) => void): () => void {
  installListeners.add(callback);
  callback(deferredPrompt !== null);
  return () => {
    installListeners.delete(callback);
  };
}
