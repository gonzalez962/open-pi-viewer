import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  filterMcpServers,
  computeMcpServerCounts,
  calculateToggledServerState,
  calculateSavedServerState,
  calculateDeletedServerState,
} from '@features/mcp/McpView';
import {
  parseArgsText,
  formatArgsText,
  keyValueEntriesToRecord,
  recordToKeyValueEntries,
  serverConfigToFormData,
  formDataToSavePayload,
  EMPTY_MCP_FORM,
  type McpFormData,
} from '@features/mcp/types';
import { validateMcpForm } from '@features/mcp/hooks/useMcpModalForm';
import { McpSearchBar } from '@features/mcp/components/McpSearchBar';
import type { McpServerConfig, SaveMcpServerPayload } from '@core/types/mcp';
import { translate } from '@shared/i18n';

const sampleServers: McpServerConfig[] = [
  {
    name: 'filesystem-server',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp/files'],
    serverType: 'stdio',
    envKeys: ['FS_ROOT'],
    disabled: false,
    enabled: true,
    scope: 'project',
    configPath: '/workspace/.pi/agent/mcp.json',
  },
  {
    name: 'git-tools',
    command: 'node',
    args: ['/opt/mcp/git-server.js'],
    serverType: 'stdio',
    envKeys: [],
    disabled: true,
    enabled: false,
    scope: 'global',
    configPath: '~/.pi/agent/mcp.json',
  },
  {
    name: 'remote-database',
    url: 'https://db.internal.net/mcp/v1',
    serverType: 'remote',
    envKeys: ['DB_SECRET', 'DB_HOST'],
    disabled: false,
    enabled: true,
    scope: 'global',
    configPath: '~/.pi/agent/mcp.json',
  },
  {
    name: 'sse-streaming-service',
    url: 'http://localhost:3001/events',
    serverType: 'sse',
    envKeys: [],
    disabled: true,
    enabled: false,
    scope: 'project',
    configPath: '/workspace/.pi/agent/mcp.json',
  },
];

// ---------------------------------------------------------------------------
// 1. Server Filtering Logic Tests
// ---------------------------------------------------------------------------

test('mcp view: filterMcpServers returns all servers when query is empty or whitespace', () => {
  assert.deepStrictEqual(filterMcpServers(sampleServers, ''), sampleServers);
  assert.deepStrictEqual(filterMcpServers(sampleServers, '   '), sampleServers);
});

test('mcp view: filterMcpServers matches server name case-insensitively', () => {
  const result1 = filterMcpServers(sampleServers, 'filesystem');
  assert.strictEqual(result1.length, 1);
  assert.strictEqual(result1[0].name, 'filesystem-server');

  const result2 = filterMcpServers(sampleServers, 'GIT');
  assert.strictEqual(result2.length, 1);
  assert.strictEqual(result2[0].name, 'git-tools');

  const resultAllWithHyphen = filterMcpServers(sampleServers, '-');
  assert.strictEqual(resultAllWithHyphen.length, 4);
});

test('mcp view: filterMcpServers matches command name and arguments', () => {
  // Matches command 'npx'
  const resultNpx = filterMcpServers(sampleServers, 'npx');
  assert.strictEqual(resultNpx.length, 1);
  assert.strictEqual(resultNpx[0].name, 'filesystem-server');

  // Matches command 'node'
  const resultNode = filterMcpServers(sampleServers, 'node');
  assert.strictEqual(resultNode.length, 1);
  assert.strictEqual(resultNode[0].name, 'git-tools');

  // Matches arg 'server-filesystem'
  const resultArg = filterMcpServers(sampleServers, 'server-filesystem');
  assert.strictEqual(resultArg.length, 1);
  assert.strictEqual(resultArg[0].name, 'filesystem-server');

  // Matches arg '/opt/mcp'
  const resultPath = filterMcpServers(sampleServers, '/opt/mcp');
  assert.strictEqual(resultPath.length, 1);
  assert.strictEqual(resultPath[0].name, 'git-tools');
});

