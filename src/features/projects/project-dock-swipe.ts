export type ProjectDockTouchPoint = Pick<PointerEvent, 'pointerId' | 'clientX' | 'clientY'>;

export function getProjectDockSwipe(start: ProjectDockTouchPoint, end: ProjectDockTouchPoint) {
  if (start.pointerId !== end.pointerId) return null;
  const dx = end.clientX - start.clientX;
  const dy = end.clientY - start.clientY;
  if (Math.abs(dx) < 32 || Math.abs(dx) <= Math.abs(dy)) return null;
  return dx > 0 ? 'expand' : 'collapse';
}

type DockClick = Pick<MouseEvent, 'detail' | 'clientX' | 'clientY'> &
  Partial<Pick<PointerEvent, 'pointerType' | 'pointerId'>>;

export function isProjectDockSwipeClick(end: ProjectDockTouchPoint, click: DockClick) {
  if (click.detail === 0) return false; // Keyboard and assistive activation.
  if (click.pointerType) return click.pointerType === 'touch' && end.pointerId === click.pointerId;
  // Some browsers still deliver the compatibility click as a MouseEvent.
  return Math.abs(click.clientX - end.clientX) <= 1 && Math.abs(click.clientY - end.clientY) <= 1;
}
