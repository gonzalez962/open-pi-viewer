export const PROJECT_ORDER_STORAGE_KEY = 'pi-viewer-project-order';

function cleanOrder(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0))] : [];
}

function defaultStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

export function loadProjectOrder(storage: Storage | null = defaultStorage()): string[] {
  try { return cleanOrder(JSON.parse(storage?.getItem(PROJECT_ORDER_STORAGE_KEY) ?? 'null')); } catch { return []; }
}

export function saveProjectOrder(order: string[], storage: Storage | null = defaultStorage()): void {
  try { storage?.setItem(PROJECT_ORDER_STORAGE_KEY, JSON.stringify(cleanOrder(order))); } catch { /* Storage can be unavailable. */ }
}

export function promoteProjectOrder(order: string[], id: string): string[] {
  return order.includes(id) ? order : cleanOrder([id, ...order]);
}
