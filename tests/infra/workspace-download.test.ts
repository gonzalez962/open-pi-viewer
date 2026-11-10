import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadWorkspaceFile } from '@infra/workspace-download';

test('home download S1.1: listed file sends exact bytes and filename to host', async () => {
  const bytes = new Uint8Array([0, 255, 128]);
  let received: Blob | undefined; let name = '';
  const result = await downloadWorkspaceFile({ workingDirectory: '/home/user/project', relativePath: 'image.bin' }, {
    desktop: false,
    fetchFn: async (_url, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)), { workingDirectory: '/home/user/project', relativePath: 'image.bin' });
      return new Response(bytes, { headers: { 'content-disposition': "attachment; filename*=UTF-8''image.bin" } });
    },
    initiate: (blob, filename) => { received = blob; name = filename; },
  });
  assert.equal(name, 'image.bin');
  assert.deepEqual(new Uint8Array(await received!.arrayBuffer()), bytes);
  assert.equal(result.outcome, 'initiated');
});

test('home download S3.1: failure does not initiate', async () => {
  let initiated = false;
  await assert.rejects(downloadWorkspaceFile({ sourcePath: '~/outside' }, { desktop: false,
    fetchFn: async () => Response.json({ error: 'Access denied' }, { status: 400 }),
    initiate: () => { initiated = true; },
  }), /Access denied/);
  assert.equal(initiated, false);
});

test('home download S2.1: native cancellation is honest', async () => {
  const result = await downloadWorkspaceFile({ sourcePath: 'empty.bin' }, { desktop: true, invokeFn: async <T>(cmd: string, args?: Record<string, unknown>) => {
    assert.equal(cmd, 'download_workspace_file'); assert.deepEqual(args, { payload: { sourcePath: 'empty.bin' } }); return null as T;
  } });
  assert.equal(result.outcome, 'cancelled');
});
