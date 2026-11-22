import { isSameProjectPath, type ProjectItem } from './projects';

export function getProjectDockGroups(
  projects: ProjectItem[],
  order: string[],
  getPrimaryPath?: (path: string) => string | undefined,
): ProjectItem[][] {
  if (!getPrimaryPath) return projects.map(project => [project]);

  // A child belongs to a group only if its confirmed primary is visible.
  const children = new Map<string, ProjectItem[]>();
  const childIds = new Set<string>();
  for (const project of projects) {
    const primaryPath = getPrimaryPath(project.path);
    if (!primaryPath || isSameProjectPath(primaryPath, project.path)) continue;
    const parent = projects.find(candidate => isSameProjectPath(candidate.path, primaryPath));
    if (!parent) continue;
    children.set(parent.id, [...(children.get(parent.id) ?? []), project]);
    childIds.add(project.id);
  }
  const groups = projects.filter(project => !childIds.has(project.id))
    .map(project => [project, ...(children.get(project.id) ?? [])]);
  const ranks = new Map(order.map((id, index) => [id, index]));
  const rank = (group: ProjectItem[]) => Math.min(...group.map(project => ranks.get(project.id) ?? Infinity));
  return groups.sort((a, b) => rank(a) - rank(b) || 0);
}

// A ranked checkout hidden from the dock still belongs to its confirmed parent.
// Move that rank with the group so it cannot undo the move when it reappears.
export function includeHiddenWorktreeRanks(
  visibleOrder: string[],
  order: string[],
  projects: ProjectItem[],
  getPrimaryPath?: (path: string) => string | undefined,
): string[] {
  if (!getPrimaryPath) return visibleOrder;
  const visible = new Set(visibleOrder);
  const ranked = new Set(order);
  const groups = getProjectDockGroups(projects.filter(project => visible.has(project.id) || ranked.has(project.id)), [], getPrimaryPath);
  const hiddenByParent = new Map(groups.filter(([parent]) => visible.has(parent.id)).map(([parent, ...children]) => [
    parent.id, children.filter(child => !visible.has(child.id)).map(child => child.id),
  ]));
  return visibleOrder.flatMap(id => [id, ...(hiddenByParent.get(id) ?? [])]);
}

// Use every visible member's ID so a child's historical rank can't override the move.
export function moveProjectDockGroup(groups: ProjectItem[][], sourceId: string, toIndex: number): string[] | null {
  const fromIndex = groups.findIndex(([project]) => project.id === sourceId);
  if (fromIndex < 0 || fromIndex === toIndex || !Number.isInteger(toIndex) || toIndex < 0 || toIndex >= groups.length) return null;
  const moved = [...groups];
  const [group] = moved.splice(fromIndex, 1);
  moved.splice(toIndex, 0, group);
  return moved.flatMap(members => members.map(project => project.id));
}
