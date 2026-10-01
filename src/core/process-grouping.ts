import type {
  ChatMessage,
  MessageBlock,
  ThinkingBlock,
  ToolCallBlock,
} from './types/messages';

export type ProcessCategory =
  | 'bash'
  | 'edit'
  | 'read'
  | 'write'
  | 'search'
  | 'agents'
  | 'thinking'
  | 'other';

export const PROCESS_CATEGORY_ORDER: readonly ProcessCategory[] = [
  'agents',
  'bash',
  'edit',
  'write',
  'read',
  'search',
  'thinking',
  'other',
] as const;

export type ProcessableBlock = ThinkingBlock | ToolCallBlock;

export interface ProcessItem {
  id: string;
  category: ProcessCategory;
  block: ToolCallBlock | ThinkingBlock;
  messageId: string;
  timestamp?: string;
}

export interface ProcessGroup {
  id: string;
  type: 'process_group';
  items: ProcessItem[];
  byCategory: Record<ProcessCategory, ProcessItem[]>;
  categoriesPresent: ProcessCategory[];
  totalCount: number;
  hasErrors: boolean;
  hasRunning: boolean;
  timestamp: string;

  // Backward compatibility with Issue #8 / origin/main
  blocks: ProcessableBlock[];
  categoryOrder: ProcessCategory[];
  counts: Partial<Record<ProcessCategory, number>>;
  total: number;
  hasError: boolean;
}

export interface PassthroughItem {
  type: 'block';
  block: MessageBlock;
}

export type RenderItem = PassthroughItem | ProcessGroup;

export type RenderableChatItem =
  | { type: 'message'; message: ChatMessage }
  | ProcessGroup;

/**
 * Categorizes a tool call or thinking block into one of the designated process categories:
 * - bash: terminal commands (bash, powershell, sh, terminal, exec)
 * - edit: file modifications (edit, patch, replace)
 * - read: reading files (read, cat, read_workspace_file)
 * - write: writing files (write, create_file)
 * - search: find & grep (grep, find, ls, codegraph)
 * - agents: subagents (subagent_run, subagent_status, agent, etc.)
 * - thinking: model reasoning blocks
 * - other: any other tools
 */
export function categorizeProcess(block: ToolCallBlock | ThinkingBlock): ProcessCategory {
  if (block.type === 'thinking') {
    return 'thinking';
  }

  const name = (block.name || '').toLowerCase().trim();

  // 1. Agents / Subagents
  if (
    name.startsWith('subagent') ||
    name === 'agent' ||
    name === 'subagent' ||
    name === 'sdd_agent'
  ) {
    return 'agents';
  }

  // 2. Terminal / Shell
  if (
    name === 'bash' ||
    name === 'powershell' ||
    name === 'sh' ||
    name === 'zsh' ||
    name === 'fish' ||
    name === 'terminal' ||
    name === 'exec_command' ||
    name === 'command'
  ) {
    return 'bash';
  }

  // 3. Edit
  if (
    name === 'edit' ||
    name === 'patch' ||
    name === 'replace' ||
    name === 'edit_file'
  ) {
    return 'edit';
  }

  // 4. Read
  if (
    name === 'read' ||
    name === 'read_file' ||
    name === 'cat' ||
    name === 'read_workspace_file'
  ) {
    return 'read';
  }

  // 5. Write
  if (
    name === 'write' ||
    name === 'write_file' ||
    name === 'create_file'
  ) {
    return 'write';
  }

  // 6. Search
  if (
    name === 'grep' ||
    name === 'find' ||
    name === 'find_files' ||
    name === 'ls' ||
    name === 'file_search' ||
    name.startsWith('codegraph')
  ) {
    return 'search';
  }

  return 'other';
}

export function categorizeToolName(name: unknown): ProcessCategory {
  if (typeof name !== 'string') return 'other';
  return categorizeProcess({
    type: 'tool_call',
    name,
    args: {},
    id: '',
    output: '',
    status: 'completed',
  });
}

export function categorizeBlock(block: ToolCallBlock | ThinkingBlock): ProcessCategory {
  return categorizeProcess(block);
}

/**
 * Checks if a tool name corresponds to an interactive question, choice, or permission tool
 * that directly converses with the human rather than executing an automated background task.
 */
