/**
 * Safe Markdown Parser (Bounded Subset)
 *
 * Implements a strict, deterministic, and safe subset of Markdown:
 * - Headings 1-6 (# to ######)
 * - Fenced code blocks (``` or ~~~) with optional sanitized language info string
 * - Unclosed fence at EOF parsed as code block (for streaming assistant responses)
 * - Unordered lists (-, *, +) and ordered lists (1., 1)) with sub-list nesting
 * - Paragraphs with normalized line endings (CRLF and LF)
 * - Inline formatting: strong (** / __), emphasis (* / _), strong+emphasis (*** / ___),
 *   inline code (`...`), and safe links ([label](url))
 * - Unclosed inline delimiters remain literal text
 * - Strict URL validation allowing only http, https, and mailto schemes via URL parsing
 * - Unsafe or malformed links and raw HTML remain literal text escaped by React
 * - Bounded linear scanning avoiding catastrophic regex backtracking (ReDoS)
 */

import type { ChatMessage } from './types/messages';

export type InlineNode =
  | { type: 'text'; value: string }
  | { type: 'code_inline'; value: string }
  | { type: 'strong'; children: InlineNode[] }
  | { type: 'emphasis'; children: InlineNode[] }
  | { type: 'link'; label: InlineNode[]; href: string };

export interface ListItemNode {
  type: 'list_item';
  children: InlineNode[];
  subList?: ListBlockNode;
}

export interface HeadingBlockNode {
  type: 'heading';
  level: 1 | 2 | 3 | 4 | 5 | 6;
  children: InlineNode[];
}

export interface CodeBlockNode {
  type: 'code_block';
  language?: string;
  fileName?: string;
  filename?: string;
  title?: string;
  isDiff?: boolean;
  code: string;
}

export interface ParagraphBlockNode {
  type: 'paragraph';
  children: InlineNode[];
}

export interface ListBlockNode {
  type: 'list';
  ordered: boolean;
  start?: number;
  items: ListItemNode[];
}

export type TableAlign = 'left' | 'center' | 'right' | null;

export interface TableCellNode {
  children: InlineNode[];
  align?: TableAlign;
}

export interface TableBlockNode {
  type: 'table';
  headers: TableCellNode[];
  rows: TableCellNode[][];
}

/**
 * Maximum permitted recursion depth for nested list parsing.
 * Beyond this cap, deeply indented sub-lines are deterministically flattened into
 * the current list item's content, preventing stack overflow while preserving all text.
 */
export const MAX_LIST_NESTING_DEPTH = 6;

export type BlockNode =
  | HeadingBlockNode
  | CodeBlockNode
  | ParagraphBlockNode
  | ListBlockNode
  | TableBlockNode;

export interface MarkdownRoot {
  type: 'root';
  children: BlockNode[];
}

/**
 * Determines whether a message role should be rendered via the safe Markdown engine.
 * Only assistant messages are rendered as Markdown; user and system remain literal.
 */
export function shouldRenderAsMarkdown(role: string): boolean {
  return role === 'assistant';
}

export interface CodeFenceMeta {
  language?: string;
  fileName?: string;
  title?: string;
  isDiff?: boolean;
}

/**
 * Parses code fence info strings, extracting language, filename, title and diff categorization.
 * Supports formats like:
 * - ```typescript
 * - ```typescript:src/auth.ts
 * - ```rust filename="engine.rs"
 * - ```python title="Data Migration"
 * - ```main.go
 * - ```diff
 */
