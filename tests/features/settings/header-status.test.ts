import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldShowHeaderStatus } from '@features/settings/connection';

test('header connection status is hidden once connected and visible otherwise', () => {
  assert.equal(shouldShowHeaderStatus('connected'), false);
  for (const status of ['connecting', 'disconnected', 'error'] as const) {
    assert.equal(shouldShowHeaderStatus(status), true);
  }
});
