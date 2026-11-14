import test from 'node:test';
import assert from 'node:assert/strict';
import { dockerRequest } from '../../src/infra/bridge';

const payload = { action: 'updateImage', containerId: 'bbbbbbbbbbbb', confirmed: true };
const event = (value: unknown) => JSON.stringify(value) + '\n';
function response(bytes: Uint8Array[]) {
  return new Response(new ReadableStream({ start(controller) { for (const part of bytes) controller.enqueue(part); controller.close(); } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
}

test('S6.3 parses split UTF-8 and multiple NDJSON records incrementally', async () => {
  const bytes = new TextEncoder().encode(event({ type: 'phase', phase: 'pull' }) + event({ type: 'output', stream: 'stdout', text: 'línea\n' }) + event({ type: 'result', ok: true }));
  const i = bytes.indexOf(0xc3);
  const seen: any[] = [];
  await (dockerRequest as any)(payload, async () => response([bytes.slice(0, i + 1), bytes.slice(i + 1, i + 2), bytes.slice(i + 2)]), (value: unknown) => seen.push(value));
  assert.deepEqual(seen, [{ type: 'phase', phase: 'pull' }, { type: 'output', stream: 'stdout', text: 'línea\n' }, { type: 'result', ok: true }]);
});

test('S6.2 EOF without terminal event is unknown, not success', async () => {
  await assert.rejects((dockerRequest as any)(payload, async () => response([new TextEncoder().encode(event({ type: 'phase', phase: 'pull' }))]), () => {}), /unknown/i);
});

function brokenAfter(value: unknown) {
  let reads = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (reads++ === 0) controller.enqueue(new TextEncoder().encode(event(value)));
    else controller.error(new Error('raw transport failure'));
  } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
}

test('S6.2 read failure after progress reports unknown outcome without retry or cancellation', async () => {
  const seen: any[] = []; let calls = 0;
  await assert.rejects((dockerRequest as any)(payload, async () => { calls++; return brokenAfter({ type: 'phase', phase: 'pull' }); }, (item: unknown) => seen.push(item)), (error: Error) => {
    assert.match(error.message, /unknown/i); assert.match(error.message, /may continue/i); assert.doesNotMatch(error.message, /raw transport failure/i); return true;
  });
  assert.equal(calls, 1); assert.deepEqual(seen, [{ type: 'phase', phase: 'pull' }]);
});

test('S6.2 received terminal result remains authoritative despite later read failure', async () => {
  assert.deepEqual(await (dockerRequest as any)(payload, async () => brokenAfter({ type: 'result', ok: true }), () => {}), { ok: true });
  await assert.rejects((dockerRequest as any)(payload, async () => brokenAfter({ type: 'result', ok: false, error: 'recreation failed' }), () => {}), /recreation failed/i);
});

test('S6.2 failed terminal event reports failure', async () => {
  await assert.rejects((dockerRequest as any)(payload, async () => response([new TextEncoder().encode(event({ type: 'result', ok: false, error: 'pull failed' }))]), () => {}), /pull failed/i);
});

test('S6.3 rejects an unbounded unterminated record', async () => {
  await assert.rejects((dockerRequest as any)(payload, async () => response([new TextEncoder().encode('x'.repeat(1024 * 1024))]), () => {}), /limit|large|size/i);
});

test('S6.2 non-update JSON remains unchanged', async () => {
  const data = await dockerRequest({ action: 'list' }, async () => new Response(JSON.stringify({ containers: [] }), { headers: { 'Content-Type': 'application/json' } }));
  assert.deepEqual(data, { containers: [] });
});