test('mcp view: filterMcpServers matches URL for remote and SSE servers', () => {
  // Matches https URL
  const resultHttps = filterMcpServers(sampleServers, 'db.internal.net');
  assert.strictEqual(resultHttps.length, 1);
  assert.strictEqual(resultHttps[0].name, 'remote-database');

  // Matches http / localhost URL
  const resultLocalhost = filterMcpServers(sampleServers, 'localhost:3001');
  assert.strictEqual(resultLocalhost.length, 1);
  assert.strictEqual(resultLocalhost[0].name, 'sse-streaming-service');

  // Matches protocol prefix
  const resultEvents = filterMcpServers(sampleServers, '/events');
  assert.strictEqual(resultEvents.length, 1);
  assert.strictEqual(resultEvents[0].name, 'sse-streaming-service');
});

test('mcp view: filterMcpServers returns empty array when nothing matches', () => {
  const result = filterMcpServers(sampleServers, 'non-existent-keyword-xyz');
  assert.deepStrictEqual(result, []);
});

// ---------------------------------------------------------------------------
// 2. Count Summaries Calculation Tests
// ---------------------------------------------------------------------------

test('mcp view: computeMcpServerCounts accurately sums total and active servers', () => {
  // Sample servers: 4 total, 2 enabled (filesystem-server, remote-database)
  const counts = computeMcpServerCounts(sampleServers);
  assert.strictEqual(counts.total, 4);
  assert.strictEqual(counts.active, 2);

  // Empty list
  assert.deepStrictEqual(computeMcpServerCounts([]), { total: 0, active: 0 });

  // All enabled
  const allEnabled: McpServerConfig[] = [
    { ...sampleServers[0], enabled: true, disabled: false },
    { ...sampleServers[1], enabled: true, disabled: false },
  ];
  assert.deepStrictEqual(computeMcpServerCounts(allEnabled), {
    total: 2,
    active: 2,
  });

  // All disabled
  const allDisabled: McpServerConfig[] = [
    { ...sampleServers[0], enabled: false, disabled: true },
    { ...sampleServers[1], enabled: false, disabled: true },
  ];
  assert.deepStrictEqual(computeMcpServerCounts(allDisabled), {
    total: 2,
    active: 0,
  });
});

// ---------------------------------------------------------------------------
// 3. State Toggling Calculations Tests
// ---------------------------------------------------------------------------

test('mcp view: calculateToggledServerState immutably updates enabled and disabled properties', () => {
  // Toggle filesystem-server from enabled (true) to disabled (false)
  const toggledOff = calculateToggledServerState(
    sampleServers,
    'filesystem-server',
    false
  );

  // Original array remains intact (immutability)
  assert.strictEqual(sampleServers[0].enabled, true);
  assert.strictEqual(sampleServers[0].disabled, false);

  // Toggled array has updated values
  const updatedOff = toggledOff.find((s) => s.name === 'filesystem-server');
  assert.ok(updatedOff);
  assert.strictEqual(updatedOff.enabled, false);
  assert.strictEqual(updatedOff.disabled, true);

  // Other servers remain unchanged
  const otherServer = toggledOff.find((s) => s.name === 'git-tools');
  assert.ok(otherServer);
  assert.strictEqual(otherServer.enabled, false);
  assert.strictEqual(otherServer.disabled, true);

  // Toggle git-tools from disabled (false) to enabled (true)
  const toggledOn = calculateToggledServerState(toggledOff, 'git-tools', true);
  const updatedOn = toggledOn.find((s) => s.name === 'git-tools');
  assert.ok(updatedOn);
  assert.strictEqual(updatedOn.enabled, true);
  assert.strictEqual(updatedOn.disabled, false);
});

test('mcp view: calculateToggledServerState leaves array unchanged if server name is not found', () => {
  const result = calculateToggledServerState(
    sampleServers,
    'unknown-server',
    true
  );
  assert.deepStrictEqual(result, sampleServers);
});

// ---------------------------------------------------------------------------
// 4. Locales & Label Formatting Tests
// ---------------------------------------------------------------------------

