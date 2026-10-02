import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExtensionUiPromptBar, isOptionCustom } from '@features/chat/components/ExtensionUiPromptBar';
import type { QueuedExtensionUiDialog } from '@features/chat/hooks/useExtensionUiDialog';

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
