interface ScrollPosition {
  top: number;
  pinned: boolean;
}

function key(projectId: string, sessionId: string): string {
  return `chat-scroll:${JSON.stringify([projectId, sessionId])}`;
}

export function readScrollPosition(projectId: string, sessionId: string): ScrollPosition | null {
  try {
    const value = JSON.parse(localStorage.getItem(key(projectId, sessionId)) ?? 'null');
    return value && typeof value.top === 'number' && Number.isFinite(value.top) && value.top >= 0 && typeof value.pinned === 'boolean'
      ? { top: value.top, pinned: value.pinned }
      : null;
  } catch {
    return null;
  }
}

export function saveScrollPosition(projectId: string, sessionId: string, position: ScrollPosition): void {
  try {
    localStorage.setItem(key(projectId, sessionId), JSON.stringify(position));
  } catch {
    // Storage may be unavailable or full; scrolling must still work.
  }
}
