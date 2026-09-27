/**
 * Process grouping (Issue #8): categorizes tool/thinking blocks and merges consecutive
 * runs of them into a single compact `ProcessGroup` per assistant message.
 *
 * Design decision: the reducer (see `src/core/reducer/tool-execution.ts` and
 * `messaging.ts`) accumulates every block of one agent turn — thinking, tool_call, and
 * text — into a single assistant `ChatMessage.blocks` array (it targets the active
 * assistant message and only creates a new one when none exists for the turn). Text
 * blocks are appended to that same array as they stream in, interleaved with process
 * blocks. Grouping therefore operates within one message's `blocks` array: it scans that
 * array once, merging consecutive `thinking`/`tool_call` blocks into a `ProcessGroup`, and
 * lets any `text` block flush the current group and pass through unchanged. This keeps
 * message headers/keys intact (grouping never spans multiple `ChatMessage`s) while still
 * compacting the flood of process blocks within a turn.
 *
 * Pure core module: no React, no Tauri, no outer-layer imports.
 */

import type { ChatMessage, MessageBlock, ThinkingBlock, ToolCallBlock } from './types/messages';

export type ProcessCategory =
  | 'bash'
  | 'edit'
  | 'read'
  | 'write'
  | 'search'
  | 'agents'
  | 'thinking'
  | 'other';

/** Stable display order for category badges/sections. */
export const PROCESS_CATEGORY_ORDER: readonly ProcessCategory[] = [
  'thinking',
  'bash',
  'read',
  'write',
  'edit',
  'search',
  'agents',
  'other',
];

export type ProcessableBlock = ThinkingBlock | ToolCallBlock;

/**
 * Categorizes a tool name into one of the compact process categories. Case-insensitive;
 * falls back to substring matching for search-like and agent-like tool name variants
 * (e.g. `grep_search`, `subagent_task`) so unfamiliar but conventionally-named tools still
 * group sensibly instead of always landing in `other`.
 */
export function categorizeToolName(name: unknown): ProcessCategory {
  if (typeof name !== 'string' || name.length === 0) return 'other';
  const n = name.toLowerCase();

  if (n === 'bash' || n === 'shell' || n === 'powershell' || n === 'sh' || n === 'zsh') {
    return 'bash';
  }
  if (n === 'edit' || n === 'multiedit' || n === 'multi_edit') {
    return 'edit';
  }
  if (n === 'write') {
    return 'write';
  }
  if (n === 'read') {
    return 'read';
  }
  if (
    n === 'grep' ||
    n === 'find' ||
    n === 'ls' ||
    n === 'glob' ||
    n.includes('search') ||
    n.includes('grep') ||
    n.includes('glob') ||
    n.includes('find')
  ) {
    return 'search';
  }
  if (n === 'task' || n.includes('agent') || n.includes('subagent') || n.includes('task')) {
    return 'agents';
  }
  return 'other';
}

/** Categorizes a thinking or tool_call block. */
export function categorizeBlock(block: ProcessableBlock): ProcessCategory {
  if (block.type === 'thinking') return 'thinking';
  return categorizeToolName(block.name);
}

function isProcessableBlock(block: MessageBlock): block is ProcessableBlock {
  return block.type === 'thinking' || block.type === 'tool_call';
}

/** A compacted run of consecutive process (thinking/tool_call) blocks. */
export interface ProcessGroup {
  type: 'process_group';
  /** Stable id for React keys, unique within the owning message's render items. */
  id: string;
  blocks: ProcessableBlock[];
  /** Categories present, in first-seen order (no duplicates). */
  categoryOrder: ProcessCategory[];
  /** Per-category activity count. */
  counts: Partial<Record<ProcessCategory, number>>;
  /** Total number of blocks in the group. */
  total: number;
  /** True when at least one contained tool_call block ended in error. */
  hasError: boolean;
}

/** A single passthrough block (currently only ever a `text` block reaches here). */
export interface PassthroughItem {
  type: 'block';
  block: MessageBlock;
}

export type RenderItem = PassthroughItem | ProcessGroup;

function buildGroup(blocks: ProcessableBlock[], index: number): ProcessGroup {
  const categoryOrder: ProcessCategory[] = [];
  const counts: Partial<Record<ProcessCategory, number>> = {};
  let hasError = false;

  for (const block of blocks) {
    const category = categorizeBlock(block);
    if (!categoryOrder.includes(category)) {
      categoryOrder.push(category);
    }
    counts[category] = (counts[category] ?? 0) + 1;
    if (block.type === 'tool_call' && block.isError) {
      hasError = true;
    }
  }

  const firstBlock = blocks[0];
  const idSeed = firstBlock.type === 'tool_call' ? firstBlock.id : `thinking-${index}`;

  return {
    type: 'process_group',
    id: `process-group-${index}-${idSeed}`,
    blocks,
    categoryOrder,
    counts,
    total: blocks.length,
    hasError,
  };
}

/**
 * Groups one message's blocks into render items: consecutive `thinking`/`tool_call`
 * blocks are merged into a single `ProcessGroup`; a `text` block flushes the current
 * group (if any) and passes through unchanged. Preserves original order.
 */
export function groupMessageBlocks(blocks: ReadonlyArray<MessageBlock>): RenderItem[] {
  const items: RenderItem[] = [];
  let current: ProcessableBlock[] = [];
  let groupIndex = 0;

  const flush = () => {
    if (current.length === 0) return;
    items.push(buildGroup(current, groupIndex++));
    current = [];
  };

  for (const block of blocks) {
    if (isProcessableBlock(block)) {
      current.push(block);
    } else {
      flush();
      items.push({ type: 'block', block });
    }
  }
  flush();

  return items;
}

/** A chat message paired with its grouped render items (process blocks compacted). */
export interface GroupedChatMessage {
  message: ChatMessage;
  renderItems: RenderItem[];
}

/**
 * Groups every message's blocks (see `groupMessageBlocks`). Messages without `blocks`
 * (e.g. plain-content messages) get an empty `renderItems` array; callers should keep
 * falling back to `message.content` in that case exactly as before this feature.
 */
export function groupChatMessages(
  messages: ReadonlyArray<ChatMessage>
): GroupedChatMessage[] {
  return messages.map((message) => ({
    message,
    renderItems: message.blocks ? groupMessageBlocks(message.blocks) : [],
  }));
}