export function isInteractiveUserTool(name?: string): boolean {
  if (!name || typeof name !== 'string') return false;
  const lower = name.toLowerCase().trim();
  return (
    lower === 'ask_user_question' ||
    lower === 'ask_user_choice' ||
    lower === 'ask_user_confirmation' ||
    lower === 'question'
  );
}

/**
 * Checks if an assistant message is a pure process message (only tools/thinking, no text content).
 */
export function isProcessOnlyAssistantMessage(msg: ChatMessage): boolean {
  if (msg.role !== 'assistant') return false;

  // Never consider a message containing interactive question/decision tools as a pure process message
  if (
    msg.blocks &&
    msg.blocks.some((b) => b.type === 'tool_call' && isInteractiveUserTool(b.name))
  ) {
    return false;
  }

  // If message has substantial content text
  const trimmed = (msg.content || '').trim();
  if (trimmed.length > 0) {
    // If blocks exist, check if there's any text block with non-empty content
    if (msg.blocks && msg.blocks.length > 0) {
      const hasText = msg.blocks.some(
        (b) => b.type === 'text' && b.text.trim().length > 0
      );
      if (hasText) return false;
    } else {
      // Content has text and no blocks -> standard text message
      return false;
    }
  }

  // If blocks exist, check if there is at least one tool call or thinking block
  if (msg.blocks && msg.blocks.length > 0) {
    return msg.blocks.some(
      (b) => b.type === 'tool_call' || b.type === 'thinking'
    );
  }

  return false;
}

/**
 * Extracts process items from an assistant message's blocks.
 */
export function extractProcessItemsFromMessage(msg: ChatMessage): ProcessItem[] {
  if (!msg.blocks || msg.blocks.length === 0) return [];

  const items: ProcessItem[] = [];
  msg.blocks.forEach((block, index) => {
    if (block.type === 'thinking') {
      items.push({
        id: `${msg.id}-thinking-${index}`,
        category: 'thinking',
        block,
        messageId: msg.id,
        timestamp: msg.timestamp,
      });
    } else if (block.type === 'tool_call') {
      // Interactive question/decision tools are directed to the user and must not be grouped into background processes
      if (isInteractiveUserTool(block.name)) {
        return;
      }
      items.push({
        id: block.id || `${msg.id}-tool-${index}`,
        category: categorizeProcess(block),
        block,
        messageId: msg.id,
        timestamp: msg.timestamp,
      });
    }
  });

  return items;
}

/**
 * Creates a structured ProcessGroup from an array of ProcessItem elements.
 */
export function createProcessGroup(id: string, items: ProcessItem[], timestamp: string): ProcessGroup {
  const byCategory: Record<ProcessCategory, ProcessItem[]> = {
    bash: [],
    edit: [],
    read: [],
    write: [],
    search: [],
    agents: [],
    thinking: [],
    other: [],
  };

  let hasErrors = false;
  let hasRunning = false;

  for (const item of items) {
    byCategory[item.category].push(item);
    if (item.block.type === 'tool_call') {
      if (item.block.status === 'error' || item.block.isError) {
        hasErrors = true;
      }
      if (item.block.status === 'running') {
        hasRunning = true;
      }
    } else if (item.block.type === 'thinking' && item.block.isStreaming) {
      hasRunning = true;
    }
  }

  // Order of categories present in declared logical sequence
  const categoryOrder: ProcessCategory[] = [
    'agents',
    'bash',
    'edit',
    'write',
    'read',
    'search',
    'thinking',
    'other',
  ];

  const categoriesPresent = categoryOrder.filter(
    (cat) => byCategory[cat].length > 0
  );

  const counts: Partial<Record<ProcessCategory, number>> = {};
  for (const cat of categoriesPresent) {
    counts[cat] = byCategory[cat].length;
  }

  return {
    id,
    type: 'process_group',
    items,
    byCategory,
    categoriesPresent,
    totalCount: items.length,
    hasErrors,
    hasRunning,
    timestamp,

    // Legacy compatibility fields
    blocks: items.map((i) => i.block),
    categoryOrder: categoriesPresent,
    counts,
    total: items.length,
    hasError: hasErrors,
  };
}

