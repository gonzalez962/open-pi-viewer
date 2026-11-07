import type { SessionSummary } from '@core/types/sessions';

export function matchesSessionSearch(session: SessionSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (session.customTitle?.toLowerCase() ?? '').includes(q)
    || (session.firstMessage?.toLowerCase() ?? '').includes(q)
    || (session.id?.toLowerCase() ?? '').includes(q);
}

export function pageSessions(sessions: SessionSummary[], search: string, count: number) {
  const filtered = sessions.filter(session => matchesSessionSearch(session, search));
  return { filtered, visible: filtered.slice(0, count), hasMore: filtered.length > count };
}

export function updateSessionPage(
  state: { identity: string; search: string; count: number },
  identity: string,
  search: string,
  loadMore: boolean,
) {
  if (state.identity !== identity || state.search !== search) return { identity, search, count: 10 };
  return loadMore ? { ...state, count: state.count + 10 } : state;
}
