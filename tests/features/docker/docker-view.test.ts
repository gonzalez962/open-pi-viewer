import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { registerHooks } from 'node:module';

registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  return nextLoad(url, context);
} });

// Exercise the real presentation component, not the controller as a proxy for the UI.
// A browser is still needed to verify showModal, focus, Escape, and scrolling.
const updateConsole = { id: 'aaaaaaaaaaaa', phase: 'recreate', phases: ['pull', 'recreate'], text: 'live output\n' };

test('S7.1 update output renders in a named native dialog with phase and live log', async () => {
  const { UpdateLogModal } = await import('../../../src/features/docker/DockerView');
  const html = renderToStaticMarkup(React.createElement(UpdateLogModal, {
    isOpen: true, console: updateConsole, locale: 'en', onClose: () => {},
  }));
  assert.match(html, /<dialog\b/);
  assert.match(html, /aria-labelledby="([^"]+)"/);
  const titleId = html.match(/aria-labelledby="([^"]+)"/)![1];
  assert.ok(html.includes(`id="${titleId}"`));
  assert.match(html, /recreate/);
  assert.match(html, /live output/);
  assert.match(html, /aaaaaaaaaaaa/);
  assert.match(html, /<button\b[^>]*>[^<]*close/i);
  assert.match(html, /<pre\b[^>]*>[^<]*live output/);
});

test('S7.2 closed output is hidden and retained output renders again without a selected container', async () => {
  const { UpdateLogModal } = await import('../../../src/features/docker/DockerView');
  const props = { console: updateConsole, locale: 'en' as const, onClose: () => {} };
  assert.equal(renderToStaticMarkup(React.createElement(UpdateLogModal, { ...props, isOpen: false })), '');
  const reopened = renderToStaticMarkup(React.createElement(UpdateLogModal, { ...props, isOpen: true }));
  assert.match(reopened, /<dialog\b/);
  assert.match(reopened, /aaaaaaaaaaaa/);
  assert.match(reopened, /live output/);
});

test('S8.1 retained update output offers no reopen control in the production view', async () => {
  const { createDockerController } = await import('../../../src/features/docker/docker-controller');
  const { DockerView } = await import('../../../src/features/docker/DockerView');
  const controller = createDockerController((async (payload: any, onEvent: any) => {
    if (payload.action === 'list') return { containers: [{ id: 'aaaaaaaaaaaa', name: 'web', state: 'running', status: 'Up' }] };
    onEvent?.({ type: 'output', stream: 'stdout', text: 'retained output' });
    onEvent?.({ type: 'result', ok: true });
    return { ok: true };
  }) as any);
  await controller.refresh();
  await controller.select('aaaaaaaaaaaa');
  await controller.updateImage(true);
  assert.match(controller.getState().updateConsole?.text ?? '', /retained output/);
  const html = renderToStaticMarkup(React.createElement(DockerView, { locale: 'en', controller } as any));
  // Confirm SSR actually consumed the populated controller before checking absence.
  assert.match(html, /web/);
  assert.doesNotMatch(html, /<button\b[^>]*>\s*View update log\s*<\/button>/i);
});

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

