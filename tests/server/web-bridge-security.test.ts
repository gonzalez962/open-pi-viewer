import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {
  handleIpcCommand,
  setSessionsRootDirForTest,
} from '@server/web-ipc-bridge';
import {
  setSqliteExecutorForTest,
  getEngramObservationsImpl,
} from '@server/bridge/engram';
import { handleListWorkspaceDir } from '@server/bridge/paths';
import { installWebApi } from '@server/web-api';

function createSecurityFixture() {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.tmp-security-test-'));
  const sessionsRoot = path.join(root, 'sessions');
  const outsideDir = path.join(root, 'outside');
  fs.mkdirSync(sessionsRoot, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  setSessionsRootDirForTest(sessionsRoot);

  return {
    root,
    sessionsRoot,
    outsideDir,
    cleanup() {
      setSessionsRootDirForTest(null);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('S1.1: delete_session rejects arbitrary file outside sessions or non-jsonl file and does not unlink', async (t) => {
  const fixture = createSecurityFixture();
  t.after(() => fixture.cleanup());

  // 1. Arbitrary file outside sessions
  const outsideFile = path.join(fixture.outsideDir, 'important-outside.txt');
  fs.writeFileSync(outsideFile, 'sensitive data', 'utf8');

  const res1 = await handleIpcCommand('delete_session', {
    payload: { sessionPath: outsideFile },
  });
  assert.strictEqual(res1.success, false);
  assert.strictEqual(fs.existsSync(outsideFile), true);
  assert.strictEqual(fs.readFileSync(outsideFile, 'utf8'), 'sensitive data');

  // 2. Traversal attempt pointing outside sessions
  const traversalPath = path.join(fixture.sessionsRoot, '..', 'outside', 'important-outside.txt');
  const res2 = await handleIpcCommand('delete_session', {
    payload: { sessionPath: traversalPath },
  });
  assert.strictEqual(res2.success, false);
  assert.strictEqual(fs.existsSync(outsideFile), true);

  // 3. Non-.jsonl file inside sessions root
  const nonJsonlInside = path.join(fixture.sessionsRoot, 'not-a-session.txt');
  fs.writeFileSync(nonJsonlInside, 'do not delete me', 'utf8');
  const res3 = await handleIpcCommand('delete_session', {
    payload: { sessionPath: nonJsonlInside },
  });
  assert.strictEqual(res3.success, false);
  assert.strictEqual(fs.existsSync(nonJsonlInside), true);
  assert.strictEqual(fs.readFileSync(nonJsonlInside, 'utf8'), 'do not delete me');
});

test('S1.2: rename_session rejects arbitrary file outside sessions or non-jsonl file and does not modify', async (t) => {
  const fixture = createSecurityFixture();
  t.after(() => fixture.cleanup());

  // 1. Arbitrary file outside sessions
  const outsideFile = path.join(fixture.outsideDir, 'external-config.json');
  const originalOutsideContent = JSON.stringify({ key: 'secret-token' });
  fs.writeFileSync(outsideFile, originalOutsideContent, 'utf8');

  const res1 = await handleIpcCommand('rename_session', {
    payload: { sessionPath: outsideFile, newTitle: 'Malicious Title' },
  });
  assert.strictEqual(res1.success, false);
  assert.strictEqual(fs.readFileSync(outsideFile, 'utf8'), originalOutsideContent);

  // 2. Traversal attempt pointing outside sessions
  const traversalPath = path.join(fixture.sessionsRoot, '..', 'outside', 'external-config.json');
  const res2 = await handleIpcCommand('rename_session', {
    payload: { sessionPath: traversalPath, newTitle: 'Malicious Title' },
  });
  assert.strictEqual(res2.success, false);
  assert.strictEqual(fs.readFileSync(outsideFile, 'utf8'), originalOutsideContent);

  // 3. Non-.jsonl file inside sessions root
  const nonJsonlInside = path.join(fixture.sessionsRoot, 'project-info.txt');
  const originalInsideContent = 'static information';
  fs.writeFileSync(nonJsonlInside, originalInsideContent, 'utf8');
  const res3 = await handleIpcCommand('rename_session', {
    payload: { sessionPath: nonJsonlInside, newTitle: 'Malicious Title' },
  });
  assert.strictEqual(res3.success, false);
  assert.strictEqual(fs.readFileSync(nonJsonlInside, 'utf8'), originalInsideContent);
});

test('S1.3: delete_session unlinks valid .jsonl file inside sessions root and returns success true', async (t) => {
  const fixture = createSecurityFixture();
  t.after(() => fixture.cleanup());

  const projectDir = path.join(fixture.sessionsRoot, '--test-project--');
  fs.mkdirSync(projectDir, { recursive: true });
  const validSessionFile = path.join(projectDir, '2026-10-14_sess-001.jsonl');
  const sessionHeader = {
    type: 'session',
    version: 3,
    id: 'sess-001',
    timestamp: new Date().toISOString(),
    cwd: fixture.root,
  };
  fs.writeFileSync(validSessionFile, JSON.stringify(sessionHeader) + '\n', 'utf8');
  assert.strictEqual(fs.existsSync(validSessionFile), true);

  const res = await handleIpcCommand('delete_session', {
    payload: { sessionPath: validSessionFile },
  });
  assert.strictEqual(res.success, true);
  assert.strictEqual(fs.existsSync(validSessionFile), false);
});

test('PRESERVE: rename_session modifies valid .jsonl file inside sessions root and preserves previous behavior', async (t) => {
  const fixture = createSecurityFixture();
  t.after(() => fixture.cleanup());

  const projectDir = path.join(fixture.sessionsRoot, '--test-project--');
  fs.mkdirSync(projectDir, { recursive: true });
  const validSessionFile = path.join(projectDir, '2026-10-14_sess-002.jsonl');
  const sessionHeader = {
    type: 'session',
    version: 3,
    id: 'sess-002',
    timestamp: new Date().toISOString(),
    cwd: fixture.root,
  };
  fs.writeFileSync(validSessionFile, JSON.stringify(sessionHeader) + '\n', 'utf8');

  const res = await handleIpcCommand('rename_session', {
    payload: { sessionPath: validSessionFile, newTitle: 'Renamed Session Title' },
  });
  assert.strictEqual(res.success, true);
  const updatedContent = fs.readFileSync(validSessionFile, 'utf8');
  assert.ok(updatedContent.includes('Renamed Session Title'));
  assert.ok(updatedContent.includes('session_info'));
});

function createSqliteCapture() {
  const queries: string[] = [];
  setSqliteExecutorForTest((_bin, args) => {
    queries.push(args[1]);
    return JSON.stringify([{ id: 1, title: 'Sample observation' }]);
  });
  return {
    queries,
    get lastQuery() {
      return queries[queries.length - 1] || '';
    },
    cleanup() {
      setSqliteExecutorForTest(null);
    },
  };
}

test('S2.1: get_engram_observations sanitizes non-numeric or SQL injection strings for limit', async (t) => {
  const capture = createSqliteCapture();
  t.after(() => capture.cleanup());

  // 1. SQL injection attempt with leading integer
  const res1 = await handleIpcCommand('get_engram_observations', {
    payload: { limit: '10; DROP TABLE observations;--' },
  });
  assert.ok(Array.isArray(res1));
  assert.strictEqual(capture.lastQuery.includes('DROP TABLE'), false);
  assert.match(capture.lastQuery, /LIMIT 10\);$/);

  // 2. Pure non-numeric injection attempt
  const res2 = await handleIpcCommand('get_engram_observations', {
    payload: { limit: 'DROP TABLE observations;--' },
  });
  assert.ok(Array.isArray(res2));
  assert.strictEqual(capture.lastQuery.includes('DROP TABLE'), false);
  assert.match(capture.lastQuery, /LIMIT 20\);$/);

  // 3. Random non-numeric string falls back to default 20
  await handleIpcCommand('get_engram_observations', {
    payload: { limit: 'invalid-limit-value' },
  });
  assert.match(capture.lastQuery, /LIMIT 20\);$/);

  // 4. Direct invocation of getEngramObservationsImpl with SQL injection
  const directRes = getEngramObservationsImpl('test-proj', '15; VACUUM;--');
  assert.ok(Array.isArray(directRes));
  assert.strictEqual(capture.lastQuery.includes('VACUUM'), false);
  assert.match(capture.lastQuery, /LIMIT 15\);$/);
});

