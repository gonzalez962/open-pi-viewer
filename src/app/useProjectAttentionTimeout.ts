import { useEffect } from 'react';
import type { ProjectAttentionEvent } from '@features/chat/session-events';

/** Each visible toast gets its own lifetime, independent of the queued notices. */
export function useProjectAttentionTimeout(event: ProjectAttentionEvent | null, onDismiss: () => void): void {
  useEffect(() => {
    if (!event) return;
    const timer = setTimeout(onDismiss, 15_000);
    return () => clearTimeout(timer);
  }, [event, onDismiss]);
}
