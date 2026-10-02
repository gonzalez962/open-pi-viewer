import assert from 'node:assert/strict';
import test from 'node:test';
import {
  exportToMarkdown,
  exportToJson,
  generateExportFilename,
  sanitizeFilename,
} from '@core/export';
import type { ChatMessage } from '@core/types/messages';

test('export: sanitizeFilename cleans invalid filename characters and trims whitespace', () => {
  assert.equal(sanitizeFilename('My Feature: Part 1/2?'), 'my-feature--part-1-2-');
  assert.equal(sanitizeFilename('   Normal Title   '), 'normal-title');
  assert.equal(sanitizeFilename(''), 'session');
  assert.equal(sanitizeFilename(undefined), 'session');
});

test('export: generateExportFilename includes safe title, date, and extension', () => {
  const nameMd = generateExportFilename('Integracion pi-messages', 'md');
  assert.ok(nameMd.startsWith('integracion-pi-messages-'));
  assert.ok(nameMd.endsWith('.md'));

  const nameJson = generateExportFilename('Test Session', 'json');
  assert.ok(nameJson.startsWith('test-session-'));
  assert.ok(nameJson.endsWith('.json'));
});

test('export: exportToMarkdown structures conversation with headers, code, and details', () => {
  const messages: ChatMessage[] = [
    {
      id: 'm1',
      role: 'user',
      content: 'Hello, can you write code?',
      timestamp: '12:00:00',
    },
    {
      id: 'm2',
      role: 'assistant',
      content: 'Sure! Here is code.',
      timestamp: '12:00:05',
      blocks: [
        { type: 'thinking', thinking: 'Model thoughts here' },
        { type: 'tool_call', id: 't1', name: 'read', status: 'completed', args: { path: 'file.ts' }, output: 'content' },
        { type: 'text', text: 'Sure! Here is code.' },
      ],
    },
  ];

  const md = exportToMarkdown(messages, 'Mi Sesion');
  assert.ok(md.includes('# Mi Sesion'));
  assert.ok(md.includes('👤 User — *12:00:00*'));
  assert.ok(md.includes('Hello, can you write code?'));
  assert.ok(md.includes('🤖 Assistant — *12:00:05*'));
  assert.ok(md.includes('💭 **Reasoning**'));
  assert.ok(md.includes('Model thoughts here'));
  assert.ok(md.includes('<code>read</code> (completed)'));
  assert.ok(md.includes('file.ts'));
});

test('export: exportToJson formats valid JSON containing messages array and metadata', () => {
  const messages: ChatMessage[] = [
    {
      id: 'm1',
      role: 'user',
      content: 'test',
      timestamp: '10:00:00',
    },
  ];

  const jsonStr = exportToJson(messages, 'Test Export');
  const parsed = JSON.parse(jsonStr);
  assert.equal(parsed.title, 'Test Export');
  assert.ok(parsed.exportedAt);
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.messages[0].content, 'test');
});