test('S2.2: get_engram_observations bounds valid numeric limits between 1 and 100', async (t) => {
  const capture = createSqliteCapture();
  t.after(() => capture.cleanup());

  // 1. Within range (e.g. 5)
  await handleIpcCommand('get_engram_observations', {
    payload: { limit: 5 },
  });
  assert.match(capture.lastQuery, /LIMIT 5\);$/);

  // 2. Lower boundary (1)
  await handleIpcCommand('get_engram_observations', {
    payload: { limit: 1 },
  });
  assert.match(capture.lastQuery, /LIMIT 1\);$/);

  // 3. Upper boundary (100)
  await handleIpcCommand('get_engram_observations', {
    payload: { limit: 100 },
  });
  assert.match(capture.lastQuery, /LIMIT 100\);$/);

  // 4. Clamped to 100 when > 100
  await handleIpcCommand('get_engram_observations', {
    payload: { limit: 500 },
  });
  assert.match(capture.lastQuery, /LIMIT 100\);$/);

  // 5. Clamped to 1 when negative
  await handleIpcCommand('get_engram_observations', {
    payload: { limit: -10 },
  });
  assert.match(capture.lastQuery, /LIMIT 1\);$/);

  // 6. Zero falls back to default 20
  await handleIpcCommand('get_engram_observations', {
    payload: { limit: 0 },
  });
  assert.match(capture.lastQuery, /LIMIT 20\);$/);

  // 7. Numeric string is accepted and clamped
  await handleIpcCommand('get_engram_observations', {
    payload: { limit: '42' },
  });
  assert.match(capture.lastQuery, /LIMIT 42\);$/);

  // 8. Numeric string > 100 is clamped to 100
  await handleIpcCommand('get_engram_observations', {
    payload: { limit: '999999' },
  });
  assert.match(capture.lastQuery, /LIMIT 100\);$/);
});

