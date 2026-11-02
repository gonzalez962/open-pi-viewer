export interface TodoTask {
  id: number;
  title: string;
  status: 'pending' | 'in_progress' | 'blocked' | 'done' | 'dropped';
  note?: string;
}

export interface TodoSnapshot {
  tasks: TodoTask[];
  nextId: number;
  updatedTurn: number | null;
}
