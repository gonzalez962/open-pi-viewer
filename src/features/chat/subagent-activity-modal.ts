import React from 'react';
import type { SubagentDetail } from '@core/types/agent-activity';
import { capitalize } from './agent-working-status';

type FocusTarget = Pick<HTMLElement, 'focus'> & Partial<Pick<HTMLElement, 'isConnected'>>;

export function SubagentActivityEntry({ tasks, taskId, onClick }: {
  tasks?: SubagentDetail[] | null;
  taskId?: string;
  onClick: (taskId: string, trigger: HTMLButtonElement) => void;
}) {
  const task = taskId === undefined ? tasks?.[0] : tasks?.find(item => item.id === taskId);
  if (!task) return null;
  return React.createElement('button', {
    type: 'button',
    className: 'working-subagent-trigger',
    'aria-haspopup': 'dialog',
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => onClick(task.id, event.currentTarget),
  }, capitalize(task.agent));
}

export function createSubagentActivityController(options: {
  getTasks: () => SubagentDetail[] | null | undefined;
  getOtherDialogOpen: () => boolean;
  getActiveElement: () => FocusTarget | null;
  setOpen: (value: boolean) => void;
  selectTask?: (taskId: string) => void;
}) {
  let open = false;
  let previous: FocusTarget | null = null;
  const close = (restore = true) => {
    if (!open) return;
    open = false;
    options.setOpen(false);
    if (restore && !options.getOtherDialogOpen() && previous?.isConnected !== false) previous?.focus();
    previous = null;
  };
  const onClick = (taskId?: string, trigger?: FocusTarget) => {
    const tasks = options.getTasks();
    if (open || options.getOtherDialogOpen() || !tasks?.length) return;
    if (taskId !== undefined && !tasks.some(task => task.id === taskId)) return;
    previous = trigger ?? options.getActiveElement();
    if (taskId !== undefined) options.selectTask?.(taskId);
    open = true;
    options.setOpen(true);
  };
  const onKeyDown = (event: Pick<KeyboardEvent, 'key' | 'altKey' | 'preventDefault' | 'stopPropagation'> & Partial<Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'repeat' | 'defaultPrevented'>>) => {
    if (event.defaultPrevented || options.getOtherDialogOpen()) return;
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) close();
    } else if (!event.repeat && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.altKey && event.key.toLowerCase() === 'a' && !open && options.getTasks()?.length) {
      event.preventDefault();
      onClick();
    }
  };
  return { onClick, onKeyDown, close };
}