test('S11.1 production metadata and discovered paths are presented separately', async () => {
  const files = [yaml, env, { path: 'C:\\deploy\\other\\stack.yaml', kind: 'yaml' as const, identity: 'win' }, { path: 'C:\\deploy\\other\\.env', kind: 'env' as const, identity: 'win-env' }];
  const container = { ...running, status: 'Up 3 hours' };
  const { controller } = await setup(p => p.action === 'list' ? { containers: [container] } : { files });
  await controller.refresh(); await controller.select(container.id); await controller.loadFiles();
  const { DockerView } = await import('../../../src/features/docker/DockerView');
  const html = renderToStaticMarkup(React.createElement(DockerView, { locale: 'en', controller }));
  const list = html.match(/<button[^>]*aria-pressed="true"[^>]*>[\s\S]*?<\/button>/)![0];
  assert.doesNotMatch(list, /Up 3 hours/);
  assert.match(list, />Running<\/span>/);
  const detail = html.slice(html.indexOf(container.id), html.indexOf('Restart'));
  assert.ok(detail.indexOf('Up 3 hours') < detail.indexOf('>Running</span>'));
  assert.doesNotMatch(html, /Available only for containers with accessible Compose metadata and files\./);
  const buttons = [...html.matchAll(/<button\b[^>]*>([^<]*)<\/button>/g)].map(m => m[1].trim());
  for (const name of ['compose.yml', 'stack.yaml']) assert.ok(buttons.includes(name));
  assert.equal(buttons.filter(b => b === '.env').length, 2);
  assert.ok(!buttons.some(b => b.includes('/example/') || b.includes('C:\\deploy')));
  assert.equal(html.split('/example').length - 1, 1);
  assert.equal(html.split('C:\\deploy\\other').length - 1, 1);
  assert.ok(html.indexOf('/example') < html.indexOf('>compose.yml</button>'));
  assert.ok(html.indexOf('C:\\deploy\\other') < html.indexOf('>stack.yaml</button>'));
});

test('S11.2 reopening the selected file closes without saving and another file opens', async () => {
  const { controller, calls } = await setup(p => p.action === 'list' ? { containers: [running] } : p.action === 'files' ? { files: [yaml, env] } : { content: p.file.kind, version: 'v1' });
  await controller.refresh(); await controller.select(running.id); await controller.loadFiles(); await controller.openFile(yaml);
  controller.editContent('unsaved'); await controller.openFile(yaml);
  assert.equal(controller.getState().file, null); assert.equal(controller.getState().content, ''); assert.equal(controller.getState().version, '');
  assert.equal(calls.filter(p => p.action === 'readFile').length, 1);
  assert.equal(calls.some(p => p.action === 'saveFile'), false);
  await controller.openFile(env);
  assert.deepEqual(controller.getState().file, env); assert.equal(controller.getState().content, 'env');
  const { DockerView } = await import('../../../src/features/docker/DockerView');
  assert.match(renderToStaticMarkup(React.createElement(DockerView, { locale: 'en', controller })), /<textarea\b/);
});

test('S11.2 late reads and errors cannot replace a newer editor or emit stale feedback', async () => {
  const pending: { resolve: (value: any) => void; reject: (error: Error) => void }[] = [];
  const { controller } = await setup(p => p.action === 'list' ? { containers: [running] } : p.action === 'files' ? { files: [yaml, env] } : new Promise((resolve, reject) => pending.push({ resolve, reject })));
  const feedback: unknown[] = []; controller.subscribeFeedback(event => feedback.push(event));
  await controller.refresh(); await controller.select(running.id); await controller.loadFiles();
  const first = controller.openFile(yaml); const second = controller.openFile(env);
  pending[1].resolve({ content: 'env contents', version: 'env-v' }); await second;
  pending[0].resolve({ content: 'stale', version: 'old' }); await first;
  assert.deepEqual(controller.getState().file, env); assert.equal(controller.getState().content, 'env contents'); assert.equal(controller.getState().version, 'env-v');
  const third = controller.openFile(yaml); await controller.openFile(env);
  pending[2].reject(new Error('stale error')); await third;
  assert.equal(controller.getState().file, null); assert.equal(controller.getState().content, ''); assert.equal(controller.getState().version, '');
  assert.deepEqual(feedback, []); assert.equal(controller.getState().error, '');
  const { DockerView } = await import('../../../src/features/docker/DockerView');
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(DockerView, { locale: 'en', controller })), /<textarea\b/);
});

