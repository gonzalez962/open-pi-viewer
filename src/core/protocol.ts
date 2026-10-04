import type {
  AssistantMessageDelta,
  AuthoritativeMessage,
  ExtensionUiRequest,
  ExtensionUiResponsePayload,
  MessageContentBlock,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  ToolExecutionUpdateEvent,
} from './types/events';
import type { ImageContent, MessageBlock } from './types/messages';

/** Maximum record buffer size (16 MB) */
export const MAX_RECORD_SIZE = 16 * 1024 * 1024;

/**
 * Strict LF JSONL Parser.
 *
 * Adheres to docs/rpc.md specifications:
 * - Splits records on LF (`\n`, `0x0A`) only.
 * - Accept optional `\r\n` input by stripping trailing `\r`.
 * - Does not use generic line readers that split on Unicode separators (U+2028, U+2029).
 * - Correctly preserves multi-byte UTF-8 characters across chunk boundaries.
 * - Enforces bounded buffer size to prevent memory exhaustion.
 */
export class JsonlParser {
  private buffer: Uint8Array = new Uint8Array(0);
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });
  private readonly maxBufferSize: number;

  constructor(maxBufferSize: number = MAX_RECORD_SIZE) {
    this.maxBufferSize = maxBufferSize;
  }

  /**
   * Feed raw bytes (Uint8Array) into the parser and extract parsed JSON objects.
   */
  public feedBytes(chunk: Uint8Array): Array<Record<string, unknown>> {
    if (this.buffer.length + chunk.length > this.maxBufferSize) {
      throw new Error(
        `JsonlParser buffer exceeded maximum record size of ${this.maxBufferSize} bytes`
      );
    }

    // Concatenate existing buffer with new chunk
    const combined = new Uint8Array(this.buffer.length + chunk.length);
    combined.set(this.buffer);
    combined.set(chunk, this.buffer.length);
    this.buffer = combined;

    const results: Array<Record<string, unknown>> = [];
    let start = 0;

    // Scan for \n (0x0A)
    for (let i = 0; i < this.buffer.length; i++) {
      if (this.buffer[i] === 0x0a) {
        // Line ends at i
        let end = i;
        // Strip trailing \r (0x0D) if present
        if (end > start && this.buffer[end - 1] === 0x0d) {
          end--;
        }

        if (end > start) {
          const lineBytes = this.buffer.subarray(start, end);
          const lineStr = this.decoder.decode(lineBytes);
          if (lineStr.trim().length > 0) {
            try {
              const parsed = JSON.parse(lineStr);
              if (parsed && typeof parsed === 'object') {
                results.push(parsed as Record<string, unknown>);
              }
            } catch {
              // Ignore or skip unparseable lines
            }
          }
        }
        start = i + 1;
      }
    }

    // Keep remainder in buffer
    this.buffer = this.buffer.slice(start);
    return results;
  }

  /**
   * Feed a string into the parser (convenience for string-based inputs).
   */
  public feedString(chunk: string): Array<Record<string, unknown>> {
    const encoder = new TextEncoder();
    return this.feedBytes(encoder.encode(chunk));
  }

  /**
   * Number of pending unconsumed bytes in the buffer.
   */
  public get pendingBytes(): number {
    return this.buffer.length;
  }

  /**
   * Reset parser buffer.
   */
  public reset(): void {
    this.buffer = new Uint8Array(0);
  }
}

/**
 * Parse structured message blocks (text, thinking, tool_call) from message content.
 *
 * Supports string content and arrays containing text, thinking, and toolCall blocks.
 */
