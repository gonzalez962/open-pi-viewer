import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveNotificationOriginName } from '@features/chat/hooks/useSessionEvents';
import { SessionEventController } from '@features/chat/session-events';
import type { NotifyAppEventParams } from '@infra/notifications';
import { DEFAULT_LOCALE, translate } from '@shared/i18n';

const repo = { isRepo: true, repoName: 'repository', modifiedFiles: [], addedFiles: [], untrackedFiles: [] };

test('origin hierarchy prefers the matching custom project, then Git repo, then folder', async () => {
  let lookups = 0;
  const getGitStatus = async (cwd?: string) => { lookups++; assert.equal(cwd, '/repo/nested'); return repo; };
  const projects = [{ id: 'other', path: '/other', customName: 'Wrong project' }, { id: 'source', path: '/repo/nested', customName: '  Named project  ' }];
  assert.equal(await resolveNotificationOriginName('/repo/nested', projects, getGitStatus), 'Named project');
  assert.equal(lookups, 0);
  assert.equal(await resolveNotificationOriginName('/repo/nested', [], getGitStatus), 'repository');
  assert.equal(lookups, 1);
  assert.equal(await resolveNotificationOriginName('/repo/nested', [], async () => ({ ...repo, isRepo: false, repoName: null })), 'nested');
  assert.equal(await resolveNotificationOriginName('C:\\work\\folder\\', [], async () => { throw new Error('Git unavailable'); }), 'folder');
});

for (const type of ['agent_settled', 'extension_ui_request']) {
  test(`${type} notification captures source while origin lookup is pending`, async () => {
    const sent: NotifyAppEventParams[] = [];
    let cwd = '/other';
    let resolve!: (name: string) => void;
    const controller = new SessionEventController({
      getCurrentConfig: () => ({ nodePath: 'node', piEntrypoint: '/pi.js', workingDirectory: cwd }),
      getCurrentSessionId: () => 'session', dispatch: () => {},
      resolveTargetProjectId: () => 'source',
      resolveNotificationOriginName: path => { assert.equal(path, '/repo/nested'); return new Promise<string>(done => { resolve = done; }); },
      notifyAppEventFn: params => sent.push(params),
      checkPersistenceFn: async () => { throw new Error('No persistence'); },
      dialogAdapter: { select: async () => null, input: async () => null, confirm: async () => null },
      sendExtensionUiResponseFn: async payload => ({ success: true, id: payload.id }),
    });
    controller.handleEvent({ type, cwd: '/repo/nested', method: 'confirm', id: 'request' });
    cwd = '/changed-active';
    resolve('Named project');
    await new Promise(done => setImmediate(done));
    assert.equal(sent.length, 1);
    assert.ok(sent[0].title.endsWith(' — Named project'));
    assert.equal(sent[0].body, translate(DEFAULT_LOCALE, type === 'agent_settled' ? 'notifications.task_complete_body' : 'notifications.waiting_input_body'));
    assert.equal(sent[0].projectId, 'source');
    assert.equal(sent[0].sessionId, 'session');
  });
}