test('S11.2 completing a save after closing does not reopen its file', async () => {
  let finish!: (value: unknown) => void;
  const { controller, calls } = await setup(p => p.action === 'list' ? { containers: [running] } : p.action === 'files' ? { files: [yaml, env] } : p.action === 'readFile' ? { content: 'original', version: 'v1' } : new Promise(resolve => { finish = resolve; }));
  await controller.refresh(); await controller.select(running.id); await controller.loadFiles(); await controller.openFile(yaml);
  controller.editContent('draft'); const save = controller.saveFile(); await controller.openFile(yaml);
  finish({ ok: true }); await save;
  assert.equal(controller.getState().file, null); assert.equal(controller.getState().content, ''); assert.equal(controller.getState().version, '');
  assert.equal(calls.filter(p => p.action === 'readFile').length, 1);
});

test('S11.1 root directories retain their separators in rendered file context', async () => {
  const files = [
    { path: 'C:\\file.yml', kind: 'yaml' as const, identity: 'drive-root' },
    { path: '/root.yml', kind: 'yaml' as const, identity: 'posix-root' },
  ];
  const { controller } = await setup(p => p.action === 'list' ? { containers: [running] } : { files });
  await controller.refresh(); await controller.select(running.id); await controller.loadFiles();
  const { DockerView } = await import('../../../src/features/docker/DockerView');
  const html = renderToStaticMarkup(React.createElement(DockerView, { locale: 'en', controller }));
  assert.ok(html.includes('C:\\ · /</p>'));
  assert.match(html, />file\.yml<\/button>/);
  assert.match(html, />root\.yml<\/button>/);
});

// A feedback event is emitted once per completed operation, not per state update.
// The view must adapt these events to the existing Settings toast manager.
test('S10.2 identical completed updates emit distinct feedback; stream updates emit none', async () => {
  let emit!: (event: any) => void;
  let finish!: (value: unknown) => void;
  const { createDockerController } = await import('../../../src/features/docker/docker-controller');
  const controller = createDockerController((async (payload: any, onEvent: any) => {
    if (payload.action === 'list') return { containers: [running] };
    emit = onEvent;
    return new Promise(resolve => { finish = resolve; });
  }) as any);
  const feedback: any[] = [];
  (controller as any).subscribeFeedback((event: any) => feedback.push(event));
  await controller.refresh(); await controller.select(running.id);
  for (let i = 0; i < 2; i++) {
    const pending = controller.updateImage(true);
    emit({ type: 'phase', phase: 'pull' });
    emit({ type: 'output', stream: 'stdout', text: 'progress' });
    assert.equal(feedback.length, i);
    emit({ type: 'result', ok: true });
    finish({ ok: true }); await pending;
    assert.equal(feedback.length, i + 1);
    assert.equal(feedback[i].type, 'success');
    assert.equal(feedback[i].notice, 'updateImage');
  }
});

test('S10.2 update failures notify once and selection changes suppress stale completion', async () => {
  let reject!: (error: Error) => void;
  const { controller } = await setup(p => p.action === 'list' ? { containers: [running, stopped] } : new Promise((_, fail) => { reject = fail; }));
  const feedback: any[] = [];
  (controller as any).subscribeFeedback((event: any) => feedback.push(event));
  await controller.refresh(); await controller.select(running.id);
  const first = controller.updateImage(true); reject(new Error('pull failed')); await first;
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].type, 'error');
  assert.equal(feedback[0].error, 'pull failed');
  assert.equal(feedback[0].updateFailed, true);
  const second = controller.updateImage(true); await controller.select(stopped.id);
  reject(new Error('old pull failed')); await second;
  assert.equal(feedback.length, 1);
});

test('S10.1 result feedback is not rendered as an inline banner', async () => {
  const { DockerView } = await import('../../../src/features/docker/DockerView');
  const { controller } = await setup(p => {
    if (p.action === 'list') return { containers: [running] };
    throw new Error('distinct operation failure');
  });
  await controller.refresh(); await controller.select(running.id); await controller.action('restart');
  const html = renderToStaticMarkup(React.createElement(DockerView, { locale: 'en', controller }));
  assert.match(html, /web/);
  assert.doesNotMatch(html, /distinct operation failure/);
  assert.doesNotMatch(html, /class="docker-error"/);
});

