import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExtensionUiPromptBar, isOptionCustom } from '@features/chat/components/ExtensionUiPromptBar';
import type { QueuedExtensionUiDialog } from '@features/chat/hooks/useExtensionUiDialog';

test('choice descriptions follow their own buttons and labels-only choices stay unchanged', () => {
  for (const multi of [false, true]) {
    const dialog: QueuedExtensionUiDialog = {
      id: 'layout', itemKey: 'layout', method: 'select', createdAt: 0, resolve: () => {},
      request: { type: 'extension_ui_request', id: 'layout', method: 'select', title: 'Choose',
        options: multi ? ['[ ] Alpha', '[ ] Beta', '[ ] Gamma', 'Done'] : ['Alpha', 'Beta', 'Gamma'],
        optionDescriptions: ['First detail', 'Second detail', ''] },
    };
    const html = renderToStaticMarkup(React.createElement(ExtensionUiPromptBar, {
      dialog, onSelect: () => {}, onMultiSelectSubmit: () => {}, onInput: () => {}, onConfirm: () => {}, onCancel: () => {},
    }));
    const role = multi ? 'checkbox' : 'option';
    const buttons = [...html.matchAll(new RegExp(`<button[^>]*role="${role}"[^>]*>[\\s\\S]*?<\\/button>(?:<[^>]+class="extension-prompt-choice-description"[^>]*>[^<]*<\\/[^>]+>)?`, 'g'))];
    assert.strictEqual(buttons.length, 3);
    for (const [index, detail] of ['First detail', 'Second detail'].entries()) {
      const match = buttons[index][0].match(/aria-describedby="([^"]+)"[^>]*>[\s\S]*<\/button><[^>]*id="([^"]+)"[^>]*class="extension-prompt-choice-description"[^>]*>([^<]*)<\/[^>]+>$/);
      assert.ok(match, buttons[index][0]);
      assert.strictEqual(match[1], match[2]);
      assert.strictEqual(match[3], detail);
      assert.ok(!buttons[index][0].split('</button>')[0].includes(detail));
    }
    assert.ok(!buttons[2][0].includes('aria-describedby'));
    assert.ok(buttons[2][0].includes('Gamma'));
  }
});

test('choice lists use responsive columns capped at 350px with full-width buttons', () => {
  const css = readFileSync('src/features/chat/chat.css', 'utf8');
  for (const selector of ['extension-prompt-checkbox-list', 'extension-prompt-options-list']) {
    const block = css.match(new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
    assert.match(block, /display:\s*grid\s*;/);
    assert.match(block, /grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*240px\),\s*min\(100%,\s*350px\)\)\)\s*;/);
  }
  for (const selector of ['extension-prompt-checkbox-item', 'extension-prompt-option-btn']) {
    const block = css.match(new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
    assert.match(block, /width:\s*100%/);
  }
});

test('custom answers use a wrapping textarea without changing standalone input dialogs', () => {
  const source = readFileSync('src/features/chat/components/ExtensionUiPromptBar.tsx', 'utf8');
  const customField = source.slice(source.indexOf('{isTypingCustomOption && ('), source.indexOf('<div className="extension-prompt-footer-actions">', source.indexOf('{isTypingCustomOption && (')));
  assert.match(customField, /<textarea\s/);
  assert.match(customField, /wrap="soft"/);
  assert.match(customField, /rows=\{3\}/);
  assert.match(customField, /value=\{customOptionText\}/);
  assert.match(customField, /onSelect\(itemKey, val\)/);
  assert.match(source, /<input\s+ref=\{inputRef\}\s+type="text"/);
  const css = readFileSync('src/features/chat/chat.css', 'utf8');
  const block = css.match(/\.extension-prompt-custom-textarea\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(block, /white-space:\s*pre-wrap/);
  assert.match(block, /overflow-wrap:\s*anywhere/);
  assert.match(block, /resize:\s*vertical/);
});

test('final answer review keeps per-answer edits but has no redundant modify-selection action', () => {
  const source = readFileSync('src/features/chat/components/ExtensionUiPromptBar.tsx', 'utf8');
  const summary = source.slice(source.indexOf('<div className="extension-prompt-summary-view">'), source.indexOf('<div key={itemKey} className="extension-prompt-step-content">'));
  assert.ok(!summary.includes('Modificar selección'));
  assert.match(summary, /onClick=\{\(\) => handleModifyQuestion\(item.step\)\}/);
  assert.match(summary, /onClick=\{handleFinalSubmit\}/);
  assert.match(summary, /onClick=\{\(\) => onCancel\(itemKey\)\}/);
});

test('Extension UI: isOptionCustom detects custom and free-text options accurately', () => {
  // Common custom options
  assert.strictEqual(isOptionCustom('Type something.', 3, 4), true);
  assert.strictEqual(isOptionCustom('Type something...', 3, 4), true);
  assert.strictEqual(isOptionCustom('Personalizado', 3, 4), true);
  assert.strictEqual(isOptionCustom('Respuesta personalizada', 3, 4), true);
  assert.strictEqual(isOptionCustom('Other...', 3, 4), true);
  assert.strictEqual(isOptionCustom('Otro...', 3, 4), true);
  assert.strictEqual(isOptionCustom('Otra opción...', 3, 4), true);
  assert.strictEqual(isOptionCustom('Escribir respuesta...', 3, 4), true);

  // Standard non-custom options
  assert.strictEqual(isOptionCustom('Option 1: Deploy now', 0, 4), false);
  assert.strictEqual(isOptionCustom('Option 2: Run tests', 1, 4), false);
  assert.strictEqual(isOptionCustom('Option 3: Cancel pipeline', 2, 4), false);
  assert.strictEqual(isOptionCustom('Automatic reconciliation', 0, 2), false);
});

test('Extension UI: ExtensionUiPromptBar marks custom option button with is-custom-choice class', () => {
  const dialog: QueuedExtensionUiDialog = {
    id: 'req-1',
    itemKey: 'test-item-key-1',
    method: 'select',
    request: {
      type: 'extension_ui_request',
      id: 'req-1',
      method: 'select',
      title: 'Choose deployment strategy',
      options: ['Rolling update', 'Canary release', 'Blue-Green', 'Type something.'],
    },
    createdAt: Date.now(),
    resolve: () => {},
  };

  const html = renderToStaticMarkup(
    React.createElement(ExtensionUiPromptBar, {
      dialog,
      onSelect: () => {},
      onMultiSelectSubmit: () => {},
      onInput: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  // Checks that the 4th button has the is-custom-choice CSS marker
  assert.ok(html.includes('is-custom-choice'));
  assert.ok(html.includes('Type something.'));
});
