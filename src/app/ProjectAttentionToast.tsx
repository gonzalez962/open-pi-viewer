import { getProjectDisplayName, type ProjectItem } from '@features/projects/projects';
import type { ProjectAttentionEvent } from '@features/chat/session-events';
import { translate, type SupportedLocale } from '@shared/i18n';

interface Props {
  event: ProjectAttentionEvent | null;
  projects: ProjectItem[];
  activeProjectId: string | null;
  isMobile: boolean;
  locale: SupportedLocale;
  onDismiss: () => void;
}

const tones = {
  task_complete: { color: '#86efac', background: '#102b20', border: '#28734b', icon: 'M5 12l4 4L19 6' },
  error: { color: '#fca5a5', background: '#35191d', border: '#94404b', icon: 'M12 8v5m0 3h.01' },
  waiting_input: { color: '#fcd34d', background: '#302611', border: '#92702b', icon: 'M12 7v5l3 2' },
};

export function ProjectAttentionToast({ event, projects, activeProjectId, isMobile, locale, onDismiss }: Props) {
  if (!event || !isMobile || event.projectId === activeProjectId) return null;
  const project = projects.find(item => item.id === event.projectId);
  if (!project) return null;
  const tone = tones[event.type];
  return (
    <div role="status" style={{
      position: 'fixed', top: 'calc(env(safe-area-inset-top) + 12px)',
      left: 'max(12px, env(safe-area-inset-left))', right: 'max(12px, env(safe-area-inset-right))',
      zIndex: 1000, display: 'flex', alignItems: 'center', gap: '12px', padding: '14px',
      borderRadius: '14px', border: `1px solid ${tone.border}`, background: tone.background,
      color: tone.color, boxShadow: '0 8px 28px #0005',
    }}>
      <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
        {event.type !== 'task_complete' && <circle cx="12" cy="12" r="9" />}
        <path d={tone.icon} />
      </svg>
      <span style={{ flex: 1, minWidth: 0, lineHeight: 1.4 }}>
        <strong style={{ display: 'block', fontSize: '14px', overflowWrap: 'anywhere' }}>{getProjectDisplayName(project)}</strong>
        <span style={{ display: 'block', marginTop: '2px', fontSize: '13px' }}>{translate(locale, `project_attention.${event.type}`)}</span>
      </span>
      <button type="button" aria-label={translate(locale, 'command_palette.toast_close')} onClick={onDismiss} style={{
        display: 'grid', placeItems: 'center', flexShrink: 0, width: '44px', height: '44px',
        padding: 0, border: '1px solid currentColor', borderRadius: '12px',
        background: 'transparent', color: 'inherit', cursor: 'pointer',
      }}>
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
  );
}
