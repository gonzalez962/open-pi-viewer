import type { ToolExecutionStatus } from './messages';

export type ExportFormat = 'markdown' | 'json' | 'md';

export interface ExportDisclosures {
  /** Scope of the export (current loaded transcript only) */
  scope: string;
  /** Content policy applied (conversation_summary) */
  contentPolicy: string;
  /** Notice regarding text secret redaction */
  secretRedactionNotice: string;
}

export interface ExportMetadata {
  /** Version of the JSON export schema */
  schemaVersion: number;
  /** Title of the exported conversation */
  title: string;
  /** Deterministic timestamp when the export was generated (ISO 8601) */
  exportedAt: string;
  /** Total count of exported messages */
  messageCount: number;
  /** Disclosures and policy disclaimers */
  disclosures: ExportDisclosures;
}

export interface ExportedToolCall {
  /** Tool name */
  name: string;
  /** Execution status only (running | completed | error) */
  status: ToolExecutionStatus;
}

export interface ExportedImagesMetadata {
  /** Number of images attached to this message */
  count: number;
  /** Distinct MIME types of the attached images */
  mimeTypes: string[];
}

export interface ExportedMessage {
  /** Message role (user | assistant | system) */
  role: 'user' | 'assistant' | 'system';
  /** Display timestamp from message */
  timestamp?: string;
  /** Canonical text content */
  text: string;
  /** Tool executions (name and status only, never args or outputs) */
  tools?: ExportedToolCall[];
  /** Image metadata only (count and mime types, never data) */
  images?: ExportedImagesMetadata;
}

export interface ConversationJsonExport {
  schemaVersion: 1;
  metadata: ExportMetadata;
  messages: ExportedMessage[];
}

export interface ExportOptions {
  /** Conversation or session title */
  title?: string;
  /** Deterministic export timestamp (Date or ISO 8601 string) */
  exportedAt?: Date | string;
  /** Fallback title when none provided */
  fallbackTitle?: string;
}

export interface GenerateFilenameOptions {
  /** Conversation or session title */
  title?: string;
  /** Export format ('markdown' | 'json' | 'md') */
  format?: ExportFormat;
  /** Deterministic export timestamp (Date or ISO 8601 string) */
  exportedAt?: Date | string;
  /** Fallback title when none provided */
  fallbackTitle?: string;
}
