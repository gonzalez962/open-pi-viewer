import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { validateConnectConfig } from '@features/settings/config';
import { GentleMeshClient } from '@infra/mesh';
import type { RpcEventBase } from '@core/types/events';

test('validateConnectConfig: validates Gentle Mesh connection configuration', () => {
  const validMesh = validateConnectConfig({
    connectionType: 'mesh',
    meshCoordinatorUrl: 'http://100.64.0.1:8080',
    meshToken: 'secret-token-123',
    workingDirectory: '/home/user/project',
  });

  assert.strictEqual(validMesh.valid, true);
  assert.strictEqual(validMesh.config?.connectionType, 'mesh');
  assert.strictEqual(validMesh.config?.meshCoordinatorUrl, 'http://100.64.0.1:8080');
  assert.strictEqual(validMesh.config?.meshToken, 'secret-token-123');
  assert.strictEqual(validMesh.config?.workingDirectory, '/home/user/project');

  // Defaults workingDirectory to '.' if empty
  const defaultDirMesh = validateConnectConfig({
    connectionType: 'mesh',
    meshCoordinatorUrl: 'http://localhost:8080',
  });
  assert.strictEqual(defaultDirMesh.valid, true);
  assert.strictEqual(defaultDirMesh.config?.workingDirectory, '.');

  // Rejects invalid URL scheme
  const invalidUrlMesh = validateConnectConfig({
    connectionType: 'mesh',
    meshCoordinatorUrl: 'ftp://localhost:8080',
  });
  assert.strictEqual(invalidUrlMesh.valid, false);
  assert.match(invalidUrlMesh.error || '', /must begin with http:\/\/ or https:\/\//);
});

test('GentleMeshClient: connects to mock coordinator and fetches health/radar', async () => {
  let healthCalled = false;
  let radarCalled = false;

  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      healthCalled = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy' }));
      return;
    }
    if (req.url === '/v1/mesh/radar') {
      radarCalled = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ summary: { online_workers: 4 } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const coordinatorUrl = `http://127.0.0.1:${port}`;

  try {
    const statuses: string[] = [];
    const client = new GentleMeshClient({
      onStatusChange: (s) => statuses.push(s.state),
    });

    const result = await client.connect({
      nodePath: 'node',
      piEntrypoint: '',
      workingDirectory: '.',
      connectionType: 'mesh',
      meshCoordinatorUrl: coordinatorUrl,
    });

    assert.strictEqual(healthCalled, true, 'healthz endpoint was called');
    assert.strictEqual(radarCalled, true, 'radar endpoint was called');
    assert.strictEqual(result.connected, true);
    assert.strictEqual(result.model?.provider, 'gentle-mesh');
    assert.ok(statuses.includes('connecting'));
    assert.ok(statuses.includes('connected'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('GentleMeshClient: sends prompt, dispatches message_start, and streams SSE events', async () => {
  let taskCreated = false;
  let sseConnected = false;

  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.url === '/v1/mesh/radar') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ summary: { online_workers: 2 } }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/tasks') {
      taskCreated = true;
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        assert.strictEqual(parsed.prompt, 'Hello from Open Pi Viewer');
        assert.strictEqual(parsed.session_id, 'test-prompt-1');
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ task_id: 'task-mesh-123', status: 'running' }));
      });
      return;
    }
    if (req.url === '/v1/tasks/task-mesh-123/events') {
      sseConnected = true;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      // Stream events simulating thoughts, tool calls, and completion
      res.write('event: thought\ndata: {"text":"Thinking about architecture..."}\n\n');
      res.write('event: tool_call\ndata: {"call_id":"c1","tool":"read","args":{"path":"README.md"}}\n\n');
      res.write('event: tool_result\ndata: {"call_id":"c1","output":"# Gentle Mesh","is_error":false}\n\n');
      res.write('event: completion\ndata: {"text":"Task completed successfully"}\n\n');
      res.write('event: status\ndata: {"status":"completed"}\n\n');
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const coordinatorUrl = `http://127.0.0.1:${port}`;

  try {
    const receivedEvents: RpcEventBase[] = [];
    const client = new GentleMeshClient({
      onEvent: (e) => receivedEvents.push(e),
    });

    await client.connect({
      nodePath: 'node',
      piEntrypoint: '',
      workingDirectory: '.',
      connectionType: 'mesh',
      meshCoordinatorUrl: coordinatorUrl,
    });

    const promptRes = await client.sendPrompt('test-prompt-1', 'Hello from Open Pi Viewer');
    assert.strictEqual(promptRes.accepted, true);
    assert.strictEqual(promptRes.id, 'test-prompt-1');
    assert.strictEqual(taskCreated, true, 'POST /v1/tasks was invoked');

    // Wait for SSE stream to complete
    let waitLoops = 0;
    while (!receivedEvents.some((e) => e.type === 'agent_settled') && waitLoops < 50) {
      await new Promise((r) => setTimeout(r, 20));
      waitLoops++;
    }

    assert.strictEqual(sseConnected, true, 'SSE endpoint was connected');

    // Verify all mapped event types were emitted
    const types = receivedEvents.map((e) => e.type);
    assert.ok(types.includes('message_start'), 'message_start emitted');
    assert.ok(types.includes('message_update'), 'message_update emitted');
    assert.ok(types.includes('tool_execution_start'), 'tool_execution_start emitted');
    assert.ok(types.includes('tool_execution_end'), 'tool_execution_end emitted');
    assert.ok(types.includes('agent_settled'), 'agent_settled emitted');
    assert.ok(types.includes('message_end'), 'message_end emitted');

    // Check payload details
    const toolStart = receivedEvents.find((e) => e.type === 'tool_execution_start') as any;
    assert.strictEqual(toolStart.toolCallId, 'c1');
    assert.strictEqual(toolStart.toolName, 'read');

    const toolEnd = receivedEvents.find((e) => e.type === 'tool_execution_end') as any;
    assert.strictEqual(toolEnd.toolCallId, 'c1');
    assert.strictEqual(toolEnd.result, '# Gentle Mesh');

    const msgEnd = receivedEvents.find((e) => e.type === 'message_end') as any;
    assert.strictEqual(msgEnd.message.content, 'Task completed successfully');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('GentleMeshClient: listWorkspaceDir and readWorkspaceFile query remote endpoints', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/workspace/tree?path=src') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          root: '/app',
          path: 'src',
          entries: [
            { name: 'main.go', path: 'src/main.go', is_dir: false, size: 1024, mod_time: 1727000000 },
            { name: 'pkg', path: 'src/pkg', is_dir: true, size: 4096, mod_time: 1727000100 },
          ],
        })
      );
      return;
    }
    if (req.url === '/v1/workspace/file?path=src%2Fmain.go') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          path: 'src/main.go',
          content: 'package main\n\nfunc main() {}\n',
          size: 30,
          mod_time: 1727000000,
        })
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const coordinatorUrl = `http://127.0.0.1:${port}`;

  try {
    const client = new GentleMeshClient();
    client.setCoordinatorUrl(coordinatorUrl);

    // List workspace dir
    const entries = await client.listWorkspaceDir('src');
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].name, 'main.go');
    assert.strictEqual(entries[0].relativePath, 'src/main.go');
    assert.strictEqual(entries[0].isDir, false);
    assert.strictEqual(entries[1].name, 'pkg');
    assert.strictEqual(entries[1].isDir, true);

    // Read workspace file
    const file = await client.readWorkspaceFile('src/main.go');
    assert.strictEqual(file.relativePath, 'src/main.go');
    assert.strictEqual(file.content, 'package main\n\nfunc main() {}\n');
    assert.strictEqual(file.size, 30);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