export function parseMessageBlocks(content: unknown): MessageBlock[] {
  if (typeof content === 'string') {
    if (content.length === 0) return [];
    return [{ type: 'text', text: content }];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: MessageBlock[] = [];
  for (let i = 0; i < content.length; i++) {
    const item = content[i];
    if (!item || typeof item !== 'object') continue;
    const blockObj = item as Record<string, unknown>;
    const type = blockObj.type;

    if (type === 'thinking' && typeof blockObj.thinking === 'string') {
      blocks.push({
        type: 'thinking',
        thinking: blockObj.thinking,
        isStreaming: false,
      });
    } else if (type === 'text' && typeof blockObj.text === 'string') {
      blocks.push({
        type: 'text',
        text: blockObj.text,
      });
    } else if (type === 'toolCall' || type === 'tool_call') {
      const id =
        typeof blockObj.id === 'string' && blockObj.id.length > 0
          ? blockObj.id
          : `call-${i}`;
      const name =
        typeof blockObj.name === 'string'
          ? blockObj.name
          : typeof blockObj.toolName === 'string'
            ? blockObj.toolName
            : 'unknown';
      const args =
        blockObj.arguments !== undefined
          ? (blockObj.arguments as Record<string, unknown> | string)
          : (blockObj.args as Record<string, unknown> | string | undefined);

      blocks.push({
        type: 'tool_call',
        id,
        name,
        args,
        status: 'completed',
        output: '',
        isError: false,
      });
    }
  }

  return blocks;
}

const SAFE_PREVIEW_MIME_REGEX = /^image\/(png|jpe?g|webp|gif|bmp|svg\+xml|avif)$/i;

/**
 * Validates that a MIME type is a safe image preview format for browser/webview display.
 */
export function isSafePreviewImageMimeType(mimeType: unknown): boolean {
  if (typeof mimeType !== 'string') return false;
  const normalized = mimeType.trim().toLowerCase().split(';')[0];
  return SAFE_PREVIEW_MIME_REGEX.test(normalized);
}

export const isSafeImageMimeType = isSafePreviewImageMimeType;

/**
 * Validates whether an object conforms to real ImageContent with non-empty data and an image MIME.
 * Preserves outbound/domain non-preview image formats (e.g. HEIC, TIFF).
 */
export function isValidImageContent(item: unknown): item is ImageContent {
  if (!item || typeof item !== 'object') return false;
  const obj = item as Record<string, unknown>;
  return (
    obj.type === 'image' &&
    typeof obj.data === 'string' &&
    obj.data.trim().length > 0 &&
    typeof obj.mimeType === 'string' &&
    /^image\/[a-zA-Z0-9.\+_-]+$/i.test(obj.mimeType.trim().toLowerCase().split(';')[0])
  );
}

const BASE64_CHAR_REGEX = /^[A-Za-z0-9+/=]+$/;

/**
 * Validates preview image payload and returns a safe data: URI for img rendering,
 * or null if the payload is malformed or not an allowed display MIME.
 */
export function getSafePreviewImageSrc(image: ImageContent | unknown): string | null {
  if (!image || typeof image !== 'object') return null;
  const obj = image as Record<string, unknown>;
  if (obj.type !== 'image' || typeof obj.data !== 'string' || typeof obj.mimeType !== 'string') {
    return null;
  }

  const rawMime = obj.mimeType.trim().toLowerCase().split(';')[0];
  if (!isSafePreviewImageMimeType(rawMime)) {
    return null;
  }

  const dataStr = obj.data.trim();
  if (dataStr.length === 0) {
    return null;
  }

  if (dataStr.startsWith('data:')) {
    const match = /^data:([^;,]+);base64,(.+)$/i.exec(dataStr);
    if (!match) {
      return null;
    }
    const uriMime = match[1].trim().toLowerCase();
    if (!isSafePreviewImageMimeType(uriMime)) {
      return null;
    }
    const cleanBase64 = match[2].trim().replace(/\s+/g, '');
    if (!BASE64_CHAR_REGEX.test(cleanBase64)) {
      return null;
    }
    return `data:${uriMime};base64,${cleanBase64}`;
  }

  const cleanBase64 = dataStr.replace(/\s+/g, '');
  if (!BASE64_CHAR_REGEX.test(cleanBase64)) {
    return null;
  }

  return `data:${rawMime};base64,${cleanBase64}`;
}

/**
 * Extracts validated ImageContent blocks from authoritative message content or image lists.
 * Preserves repeated images inside content, but prevents duplicating the same image
 * when present in both content and the images list.
 */
export function extractImagesFromMessage(
  msg: AuthoritativeMessage | Record<string, unknown>
): ImageContent[] {
  const images: ImageContent[] = [];

  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (isValidImageContent(block)) {
        images.push({
          type: 'image',
          data: block.data,
          mimeType: block.mimeType,
        });
      }
    }
  }

  const rawMsg = msg as Record<string, unknown>;
  if (Array.isArray(rawMsg.images)) {
    for (const item of rawMsg.images) {
      if (isValidImageContent(item)) {
        const alreadyInContent = images.some(
          (existing) => existing.data === item.data && existing.mimeType === item.mimeType
        );
        if (!alreadyInContent) {
          images.push({
            type: 'image',
            data: item.data,
            mimeType: item.mimeType,
          });
        }
      }
    }
  }

  return images;
}

