import assert from 'node:assert/strict';
import test from 'node:test';

import { describeReloadOutcome } from '@core/commands';

test('describeReloadOutcome: a successful reconnect maps to the success notice', () => {
  assert.deepEqual(describeReloadOutcome({ status: 'success' }), {
    key: 'command_palette.reload_success',
  });
});

test('describeReloadOutcome: a failed reconnect maps to the failure notice carrying the error', () => {
  assert.deepEqual(describeReloadOutcome({ status: 'error', error: 'spawn node ENOENT' }), {
    key: 'command_palette.reload_failed',
    params: { error: 'spawn node ENOENT' },
  });
});

test('describeReloadOutcome: an empty error message falls back to a generic "unknown error" placeholder', () => {
  assert.deepEqual(describeReloadOutcome({ status: 'error', error: '   ' }), {
    key: 'command_palette.reload_failed',
    params: { error: 'unknown error' },
  });
});

test('describeReloadOutcome: a superseded/cancelled attempt is never reported as success', () => {
  assert.deepEqual(describeReloadOutcome({ status: 'cancelled' }), {
    key: 'command_palette.reload_superseded',
  });
});

test('describeReloadOutcome: a reload requested while one is already running maps to the busy notice', () => {
  assert.deepEqual(describeReloadOutcome({ status: 'busy' }), {
    key: 'command_palette.reload_busy',
  });
});
