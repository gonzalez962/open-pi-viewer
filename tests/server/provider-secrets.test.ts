import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleIpcCommand, setPiAgentDirForTest } from '@server/web-ipc-bridge';
import { clearOpenRouterCatalogCache } from '@features/providers/providers';

test('S3.1 provider responses hide credentials and blank edits preserve; explicit deletion is targeted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-secrets-'));
  setPiAgentDirForTest(dir);
  const base = { id: 'p', baseUrl: 'https://example.test/v1', api: 'openai', models: [{ id: 'm' }] };
  try {
    const created: any = await handleIpcCommand('upsert_custom_provider', { provider: { ...base, apiKey: 'fake-key', headers: { Authorization: 'fake-header', Other: 'fake-other' } } });
    assert.doesNotMatch(JSON.stringify(created), /fake-key|fake-header|fake-other/);
    const read: any = await handleIpcCommand('get_custom_providers', {});
    assert.doesNotMatch(JSON.stringify(read), /fake-key|fake-header|fake-other/);
    assert.equal(read.providers.p.apiKeyConfigured, true);
    assert.deepEqual(read.providers.p.headerKeys.sort(), ['Authorization', 'Other']);
    await handleIpcCommand('upsert_custom_provider', { provider: { ...base, apiKey: '', headers: { Authorization: '' } } });
    let saved = JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8')).providers.p;
    assert.equal(saved.apiKey, 'fake-key');
    assert.deepEqual(saved.headers, { Authorization: 'fake-header', Other: 'fake-other' });
    const result: any = await handleIpcCommand('upsert_custom_provider', { provider: { ...base, apiKey: null, headers: { Authorization: null } } });
    assert.doesNotMatch(JSON.stringify(result), /fake-key|fake-header|fake-other/);
    saved = JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8')).providers.p;
    assert.equal(saved.apiKey, undefined);
    assert.deepEqual(saved.headers, { Other: 'fake-other' });
  } finally { setPiAgentDirForTest(null); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('S3.2 discovery authenticates with stored credentials without returning them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-discovery-'));
  setPiAgentDirForTest(dir);
  const original = globalThis.fetch;
  try {
    fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ providers: { p: { baseUrl: 'https://example.test/v1', api: 'openai', apiKey: 'fake-key', headers: { 'X-Test': 'fake-header' } } } }));
    globalThis.fetch = async (_url, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('authorization'), 'Bearer fake-key');
      assert.equal(headers.get('x-test'), 'fake-header');
      return new Response(JSON.stringify({ data: [{ id: 'model-one' }] }), { status: 200 });
    };
    const result: any = await handleIpcCommand('discover_provider_models', { providerId: 'p' });
    assert.doesNotMatch(JSON.stringify(result), /fake-key|fake-header/);
    assert.equal(result[0].id, 'model-one');
  } finally { globalThis.fetch = original; setPiAgentDirForTest(null); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('discovery supports new Google providers and rejects echoed secrets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-new-'));
  setPiAgentDirForTest(dir);
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      assert.match(String(url), /^https:\/\/example\.test\/v1beta\/models\?key=fake-new/);
      return new Response(JSON.stringify({ models: [{ name: 'models/fake-new' }, { name: 'models/safe' }] }), { status: 200 });
    };
    const result: any = await handleIpcCommand('discover_provider_models', { providerId: 'new', baseUrl: 'https://example.test/v1beta', api: 'google-generative-ai', apiKey: 'fake-new' });
    assert.doesNotMatch(JSON.stringify(result), /fake-new/);
    assert.ok(result.some((m: any) => m.id === 'safe'));
  } finally { globalThis.fetch = original; setPiAgentDirForTest(null); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('catalog enrichment never receives provider credentials', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-catalog-'));
  setPiAgentDirForTest(dir);
  const original = globalThis.fetch;
  let catalog = false;
  try {
    fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ providers: { p: { baseUrl: 'https://private.example/v1', api: 'openai', apiKey: 'saved-key', headers: { 'X-Secret': 'saved-header' } } } }));
    globalThis.fetch = async (url, init) => {
      const headers = new Headers(init?.headers);
      if (String(url) === 'https://openrouter.ai/api/v1/models') {
        catalog = true;
        assert.equal(headers.get('authorization'), null);
        assert.equal(headers.get('x-secret'), null);
        assert.equal(init?.redirect, 'error');
        return new Response(JSON.stringify({ data: [{ id: 'm', architecture: { input_modalities: ['text', 'image'] } }] }));
      }
      assert.equal(headers.get('authorization'), 'Bearer saved-key');
      assert.equal(headers.get('x-secret'), 'saved-header');
      return new Response(JSON.stringify({ data: [{ id: 'm' }] }));
    };
    await handleIpcCommand('discover_provider_models', { providerId: 'p' });
    assert.equal(catalog, true);
  } finally { globalThis.fetch = original; setPiAgentDirForTest(null); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('OpenRouter primary is authenticated while its catalog request is public', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-same-origin-'));
  setPiAgentDirForTest(dir);
  clearOpenRouterCatalogCache();
  const original = globalThis.fetch;
  const seen: string[] = [];
  try {
    fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ providers: { p: { baseUrl: 'https://openrouter.ai/api/v1', api: 'openai', apiKey: 'saved-key', headers: { 'X-Secret': 'saved-header' } } } }));
    globalThis.fetch = async (_url, init) => {
      const headers = new Headers(init?.headers);
      seen.push(headers.get('authorization') || 'public');
      if (seen.length === 1) {
        assert.equal(headers.get('authorization'), 'Bearer saved-key');
        assert.equal(headers.get('x-secret'), 'saved-header');
        return new Response(JSON.stringify({ data: [{ id: 'm' }, { id: 'saved-header' }] }));
      }
      assert.equal(headers.get('authorization'), null);
      assert.equal(headers.get('x-secret'), null);
      assert.equal(init?.redirect, 'error');
      return new Response(JSON.stringify({ data: [] }));
    };
    const models = await handleIpcCommand('discover_provider_models', { providerId: 'p' });
    assert.deepEqual(seen, ['Bearer saved-key', 'public']);
    assert.doesNotMatch(JSON.stringify(models), /saved-header|saved-key/);
  } finally { globalThis.fetch = original; clearOpenRouterCatalogCache(); setPiAgentDirForTest(null); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('S2.3 import preserves prototype-named headers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-import-prototype-'));
  setPiAgentDirForTest(dir);
  try {
    const ack: any = await handleIpcCommand('import_provider_credentials', { providers: { p: { baseUrl: 'https://example.test', api: 'openai', headers: { toString: 'legacy-header' } } } });
    assert.equal(ack.imported, true);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8')).providers.p;
    assert.equal(saved.headers.toString, 'legacy-header');
  } finally { setPiAgentDirForTest(null); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('S2.3 legacy provider import acknowledges without overwriting backend credentials', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-import-'));
  setPiAgentDirForTest(dir);
  try {
    fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ providers: { p: { baseUrl: 'https://example.test', api: 'openai', apiKey: 'backend-key', headers: { A: 'backend-header' } } } }));
    const ack: any = await handleIpcCommand('import_provider_credentials', { providers: { p: { baseUrl: 'https://example.test', api: 'openai', apiKey: 'legacy-key', headers: { A: 'legacy-header', B: 'legacy-new' } } } });
    assert.equal(ack.imported, true);
    assert.doesNotMatch(JSON.stringify(ack), /backend-key|backend-header|legacy-key|legacy-header|legacy-new/);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8')).providers.p;
    assert.equal(saved.apiKey, 'backend-key');
    assert.deepEqual(saved.headers, { A: 'backend-header', B: 'legacy-new' });
  } finally { setPiAgentDirForTest(null); fs.rmSync(dir, { recursive: true, force: true }); }
});
