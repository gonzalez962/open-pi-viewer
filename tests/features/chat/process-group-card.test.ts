import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProcessGroupCard } from '@features/chat/components/ProcessGroupCard';
import { getCategoryDetails } from '@features/chat/process-utils';
import { createProcessGroup } from '@core/process-grouping';
import enJson from '@shared/locales/en.json';
import esJson from '@shared/locales/es.json';

const tEn = (key: any, params?: any) => {
  let str = (enJson as any)[key] || key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(`{${k}}`, String(v));
    }
  }
  return str;
};

const tEs = (key: any, params?: any) => {
  let str = (esJson as any)[key] || key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(`{${k}}`, String(v));
    }
  }
  return str;
};

test('process-card: getCategoryDetails maps categories to labels and glyphs in en and es', () => {
  // bash
  const bashEn = getCategoryDetails('bash', 5, tEn);
  assert.equal(bashEn.label, 'bash');
  assert.equal(bashEn.countLabel, '5 executions');
  assert.equal(bashEn.glyph, '');

  const bashEs = getCategoryDetails('bash', 1, tEs);
  assert.equal(bashEs.label, 'bash');
  assert.equal(bashEs.countLabel, '1 ejecución');

  // edit
  const editEs = getCategoryDetails('edit', 3, tEs);
  assert.equal(editEs.label, 'edit');
  assert.equal(editEs.countLabel, '3 ediciones');

  // read
  const readEn = getCategoryDetails('read', 2, tEn);
  assert.equal(readEn.label, 'read');
  assert.equal(readEn.countLabel, '2 files');

  // agents
  const agentEs = getCategoryDetails('agents', 1, tEs);
  assert.equal(agentEs.label, 'agentes');
  assert.equal(agentEs.countLabel, '1 subagente');
  assert.equal(agentEs.glyph, '󰚩');
});

test('process-card: ProcessGroupCard renders general header, categories, and + toggle signs', () => {
  const group = createProcessGroup(
    'group-1',
    [
      {
        id: 'item-1',
        category: 'bash',
        block: { type: 'tool_call', id: 't1', name: 'bash', status: 'completed' },
        messageId: 'm1',
      },
      {
        id: 'item-2',
        category: 'read',
        block: { type: 'tool_call', id: 't2', name: 'read', status: 'completed' },
        messageId: 'm2',
      },
      {
        id: 'item-3',
        category: 'agents',
        block: { type: 'tool_call', id: 't3', name: 'subagent_run', status: 'completed' },
        messageId: 'm3',
      },
    ],
    '12:00'
  );

  const html = renderToStaticMarkup(
    React.createElement(ProcessGroupCard, {
      group,
      t: tEs,
    })
  );

  // General header present
  assert.ok(html.includes('Procesos ejecutados'));
  assert.ok(html.includes('3 actividades'));
  assert.ok(html.includes('Ampliar todo'));
  assert.ok(html.includes('+'));

  // Categories present
  assert.ok(html.includes('agentes'));
  assert.ok(html.includes('bash'));
  assert.ok(html.includes('read'));
});