test('mcp view: locale keys translate and format with expected interpolations', () => {
  // English translations
  assert.strictEqual(translate('en', 'settings.tab_mcp'), 'MCP Servers');
  assert.strictEqual(translate('en', 'mcp.title'), 'MCP Servers');
  assert.strictEqual(translate('en', 'mcp.badge_stdio'), 'Command');
  assert.strictEqual(translate('en', 'mcp.badge_remote'), 'Remote');
  assert.strictEqual(translate('en', 'mcp.badge_sse'), 'SSE');
  assert.strictEqual(translate('en', 'mcp.scope_global'), 'Global');
  assert.strictEqual(translate('en', 'mcp.scope_project'), 'Project');
  assert.strictEqual(
    translate('en', 'mcp.servers_count', { count: 3 }),
    '3 servers'
  );
  assert.strictEqual(
    translate('en', 'mcp.active_count', { count: 2 }),
    '2 active'
  );
  assert.strictEqual(
    translate('en', 'mcp.toggle_success', {
      name: 'filesystem-server',
      status: 'active',
    }),
    'Server "filesystem-server" active'
  );
  assert.strictEqual(
    translate('en', 'mcp.toggle_error', {
      name: 'git-tools',
      error: 'Permission denied',
    }),
    'Failed to toggle server "git-tools": Permission denied'
  );

  // Spanish translations
  assert.strictEqual(translate('es', 'settings.tab_mcp'), 'Servidores MCP');
  assert.strictEqual(translate('es', 'mcp.title'), 'Servidores MCP');
  assert.strictEqual(translate('es', 'mcp.badge_stdio'), 'Comando');
  assert.strictEqual(translate('es', 'mcp.badge_remote'), 'Remoto');
  assert.strictEqual(translate('es', 'mcp.badge_sse'), 'SSE');
  assert.strictEqual(translate('es', 'mcp.scope_global'), 'Global');
  assert.strictEqual(translate('es', 'mcp.scope_project'), 'Proyecto');
  assert.strictEqual(
    translate('es', 'mcp.servers_count', { count: 3 }),
    '3 servidores'
  );
  assert.strictEqual(
    translate('es', 'mcp.active_count', { count: 2 }),
    '2 activos'
  );
  assert.strictEqual(
    translate('es', 'mcp.toggle_success', {
      name: 'filesystem-server',
      status: 'activo',
    }),
    'Servidor "filesystem-server" activo'
  );
  assert.strictEqual(
    translate('es', 'mcp.toggle_error', {
      name: 'git-tools',
      error: 'Permiso denegado',
    }),
    'Error al cambiar el estado del servidor "git-tools": Permiso denegado'
  );
});

// ---------------------------------------------------------------------------
// 5. Arguments & Key-Value serialization helpers
// ---------------------------------------------------------------------------

test('mcp helpers: parseArgsText splits args by whitespace and preserves quotes', () => {
  // Empty & whitespace cases
  assert.deepStrictEqual(parseArgsText(''), []);
  assert.deepStrictEqual(parseArgsText('   \n\t  '), []);

  // Simple tokens
  assert.deepStrictEqual(parseArgsText('-y @modelcontextprotocol/server-postgres'), [
    '-y',
    '@modelcontextprotocol/server-postgres',
  ]);

  // Multiline input
  assert.deepStrictEqual(parseArgsText('arg1\narg2\narg3'), ['arg1', 'arg2', 'arg3']);

  // Double quotes with spaces
  assert.deepStrictEqual(
    parseArgsText('run --dir "C:\\Program Files\\app" --flag'),
    ['run', '--dir', 'C:\\Program Files\\app', '--flag']
  );

  // Single quotes with spaces
  assert.deepStrictEqual(
    parseArgsText("exec --message 'hello world from mcp'"),
    ['exec', '--message', 'hello world from mcp']
  );
});

