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

export function appendProjectOrder(order: string[], id: string): string[] {
  return !id || order.includes(id) ? order : [...order, id];
}

export function mergeVisibleProjectOrder(order: string[], visibleOrder: string[]): string[] {
  const visible = cleanOrder(visibleOrder);
  const visibleIds = new Set(visible);
  // Fill existing visible slots first and leave every unrelated ID in place.
  let index = 0;
  const next = order.map(id => visibleIds.has(id) ? visible[index++] : id);
  next.push(...visible.slice(index));
  return next.length === order.length && next.every((id, i) => id === order[i]) ? order : next;
}
