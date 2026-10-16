import test from 'node:test';
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { addSseClient, removeSseClient, broadcastSse } from '@server/bridge/sse';

test('OAuth SSE events are private while regular bridge events remain shared', () => {
  const writes = [[], [], []] as string[][];
  const clients = writes.map((output) => ({ write: (value: string) => output.push(value) }) as unknown as ServerResponse);
  try {
    addSseClient(clients[0], 'owner-a');
    addSseClient(clients[1], 'owner-b');
    addSseClient(clients[2]);
    broadcastSse('pi://oauth-event', { kind: 'prompt', data: { promptId: 'prompt-1' } }, 'owner-a');
    assert.equal(writes[0].length, 1);
    assert.deepEqual(writes.slice(1), [[], []]);
    broadcastSse('pi://oauth-event', { kind: 'status', data: { state: 'starting' } });
    assert.equal(writes[0].length, 1);
    assert.deepEqual(writes.slice(1), [[], []]);
    broadcastSse('pi://status', { state: 'connected' });
    assert.deepEqual(writes.map((output) => output.length), [2, 1, 1]);
  } finally {
    clients.forEach(removeSseClient);
  }
});