export function extractTextFromContent(
  content: string | MessageContentBlock[] | unknown
): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .filter((block) => block && (block.type === 'text' || typeof block.text === 'string'))
      .map((block) => block.text || '')
      .join('');
  }

  return '';
}

/**
 * Check if an extension UI request requires interactive response (dialog method).
 * Dialog methods must be cancelled rather than approved.
 */
export function isDialogExtensionUiRequest(req: ExtensionUiRequest): boolean {
  return ['select', 'confirm', 'input', 'editor'].includes(req.method);
}

/**
 * Check if an extension UI request is a supported interactive dialog method (select, input, confirm).
 */
export function isSupportedDialogExtensionUiRequest(req: ExtensionUiRequest): boolean {
  return ['select', 'input', 'confirm'].includes(req.method);
}

/**
 * Parse a user's select choice against the allowed options array.
 * Supports:
 * - 1-based numeric option index (e.g. "1" -> options[0])
 * - Exact string match against an entry in options
 * - Case-insensitive string match against an entry in options (returns exact option casing)
 * Returns null if cancelled, empty, or not matching any option.
 */
export function parseSelectChoice(
  input: string | null | undefined,
  options: string[]
): string | null {
  if (input === null || input === undefined) {
    return null;
  }
  const trimmed = input.trim();
  if (!trimmed || options.length === 0) {
    return null;
  }

  // 1. Check if 1-based numeric option index
  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && String(num) === trimmed && num >= 1 && num <= options.length) {
    return options[num - 1];
  }

  // 2. Exact match
  const exact = options.find((opt) => opt === trimmed);
  if (exact !== undefined) {
    return exact;
  }

  // 3. Case-insensitive match
  const lower = trimmed.toLowerCase();
  const ci = options.find((opt) => opt.toLowerCase() === lower);
  if (ci !== undefined) {
    return ci;
  }

  return null;
}

/**
 * Extension UI dialog adapter interface.
 * Abstracts browser/Tauri dialog interaction for select, input, and confirm requests.
 */
export interface ExtensionUiDialogAdapter {
  select(request: ExtensionUiRequest): Promise<string | null> | string | null;
  input(request: ExtensionUiRequest): Promise<string | null> | string | null;
  confirm(request: ExtensionUiRequest): Promise<boolean | null> | boolean | null;
  cancelPending?(cwd?: string, activeCwd?: string): void;
}

/**
 * Default pragmatic browser dialog adapter.
 * Uses window.prompt with numbered options for select, window.prompt for input,
 * and window.confirm for boolean confirmations.
 */
