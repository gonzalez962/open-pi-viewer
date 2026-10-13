/** Loaded only in the native desktop runtime, never by web delivery. */
export async function loadNativeNotifications() {
  return import('@tauri-apps/plugin-notification');
}