export function parseCodeFenceHeader(raw?: string): CodeFenceMeta {
  if (!raw || typeof raw !== 'string') return {};
  const trimmed = raw.trim();
  if (!trimmed) return {};

  let rawLang = '';
  let rawFileOrTitle = '';

  if (trimmed.includes(':')) {
    const colonIdx = trimmed.indexOf(':');
    rawLang = trimmed.slice(0, colonIdx).trim();
    rawFileOrTitle = trimmed.slice(colonIdx + 1).trim();
  } else if (/filename=["']?([^"'\r\n]+)["']?/i.test(trimmed)) {
    const match = trimmed.match(/filename=["']?([^"'\r\n]+)["']?/i);
    rawFileOrTitle = match ? match[1].trim() : '';
    rawLang = trimmed.split(/\s+/)[0].trim();
  } else if (/title=["']?([^"'\r\n]+)["']?/i.test(trimmed)) {
    const match = trimmed.match(/title=["']?([^"'\r\n]+)["']?/i);
    rawFileOrTitle = match ? match[1].trim() : '';
    rawLang = trimmed.split(/\s+/)[0].trim();
  } else if (trimmed.includes(' ')) {
    const parts = trimmed.split(/\s+/);
    rawLang = parts[0].trim();
    const rest = parts.slice(1).join(' ').trim();
    if (rest && !rest.startsWith('-')) {
      rawFileOrTitle = rest;
    }
  } else if (trimmed.includes('.') && !/^[a-zA-Z0-9_#-]+$/.test(trimmed)) {
    rawFileOrTitle = trimmed;
    rawLang = trimmed.split('.').pop() || '';
  } else {
    rawLang = trimmed;
  }

  const language = sanitizeLanguage(rawLang);
  const sanitizedFileOrTitle = rawFileOrTitle
    ? rawFileOrTitle.replace(/[\u0000-\u001f\u007f"']/g, '').slice(0, 128).trim()
    : undefined;

  const isDiff = language === 'diff' || language === 'patch' || language === 'gitcommit' || language === 'gitrebase';

  return {
    language,
    fileName: sanitizedFileOrTitle,
    title: sanitizedFileOrTitle,
    ...(isDiff ? { isDiff: true } : {}),
  };
}

/**
 * Sanitizes code fence language labels.
 * Strips out whitespace, HTML characters, and non-identifier symbols.
 * Bounded to 32 characters.
 */
export function sanitizeLanguage(raw?: string): string | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  const firstWord = raw.trim().split(/\s+/)[0];
  const cleaned = firstWord.replace(/[^a-zA-Z0-9_#+.-]/g, '').slice(0, 32);
  return cleaned.length > 0 ? cleaned.toLowerCase() : undefined;
}

/**
 * Maximum permitted length for external URL strings (2 KB / 2048 bytes).
 */
export const MAX_URL_LENGTH = 2048;

/**
 * Validates a URL against strict defense-in-depth presentation security policy:
 * - Must parse successfully via standard URL API
 * - Maximum length bounded to 2048 characters
 * - Rejects control characters and whitespace
 * - Disallows dangerous schemes (javascript, data, file, tauri, vbscript, etc.)
 * - Allowed schemes strictly: http, https, mailto
 * - Rejects user credentials (username/password) to ensure visible destination
 * - For http/https: requires valid non-empty host (standard path percent-encoding, ports, IPv6, fragments allowed)
 * - For mailto: rejects query parameters, fragments, percent-encoding (% entirely),
 *   multiple recipients (no commas), and requires valid simple single recipient with dotted domain
 */
export function isSafeUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_URL_LENGTH) return false;

  // Reject internal whitespace, newlines, or control characters
  if (/[\u0000-\u0020\u007f]/.test(trimmed)) return false;

  // Immediate prefix rejection for known dangerous schemes
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('javascript:') ||
    lower.startsWith('data:') ||
    lower.startsWith('file:') ||
    lower.startsWith('tauri:') ||
    lower.startsWith('vbscript:')
  ) {
    return false;
  }

  try {
    const parsed = new URL(trimmed);
    const proto = parsed.protocol.toLowerCase();
    if (proto !== 'http:' && proto !== 'https:' && proto !== 'mailto:') {
      return false;
    }

    // Reject user credentials (username/password) to eliminate destination spoofing
    if (parsed.username || parsed.password) {
      return false;
    }

    if (proto === 'http:' || proto === 'https:') {
      return Boolean(parsed.hostname && parsed.hostname.length > 0);
    }

    if (proto === 'mailto:') {
      // Reject query parameters / headers and fragments
      if (parsed.search || trimmed.includes('?') || parsed.hash || trimmed.includes('#')) {
        return false;
      }
      // Reject percent-encoded recipient content entirely for this MVP
      if (trimmed.includes('%')) {
        return false;
      }
      // Simple one-recipient policy: reject commas / multiple recipients
      if (trimmed.includes(',')) {
        return false;
      }

      const recipient = parsed.pathname.trim();
      if (!recipient) return false;

      // Must have exactly one '@'
      const atIndex = recipient.indexOf('@');
      if (atIndex <= 0 || atIndex !== recipient.lastIndexOf('@')) {
        return false;
      }

      const local = recipient.slice(0, atIndex);
      const domain = recipient.slice(atIndex + 1);
      if (!local || !domain) return false;

      // Reject forbidden/control/punctuation characters
      if (/[\s/\\?#"':;<>\[\]{}|`^~]/.test(recipient)) {
        return false;
      }

      // Dotted domain policy: domain must contain dot, not start/end with dot, no empty labels
      if (domain.startsWith('.') || domain.endsWith('.') || !domain.includes('.')) {
        return false;
      }
      if (domain.split('.').some((label) => label.length === 0)) {
        return false;
      }

      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Parses inline formatting with bounded linear recursion.
 * Delimiters without matching closures are kept as literal text.
 */
export function parseInline(input: string, depth = 0): InlineNode[] {
  if (!input) return [];
  if (depth > 6) {
    return [{ type: 'text', value: input }];
  }

  const nodes: InlineNode[] = [];
  let i = 0;
  let textBuffer = '';

  const flushText = () => {
    if (textBuffer.length > 0) {
      nodes.push({ type: 'text', value: textBuffer });
      textBuffer = '';
    }
  };

  while (i < input.length) {
    // 1. Inline code: `...`
    if (input[i] === '`') {
      const closeIdx = input.indexOf('`', i + 1);
      if (closeIdx !== -1) {
        flushText();
        const codeValue = input.slice(i + 1, closeIdx);
        nodes.push({ type: 'code_inline', value: codeValue });
        i = closeIdx + 1;
        continue;
      } else {
        // Unclosed inline backtick -> literal
        textBuffer += '`';
        i++;
        continue;
      }
    }

    // 2. Links: [label](url)
    if (input[i] === '[') {
      const closeBracket = input.indexOf(']', i + 1);
      if (closeBracket !== -1 && input[closeBracket + 1] === '(') {
        const closeParen = input.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          const rawUrl = input.slice(closeBracket + 2, closeParen).trim();
          if (isSafeUrl(rawUrl)) {
            flushText();
            const labelText = input.slice(i + 1, closeBracket);
            const labelNodes = parseInline(labelText, depth + 1);
            nodes.push({
              type: 'link',
              label: labelNodes.length > 0 ? labelNodes : [{ type: 'text', value: rawUrl }],
              href: rawUrl,
            });
            i = closeParen + 1;
            continue;
          }
        }
      }
      // Unclosed or unsafe link -> treat '[' as literal text
      textBuffer += '[';
      i++;
      continue;
    }

    // 2b. Bracketed autolinks: <https://...> or <http://...>
    if (input[i] === '<' && (input.startsWith('<http://', i) || input.startsWith('<https://', i))) {
      const closeIdx = input.indexOf('>', i + 1);
      if (closeIdx !== -1) {
        const rawUrl = input.slice(i + 1, closeIdx).trim();
        if (isSafeUrl(rawUrl)) {
          flushText();
          nodes.push({
            type: 'link',
            label: [{ type: 'text', value: rawUrl }],
            href: rawUrl,
          });
          i = closeIdx + 1;
          continue;
        }
      }
    }

    // 2c. Bare URL autolinks: https://... or http://...
    if (
      (input.startsWith('https://', i) || input.startsWith('http://', i)) &&
      (i === 0 || /[\s\(\[\{<"']/.test(input[i - 1]))
    ) {
      let endIdx = i;
      while (endIdx < input.length && !/[\s<>"'`\*\~]/.test(input[endIdx])) {
        endIdx++;
      }
      let rawUrl = input.slice(i, endIdx);
      while (rawUrl.length > 0 && /[.,;:!?)]/.test(rawUrl[rawUrl.length - 1])) {
        if (rawUrl.endsWith(')')) {
          const openParens = (rawUrl.match(/\(/g) || []).length;
          const closeParens = (rawUrl.match(/\)/g) || []).length;
          if (closeParens > openParens) {
            rawUrl = rawUrl.slice(0, -1);
            continue;
          }
          break;
        } else {
          rawUrl = rawUrl.slice(0, -1);
        }
      }

      if (rawUrl && isSafeUrl(rawUrl)) {
        flushText();
        nodes.push({
          type: 'link',
          label: [{ type: 'text', value: rawUrl }],
          href: rawUrl,
        });
        i += rawUrl.length;
        continue;
      }
    }

    // 3. Bold + Italic: ***...*** or ___...___
    if (input.startsWith('***', i)) {
      const closeIdx = input.indexOf('***', i + 3);
      if (closeIdx !== -1 && closeIdx > i + 3) {
        flushText();
        const inner = input.slice(i + 3, closeIdx);
        nodes.push({
          type: 'strong',
          children: [
            {
              type: 'emphasis',
              children: parseInline(inner, depth + 1),
            },
          ],
        });
        i = closeIdx + 3;
        continue;
      } else {
        textBuffer += input[i];
        i++;
        continue;
      }
    }
    if (input.startsWith('___', i)) {
      const closeIdx = input.indexOf('___', i + 3);
      if (closeIdx !== -1 && closeIdx > i + 3) {
        flushText();
        const inner = input.slice(i + 3, closeIdx);
        nodes.push({
          type: 'strong',
          children: [
            {
              type: 'emphasis',
              children: parseInline(inner, depth + 1),
            },
          ],
        });
        i = closeIdx + 3;
        continue;
      } else {
        textBuffer += input[i];
        i++;
        continue;
      }
    }

    // 4. Bold: **...** or __...__
    if (input.startsWith('**', i)) {
      const closeIdx = input.indexOf('**', i + 2);
      if (closeIdx !== -1 && closeIdx > i + 2) {
        flushText();
        const inner = input.slice(i + 2, closeIdx);
        nodes.push({
          type: 'strong',
          children: parseInline(inner, depth + 1),
        });
        i = closeIdx + 2;
        continue;
      } else {
        textBuffer += input[i];
        i++;
        continue;
      }
    }
    if (input.startsWith('__', i)) {
      const closeIdx = input.indexOf('__', i + 2);
      if (closeIdx !== -1 && closeIdx > i + 2) {
        flushText();
        const inner = input.slice(i + 2, closeIdx);
        nodes.push({
          type: 'strong',
          children: parseInline(inner, depth + 1),
        });
        i = closeIdx + 2;
        continue;
      } else {
        textBuffer += input[i];
        i++;
        continue;
      }
    }

    // 5. Italic: *...* or _..._
    if (input[i] === '*') {
      const closeIdx = input.indexOf('*', i + 1);
      if (closeIdx !== -1 && closeIdx > i + 1 && input[i + 1] !== '*') {
        flushText();
        const inner = input.slice(i + 1, closeIdx);
        nodes.push({
          type: 'emphasis',
          children: parseInline(inner, depth + 1),
        });
        i = closeIdx + 1;
        continue;
      }
    }
    if (input[i] === '_') {
      const closeIdx = input.indexOf('_', i + 1);
      if (closeIdx !== -1 && closeIdx > i + 1 && input[i + 1] !== '_') {
        flushText();
        const inner = input.slice(i + 1, closeIdx);
        nodes.push({
          type: 'emphasis',
          children: parseInline(inner, depth + 1),
        });
        i = closeIdx + 1;
        continue;
      }
    }

    // 6. Plain character (including raw HTML like <script> or <img>)
    textBuffer += input[i];
    i++;
  }

  flushText();
  return mergeAdjacentTextNodes(nodes);
}

function mergeAdjacentTextNodes(nodes: InlineNode[]): InlineNode[] {
  const merged: InlineNode[] = [];
  for (const node of nodes) {
    if (node.type === 'text') {
      const prev = merged[merged.length - 1];
      if (prev && prev.type === 'text') {
        prev.value += node.value;
      } else if (node.value.length > 0) {
        merged.push(node);
      }
    } else {
      merged.push(node);
    }
  }
  return merged;
}

interface ListItemMatch {
  indent: number;
  ordered: boolean;
  marker: string;
  startNum?: number;
  content: string;
}

function matchListItem(line: string): ListItemMatch | null {
  const expanded = line.replace(/\t/g, '  ');
  const indentMatch = expanded.match(/^( *)/);
  const indent = indentMatch ? indentMatch[1].length : 0;
  const trimmed = expanded.slice(indent);

  // Unordered list item: -, *, or + followed by space
  const unordMatch = trimmed.match(/^([-*+])\s+(.*)$/);
  if (unordMatch) {
    return {
      indent,
      ordered: false,
      marker: unordMatch[1],
      content: unordMatch[2],
    };
  }

  // Ordered list item: digits followed by . or ) and space
  const ordMatch = trimmed.match(/^(\d+)([.)])\s+(.*)$/);
  if (ordMatch) {
    return {
      indent,
      ordered: true,
      marker: ordMatch[2],
      startNum: parseInt(ordMatch[1], 10),
      content: ordMatch[3],
    };
  }

  return null;
}

function parseListBlock(
  lines: string[],
  startIndex: number,
  depth = 0
): { listBlock: ListBlockNode; nextIndex: number } {
  const firstMatch = matchListItem(lines[startIndex])!;
  const baseIndent = firstMatch.indent;
  const ordered = firstMatch.ordered;
  const start = ordered ? firstMatch.startNum : undefined;

  const items: ListItemNode[] = [];
  let i = startIndex;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      let peek = i + 1;
      while (peek < lines.length && lines[peek].trim() === '') {
        peek++;
      }
      if (peek < lines.length) {
        const nextMatch = matchListItem(lines[peek]);
        if (nextMatch && nextMatch.indent >= baseIndent) {
          i++;
          continue;
        }
      }
      break;
    }

    const itemMatch = matchListItem(line);
    if (itemMatch && itemMatch.indent === baseIndent) {
      let itemContent = itemMatch.content;
      const subLines: string[] = [];
      i++;

      // Accumulate indented sub-lines belonging to this item
      while (i < lines.length) {
        const subLine = lines[i];
        if (subLine.trim() === '') {
          let peek = i + 1;
          while (peek < lines.length && lines[peek].trim() === '') {
            peek++;
          }
          if (peek < lines.length) {
            const peekMatch = matchListItem(lines[peek]);
            if (peekMatch && peekMatch.indent > baseIndent) {
              subLines.push(subLine);
              i++;
              continue;
            }
          }
          break;
        }

        const subMatch = matchListItem(subLine);
        if (subMatch && subMatch.indent <= baseIndent) {
          break;
        }

        const subIndent = subLine.replace(/\t/g, '  ').match(/^( *)/)![1].length;
        if (subIndent > baseIndent) {
          subLines.push(subLine);
          i++;
        } else {
          break;
        }
      }

      let subList: ListBlockNode | undefined;
      if (subLines.length > 0) {
        if (depth < MAX_LIST_NESTING_DEPTH) {
          let firstSubIdx = 0;
          while (firstSubIdx < subLines.length && subLines[firstSubIdx].trim() === '') {
            firstSubIdx++;
          }
          if (firstSubIdx < subLines.length && matchListItem(subLines[firstSubIdx])) {
            subList = parseListBlock(subLines, firstSubIdx, depth + 1).listBlock;
          }
        } else {
          // Bounded recursion depth reached: deterministically flatten sub-lines into
          // the current item's text, avoiding call stack exhaustion and preventing content loss
          const extraText = subLines
            .map((l) => l.trim())
            .filter((l) => l.length > 0)
            .join(' ');
          if (extraText.length > 0) {
            itemContent = `${itemContent} ${extraText}`;
          }
        }
      }

      items.push({
        type: 'list_item',
        children: parseInline(itemContent),
        subList,
      });
    } else {
      break;
    }
  }

  return {
    listBlock: {
      type: 'list',
      ordered,
      start,
      items,
    },
    nextIndex: i,
  };
}

/**
 * Splits a Markdown table row line into trimmed cell contents, respecting inline code backticks.
 */
export function splitTableCells(line: string): string[] {
  let content = line.trim();
  if (content.startsWith('|')) {
    content = content.slice(1);
  }
  if (content.endsWith('|') && !content.endsWith('\\|')) {
    content = content.slice(0, -1);
  }

  const cells: string[] = [];
  let current = '';
  let inCode = false;

  for (let j = 0; j < content.length; j++) {
    const char = content[j];
    if (char === '`') {
      inCode = !inCode;
      current += char;
    } else if (char === '\\' && j + 1 < content.length && content[j + 1] === '|') {
      current += '|';
      j++;
    } else if (char === '|' && !inCode) {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

/**
 * Parses a table delimiter row (e.g. '| :--- | :---: | ---: |') into column alignments.
 */
export function parseTableDelimiter(line: string): TableAlign[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes('-')) return null;

  const cells = splitTableCells(trimmed);
  if (cells.length === 0) return null;

  const alignments: TableAlign[] = [];
  for (const cell of cells) {
    const m = cell.match(/^(:?)-+(:?)$/);
    if (!m) return null;
    const left = m[1] === ':';
    const right = m[2] === ':';
    if (left && right) alignments.push('center');
    else if (right) alignments.push('right');
    else if (left) alignments.push('left');
    else alignments.push(null);
  }
  return alignments;
}

/**
 * Main parser entrypoint.
 * Converts raw Markdown text into a typed Abstract Syntax Tree (AST).
 */
export function parseMarkdown(raw: string): MarkdownRoot {
  if (!raw || typeof raw !== 'string') {
    return { type: 'root', children: [] };
  }

  // Normalize CRLF and CR to LF
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');

  const blocks: BlockNode[] = [];
  let inCodeBlock = false;
  let codeFenceChar = '';
  let codeFenceLen = 0;
  let codeMeta: CodeFenceMeta = {};
  let codeLines: string[] = [];
  let paragraphLines: string[] = [];

  const flushParagraph = () => {
    if (paragraphLines.length > 0) {
      const joined = paragraphLines.join('\n');
      blocks.push({
        type: 'paragraph',
        children: parseInline(joined),
      });
      paragraphLines = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Inside a fenced code block
    if (inCodeBlock) {
      const closeMatch = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (
        closeMatch &&
        closeMatch[1][0] === codeFenceChar &&
        closeMatch[1].length >= codeFenceLen
      ) {
        // Closing fence found
        blocks.push({
          type: 'code_block',
          language: codeMeta.language,
          ...(codeMeta.fileName ? { fileName: codeMeta.fileName, filename: codeMeta.fileName } : {}),
          ...(codeMeta.title ? { title: codeMeta.title } : {}),
          ...(codeMeta.isDiff ? { isDiff: true } : {}),
          code: codeLines.join('\n'),
        });
        inCodeBlock = false;
        codeLines = [];
        codeMeta = {};
        i++;
        continue;
      } else {
        codeLines.push(line);
        i++;
        continue;
      }
    }

    // Check for opening code fence: at least 3 backticks or tildes
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      flushParagraph();
      inCodeBlock = true;
      codeFenceChar = fenceMatch[1][0];
      codeFenceLen = fenceMatch[1].length;
      codeMeta = parseCodeFenceHeader(fenceMatch[2]);
      codeLines = [];
      i++;
      continue;
    }

    // Check for heading: 1 to 6 # followed by space
    const headingMatch = line.match(/^ {0,3}(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      const level = headingMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6;
      const headingContent = headingMatch[2].trim();
      blocks.push({
        type: 'heading',
        level,
        children: parseInline(headingContent),
      });
      i++;
      continue;
    }

    // Check for list item
    const listMatch = matchListItem(line);
    if (listMatch) {
      flushParagraph();
      const { listBlock, nextIndex } = parseListBlock(lines, i);
      blocks.push(listBlock);
      i = nextIndex;
      continue;
    }

    // Check for GFM table
    if (line.includes('|') && i + 1 < lines.length && lines[i + 1].includes('-')) {
      const delimiterAlignments = parseTableDelimiter(lines[i + 1]);
      if (delimiterAlignments && delimiterAlignments.length > 0) {
        flushParagraph();
        const headerRawCells = splitTableCells(line);
        const colCount = delimiterAlignments.length;

        const headers: TableCellNode[] = [];
        for (let c = 0; c < colCount; c++) {
          const rawCell = headerRawCells[c] || '';
          headers.push({
            children: parseInline(rawCell),
            align: delimiterAlignments[c],
          });
        }

        const rows: TableCellNode[][] = [];
        let rIndex = i + 2;
        while (rIndex < lines.length) {
          const rowLine = lines[rIndex];
          if (!rowLine.trim() || !rowLine.includes('|')) {
            break;
          }
          const rawRowCells = splitTableCells(rowLine);
          const rowCells: TableCellNode[] = [];
          for (let c = 0; c < colCount; c++) {
            const rawCell = rawRowCells[c] || '';
            rowCells.push({
              children: parseInline(rawCell),
              align: delimiterAlignments[c],
            });
          }
          rows.push(rowCells);
          rIndex++;
        }

        blocks.push({
          type: 'table',
          headers,
          rows,
        });

        i = rIndex;
        continue;
      }
    }

    // Blank line
    if (line.trim() === '') {
      flushParagraph();
      i++;
      continue;
    }

    // Regular text line -> paragraph accumulation
    paragraphLines.push(line);
    i++;
  }

  // Handle unclosed fence at EOF: emit accumulated code lines as code_block
  if (inCodeBlock) {
    blocks.push({
      type: 'code_block',
      language: codeMeta.language,
      ...(codeMeta.fileName ? { fileName: codeMeta.fileName, filename: codeMeta.fileName } : {}),
      ...(codeMeta.title ? { title: codeMeta.title } : {}),
      ...(codeMeta.isDiff ? { isDiff: true } : {}),
      code: codeLines.join('\n'),
    });
  } else {
    flushParagraph();
  }

  return {
    type: 'root',
    children: blocks,
  };
}

/**
 * Extracts all non-diff code blocks from a Markdown text string.
 */
export function extractCodeBlocks(markdown: string): CodeBlockNode[] {
  if (!markdown || typeof markdown !== 'string') return [];
  const ast = parseMarkdown(markdown);
  const blocks: CodeBlockNode[] = [];
  for (const child of ast.children) {
    if (child.type === 'code_block' && !child.isDiff) {
      blocks.push(child);
    }
  }
  return blocks;
}

export function inferLanguageFromFilename(filename?: string): string | undefined {
  if (!filename || typeof filename !== 'string') return undefined;
  const dot = filename.lastIndexOf('.');
  if (dot === -1 || dot === filename.length - 1) return undefined;
  return filename.slice(dot + 1).toLowerCase();
}

export function isDiff(language?: string): boolean {
  if (!language || typeof language !== 'string') return false;
  const l = language.toLowerCase();
  return l === 'diff' || l === 'patch' || l === 'gitcommit' || l === 'gitrebase';
}

export function buildCopyAllCodeText(blocks: ReadonlyArray<any>): string | null {
  const executable = blocks.filter((b) => !b.isDiff);
  if (executable.length === 0) return null;
  return executable.map((b) => b.code).join('\n\n');
}

/**
 * Traverses backwards through messages to find the most recent assistant message
 * and extracts all non-diff code blocks from it.
 */
export function getLastAssistantCodeBlocks(messages: ChatMessage[]): CodeBlockNode[] {
  if (!messages || !Array.isArray(messages)) return [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      let combined = msg.content || '';
      if (msg.blocks && msg.blocks.length > 0) {
        const textFromBlocks = msg.blocks
          .filter((b) => b.type === 'text')
          .map((b) => (b as any).text)
          .join('\n');
        if (textFromBlocks) {
          combined = textFromBlocks;
        }
      }
      const blocks = extractCodeBlocks(combined);
      if (blocks.length > 0) {
        return blocks;
      }
    }
  }

  return [];
}