test('mcp helpers: formatArgsText quotes each argument for lossless editing', () => {
  assert.strictEqual(formatArgsText([]), '');
  assert.strictEqual(formatArgsText(undefined), '');

  const simple = ['-y', 'my-pkg'];
  assert.strictEqual(formatArgsText(simple), '"-y" "my-pkg"');

  const withSpaces = ['--path', '/path with spaces/file', '--quiet'];
  assert.strictEqual(
    formatArgsText(withSpaces),
    '"--path" "/path with spaces/file" "--quiet"'
  );

  // Roundtrip test
  const original = ['npx', '-y', '@mcp/server', 'path with space'];
  const formatted = formatArgsText(original);
  const parsed = parseArgsText(formatted);
  assert.deepStrictEqual(parsed, original);
});

test('mcp helpers: keyValueEntriesToRecord and recordToKeyValueEntries roundtrip cleanly', () => {
  // Empty cases
  assert.deepStrictEqual(keyValueEntriesToRecord([]), {});
  assert.deepStrictEqual(recordToKeyValueEntries(undefined), []);
  assert.deepStrictEqual(recordToKeyValueEntries({}), []);

  // Ignores blank / whitespace keys
  const entries = [
    { id: '1', key: 'FOO', value: 'bar' },
    { id: '2', key: '', value: 'ignored' },
    { id: '3', key: '   ', value: 'also ignored' },
    { id: '4', key: 'BAZ', value: '123' },
  ];
  const record = keyValueEntriesToRecord(entries);
  assert.deepStrictEqual(record, { FOO: 'bar', BAZ: '123' });

  // Record to entries
  const convertedEntries = recordToKeyValueEntries(record);
  assert.strictEqual(convertedEntries.length, 2);
  assert.strictEqual(convertedEntries[0].key, 'FOO');
  assert.strictEqual(convertedEntries[0].value, 'bar');
  assert.strictEqual(convertedEntries[1].key, 'BAZ');
  assert.strictEqual(convertedEntries[1].value, '123');
});

// ---------------------------------------------------------------------------
// 6. Form Data & Payload mapping
// ---------------------------------------------------------------------------

test('mcp helpers: serverConfigToFormData converts stdio and sse server configs accurately', () => {
  // Stdio server with env map
  const stdioServer: McpServerConfig = {
    name: 'custom-stdio',
    serverType: 'stdio',
    command: 'python',
    args: ['-m', 'mcp_server'],
    env: { API_KEY: 'secret-token' },
    envKeys: ['API_KEY'],
    disabled: false,
    enabled: true,
    scope: 'project',
    configPath: '/path/mcp.json',
  };
  const stdioForm = serverConfigToFormData(stdioServer);
  assert.strictEqual(stdioForm.name, 'custom-stdio');
  assert.strictEqual(stdioForm.serverType, 'stdio');
  assert.strictEqual(stdioForm.command, 'python');
  assert.strictEqual(stdioForm.argsText, '"-m" "mcp_server"');
  assert.deepStrictEqual(formDataToSavePayload(stdioForm).server.args, stdioServer.args);
  assert.strictEqual(stdioForm.envEntries.length, 1);
  assert.strictEqual(stdioForm.envEntries[0].key, 'API_KEY');
  assert.strictEqual(stdioForm.envEntries[0].value, 'secret-token');
  assert.strictEqual(stdioForm.scope, 'project');
  assert.strictEqual(stdioForm.enabled, true);

  // SSE server with headers
  const sseServer: McpServerConfig = {
    name: 'remote-sse',
    serverType: 'sse',
    url: 'https://api.example.com/sse',
    headers: { Authorization: 'Bearer test' },
    envKeys: [],
    disabled: true,
    enabled: false,
    scope: 'global',
    configPath: '~/.pi/agent/mcp.json',
  };
  const sseForm = serverConfigToFormData(sseServer);
  assert.strictEqual(sseForm.name, 'remote-sse');
  assert.strictEqual(sseForm.serverType, 'sse');
  assert.strictEqual(sseForm.url, 'https://api.example.com/sse');
  assert.strictEqual(sseForm.headersEntries.length, 1);
  assert.strictEqual(sseForm.headersEntries[0].key, 'Authorization');
  assert.strictEqual(sseForm.headersEntries[0].value, 'Bearer test');
  assert.strictEqual(sseForm.enabled, false);
});

