import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmWebLogout } from '@infra/web-auth';

test('cancelled logout does not revoke access or send requests', async () => {
  let calls = 0;
  const ok = await confirmWebLogout('Processes keep running', () => false, async () => { calls++; });
  assert.equal(ok, false);
  assert.equal(calls, 0);
});

test('confirmed logout revokes web access exactly once and propagates failures', async () => {
  let calls = 0;
  const ok = await confirmWebLogout('Processes keep running', message => { assert.equal(message, 'Processes keep running'); return true; }, async () => { calls++; });
  assert.equal(ok, true);
  assert.equal(calls, 1);
  await assert.rejects(confirmWebLogout('Confirm', () => true, async () => { throw new Error('revoke failed'); }), /revoke failed/);
});
