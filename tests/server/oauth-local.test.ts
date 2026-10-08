import test from 'node:test';
import assert from 'node:assert/strict';
import { createOAuthAccess } from '@server/bridge/oauth-access';

test('development accepts local and remote keyless sessions but rejects cross-origin requests', async () => {
  const access = createOAuthAccess({ key: '', developmentAnonymous: true });
  const owners = new Set<string>();
  for (const host of ['localhost:5173', '192.168.1.10:5173', 'viewer.example:5173']) {
    const headers: Record<string, string> = {};
    const res = { setHeader: (name: string, value: string | string[]) => { headers[name] = String(value); } };
    const req = { headers: { host, origin: `http://${host}` } };
    const result = await access.authorize(req, res, {});
    assert.equal(result.ok, true);
    assert.ok(!owners.has(result.owner));
    owners.add(result.owner);
    const cookie = headers['Set-Cookie'].split(';')[0];
    assert.ok(access.requireOAuthOwner('start_oauth_login', { headers: { ...req.headers, cookie } }).ok);
    assert.equal((await access.authorize({ headers: { ...req.headers, origin: 'http://other.example' } }, res, {})).ok, false);
    assert.equal(access.requireOAuthOwner('start_oauth_login', { headers: { ...req.headers, cookie, origin: 'http://other.example' } }).ok, false);
  }
});