test('PRESERVE: get_engram_observations preserves default limit, project filter, and result parsing', async (t) => {
  const capture = createSqliteCapture();
  t.after(() => capture.cleanup());

  const res = await handleIpcCommand('get_engram_observations', {
    payload: { project: 'core-repo' },
  });
  assert.deepStrictEqual(res, [{ id: 1, title: 'Sample observation' }]);
  assert.match(capture.lastQuery, /AND project = 'core-repo'/);
  assert.match(capture.lastQuery, /LIMIT 20\);$/);
});

class MockApiResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = '';
  ended = false;

  writeHead(statusCode: number, headers?: Record<string, string>) {
    this.statusCode = statusCode;
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        this.headers[k.toLowerCase()] = v;
      }
    }
    return this;
  }

  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  }

  getHeader(name: string) {
    return this.headers[name.toLowerCase()];
  }

  end(chunk?: any) {
    if (chunk) this.body += String(chunk);
    this.ended = true;
    this.emit('finish');
    return this;
  }
}

function createDaemonTestRig() {
  let daemonHandler: ((req: any, res: any) => Promise<void>) | null = null;
  const app = {
    use(arg1: any, arg2?: any) {
      if (arg1 === '/api/engram-daemon') {
        daemonHandler = arg2;
      }
    },
  };
  const server = new EventEmitter();
  installWebApi(app as any, server, { enabled: false });
  if (!daemonHandler) {
    throw new Error('Engram daemon handler was not registered');
  }

  const fetchedUrls: Array<{ url: string; method: string }> = [];
  const originalFetch = globalThis.fetch;

  let fetchMockImpl: (url: string, init?: RequestInit) => Promise<Response> = async (url) => {
    return new Response(JSON.stringify({ status: 'ok', url }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = String(input);
    const method = init?.method || 'GET';
    fetchedUrls.push({ url: urlStr, method });
    return fetchMockImpl(urlStr, init);
  }) as typeof fetch;

  return {
    async invoke(url: string, method = 'GET') {
      const req = { url, method };
      const res = new MockApiResponse();
      await daemonHandler!(req, res);
      return res;
    },
    setFetchMock(mock: (url: string, init?: RequestInit) => Promise<Response>) {
      fetchMockImpl = mock;
    },
    fetchedUrls,
    cleanup() {
      globalThis.fetch = originalFetch;
      server.emit('close');
    },
  };
}

test('S3.1: engram daemon proxy rejects authority confusion, traversal, backslashes, and control characters with 400 Bad Request', async (t) => {
  const rig = createDaemonTestRig();
  t.after(() => rig.cleanup());

  const maliciousPaths = [
    // Authority confusion
    '@evil.com/sync',
    '/@evil.com/sync',
    '/%40evil.com/sync',
    // Missing leading slash or question mark
    'evil.com/sync',
    'sync/status',
    // Directory traversal
    '/..',
    '/sync/../status',
    '/%2e%2e/status',
    // Backslashes
    '\\evil.com',
    '/\\evil.com',
    '/%5cevil.com',
    // Control characters
    '/sync\x00status',
    '/sync\x1Fstatus',
    '/sync\x7Fstatus',
    '/sync%00status',
  ];

  for (const badPath of maliciousPaths) {
    rig.fetchedUrls.length = 0;
    const res = await rig.invoke(badPath);
    assert.strictEqual(
      res.statusCode,
      400,
      `Expected 400 Bad Request for "${badPath}", got ${res.statusCode}`
    );
    assert.strictEqual(
      res.headers['access-control-allow-origin'],
      undefined,
      `Wildcard CORS must not be present on error for "${badPath}"`
    );
    assert.strictEqual(
      rig.fetchedUrls.length,
      0,
      `fetch must not be called for malicious path "${badPath}"`
    );
  }
});

test('S3.2: engram daemon proxy connects safely to valid subpath and omits wildcard CORS', async (t) => {
  const rig = createDaemonTestRig();
  t.after(() => rig.cleanup());

  // 1. Valid subpath
  const res1 = await rig.invoke('/sync/status');
  assert.strictEqual(res1.statusCode, 200);
  assert.strictEqual(rig.fetchedUrls.length, 1);
  assert.strictEqual(rig.fetchedUrls[0].url, 'http://127.0.0.1:7437/sync/status');
  assert.strictEqual(res1.headers['access-control-allow-origin'], undefined);

  // 2. Query only
  const res2 = await rig.invoke('?project=demo');
  assert.strictEqual(res2.statusCode, 200);
  assert.strictEqual(rig.fetchedUrls.length, 2);
  assert.strictEqual(rig.fetchedUrls[1].url, 'http://127.0.0.1:7437?project=demo');
  assert.strictEqual(res2.headers['access-control-allow-origin'], undefined);

  // 3. Subpath with query
  const res3 = await rig.invoke('/sync/status?project=demo');
  assert.strictEqual(res3.statusCode, 200);
  assert.strictEqual(rig.fetchedUrls.length, 3);
  assert.strictEqual(rig.fetchedUrls[2].url, 'http://127.0.0.1:7437/sync/status?project=demo');
  assert.strictEqual(res3.headers['access-control-allow-origin'], undefined);

  // 4. Empty subpath
  const res4 = await rig.invoke('');
  assert.strictEqual(res4.statusCode, 200);
  assert.strictEqual(rig.fetchedUrls.length, 4);
  assert.strictEqual(rig.fetchedUrls[3].url, 'http://127.0.0.1:7437');
  assert.strictEqual(res4.headers['access-control-allow-origin'], undefined);
});

test('PRESERVE: engram daemon proxy handles daemon failure with 502 and omits wildcard CORS', async (t) => {
  const rig = createDaemonTestRig();
  t.after(() => rig.cleanup());

  rig.setFetchMock(async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:7437');
  });

  const res = await rig.invoke('/sync/status');
  assert.strictEqual(res.statusCode, 502);
  const parsed = JSON.parse(res.body);
  assert.strictEqual(parsed.error, 'Engram daemon unreachable');
  assert.strictEqual(res.headers['access-control-allow-origin'], undefined);
});