test('S10 production toast adapter localizes results, preserves update error context and unsubscribes', async () => {
  const { subscribeDockerToasts } = await import('../../../src/features/docker/DockerView');
  const { translate } = await import('../../../src/shared/i18n');
  let fail = false;
  const { controller } = await setup(p => {
    if (p.action === 'list') return { containers: [running] };
    if (fail) throw new Error('pull failed');
    return { ok: true };
  });
  const messages: string[] = [];
  const unsubscribe = subscribeDockerToasts(controller, 'es', {
    success: message => { messages.push(`success:${message}`); return ''; },
    error: message => { messages.push(`error:${message}`); return ''; },
  });
  await controller.refresh(); await controller.select(running.id);
  await controller.action('restart'); await controller.action('restart');
  assert.deepEqual(messages, [`success:${translate('es', 'docker.feedback_restart', { container: 'web' })}`, `success:${translate('es', 'docker.feedback_restart', { container: 'web' })}`]);
  fail = true; await controller.updateImage(true);
  assert.equal(messages[2], `error:${translate('es', 'docker.error_updateImage', { container: 'web', reason: 'pull failed' })}`);
  unsubscribe(); await controller.updateImage(true);
  assert.equal(messages.length, 3);
});

test('S10 lifecycle completion after switching selection emits no stale feedback', async () => {
  let finish!: (value: unknown) => void;
  const { controller } = await setup(p => p.action === 'list' ? { containers: [running, stopped] } : new Promise(resolve => { finish = resolve; }));
  const events: unknown[] = [];
  controller.subscribeFeedback(event => events.push(event));
  await controller.refresh(); await controller.select(running.id);
  const operation = controller.action('restart');
  await controller.select(stopped.id); finish({ ok: true }); await operation;
  assert.deepEqual(events, []);
  assert.equal(controller.getState().selected, stopped.id);
});

for (const [state, expected] of [
  ['running', 'Stop'], ['exited', 'Start'], ['created', 'Start'], ['dead', 'Start'],
  ['unknown', null], ['restarting', null],
] as const) {
  test(`S9 selected ${state} container exposes only its applicable lifecycle action`, async () => {
    const container = { ...running, state };
    const { controller } = await setup(p => p.action === 'list' ? { containers: [container] } : {});
    await controller.refresh();
    await controller.select(container.id);
    const { DockerView } = await import('../../../src/features/docker/DockerView');
    const html = renderToStaticMarkup(React.createElement(DockerView, { locale: 'en', controller }));
    assert.match(html, /web/);
    const labels = [...html.matchAll(/<button\b[^>]*>([^<]*)<\/button>/g)].map(match => match[1].trim());
    assert.equal(labels.includes('Start'), expected === 'Start');
    assert.equal(labels.includes('Stop'), expected === 'Stop');
    for (const label of ['Restart', 'Update image', 'Remove', 'Configuration', 'Logs']) {
      assert.ok(labels.includes(label), `missing existing ${label} action`);
    }
  });
}

test('S6.1 S6.3 controller retains bounded incremental console across selection and replacement', async () => {
  let emit!: (event: any) => void;
  let finish!: (result: unknown) => void;
  let lists = 0;
  const replacement = { ...running, id: 'cccccccccccc' };
  const { createDockerController } = await import('../../../src/features/docker/docker-controller');
  const controller = createDockerController((async (payload: any, onEvent: any) => {
    if (payload.action === 'list') return { containers: ++lists === 1 ? [running, stopped] : [replacement, stopped] };
    emit = onEvent;
    return new Promise(resolve => { finish = resolve; });
  }) as any);
  await controller.refresh(); await controller.select(running.id);
  const pending = controller.updateImage(true);
  assert.equal(controller.getState().updating, true);
  assert.equal(typeof emit, 'function');
  emit({ type: 'phase', phase: 'pull' }); emit({ type: 'output', stream: 'stdout', text: 'live' });
  assert.match(JSON.stringify(controller.getState()), /live/);
  await controller.select(stopped.id);
  emit({ type: 'phase', phase: 'recreate' }); emit({ type: 'output', stream: 'stderr', text: 'x'.repeat(1024 * 1024) });
  assert.equal(controller.getState().selected, stopped.id);
  assert.equal(controller.getState().notice, '');
  assert.ok(JSON.stringify(controller.getState()).length < 512 * 1024);
  emit({ type: 'result', ok: true }); finish({ ok: true }); await pending;
  assert.match(JSON.stringify(controller.getState()), /recreate/);
  assert.equal(controller.getState().selected, stopped.id);
});