export const defaultDialogAdapter: ExtensionUiDialogAdapter = {
  select(request: ExtensionUiRequest): string | null {
    if (typeof window === 'undefined' || typeof window.prompt !== 'function') {
      return null;
    }
    const title = request.title || 'Select an option';
    const message = request.message ? `${request.message}\n\n` : '';
    const options = request.options ?? [];
    const formattedOptions = options
      .map((opt, idx) => `${idx + 1}. ${opt}`)
      .join('\n');
    const promptText = `${message}${title}\n\n${formattedOptions}\n\nEnter option number (1-${options.length}) or exact option:`;
    const input = window.prompt(promptText, '1');
    return parseSelectChoice(input, options);
  },

  input(request: ExtensionUiRequest): string | null {
    if (typeof window === 'undefined' || typeof window.prompt !== 'function') {
      return null;
    }
    const title = request.title || 'Input required';
    const message = request.message ? `${request.message}\n\n` : '';
    const promptText = `${message}${title}`;
    const prefill = request.prefill ?? request.placeholder ?? '';
    return window.prompt(promptText, prefill);
  },

  confirm(request: ExtensionUiRequest): boolean | null {
    if (typeof window === 'undefined' || typeof window.confirm !== 'function') {
      return null;
    }
    const title = request.title || 'Confirmation';
    const message = request.message ? `\n\n${request.message}` : '';
    const confirmText = `${title}${message}`;
    return window.confirm(confirmText);
  },
};

/**
 * Generate cancellation response for extension UI dialog request.
 */
export function createExtensionUiCancelResponse(id: string): Record<string, unknown> {
  return {
    type: 'extension_ui_response',
    id,
    cancelled: true,
  };
}

/**
 * Create a structured extension_ui_response object for protocol validation / testing.
 */
export function createExtensionUiResponse(
  payload: ExtensionUiResponsePayload
): Record<string, unknown> {
  if (payload.cancelled) {
    return {
      type: 'extension_ui_response',
      id: payload.id,
      cancelled: true,
    };
  }
  if (typeof payload.confirmed === 'boolean') {
    return {
      type: 'extension_ui_response',
      id: payload.id,
      confirmed: payload.confirmed,
    };
  }
  if (typeof payload.value === 'string') {
    return {
      type: 'extension_ui_response',
      id: payload.id,
      value: payload.value,
    };
  }
  return {
    type: 'extension_ui_response',
    id: payload.id,
    cancelled: true,
  };
}

/**
 * Extract chat text delta from an assistant message event.
 *
 * In Pi RPC, message_update events can carry text_delta, thinking_delta,
 * toolcall_delta, etc. Only 'text_delta' represents user-visible chat content.
 * Returns the text delta string if the event is a text_delta with a non-empty string,
 * or null otherwise.
 */
export function extractChatTextDelta(
  deltaObj: AssistantMessageDelta | Record<string, unknown> | null | undefined
): string | null {
  if (!deltaObj || typeof deltaObj !== 'object') {
    return null;
  }

  const typed = deltaObj as AssistantMessageDelta;
  if (
    typed.type === 'text_delta' &&
    typeof typed.delta === 'string' &&
    typed.delta.length > 0
  ) {
    return typed.delta;
  }

  return null;
}

/**
 * Extract thinking delta from an assistant message event.
 *
 * Returns the delta string if the event is a thinking_delta with a non-empty string,
 * or null otherwise.
 */
export function extractThinkingDelta(
  deltaObj: AssistantMessageDelta | Record<string, unknown> | null | undefined
): string | null {
  if (!deltaObj || typeof deltaObj !== 'object') {
    return null;
  }

  const typed = deltaObj as AssistantMessageDelta;
  if (
    typed.type === 'thinking_delta' &&
    typeof typed.delta === 'string' &&
    typed.delta.length > 0
  ) {
    return typed.delta;
  }

  return null;
}

/**
 * Extract toolcall delta from an assistant message event.
 *
 * Returns the delta string if the event is a toolcall_delta with a non-empty string,
 * or null otherwise.
 */
