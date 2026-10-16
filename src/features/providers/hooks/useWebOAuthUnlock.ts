import { useState, useCallback } from 'react';
import { authorizeWebOAuth } from '@infra/web-oauth-access';

// ---------------------------------------------------------------------------
// Dedicated React Hook for UI Unlock
// ---------------------------------------------------------------------------

export interface UseWebOAuthUnlockOptions {
  onUnlocked?: () => Promise<void> | void;
  authorizeFn?: typeof authorizeWebOAuth;
}

export interface UseWebOAuthUnlockResult {
  keyInput: string;
  setKeyInput: (val: string) => void;
  isAuthorizing: boolean;
  unlockError: string | null;
  unlockSuccess: boolean;
  submitUnlock: (explicitKey?: string) => Promise<boolean>;
  resetUnlock: () => void;
}

export function useWebOAuthUnlock(
  options: UseWebOAuthUnlockOptions = {}
): UseWebOAuthUnlockResult {
  const [keyInput, setKeyInput] = useState<string>('');
  const [isAuthorizing, setIsAuthorizing] = useState<boolean>(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [unlockSuccess, setUnlockSuccess] = useState<boolean>(false);

  const authFn = options.authorizeFn ?? authorizeWebOAuth;
  const onUnlocked = options.onUnlocked;

  const resetUnlock = useCallback(() => {
    setKeyInput('');
    setUnlockError(null);
    setUnlockSuccess(false);
  }, []);

  const submitUnlock = useCallback(
    async (explicitKey?: string): Promise<boolean> => {
      const targetKey = (explicitKey !== undefined ? explicitKey : keyInput).trim();
      // Browser sends key once then clears input immediately to prevent lingering in memory/UI
      setKeyInput('');

      if (!targetKey) {
        setUnlockError('Please enter an access key.');
        return false;
      }

      setIsAuthorizing(true);
      setUnlockError(null);

      try {
        const result = await authFn(targetKey);
        if (!result.ok) {
          setUnlockError(result.error || 'Authorization failed. Please check your access key.');
          setIsAuthorizing(false);
          return false;
        }

        setUnlockSuccess(true);
        setIsAuthorizing(false);
        if (onUnlocked) {
          try {
            await onUnlocked();
          } catch (refreshErr) {
            console.error('Error refreshing after unlock:', refreshErr);
          }
        }
        return true;
      } catch (err) {
        setUnlockError(err instanceof Error ? err.message : String(err));
        setIsAuthorizing(false);
        return false;
      }
    },
    [authFn, keyInput, onUnlocked]
  );

  return {
    keyInput,
    setKeyInput,
    isAuthorizing,
    unlockError,
    unlockSuccess,
    submitUnlock,
    resetUnlock,
  };
}
