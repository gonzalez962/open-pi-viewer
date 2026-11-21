import { isWebShim } from '@infra/web-oauth-access';
import { githubCredentialPi } from '@infra/viewer-storage';
import { isTauri } from '@tauri-apps/api/core';

export const GITHUB_PAT_STORAGE_KEY = 'pi_viewer_github_pat';

function resolveStorage(storage?: Storage | null): Storage | null {
  if (storage !== undefined) return storage;
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {}
  return null;
}

/**
 * Loads the saved GitHub Personal Access Token from persistent storage.
 */
export function getSavedGitHubPat(storage?: Storage | null): string {
  if (isWebShim()) return '';
  try {
    const store = resolveStorage(storage);
    return (store?.getItem(GITHUB_PAT_STORAGE_KEY) || '').trim();
  } catch {
    return '';
  }
}

/**
 * Persists a GitHub Personal Access Token to local storage for subsequent private repo clones.
 * If an empty or whitespace-only token is provided, the stored token is removed.
 */
export function saveGitHubPat(token: string, storage?: Storage | null): void | Promise<void> {
  if (isWebShim()) {
    if (!token.trim()) return Promise.reject(new Error('GitHub token required'));
    return githubCredentialPi('save_github_credential', token).then(status => { if (!status?.configured) throw new Error('GitHub credential operation failed'); });
  }
  if (typeof window !== 'undefined' && !isTauri()) return;
  try {
    const store = resolveStorage(storage);
    const clean = token.trim();
    if (clean) {
      store?.setItem(GITHUB_PAT_STORAGE_KEY, clean);
    } else {
      store?.removeItem(GITHUB_PAT_STORAGE_KEY);
    }
    // Fire-and-forget sync to server viewer storage
    if (typeof window !== 'undefined') {
      import('@infra/viewer-storage')
        .then(({ updateViewerStorageKeyPi }) => {
          void updateViewerStorageKeyPi('githubPat', clean || null);
        })
        .catch(() => {});
    }
  } catch {
    // Fail-safe ignore quota or security exceptions
  }
}

/**
 * Removes the saved GitHub Personal Access Token from persistent storage.
 */
export function clearSavedGitHubPat(storage?: Storage | null): void | Promise<void> {
  if (isWebShim()) return githubCredentialPi('clear_github_credential').then(() => {});
  if (typeof window !== 'undefined' && !isTauri()) return;
  try {
    const store = resolveStorage(storage);
    store?.removeItem(GITHUB_PAT_STORAGE_KEY);
    // Fire-and-forget sync to server viewer storage
    if (typeof window !== 'undefined') {
      import('@infra/viewer-storage')
        .then(({ updateViewerStorageKeyPi }) => {
          void updateViewerStorageKeyPi('githubPat', null);
        })
        .catch(() => {});
    }
  } catch {
    // Fail-safe ignore
  }
}

export async function probeGitHubPatUser(token: string): Promise<string | undefined> {
  const clean = token.trim();
  if (!clean) return undefined;
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${clean}`,
        'User-Agent': 'open-pi-viewer',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (res.ok) {
      const data: any = await res.json();
      if (data && typeof data.login === 'string') {
        return data.login;
      }
    }
  } catch {}
  return undefined;
}