/**
 * Groups consecutive process items and assistant tool/thinking messages into compact ProcessGroup items.
 * Non-process messages (user, system) and conversational assistant text responses are preserved in place.
 * Ensures all process executions within a turn are unified into a single ProcessGroup rather than fragmented.
 *
 * @param messages The array of chat messages
 * @param compact Whether process compacting is active (retained for signature compatibility)
 */
export function groupChatMessages(
  messages: ChatMessage[],
  _compact = true
): RenderableChatItem[] {
  if (!messages || messages.length === 0) return [];

  const result: RenderableChatItem[] = [];
  let currentGroupItems: ProcessItem[] = [];
  let groupStartId = '';
  let groupTimestamp = '';

  const flushGroup = () => {
    if (currentGroupItems.length > 0) {
      result.push(createProcessGroup(groupStartId, currentGroupItems, groupTimestamp));
      currentGroupItems = [];
      groupStartId = '';
      groupTimestamp = '';
    }
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role !== 'assistant') {
      flushGroup();
      result.push({ type: 'message', message: msg });
      continue;
    }

    const items = extractProcessItemsFromMessage(msg);
    const hasInteractive =
      msg.blocks &&
      msg.blocks.some((b) => b.type === 'tool_call' && isInteractiveUserTool(b.name));
    const hasText =
      (msg.content || '').trim().length > 0 ||
      (msg.blocks && msg.blocks.some((b) => b.type === 'text' && (b as any).text.trim().length > 0));

    if (items.length > 0) {
      if (currentGroupItems.length === 0) {
        groupStartId = `proc-group-${msg.id}`;
        groupTimestamp = msg.timestamp;
      }
      currentGroupItems.push(...items);
    }

    if (hasText || hasInteractive) {
      flushGroup();
      // Keep only non-process blocks (e.g. text or interactive tool calls) on the conversational message
      const conversationalBlocks = msg.blocks
        ? msg.blocks.filter(
            (b) => b.type === 'text' || (b.type === 'tool_call' && isInteractiveUserTool(b.name))
          )
        : undefined;
      result.push({
        type: 'message',
        message: {
          ...msg,
          blocks:
            conversationalBlocks && conversationalBlocks.length > 0
              ? conversationalBlocks
              : undefined,
        },
      });
    }
  }

  flushGroup();
  return result;
}

export function groupMessageBlocks(blocks: ReadonlyArray<MessageBlock>): RenderItem[] {
  const items: RenderItem[] = [];
  let current: ProcessableBlock[] = [];
  let groupIndex = 0;

  const flush = () => {
    if (current.length === 0) return;
    const processItems: ProcessItem[] = current.map((b, idx) => ({
      id: b.type === 'tool_call' ? b.id : `thinking-${idx}`,
      category: categorizeProcess(b),
      block: b,
      messageId: `msg-${groupIndex}`,
    }));
    items.push(createProcessGroup(`proc-grp-${groupIndex++}`, processItems, ''));
    current = [];
  };

  for (const block of blocks) {
    if (block.type === 'thinking' || block.type === 'tool_call') {
      current.push(block);
    } else {
      flush();
      items.push({ type: 'block', block });
    }
  }
  flush();

  return items;
}

function toMergeableBlocks(message: ChatMessage): MessageBlock[] {
  if (message.blocks && message.blocks.length > 0) return message.blocks;
  return message.content.length > 0 ? [{ type: 'text', text: message.content }] : [];
}

export function mergeConsecutiveAssistantMessages(
  messages: ReadonlyArray<ChatMessage>
): ChatMessage[] {
  const result: ChatMessage[] = [];
  let run: ChatMessage[] = [];

  const flush = () => {
    if (run.length === 1) {
      result.push(run[0]);
    } else if (run.length > 1) {
      const blocks = run.flatMap(toMergeableBlocks);
      result.push({
        ...run[0],
        content: run
          .map((m) => m.content)
          .filter((c) => c.length > 0)
          .join('\n\n'),
        isStreaming: run[run.length - 1].isStreaming,
        isCancelled: run.some((m) => m.isCancelled) || undefined,
        blocks: blocks.length > 0 ? blocks : undefined,
      });
    }
    run = [];
  };

  for (const message of messages) {
    if (message.role === 'assistant') {
      run.push(message);
    } else {
      flush();
      result.push(message);
    }
  }
  flush();

  return result;
}
