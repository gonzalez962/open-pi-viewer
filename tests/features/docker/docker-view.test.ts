import assert from 'node:assert/strict';
import test from 'node:test';

// The controller is the production interaction boundary used by the Docker view.
// The injected transport avoids Docker and real host configuration access.
async function setup(respond: (payload: any) => unknown | Promise<unknown>) {
  const { createDockerController } = await import('../../../src/features/docker/docker-controller');
  const calls: any[] = [];
  const controller = createDockerController(async (payload: any) => {
    calls.push(payload);
    return respond(payload);
  });
  return { controller, calls };
}

const running = { id: 'aaaaaaaaaaaa', name: 'web', state: 'running', status: 'Up' };
const stopped = { id: 'bbbbbbbbbbbb', name: 'job', state: 'exited', status: 'Exited' };
const yaml = { path: '/example/compose.yml', kind: 'yaml' as const, identity: 'yaml-id' };
const env = { path: '/example/.env', kind: 'env' as const, identity: 'env-id' };

test('S5.3 pull exposes pending and success for the selected container', async () => {
  let finish!: (value: unknown) => void;
  let lists = 0;
  const replacement = { ...running, id: 'cccccccccccc' };
  const { controller, calls } = await setup(p => {
    if (p.action === 'list') return { containers: ++lists === 1 ? [running, stopped] : [replacement, stopped] };
    if (p.action === 'updateImage') return new Promise(resolve => { finish = resolve; });
    if (p.action === 'files') return { files: [yaml] };
    if (p.action === 'readFile') return { content: 'draft', version: 'v1' };
    return {};
  });
  await controller.refresh(); await controller.select(running.id); await controller.loadFiles(); await controller.openFile(yaml);
  const pending = controller.updateImage(true);
  assert.deepEqual(calls[calls.length - 1], { action: 'updateImage', containerId: running.id, confirmed: true });
  assert.equal(controller.getState().updating, true);
  finish({ ok: true }); await pending;
  assert.equal(controller.getState().updating, false);
  assert.equal(controller.getState().notice, 'updateImage');
  assert.equal(controller.getState().error, '');
  assert.deepEqual(calls[calls.length - 1], { action: 'list' });
  assert.deepEqual(controller.getState().containers, [replacement, stopped]);
  assert.equal(controller.getState().selected, null);
  assert.deepEqual(controller.getState().files, []);
  assert.equal(controller.getState().file, null);
  assert.equal(controller.getState().content, '');
  assert.equal(controller.getState().version, '');
});

test('S5.2 S5.3 pull errors are visible but completion is not attributed to another selection', async () => {
  let reject!: (error: Error) => void;
  const { controller } = await setup(p => {
    if (p.action === 'list') return { containers: [running, stopped] };
    if (p.action === 'updateImage') return new Promise((_, fail) => { reject = fail; });
    return { files: [] };
  });
  await controller.refresh(); await controller.select(running.id);
  const first = controller.updateImage(true); reject(new Error('pull failed')); await first;
  assert.match(controller.getState().error, /pull failed/);
  const second = controller.updateImage(true);
  await controller.select(stopped.id);
  reject(new Error('old pull failed')); await second;
  assert.equal(controller.getState().selected, stopped.id);
  assert.equal(controller.getState().error, '');
  assert.equal(controller.getState().notice, '');
});

test('S5.3 successful pull after selection change does not label the new selection', async () => {
  let finish!: (value: unknown) => void;
  const { controller } = await setup(p => p.action === 'list' ? { containers: [running, stopped] } : new Promise(resolve => { finish = resolve; }));
  await controller.refresh(); await controller.select(running.id);
  const pending = controller.updateImage(true);
  await controller.select(stopped.id);
  assert.equal(controller.getState().updating, false);
  finish({ ok: true }); await pending;
  assert.equal(controller.getState().selected, stopped.id);
  assert.equal(controller.getState().notice, '');
  assert.equal(controller.getState().error, '');
});

test('S5.3 cancelled update does not send a request; confirmed update is pending and selection-aware', async () => {
  let finish!: (result: unknown) => void;
  const { controller, calls } = await setup(p => p.action === 'list' ? { containers: [running, stopped] } : new Promise(resolve => { finish = resolve; }));
  await controller.refresh(); await controller.select(running.id);
  await (controller as any).updateImage(false);
  assert.equal(calls.length, 1);
  const pending = (controller as any).updateImage(true);
  assert.deepEqual(calls[calls.length - 1], { action: 'updateImage', containerId: running.id, confirmed: true });
  assert.equal((controller.getState() as any).updating, true);
  await controller.select(stopped.id);
  finish({ ok: true }); await pending;
  assert.equal(controller.getState().notice, ''); assert.equal(controller.getState().error, '');
});

test('S5.2 standalone update unavailable is visible without success', async () => {
  const { controller } = await setup(p => { if (p.action === 'list') return { containers: [running] }; throw new Error('Compose metadata unavailable'); });
  await controller.refresh(); await controller.select(running.id); await controller.updateImage(true);
  assert.equal(controller.getState().error, 'Compose metadata unavailable');
  assert.equal(controller.getState().notice, '');
  assert.equal(controller.getState().updateFailed, true);
  assert.equal(controller.getState().updating, false);
});

test('S5.2 recreation partial failure is visible', async () => {
  const { controller } = await setup(p => { if (p.action === 'list') return { containers: [running] }; throw new Error('Image downloaded; recreation failed'); });
  await controller.refresh(); await controller.select(running.id);
  await (controller as any).updateImage(true);
  assert.match(controller.getState().error, /downloaded.*recreation failed/i);
});