test('mcp helpers: formDataToSavePayload constructs valid payload and manages oldName', () => {
  // Stdio payload creation
  const stdioForm: McpFormData = {
    name: 'new-postgres',
    scope: 'project',
    serverType: 'stdio',
    command: 'npx',
    argsText: '-y @mcp/postgres',
    envEntries: [{ id: '1', key: 'DB_URL', value: 'postgres://localhost' }],
    url: '',
    headersEntries: [],
    enabled: true,
  };
  const payloadAdd = formDataToSavePayload(stdioForm, undefined, '/my-workspace');
  assert.strictEqual(payloadAdd.name, 'new-postgres');
  assert.strictEqual(payloadAdd.oldName, undefined);
  assert.strictEqual(payloadAdd.scope, 'project');
  assert.strictEqual(payloadAdd.cwd, '/my-workspace');
  assert.strictEqual(payloadAdd.server.command, 'npx');
  assert.deepStrictEqual(payloadAdd.server.args, ['-y', '@mcp/postgres']);
  assert.deepStrictEqual(payloadAdd.server.env, { DB_URL: 'postgres://localhost' });
  assert.strictEqual(payloadAdd.server.enabled, true);

  // Rename payload retains oldName
  const payloadRename = formDataToSavePayload(stdioForm, 'old-postgres', '/my-workspace');
  assert.strictEqual(payloadRename.name, 'new-postgres');
  assert.strictEqual(payloadRename.oldName, 'old-postgres');

  // Edit with same name omits oldName
  const payloadSameName = formDataToSavePayload(stdioForm, 'new-postgres', '/my-workspace');
  assert.strictEqual(payloadSameName.name, 'new-postgres');
  assert.strictEqual(payloadSameName.oldName, undefined);

  // SSE payload creation
  const sseForm: McpFormData = {
    name: 'remote-weather',
    scope: 'global',
    serverType: 'sse',
    command: '',
    argsText: '',
    envEntries: [],
    url: 'https://weather.example.com/sse',
    headersEntries: [{ id: 'h1', key: 'X-Api-Key', value: '12345' }],
    enabled: false,
  };
  const ssePayload = formDataToSavePayload(sseForm);
  assert.strictEqual(ssePayload.name, 'remote-weather');
  assert.strictEqual(ssePayload.server.url, 'https://weather.example.com/sse');
  assert.deepStrictEqual(ssePayload.server.headers, { 'X-Api-Key': '12345' });
  assert.strictEqual(ssePayload.server.enabled, false);
  assert.strictEqual(ssePayload.server.disabled, true);
});

// ---------------------------------------------------------------------------
// 7. Form validation logic
// ---------------------------------------------------------------------------