test('S6.3 completed console remains after selected container is replaced', async () => {
  let lists = 0;
  const replacement = { ...running, id: 'cccccccccccc' };
  const { createDockerController } = await import('../../../src/features/docker/docker-controller');
  const controller = createDockerController((async (payload: any, onEvent: any) => {
    if (payload.action === 'list') return { containers: ++lists === 1 ? [running] : [replacement] };
    if (onEvent) { onEvent({ type: 'phase', phase: 'pull' }); onEvent({ type: 'output', stream: 'stdout', text: 'original-container-output' }); onEvent({ type: 'result', ok: true }); }
    return { ok: true };
  }) as any);
  await controller.refresh(); await controller.select(running.id); await controller.updateImage(true);
  assert.equal(controller.getState().selected, null);
  assert.deepEqual(controller.getState().containers, [replacement]);
  assert.match(JSON.stringify(controller.getState()), /original-container-output/);
  assert.match(JSON.stringify(controller.getState()), /aaaaaaaaaaaa/);
});

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

// Exercise the production event subscription and toast adapter together; no browser or Docker is involved.
for (const locale of ['en', 'es'] as const) {
  for (const [action, word] of Object.entries(locale === 'en'
    ? { start: /start/i, stop: /stop/i, restart: /restart/i, remove: /remov/i, updateImage: /updat/i, saveFile: /sav/i }
    : { start: /inici/i, stop: /deten/i, restart: /reinici/i, remove: /elimin/i, updateImage: /actualiz/i, saveFile: /guard/i })) {
    for (const fails of [false, true]) {
      test(`S12 ${locale} ${action} ${fails ? 'error' : 'success'} toast includes original target and action`, async () => {
        const { subscribeDockerToasts } = await import('../../../src/features/docker/DockerView');
        const target = action === 'remove' ? stopped : running;
        const file = { path: locale === 'en' ? '/private/compose.yml' : 'C:\\private\\compose.yml', kind: 'yaml' as const, identity: 'config' };
        let lists = 0;
        const { controller } = await setup(p => {
          if (p.action === 'list') return { containers: ++lists > 1 && (action === 'remove' || action === 'updateImage') ? [] : [target] };
          if (p.action === 'files') return { files: [file] };
          if (p.action === 'readFile') return { content: 'private content', version: 'v1' };
          if (p.action === action && fails) throw new Error('distinct failure reason');
          return { ok: true };
        });
        const messages: { type: string; text: string }[] = [];
        subscribeDockerToasts(controller, locale, {
          success: text => { messages.push({ type: 'success', text }); return ''; },
          error: text => { messages.push({ type: 'error', text }); return ''; },
        });
        await controller.refresh(); await controller.select(target.id);
        if (action === 'saveFile') { await controller.loadFiles(); await controller.openFile(file); controller.editContent('private draft'); }
        if (action === 'remove') await controller.remove(true);
        else if (action === 'updateImage') await controller.updateImage(true);
        else if (action === 'saveFile') await controller.saveFile();
        else await controller.action(action as 'start' | 'stop' | 'restart');
        assert.equal(messages.length, 1);
        assert.equal(messages[0].type, fails ? 'error' : 'success');
        assert.match(messages[0].text, word);
        assert.ok(messages[0].text.includes(target.name), messages[0].text);
        if (action === 'saveFile') {
          assert.ok(messages[0].text.includes('compose.yml'), messages[0].text);
          assert.doesNotMatch(messages[0].text, /private[\\/]/);
        }
        if (fails) assert.ok(messages[0].text.includes('distinct failure reason'), messages[0].text);
        assert.doesNotMatch(messages[0].text, /private content|private draft/);
        if (!fails && (action === 'remove' || action === 'updateImage')) assert.equal(controller.getState().selected, null);
      });
    }
  }
}