export function extractToolCallDelta(
  deltaObj: AssistantMessageDelta | Record<string, unknown> | null | undefined
): string | null {
  if (!deltaObj || typeof deltaObj !== 'object') {
    return null;
  }

  const typed = deltaObj as AssistantMessageDelta;
  if (
    typed.type === 'toolcall_delta' &&
    typeof typed.delta === 'string' &&
    typed.delta.length > 0
  ) {
    return typed.delta;
  }

  return null;
}

/**
 * Extract normalized text/string output from a tool result or partial result payload.
 */
export function extractToolOutput(raw: unknown): string {
  if (typeof raw === 'string') {
    return raw;
  }
  if (!raw || typeof raw !== 'object') {
    return '';
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.output === 'string') {
    return obj.output;
  }

  if (typeof obj.text === 'string') {
    return obj.text;
  }

  if (Array.isArray(obj.content)) {
    return obj.content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const itemObj = item as Record<string, unknown>;
          if (typeof itemObj.text === 'string') return itemObj.text;
          if (typeof itemObj.content === 'string') return itemObj.content;
        }
        return '';
      })
      .filter((s) => s.length > 0)
      .join('\n');
  }

  if (typeof obj.content === 'string') {
    return obj.content;
  }

  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const itemObj = item as Record<string, unknown>;
          if (typeof itemObj.text === 'string') return itemObj.text;
          if (typeof itemObj.content === 'string') return itemObj.content;
        }
        return '';
      })
      .filter((s) => s.length > 0)
      .join('\n');
  }

  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return String(raw);
  }
}

/**
 * Type guard for tool_execution_start event.
 */
export function isToolExecutionStartEvent(
  event: Record<string, unknown>
): event is ToolExecutionStartEvent {
  return (
    event.type === 'tool_execution_start' &&
    typeof event.toolCallId === 'string' &&
    typeof event.toolName === 'string'
  );
}

/**
 * Type guard for tool_execution_update event.
 */
export function isToolExecutionUpdateEvent(
  event: Record<string, unknown>
): event is ToolExecutionUpdateEvent {
  return (
    event.type === 'tool_execution_update' &&
    typeof event.toolCallId === 'string'
  );
}

/**
 * Type guard for tool_execution_end event.
 */
export function isToolExecutionEndEvent(
  event: Record<string, unknown>
): event is ToolExecutionEndEvent {
  return (
    event.type === 'tool_execution_end' &&
    typeof event.toolCallId === 'string'
  );
}

/**
 * Check if incoming payload is authoritative message_end event.
 */
export function isMessageEndEvent(event: Record<string, unknown>): event is {
  type: 'message_end';
  message: AuthoritativeMessage;
} {
  return (
    event.type === 'message_end' &&
    typeof event.message === 'object' &&
    event.message !== null
  );
}

/** Prefix for client-generated prompt request IDs to stay disjoint from internal command IDs */
export const PROMPT_REQUEST_ID_PREFIX = 'prompt-';

/**
 * Generate an authoritative client-generated opaque request ID for a prompt.
 * Prefers crypto.randomUUID() and falls back to secure random bytes when unavailable.
 */
export function generatePromptRequestId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') {
    return `${PROMPT_REQUEST_ID_PREFIX}${cryptoApi.randomUUID()}`;
  }
  if (typeof cryptoApi?.getRandomValues !== 'function') {
    throw new Error('Secure crypto random number generation is unavailable');
  }

  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return `${PROMPT_REQUEST_ID_PREFIX}${uuid}`;
}

/**
 * Validate that a prompt request ID is bounded, non-empty, and belongs to the
 * accepted client namespace ('prompt-*').
 */
export function isValidPromptRequestId(id: unknown): id is string {
  if (typeof id !== 'string') {
    return false;
  }
  const trimmed = id.trim();
  if (!trimmed || trimmed !== id) {
    return false;
  }
  if (!id.startsWith(PROMPT_REQUEST_ID_PREFIX) || id.length <= PROMPT_REQUEST_ID_PREFIX.length) {
    return false;
  }
  if (id.length > 128) {
    return false;
  }
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

