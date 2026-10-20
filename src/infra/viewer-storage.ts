import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isWebShim } from './web-oauth-access';

export interface ViewerStoragePayload {
  version: number;
  connectConfig?: Record<string, unknown> | null;
  uiPreferences?: Record<string, unknown> | null;
  projects?: Record<string, unknown> | null;
  sessions?: Record<string, unknown> | null;
  profileSnapshots?: Record<string, unknown> | null;
  githubPat?: string | null;
  [key: string]: unknown;
}

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
const defaultInvoke: InvokeFn = invoke;

export async function getViewerStoragePi(
  invokeFn: InvokeFn = defaultInvoke
): Promise<ViewerStoragePayload | null> {
  if (!isTauri() && !isWebShim() && invokeFn === defaultInvoke) {
    return null;
  }
  try {
    return await invokeFn<ViewerStoragePayload>('get_viewer_storage');
  } catch (error) {
    console.warn('[ViewerStorage] get_viewer_storage failed:', error);
    return null;
  }
}

export async function saveViewerStoragePi(
  payload: Partial<ViewerStoragePayload>,
  invokeFn: InvokeFn = defaultInvoke
): Promise<ViewerStoragePayload | null> {
  if (!isTauri() && !isWebShim() && invokeFn === defaultInvoke) {
    return null;
  }
  try {
    return await invokeFn<ViewerStoragePayload>('save_viewer_storage', { payload });
  } catch (error) {
    console.warn('[ViewerStorage] save_viewer_storage failed:', error);
    return null;
  }
}

export async function updateViewerStorageKeyPi(
  key: string,
  value: unknown,
  invokeFn: InvokeFn = defaultInvoke
): Promise<ViewerStoragePayload | null> {
  if (!isTauri() && !isWebShim() && invokeFn === defaultInvoke) {
    return null;
  }
  try {
    return await invokeFn<ViewerStoragePayload>('update_viewer_storage_key', {
      payload: { key, value },
      key,
      value,
    });
  } catch (error) {
    console.warn(`[ViewerStorage] update_viewer_storage_key (${key}) failed:`, error);
    return null;
  }
}

/**
 * Subscribes to real-time storage sync updates in Tauri desktop environment.
 */
export async function listenViewerStorageUpdatesPi(
  onUpdate: (payload: ViewerStoragePayload) => void,
  listenFn: typeof listen = listen
): Promise<UnlistenFn> {
  if (!isTauri() && listenFn === listen) {
    return () => {};
  }
  return await listenFn<ViewerStoragePayload>('viewer://storage_updated', (event) => {
    if (event?.payload) {
      onUpdate(event.payload);
    }
  });
}

