import type { ChatMessage, ToolCallBlock, ThinkingBlock } from './types/messages';

/**
 * Sanitizes session title to be safe for filenames.
 */
export function sanitizeFilename(title?: string, fallback = 'session'): string {
  if (!title || !title.trim()) return fallback;
  const cleaned = title
    .trim()
    .toLowerCase()
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 50);
  return cleaned || fallback;
}

/**
 * Generates an export filename based on the session title, timestamp and format.
 */
export function generateExportFilename(title?: string, format: 'md' | 'json' = 'md'): string {
  const safeName = sanitizeFilename(title, 'pi-conversation');
  const dateStr = new Date().toISOString().slice(0, 10);
  return `${safeName}-${dateStr}.${format}`;
}

/**
 * Formats a chat message into readable Markdown lines.
 */
function formatMessageAsMarkdown(msg: ChatMessage): string {
  const roleTitle =
    msg.role === 'user' ? '👤 User' : msg.role === 'assistant' ? '🤖 Assistant' : '⚙️ System';
  const header = `### ${roleTitle} — *${msg.timestamp}*\n`;

  const bodyParts: string[] = [];

  if (msg.blocks && msg.blocks.length > 0) {
    for (const block of msg.blocks) {
      if (block.type === 'thinking') {
        const tb = block as ThinkingBlock;
        if (tb.thinking) {
          bodyParts.push(`> 💭 **Reasoning**\n> \n> ${tb.thinking.replace(/\n/g, '\n> ')}`);
        }
      } else if (block.type === 'tool_call') {
        const tc = block as ToolCallBlock;
        const argStr = tc.args
          ? typeof tc.args === 'string'
            ? tc.args
            : JSON.stringify(tc.args, null, 2)
          : '';
        const outputStr = tc.output ? `\n\n\`\`\`\n${tc.output}\n\`\`\`` : '';
        bodyParts.push(
          `<details>\n<summary>🔧 <code>${tc.name}</code> (${tc.status})</summary>\n\n\`\`\`json\n${argStr}\n\`\`\`${outputStr}\n</details>`
        );
      } else if (block.type === 'text') {
        bodyParts.push(block.text);
      }
    }
  } else if (msg.content) {
    bodyParts.push(msg.content);
  }

  return `${header}\n${bodyParts.join('\n\n')}\n\n---\n`;
}

/**
 * Exports conversation history into clean, structured Markdown.
 */
export function exportToMarkdown(messages: ChatMessage[], sessionTitle?: string): string {
  const title = sessionTitle ? `# ${sessionTitle}\n\n` : '# Pi Conversation Export\n\n';
  const meta = `*Exported on ${new Date().toLocaleString()}*\n\n---\n\n`;

  const renderedMessages = (messages || [])
    .filter((m) => m && (m.content || (m.blocks && m.blocks.length > 0)))
    .map(formatMessageAsMarkdown)
    .join('\n');

  return `${title}${meta}${renderedMessages}`;
}

/**
 * Exports conversation history into formatted JSON.
 */
export function exportToJson(messages: ChatMessage[], sessionTitle?: string): string {
  return JSON.stringify(
    {
      title: sessionTitle || 'Pi Conversation',
      exportedAt: new Date().toISOString(),
      messages: messages || [],
    },
    null,
    2
  );
}
