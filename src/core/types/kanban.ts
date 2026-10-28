export const KANBAN_COLUMNS = ['pending', 'in_progress', 'done'] as const;
export type KanbanColumnId = typeof KANBAN_COLUMNS[number];
export interface KanbanCard {
  id: string;
  title: string;
  description: string;
  columnId: KanbanColumnId;
}
export interface KanbanBoard { cards: KanbanCard[] }

/** Normalize only known fields. Reject invalid input before any filesystem writes. */
export function validateKanbanBoard(input: unknown): KanbanBoard {
  const board = input as KanbanBoard | null;
  if (!board || !Array.isArray(board.cards) || board.cards.length > 2000) {
    throw new Error('Invalid Kanban board: cards must be an array of at most 2000 items');
  }
  const ids = new Set<string>();
  return { cards: board.cards.map((card) => {
    if (!card || typeof card.id !== 'string' || !card.id.trim() || card.id.length > 128 || ids.has(card.id)) {
      throw new Error('Invalid Kanban card id');
    }
    if (typeof card.title !== 'string' || !card.title.trim() || card.title.length > 200) {
      throw new Error('Invalid Kanban card title (1–200 characters required)');
    }
    if (typeof card.description !== 'string' || card.description.length > 10000) {
      throw new Error('Invalid Kanban card description (maximum 10000 characters)');
    }
    if (!KANBAN_COLUMNS.includes(card.columnId)) throw new Error('Invalid Kanban column');
    ids.add(card.id);
    return { id: card.id, title: card.title.trim(), description: card.description, columnId: card.columnId };
  }) };
}