test('mcp validation: validateMcpForm enforces naming and transport rules', () => {
  const t = (key: string) => key;

  // Empty name
  assert.strictEqual(
    validateMcpForm({ ...EMPTY_MCP_FORM, name: '' }, t as any),
    'mcp.error_name_required'
  );
  assert.strictEqual(
    validateMcpForm({ ...EMPTY_MCP_FORM, name: '   ' }, t as any),
    'mcp.error_name_required'
  );

  // Invalid characters in name
  assert.strictEqual(
    validateMcpForm({ ...EMPTY_MCP_FORM, name: 'invalid name with spaces' }, t as any),
    'mcp.error_name_invalid'
  );
  assert.strictEqual(
    validateMcpForm({ ...EMPTY_MCP_FORM, name: 'special@name' }, t as any),
    'mcp.error_name_invalid'
  );
  assert.strictEqual(
    validateMcpForm({ ...EMPTY_MCP_FORM, name: 'path/like' }, t as any),
    'mcp.error_name_invalid'
  );

  // Valid names with letters, numbers, dashes, underscores
  const validFormStdio: McpFormData = {
    ...EMPTY_MCP_FORM,
    name: 'Valid_Name-123',
    serverType: 'stdio',
    command: 'npx',
  };
  assert.strictEqual(validateMcpForm(validFormStdio, t as any), null);

  // Stdio requires command
  const missingCommand: McpFormData = {
    ...validFormStdio,
    command: '   ',
  };
  assert.strictEqual(
    validateMcpForm(missingCommand, t as any),
    'mcp.error_command_required'
  );

  // SSE requires URL
  const sseMissingUrl: McpFormData = {
    ...EMPTY_MCP_FORM,
    name: 'my-sse',
    serverType: 'sse',
    url: '   ',
  };
  assert.strictEqual(
    validateMcpForm(sseMissingUrl, t as any),
    'mcp.error_url_required'
  );

  // SSE rejects invalid URLs
  const sseInvalidUrl: McpFormData = {
    ...EMPTY_MCP_FORM,
    name: 'my-sse',
    serverType: 'sse',
    url: 'not-a-valid-url',
  };
  assert.strictEqual(
    validateMcpForm(sseInvalidUrl, t as any),
    'mcp.error_url_invalid'
  );

  // SSE rejects non-http protocols (e.g. ftp, file)
  const sseFtpUrl: McpFormData = {
    ...EMPTY_MCP_FORM,
    name: 'my-sse',
    serverType: 'sse',
    url: 'ftp://ftp.example.com/stream',
  };
  assert.strictEqual(
    validateMcpForm(sseFtpUrl, t as any),
    'mcp.error_url_invalid'
  );

  // SSE accepts valid HTTP and HTTPS URLs
  const sseValidHttps: McpFormData = {
    ...EMPTY_MCP_FORM,
    name: 'my-sse',
    serverType: 'sse',
    url: 'https://mcp.service.io/events',
  };
  assert.strictEqual(validateMcpForm(sseValidHttps, t as any), null);

  const sseValidHttp: McpFormData = {
    ...EMPTY_MCP_FORM,
    name: 'my-sse',
    serverType: 'sse',
    url: 'http://localhost:8080/mcp',
  };
  assert.strictEqual(validateMcpForm(sseValidHttp, t as any), null);
});

// ---------------------------------------------------------------------------
// 8. Save and Delete immutable calculations
// ---------------------------------------------------------------------------

test('mcp view: calculateSavedServerState appends new server or updates existing server immutably', () => {
  // Adding new server
  const addPayload: SaveMcpServerPayload = {
    name: 'new-sqlite',
    server: {
      command: 'uvx',
      args: ['mcp-server-sqlite'],
      enabled: true,
    },
    scope: 'project',
  };
  const added = calculateSavedServerState(sampleServers, addPayload, '/test/path');
  assert.strictEqual(added.length, sampleServers.length + 1);
  const newServer = added.find((s) => s.name === 'new-sqlite');
  assert.ok(newServer);
  assert.strictEqual(newServer.command, 'uvx');
  assert.strictEqual(newServer.scope, 'project');
  assert.strictEqual(newServer.configPath, '/test/path');
  assert.strictEqual(sampleServers.length, 4); // Original list unchanged

  // Editing existing server
  const editPayload: SaveMcpServerPayload = {
    name: 'git-tools',
    server: {
      command: 'bun',
      args: ['run', 'server.ts'],
      enabled: true,
    },
    scope: 'global',
  };
  const edited = calculateSavedServerState(sampleServers, editPayload);
  assert.strictEqual(edited.length, sampleServers.length);
  const updatedGit = edited.find((s) => s.name === 'git-tools');
  assert.ok(updatedGit);
  assert.strictEqual(updatedGit.command, 'bun');
  assert.strictEqual(updatedGit.enabled, true);
  assert.strictEqual(sampleServers[1].command, 'node'); // Original server untouched
});

test('mcp view: calculateDeletedServerState immutably removes target server', () => {
  // Delete by name and scope
  const deletedProject = calculateDeletedServerState(
    sampleServers,
    'filesystem-server',
    'project'
  );
  assert.strictEqual(deletedProject.length, 3);
  assert.strictEqual(deletedProject.some((s) => s.name === 'filesystem-server'), false);
  assert.strictEqual(sampleServers.length, 4); // Original unchanged

  // Non-matching scope does not delete
  const notDeleted = calculateDeletedServerState(
    sampleServers,
    'filesystem-server',
    'global'
  );
  assert.strictEqual(notDeleted.length, 4);

  // Deleting unknown server leaves list untouched
  const noMatch = calculateDeletedServerState(sampleServers, 'non-existent');
  assert.strictEqual(noMatch.length, 4);
});

