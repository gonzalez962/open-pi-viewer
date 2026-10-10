import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfirmationModal } from '@app/components/ConfirmationModal';
const props = { isOpen: true, title: 'Confirm logout', message: 'Processes keep running.', confirmLabel: 'Log out', cancelLabel: 'Cancel', onConfirm: () => {}, onCancel: () => {} };
test('confirmation modal exposes an accessible named dialog and configurable actions', () => {
  const html = renderToStaticMarkup(React.createElement(ConfirmationModal, props));
  assert.match(html, /role="alertdialog"/);
  assert.match(html, /aria-labelledby=/);
  assert.match(html, /aria-describedby=/);
  for (const value of ['Confirm logout', 'Processes keep running.', 'Log out', 'Cancel']) assert.ok(html.includes(value));
});
test('closed confirmation modal renders nothing; pending actions are disabled', () => {
  assert.equal(renderToStaticMarkup(React.createElement(ConfirmationModal, { ...props, isOpen: false })), '');
  const html = renderToStaticMarkup(React.createElement(ConfirmationModal, { ...props, pending: true }));
  assert.equal((html.match(/disabled=""/g) || []).length, 2);
});
