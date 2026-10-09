export interface AssistantMessageDelta {
  type:
    | 'text_start'
    | 'text_delta'
    | 'text_end'
    | 'thinking_start'
    | 'thinking_delta'
    | 'thinking_end'
    | 'toolcall_start'
    | 'toolcall_delta'
    | 'toolcall_end';
  contentIndex?: number;
  delta?: string;
  content?: string;
  id?: string;
  toolName?: string;
  toolCall?: {
    id: string;
    name: string;
    arguments?: Record<string, unknown> | unknown;
    [key: string]: unknown;
  };
}

export interface MessageContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown> | unknown;
  args?: Record<string, unknown> | unknown;
  [key: string]: unknown;
}

export interface AuthoritativeMessage {
  id?: string;
  role: string;
  content: string | MessageContentBlock[];
  timestamp?: number;
}

export interface SendPromptPayload {
  id: string;
  message: string;
}

export interface SendPromptResult {
  id: string;
  accepted: boolean;
}

export interface RpcResponse {
  type: 'response';
  id?: string;
  command?: string;
  success: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

export interface RpcEventBase {
  type: string;
  cwd?: string;
  [key: string]: unknown;
}

export interface MessageStartEvent extends RpcEventBase {
  type: 'message_start';
  message: AuthoritativeMessage;
}

export interface MessageUpdateEvent extends RpcEventBase {
  type: 'message_update';
  assistantMessageEvent: AssistantMessageDelta;
  usage?: Record<string, unknown>;
}

export interface MessageEndEvent extends RpcEventBase {
  type: 'message_end';
  message: AuthoritativeMessage;
}

export interface ToolExecutionStartEvent extends RpcEventBase {
  type: 'tool_execution_start';
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown> | unknown;
}

export interface ToolExecutionUpdateEvent extends RpcEventBase {
  type: 'tool_execution_update';
  toolCallId: string;
  toolName?: string;
  args?: Record<string, unknown> | unknown;
  partialResult?: unknown;
}

export interface ToolExecutionEndEvent extends RpcEventBase {
  type: 'tool_execution_end';
  toolCallId: string;
  toolName?: string;
  result?: unknown;
  isError?: boolean;
}

export interface AgentSettledEvent extends RpcEventBase {
  type: 'agent_settled';
}

export interface AgentEndEvent extends RpcEventBase {
  type: 'agent_end';
  messages?: unknown[];
  willRetry?: boolean;
}

export interface ExtensionUiRequest extends RpcEventBase {
  type: 'extension_ui_request';
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
}

export interface ExtensionUiResponsePayload {
  id: string;
  sessionFile?: string;
  method?: 'select' | 'input' | 'confirm' | string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
  cwd?: string;
}

export interface SendExtensionUiResponseResult {
  id: string;
  success: boolean;
}