function createWorkspaceSecurityFixture() {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.tmp-security-ws-'));
  const workspaceRoot = path.join(root, 'workspace');
  const outsideDir = path.join(root, 'outside');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, 'outside-secret.txt'), 'secret outside', 'utf8');
  fs.mkdirSync(path.join(outsideDir, 'outside-sub'), { recursive: true });

  const subDir = path.join(workspaceRoot, 'subdir');
  const deepDir = path.join(subDir, 'deep');
  fs.mkdirSync(deepDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'root-file.txt'), 'root content', 'utf8');
  fs.writeFileSync(path.join(subDir, 'sub-file.txt'), 'sub content', 'utf8');
  fs.writeFileSync(path.join(deepDir, 'deep-file.txt'), 'deep content', 'utf8');

  return {
    root,
    workspaceRoot,
    outsideDir,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('S4.1: list_workspace_dir rejects path traversal segments and paths outside workspace root', async (t) => {
  const fixture = createWorkspaceSecurityFixture();
  t.after(() => fixture.cleanup());

  const traversalPaths = [
    '..',
    '../..',
    '../../',
    '../outside',
    'subdir/../../outside',
    '..\\outside',
    '..\\..',
  ];

  for (const traversalPath of traversalPaths) {
    // 1. Calling via handleIpcCommand must reject
    await assert.rejects(
      async () => {
        await handleIpcCommand('list_workspace_dir', {
          payload: {
            workingDirectory: fixture.workspaceRoot,
            relativePath: traversalPath,
          },
        });
      },
      /access denied|traversal|outside/i,
      `handleIpcCommand must reject traversal path "${traversalPath}"`
    );

    // 2. Direct handleListWorkspaceDir call must throw
    assert.throws(
      () => {
        handleListWorkspaceDir({
          payload: {
            workingDirectory: fixture.workspaceRoot,
            relativePath: traversalPath,
          },
        });
      },
      /access denied|traversal|outside/i,
      `handleListWorkspaceDir must throw on traversal path "${traversalPath}"`
    );
  }

  // 3. Absolute path pointing outside workspace must reject
  await assert.rejects(
    async () => {
      await handleIpcCommand('list_workspace_dir', {
        payload: {
          workingDirectory: fixture.workspaceRoot,
          relativePath: fixture.outsideDir,
        },
      });
    },
    /access denied|traversal|outside/i,
    'handleIpcCommand must reject absolute path outside workspace root'
  );

  assert.throws(
    () => {
      handleListWorkspaceDir({
        payload: {
          workingDirectory: fixture.workspaceRoot,
          relativePath: fixture.outsideDir,
        },
      });
    },
    /access denied|traversal|outside/i,
    'handleListWorkspaceDir must throw on absolute path outside workspace root'
  );
});

test('S4.2: list_workspace_dir lists valid workspace directories correctly', async (t) => {
  const fixture = createWorkspaceSecurityFixture();
  t.after(() => fixture.cleanup());

  // 1. Root directory (relativePath empty)
  const rootRes = await handleIpcCommand('list_workspace_dir', {
    payload: {
      workingDirectory: fixture.workspaceRoot,
      relativePath: '',
    },
  });
  assert.ok(Array.isArray(rootRes));
  const subEntry = rootRes.find((e: any) => e.name === 'subdir');
  const fileEntry = rootRes.find((e: any) => e.name === 'root-file.txt');
  assert.ok(subEntry, 'subdir must be present in root');
  assert.strictEqual(subEntry.isDir, true);
  assert.strictEqual(subEntry.relativePath, 'subdir');
  assert.ok(fileEntry, 'root-file.txt must be present in root');
  assert.strictEqual(fileEntry.isDir, false);
  assert.strictEqual(fileEntry.relativePath, 'root-file.txt');
  assert.strictEqual(fileEntry.extension, 'txt');
  assert.strictEqual(typeof fileEntry.size, 'number');

  // 2. Subdirectory
  const subRes = await handleIpcCommand('list_workspace_dir', {
    payload: {
      workingDirectory: fixture.workspaceRoot,
      relativePath: 'subdir',
    },
  });
  assert.ok(Array.isArray(subRes));
  const deepEntry = subRes.find((e: any) => e.name === 'deep');
  const subFileEntry = subRes.find((e: any) => e.name === 'sub-file.txt');
  assert.ok(deepEntry, 'deep must be present in subdir');
  assert.strictEqual(deepEntry.isDir, true);
  assert.strictEqual(deepEntry.relativePath, 'subdir/deep');
  assert.ok(subFileEntry, 'sub-file.txt must be present in subdir');
  assert.strictEqual(subFileEntry.isDir, false);
  assert.strictEqual(subFileEntry.relativePath, 'subdir/sub-file.txt');

  // 3. Deep directory
  const deepRes = await handleIpcCommand('list_workspace_dir', {
    payload: {
      workingDirectory: fixture.workspaceRoot,
      relativePath: 'subdir/deep',
    },
  });
  assert.ok(Array.isArray(deepRes));
  const deepFileEntry = deepRes.find((e: any) => e.name === 'deep-file.txt');
  assert.ok(deepFileEntry, 'deep-file.txt must be present in deep');
  assert.strictEqual(deepFileEntry.isDir, false);
  assert.strictEqual(deepFileEntry.relativePath, 'subdir/deep/deep-file.txt');
});

test('PRESERVE: list_workspace_dir preserves directory sorting, missing dir fallback, and excludes ignored folders', async (t) => {
  const fixture = createWorkspaceSecurityFixture();
  t.after(() => fixture.cleanup());

  // Excluded folders
  fs.mkdirSync(path.join(fixture.workspaceRoot, '.git'), { recursive: true });
  fs.mkdirSync(path.join(fixture.workspaceRoot, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(fixture.workspaceRoot, 'target'), { recursive: true });
  fs.mkdirSync(path.join(fixture.workspaceRoot, 'dist'), { recursive: true });

  const rootRes = await handleIpcCommand('list_workspace_dir', {
    payload: {
      workingDirectory: fixture.workspaceRoot,
      relativePath: '',
    },
  });
  const names = rootRes.map((e: any) => e.name);
  assert.ok(!names.includes('.git'));
  assert.ok(!names.includes('node_modules'));
  assert.ok(!names.includes('target'));
  assert.ok(!names.includes('dist'));

  // Directories come before files
  const firstFileIdx = rootRes.findIndex((e: any) => !e.isDir);
  const lastDirIdx = rootRes.map((e: any) => e.isDir).lastIndexOf(true);
  if (firstFileIdx !== -1 && lastDirIdx !== -1) {
    assert.ok(lastDirIdx < firstFileIdx, 'Directories should precede files');
  }

  // Nonexistent directory inside workspace returns []
  const nonExistent = await handleIpcCommand('list_workspace_dir', {
    payload: {
      workingDirectory: fixture.workspaceRoot,
      relativePath: 'nonexistent-folder',
    },
  });
  assert.deepStrictEqual(nonExistent, []);
});