test('S1.1 S1.2: global list and exact action retain containers on failure', async () => {
  const { controller, calls } = await setup(p => {
    if (p.action === 'list') return { containers: [running, stopped] };
    throw new Error('Docker unavailable');
  });
  await controller.refresh();
  assert.deepEqual(controller.getState().containers, [running, stopped]);
  await controller.select(running.id);
  await controller.action('restart');
  assert.deepEqual(calls[calls.length - 1], { action: 'restart', containerId: running.id });
  assert.match(controller.getState().error, /Docker unavailable/);
  assert.deepEqual(controller.getState().containers, [running, stopped]);
  assert.deepEqual(calls[0], { action: 'list' });
});

test('S1.2: start and stop target only the selected container', async () => {
  const { controller, calls } = await setup(p => p.action === 'list' ? { containers: [running, stopped] } : { ok: true });
  await controller.refresh();
  await controller.select(stopped.id);
  await controller.action('start');
  await controller.select(running.id);
  await controller.action('stop');
  assert.ok(calls.some(p => p.action === 'start' && p.containerId === stopped.id));
  assert.ok(calls.some(p => p.action === 'stop' && p.containerId === running.id));
});

test('S1.3: removal requires confirmation and a stopped selection', async () => {
  const { controller, calls } = await setup(p => p.action === 'list' ? { containers: [running, stopped] } : { ok: true });
  await controller.refresh();
  await controller.select(running.id);
  await controller.remove(true);
  await controller.select(stopped.id);
  await controller.remove(false);
  assert.equal(calls.filter(p => p.action === 'remove').length, 0);
  await controller.remove(true);
  assert.deepEqual(calls.filter(p => p.action === 'remove'), [{ action: 'remove', containerId: stopped.id, confirmed: true }]);
});

test('S1.4: logs show returned bounded snapshot or explicit error', async () => {
  let fail = false;
  const { controller, calls } = await setup(p => {
    if (p.action === 'list') return { containers: [running] };
    if (p.action === 'logs') { if (fail) throw new Error('output limit exceeded'); return { stdout: 'line\n', stderr: 'warning' }; }
    return { files: [] };
  });
  await controller.refresh(); await controller.select(running.id); await controller.loadLogs();
  assert.deepEqual(calls[calls.length - 1], { action: 'logs', containerId: running.id });
  assert.deepEqual(controller.getState().logs, { stdout: 'line\n', stderr: 'warning' });
  fail = true; await controller.loadLogs();
  assert.match(controller.getState().error, /output limit exceeded/);
});

test('S2.1 S3.1: discovered descriptors and raw YAML and env text round trip without lifecycle actions', async () => {
  const { controller, calls } = await setup(p => {
    if (p.action === 'list') return { containers: [running] };
    if (p.action === 'files') return { files: [yaml, env] };
    if (p.action === 'readFile') return { content: p.file.kind === 'env' ? 'A="a=b"\n# raw\n' : 'services:\n  web: {}\n', version: 'v1' };
    return { ok: true };
  });
  await controller.refresh(); await controller.select(running.id); await controller.loadFiles();
  assert.deepEqual(controller.getState().files, [yaml, env]);
  await controller.openFile(env);
  assert.equal(controller.getState().content, 'A="a=b"\n# raw\n');
  controller.editContent('A="new=1"\n# raw\n');
  await controller.saveFile();
  assert.deepEqual(calls.find(p => p.action === 'saveFile'), { action: 'saveFile', containerId: running.id, file: env, version: 'v1', content: 'A="new=1"\n# raw\n' });
  assert.equal(calls.some(p => ['start', 'stop', 'restart'].includes(p.action)), false);
});

test('S2.2 S3.2 S3.3: unavailable configuration and failed save remain explicit and retain draft', async () => {
  let unavailable = true;
  const { controller } = await setup(p => {
    if (p.action === 'list') return { containers: [stopped] };
    if (p.action === 'files') { if (unavailable) throw new Error('configuration unavailable'); return { files: [yaml] }; }
    if (p.action === 'readFile') return { content: 'original', version: 'v1' };
    if (p.action === 'saveFile') throw new Error('validation failed or file changed');
    return { ok: true };
  });
  await controller.refresh(); await controller.select(stopped.id); await controller.loadFiles();
  assert.match(controller.getState().error, /configuration unavailable/);
  assert.deepEqual(controller.getState().containers, [stopped]);
  unavailable = false; await controller.loadFiles(); await controller.openFile(yaml);
  controller.editContent('draft'); await controller.saveFile();
  assert.equal(controller.getState().content, 'draft');
  assert.match(controller.getState().error, /validation failed or file changed/);
});

test('S4.3: Docker navigation is offered on web only, preserving other destinations', async () => {
  const { dockerNavigation } = await import('../../../src/features/docker/docker-controller');
  const existing = ['chat', 'settings'];
  assert.deepEqual(dockerNavigation(existing, false), existing);
  assert.deepEqual(dockerNavigation(existing, true), ['chat', 'settings', 'docker']);
});

test('S4.1 S4.2: authentication denial is visible and not an empty success', async () => {
  const { controller } = await setup(() => { throw new Error('Authentication required'); });
  await controller.refresh();
  assert.match(controller.getState().error, /Authentication required/);
});