test('S12 repeated contextual completions notify once each; stream output does not notify', async () => {
  const { createDockerController } = await import('../../../src/features/docker/docker-controller');
  const { subscribeDockerToasts } = await import('../../../src/features/docker/DockerView');
  const controller = createDockerController(async (p, emit) => {
    if (p.action === 'list') return { containers: [running] };
    emit?.({ type: 'output', stream: 'stdout', text: 'private stream' });
    emit?.({ type: 'result', ok: true });
    return { ok: true };
  });
  const messages: string[] = [];
  subscribeDockerToasts(controller, 'en', { success: text => { messages.push(text); return ''; }, error: text => { messages.push(text); return ''; } });
  await controller.refresh(); await controller.select(running.id);
  await controller.updateImage(true); await controller.updateImage(true);
  assert.equal(messages.length, 2);
  assert.equal(messages[0], messages[1]);
  assert.match(messages[0], /updat/i); assert.ok(messages[0].includes(running.name));
  assert.doesNotMatch(messages.join(' '), /private stream/);
});

test('S12 selection change suppresses old contextual success and failure toasts', async () => {
  const { subscribeDockerToasts } = await import('../../../src/features/docker/DockerView');
  let finish!: (value: unknown) => void; let reject!: (reason: Error) => void;
  const { controller } = await setup(p => p.action === 'list' ? { containers: [running, stopped] } : new Promise((resolve, fail) => { finish = resolve; reject = fail; }));
  const messages: string[] = [];
  subscribeDockerToasts(controller, 'en', { success: text => { messages.push(text); return ''; }, error: text => { messages.push(text); return ''; } });
  await controller.refresh(); await controller.select(running.id);
  const success = controller.action('restart'); await controller.select(stopped.id); finish({ ok: true }); await success;
  await controller.select(running.id);
  const failure = controller.action('restart'); await controller.select(stopped.id); reject(new Error('old reason')); await failure;
  assert.deepEqual(messages, []);
});

test('S12 list, logs, file discovery and file read errors have localized contextual toasts', async () => {
  const { subscribeDockerToasts } = await import('../../../src/features/docker/DockerView');
  for (const locale of ['en', 'es'] as const) {
    for (const action of ['list', 'logs', 'files', 'readFile']) {
      let fail = false;
      const { controller } = await setup(p => {
        if (fail && p.action === action) throw new Error('distinct reason');
        if (p.action === 'list') return { containers: [running] };
        if (p.action === 'files') return { files: [yaml] };
        return { content: 'secret content', version: 'v1' };
      });
      const messages: string[] = [];
      subscribeDockerToasts(controller, locale, { success: text => { messages.push(text); return ''; }, error: text => { messages.push(text); return ''; } });
      await controller.refresh(); await controller.select(running.id); await controller.loadFiles(); fail = true;
      if (action === 'list') await controller.refresh();
      if (action === 'logs') await controller.loadLogs();
      if (action === 'files') await controller.loadFiles();
      if (action === 'readFile') await controller.openFile(yaml);
      assert.equal(messages.length, 1);
      assert.ok(messages[0].includes('distinct reason'));
      if (action !== 'list') assert.ok(messages[0].includes(running.name), messages[0]);
      if (action === 'readFile') assert.ok(messages[0].includes('compose.yml'), messages[0]);
      assert.ok(messages[0].length > 'distinct reason'.length);
      assert.doesNotMatch(messages[0], /secret content/);
    }
  }
});
