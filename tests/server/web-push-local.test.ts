import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebPush } from '@server/bridge/web-push';

function request(cookie?: string, peer = '127.0.0.1', host = 'localhost:5173') {
  return { method: 'GET', url: '/api/push/config', socket: { remoteAddress: peer },
    headers: { host, origin: `http://${host}`, ...(cookie ? { cookie } : {}) } };
}
function response() {
  return { statusCode: 0, headers: {} as Record<string, string>, body: '',
    setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; },
    end(body: string) { this.body = body; } };
}
test('localhost push bootstraps isolated browser identities without web login and expires leases', async () => {
  let now = 100;
  const push = createWebPush({ config: { available: true, publicKey: 'public' }, now: () => now });
  const first = response();
  await push.handleConfig(request(), first);
  assert.deepEqual(JSON.parse(first.body), { available: true, publicKey: 'public' });
  assert.match(first.headers['set-cookie'], /HttpOnly; SameSite=Strict/);
  const cookie = first.headers['set-cookie'].split(';')[0];
  const owner = push.getRequestOwner(request(cookie));
  assert.ok(owner);
  assert.ok(push.isOwnerAuthorized(owner));
  const second = response();
  await push.handleConfig(request(), second);
  assert.notEqual(push.getRequestOwner(request(second.headers['set-cookie'].split(';')[0])), owner);
  assert.equal(push.getRequestOwner(request()), null);
  assert.equal(push.getRequestOwner(request(cookie, '192.168.1.5')), null);
  now += 24 * 60 * 60 * 1000;
  assert.equal(push.isOwnerAuthorized(owner), false);
  push.dispose();
});
for (const [peer, host] of [['192.168.1.5', 'localhost:5173'], ['127.0.0.1', 'viewer.example'], ['127.0.0.1', '192.168.1.5:5173']]) {
  test(`local no-auth push rejects nonlocal origin/peer ${peer}/${host}`, async () => {
    const push = createWebPush({ config: { available: true, publicKey: 'public' } });
    const res = response();
    await push.handleConfig(request(undefined, peer, host), res);
    assert.deepEqual(JSON.parse(res.body), { available: false });
    assert.equal(res.headers['set-cookie'], undefined);
    const writeRes = response();
    await push.handleSubscriptions({ ...request(undefined, peer, host), method: 'POST', url: '/api/push/subscriptions' }, writeRes);
    assert.equal(writeRes.statusCode, 403);
    assert.equal(push.getSubscriptionsCount(), 0);
  });
}
