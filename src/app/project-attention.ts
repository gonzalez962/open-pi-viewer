import type { ProjectAttentionEvent } from '@features/chat/session-events';

export interface AttentionContext {
  projects: readonly { id: string }[];
  activeProjectId: string | null;
  isMobile: boolean;
}

function isEligible(event: ProjectAttentionEvent, context: AttentionContext): boolean {
  return context.isMobile && event.projectId !== context.activeProjectId &&
    context.projects.some(project => project.id === event.projectId);
}

export function pruneAttention(events: ProjectAttentionEvent[], context: AttentionContext): ProjectAttentionEvent[] {
  return events.filter(event => isEligible(event, context));
}

export function enqueueAttention(events: ProjectAttentionEvent[], event: ProjectAttentionEvent, context: AttentionContext): ProjectAttentionEvent[] {
  if (!isEligible(event, context)) return events;
  return [...pruneAttention(events, context), event].slice(-3);
}
