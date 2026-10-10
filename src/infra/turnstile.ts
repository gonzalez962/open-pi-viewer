/**
 * Turnstile Client Infrastructure.
 *
 * Provides script loading, widget rendering, and lifecycle controls
 * for Cloudflare Turnstile explicit rendering mode.
 * Never persists or logs tokens.
 */

export const TURNSTILE_SCRIPT_URL =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

export const TURNSTILE_DEFAULT_TIMEOUT_MS = 15000;

export interface TurnstileRenderOptions {
  sitekey: string;
  action?: string;
  cData?: string;
  callback?: (token: string) => void;
  'error-callback'?: (errorCode?: string | number) => void;
  'expired-callback'?: () => void;
  'timeout-callback'?: () => void;
  theme?: 'light' | 'dark' | 'auto';
  size?: 'normal' | 'compact' | 'flexible';
  tabindex?: number;
  'response-field'?: boolean;
  'response-field-name'?: string;
}

export interface TurnstileApi {
  render: (
    container: string | HTMLElement,
    options: TurnstileRenderOptions
  ) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId?: string) => void;
  getResponse?: (widgetId?: string) => string | undefined;
  ready?: (callback: () => void) => void;
}

export interface TurnstileLoadOptions {
  scriptUrl?: string;
  documentRef?: Document;
  timeoutMs?: number;
}

/**
 * Returns true if window.turnstile is available.
 */
export function isTurnstileAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as any).turnstile === 'object' &&
    (window as any).turnstile !== null
  );
}

/**
 * Returns the current window.turnstile API if available.
 */
export function getTurnstileApi(): TurnstileApi | undefined {
  if (isTurnstileAvailable()) {
    return (window as any).turnstile as TurnstileApi;
  }
  return undefined;
}

/**
 * Loads the official Cloudflare Turnstile script via explicit render URL.
 * Bounded by timeout (default 15s) and safe for retries: removes failed script tags
 * on error or timeout to allow clean reloads without hanging promises.
 * Resolves immediately if turnstile is already present on window.
 */
export function loadTurnstileScript(
  options?: TurnstileLoadOptions
): Promise<TurnstileApi> {
  const existingApi = getTurnstileApi();
  if (existingApi) {
    return Promise.resolve(existingApi);
  }

  const doc =
    options?.documentRef ??
    (typeof document !== 'undefined' ? document : undefined);

  if (!doc) {
    return Promise.reject(
      new Error('Document environment unavailable for Turnstile script loading')
    );
  }

  const scriptUrl = options?.scriptUrl ?? TURNSTILE_SCRIPT_URL;
  const timeoutMs = options?.timeoutMs ?? TURNSTILE_DEFAULT_TIMEOUT_MS;

  return new Promise<TurnstileApi>((resolve, reject) => {
    let timer: any = null;
    let settled = false;

    const cleanupElement = (el?: HTMLScriptElement | null) => {
      try {
        if (el && typeof el.remove === 'function') {
          el.remove();
        } else if (el && doc.head && typeof doc.head.removeChild === 'function') {
          doc.head.removeChild(el);
        }
      } catch {
        // ignore removal error
      }
    };

    const settleReject = (err: Error, el?: HTMLScriptElement | null) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      cleanupElement(el);
      reject(err);
    };

    const settleResolve = (api: TurnstileApi) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      resolve(api);
    };

    // Check if script is already present in DOM
    const existingScript = doc.querySelector(
      `script[src="${scriptUrl}"]`
    ) as HTMLScriptElement | null;

    if (existingScript && isTurnstileAvailable()) {
      settleResolve(getTurnstileApi()!);
      return;
    }

    const isNewScript = !existingScript;
    const script =
      existingScript ??
      (() => {
        const s = doc.createElement('script') as HTMLScriptElement;
        s.src = scriptUrl;
        s.async = true;
        s.defer = true;
        return s;
      })();

    const handleLoad = () => {
      cleanupListeners();
      const api = getTurnstileApi();
      if (api) {
        // load already guarantees availability. Cloudflare forbids ready()
        // with async/defer scripts, including this explicit-render loader.
        settleResolve(api);
      } else {
        settleReject(
          new Error('Turnstile API unavailable after script load'),
          script
        );
      }
    };

    const handleError = () => {
      cleanupListeners();
      settleReject(new Error('Failed to load Turnstile script'), script);
    };

    const cleanupListeners = () => {
      if (script.removeEventListener) {
        script.removeEventListener('load', handleLoad);
        script.removeEventListener('error', handleError);
      } else {
        script.onload = null;
        script.onerror = null;
      }
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        cleanupListeners();
        settleReject(
          new Error(`Turnstile script load timed out after ${timeoutMs}ms`),
          script
        );
      }, timeoutMs);
    }

    if (script.addEventListener) {
      script.addEventListener('load', handleLoad, { once: true });
      script.addEventListener('error', handleError, { once: true });
    } else {
      script.onload = handleLoad;
      script.onerror = handleError;
    }

    if (isNewScript) {
      (doc.head || doc.body || doc).appendChild(script);
    }
  });
}

/**
 * Explicitly renders a Turnstile widget into the target container.
 */
export function renderTurnstileWidget(
  container: HTMLElement,
  options: TurnstileRenderOptions,
  api?: TurnstileApi
): string {
  const activeApi = api ?? getTurnstileApi();
  if (!activeApi || typeof activeApi.render !== 'function') {
    throw new Error('Turnstile API not loaded or render unavailable');
  }
  return activeApi.render(container, options);
}

/**
 * Resets a Turnstile widget by widget ID.
 */
export function resetTurnstileWidget(
  widgetId?: string,
  api?: TurnstileApi
): void {
  const activeApi = api ?? getTurnstileApi();
  if (activeApi && typeof activeApi.reset === 'function') {
    activeApi.reset(widgetId);
  }
}

/**
 * Removes a Turnstile widget by widget ID.
 */
export function removeTurnstileWidget(
  widgetId?: string,
  api?: TurnstileApi
): void {
  const activeApi = api ?? getTurnstileApi();
  if (activeApi && typeof activeApi.remove === 'function') {
    activeApi.remove(widgetId);
  }
}