// ---------------------------------------------------------------------------
// 9. Add, Edit, and Delete locales & translations
// ---------------------------------------------------------------------------

test('mcp view: CRUD action locale strings translate with key parity in en and es', () => {
  // English keys
  assert.strictEqual(translate('en', 'mcp.btn_add_server'), 'Add Server');
  assert.strictEqual(translate('en', 'mcp.modal_add_title'), 'Add MCP Server');
  assert.strictEqual(
    translate('en', 'mcp.modal_edit_title', { name: 'postgres' }),
    'Edit MCP Server: postgres'
  );
  assert.strictEqual(translate('en', 'mcp.btn_save_server'), 'Save Server');
  assert.strictEqual(translate('en', 'mcp.confirm_delete'), 'Delete');
  assert.strictEqual(
    translate('en', 'mcp.save_success', { name: 'my-server' }),
    'Server "my-server" saved successfully'
  );
  assert.strictEqual(
    translate('en', 'mcp.delete_success', { name: 'my-server' }),
    'Server "my-server" deleted successfully'
  );
  assert.strictEqual(
    translate('en', 'mcp.error_delete_failed', { name: 'my-server', error: 'Locked' }),
    'Failed to delete MCP server "my-server": Locked'
  );

  // Spanish keys
  assert.strictEqual(translate('es', 'mcp.btn_add_server'), 'Agregar servidor');
  assert.strictEqual(translate('es', 'mcp.modal_add_title'), 'Agregar servidor MCP');
  assert.strictEqual(
    translate('es', 'mcp.modal_edit_title', { name: 'postgres' }),
    'Editar servidor MCP: postgres'
  );
  assert.strictEqual(translate('es', 'mcp.btn_save_server'), 'Guardar servidor');
  assert.strictEqual(translate('es', 'mcp.confirm_delete'), 'Eliminar');
  assert.strictEqual(
    translate('es', 'mcp.save_success', { name: 'my-server' }),
    'Servidor "my-server" guardado exitosamente'
  );
  assert.strictEqual(
    translate('es', 'mcp.delete_success', { name: 'my-server' }),
    'Servidor "my-server" eliminado exitosamente'
  );
  assert.strictEqual(
    translate('es', 'mcp.error_delete_failed', { name: 'my-server', error: 'Bloqueado' }),
    'Error al eliminar el servidor MCP "my-server": Bloqueado'
  );
});

// ---------------------------------------------------------------------------
// 10. McpModal section legends, column headers, and empty notice translations
// ---------------------------------------------------------------------------

test('mcp view: modal section legends, column headers, and empty hints translate in en and es', () => {
  // English keys
  assert.strictEqual(translate('en', 'mcp.section_general'), 'General Information');
  assert.strictEqual(
    translate('en', 'mcp.section_transport_stdio'),
    'Command Configuration (stdio)'
  );
  assert.strictEqual(
    translate('en', 'mcp.section_transport_sse'),
    'Remote Server Configuration (SSE)'
  );
  assert.strictEqual(translate('en', 'mcp.kv_col_key'), 'Key / Variable');
  assert.strictEqual(translate('en', 'mcp.kv_col_value'), 'Value');
  assert.strictEqual(translate('en', 'mcp.kv_col_header'), 'Header Name');
  assert.strictEqual(
    translate('en', 'mcp.kv_env_empty'),
    'No environment variables added'
  );
  assert.strictEqual(
    translate('en', 'mcp.kv_headers_empty'),
    'No custom HTTP headers added'
  );

  // Spanish keys
  assert.strictEqual(
    translate('es', 'mcp.section_general'),
    'Información General'
  );
  assert.strictEqual(
    translate('es', 'mcp.section_transport_stdio'),
    'Configuración de Comando (stdio)'
  );
  assert.strictEqual(
    translate('es', 'mcp.section_transport_sse'),
    'Configuración de Servidor Remoto (SSE)'
  );
  assert.strictEqual(translate('es', 'mcp.kv_col_key'), 'Clave / Variable');
  assert.strictEqual(translate('es', 'mcp.kv_col_value'), 'Valor');
  assert.strictEqual(
    translate('es', 'mcp.kv_col_header'),
    'Nombre del encabezado'
  );
  assert.strictEqual(
    translate('es', 'mcp.kv_env_empty'),
    'Sin variables de entorno adicionales'
  );
  assert.strictEqual(
    translate('es', 'mcp.kv_headers_empty'),
    'Sin encabezados HTTP personalizados'
  );
});

