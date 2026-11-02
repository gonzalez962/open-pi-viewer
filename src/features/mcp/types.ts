import type {
  McpServerConfig,
  McpServerScope,
  McpServerType,
  SaveMcpServerPayload,
} from '@core/types/mcp';

export interface McpKeyValuePair {
  id: string;
  key: string;
  value: string;
}

export interface McpFormData {
  name: string;
  scope: McpServerScope;
  serverType: McpServerType;
  command: string;
  argsText: string;
  envEntries: McpKeyValuePair[];
  url: string;
  headersEntries: McpKeyValuePair[];
  enabled: boolean;
}

export const EMPTY_MCP_FORM: McpFormData = {
  name: '',
  scope: 'global',
  serverType: 'stdio',
  command: '',
  argsText: '',
  envEntries: [],
  url: '',
  headersEntries: [],
  enabled: true,
};

let kvCounter = 0;
export function createUniqueKvId(): string {
  kvCounter += 1;
  return `kv-${Date.now()}-${kvCounter}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Splits text into command-line arguments, handling quotes and whitespace/newlines.
 */
export function parseArgsText(argsText: string): string[] {
  const trimmed = argsText.trim();
  if (!trimmed) return [];
  const args: string[] = [];
  const regex = /[^\s"']+|"(?:\\.|[^"\\])*"|'[^']*'/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(trimmed)) !== null) {
    const token = match[0];
    if (token.startsWith('"')) {
      args.push(token.slice(1, -1).replace(/\\([\\"])/g, '$1')); 
    } else if (token.startsWith("'")) {
      args.push(token.slice(1, -1));
    } else {
      args.push(token);
    }
  }
  return args;
}

/**
 * Quotes and escapes each argument for lossless editing.
 */
export function formatArgsText(args?: string[]): string {
  if (!args || args.length === 0) return '';
  return args.map((arg) => `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(' ');
}

/**
 * Converts a list of key-value pair entries into a record, filtering out blank keys.
 */
export function keyValueEntriesToRecord(
  entries: McpKeyValuePair[]
): Record<string, string> {
  const record: Record<string, string> = {};
  for (const entry of entries) {
    const trimmedKey = entry.key.trim();
    if (trimmedKey) {
      record[trimmedKey] = entry.value;
    }
  }
  return record;
}

/**
 * Converts a record of string keys/values into key-value pair entries for form editing.
 */
export function recordToKeyValueEntries(
  record?: Record<string, string>
): McpKeyValuePair[] {
  if (!record) return [];
  return Object.entries(record).map(([key, value]) => ({
    id: createUniqueKvId(),
    key,
    value: String(value),
  }));
}

/**
 * Converts an existing McpServerConfig into McpFormData for the modal editor.
 */
export function serverConfigToFormData(server: McpServerConfig): McpFormData {
  let envEntries: McpKeyValuePair[] = [];
  if (server.env && Object.keys(server.env).length > 0) {
    envEntries = recordToKeyValueEntries(server.env);
  } else if (server.envKeys && server.envKeys.length > 0) {
    envEntries = server.envKeys.map((key) => ({
      id: createUniqueKvId(),
      key,
      value: '',
    }));
  }

  return {
    name: server.name,
    scope: server.scope || 'global',
    serverType: server.serverType || 'stdio',
    command: server.command || '',
    argsText: formatArgsText(server.args),
    envEntries,
    url: server.url || '',
    headersEntries: recordToKeyValueEntries(server.headers),
    enabled: server.enabled ?? !server.disabled,
  };
}

/**
 * Builds SaveMcpServerPayload from form data, preserving old name if renaming.
 */
export function formDataToSavePayload(
  formData: McpFormData,
  oldName?: string,
  cwd?: string,
  originalServer?: McpServerConfig | null
): SaveMcpServerPayload {
  const isStdio = formData.serverType === 'stdio';
  const server: SaveMcpServerPayload['server'] = {
    type: formData.serverType,
    serverType: formData.serverType,
    enabled: formData.enabled,
    disabled: !formData.enabled,
  };

  if (isStdio) {
    server.command = formData.command.trim();
    server.args = parseArgsText(formData.argsText);
    const env: Record<string, string | null> = keyValueEntriesToRecord(formData.envEntries);
    if (originalServer?.envKeys && originalServer.urlConfigured !== undefined) {
      for (const key of originalServer.envKeys) if (!(key in env)) env[key] = null;
    }
    if (Object.keys(env).length > 0) {
      server.env = env;
    }
  } else {
    server.url = formData.url.trim();
    const headers: Record<string, string | null> = keyValueEntriesToRecord(formData.headersEntries);
    if (originalServer?.headersConfigured) {
      for (const key of Object.keys(originalServer.headers || {})) if (!(key in headers)) headers[key] = null;
    }
    if (Object.keys(headers).length > 0) {
      server.headers = headers;
    }
  }

  return {
    name: formData.name.trim(),
    oldName:
      oldName?.trim() && oldName.trim() !== formData.name.trim()
        ? oldName.trim()
        : undefined,
    server,
    scope: formData.scope,
    cwd,
  };
}
