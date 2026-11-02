import React from 'react';
import type { SubagentTask } from '@core/types/agent-activity';
import type { TranslationKey } from '@shared/i18n';

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

export function SubagentActivityEntry({ tasks, onClick, t }: { tasks?: SubagentTask[] | null; onClick: () => void; t: Translate }) {
  if (!tasks?.length) return null;
  return React.createElement('button', { type: 'button', className: 'subagent-entry', onClick }, `${t('subagent.title')} (${tasks.length})`);
}

export function createSubagentActivityController(options: {
  getTasks: () => SubagentTask[] | null | undefined;
  getOtherDialogOpen: () => boolean;
  getActiveElement: () => { focus: () => void } | null;
  setOpen: (value: boolean) => void;
}) {
  let open = false;
  let previous: { focus: () => void } | null = null;
  const close = (restore = true) => {
    if (!open) return;
    open = false;
    options.setOpen(false);
    if (restore && !options.getOtherDialogOpen()) previous?.focus();
    previous = null;
  };
  const onClick = () => {
    if (open || options.getOtherDialogOpen() || !options.getTasks()?.length) return;
    previous = options.getActiveElement();
    open = true;
    options.setOpen(true);
  };
  const onKeyDown = (event: Pick<KeyboardEvent, 'key' | 'altKey' | 'preventDefault'> & Partial<Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'repeat' | 'defaultPrevented'>>) => {
    if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.shiftKey || options.getOtherDialogOpen()) return;
    if (event.key === 'Escape' && !event.altKey && open) { event.preventDefault(); close(); }
    else if (event.altKey && event.key.toLowerCase() === 'a' && !open && options.getTasks()?.length) { event.preventDefault(); onClick(); }
  };
  return { onClick, onKeyDown, close };
}