// ---------------------------------------------------------------------------
// 11. McpSearchBar component export, rendering, accessibility, and interactions
// ---------------------------------------------------------------------------

test('McpSearchBar: component exists, renders empty and query states with accessibility attributes', () => {
  assert.strictEqual(typeof McpSearchBar, 'function');

  let changedValue = '';
  const elementEmpty = React.createElement(McpSearchBar, {
    value: '',
    onChange: (val: string) => {
      changedValue = val;
    },
    placeholder: 'Search servers...',
    clearAriaLabel: 'Clear search',
    className: 'custom-mcp-search',
  });

  const emptyMarkup = renderToStaticMarkup(elementEmpty);

  // Outer container and classes
  assert.ok(emptyMarkup.includes('mcp-search-box custom-mcp-search'));
  // SVG icon
  assert.ok(emptyMarkup.includes('mcp-search-icon'));
  assert.ok(emptyMarkup.includes('aria-hidden="true"'));
  // Input attributes
  assert.ok(emptyMarkup.includes('class="mcp-search-input"'));
  assert.ok(emptyMarkup.includes('placeholder="Search servers..."'));
  assert.ok(emptyMarkup.includes('aria-label="Search servers..."'));
  assert.ok(emptyMarkup.includes('value=""'));
  // Clear button is not rendered when value is empty
  assert.ok(!emptyMarkup.includes('mcp-search-clear'));

  // Non-empty value renders clear button with aria-label
  const elementFilled = React.createElement(McpSearchBar, {
    value: 'test-filter',
    onChange: (val: string) => {
      changedValue = val;
    },
    placeholder: 'Search servers...',
    clearAriaLabel: 'Clear server search',
  });

  const filledMarkup = renderToStaticMarkup(elementFilled);
  assert.ok(filledMarkup.includes('value="test-filter"'));
  assert.ok(filledMarkup.includes('class="mcp-search-clear"'));
  assert.ok(filledMarkup.includes('aria-label="Clear server search"'));
  assert.ok(filledMarkup.includes('×'));

  // Disabled state suppresses clear button and sets disabled attribute
  const elementDisabled = React.createElement(McpSearchBar, {
    value: 'disabled-query',
    onChange: () => {},
    placeholder: 'Search servers...',
    disabled: true,
  });
  const disabledMarkup = renderToStaticMarkup(elementDisabled);
  assert.ok(disabledMarkup.includes('disabled=""') || disabledMarkup.includes('disabled'));
  assert.ok(!disabledMarkup.includes('mcp-search-clear'));

  // Direct component tree test for event callback handlers
  const instance = McpSearchBar({
    value: 'active-query',
    onChange: (val: string) => {
      changedValue = val;
    },
    placeholder: 'Search servers...',
    clearAriaLabel: 'Clear search',
  });

  assert.ok(React.isValidElement(instance));
  assert.strictEqual(instance.props.className, 'mcp-search-box');

  // Find input and clear button children
  const children = React.Children.toArray(instance.props.children);
  const inputEl = children.find(
    (c): c is React.ReactElement => React.isValidElement(c) && c.type === 'input'
  );
  assert.ok(inputEl);
  inputEl.props.onChange({ target: { value: 'new-search' } });
  assert.strictEqual(changedValue, 'new-search');

  const clearBtn = children.find(
    (c): c is React.ReactElement => React.isValidElement(c) && c.type === 'button'
  );
  assert.ok(clearBtn);
  clearBtn.props.onClick();
  assert.strictEqual(changedValue, '');
});

