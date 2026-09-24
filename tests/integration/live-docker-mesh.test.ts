import test from 'node:test';
import assert from 'node:assert/strict';
import { GentleMeshClient } from '@infra/mesh';
import type { RpcEventBase } from '@core/types/events';

test('Live Integration: Open Pi Viewer connects to live Docker Gentle Mesh cluster', async () => {
  const coordinatorUrl = process.env.GENTLE_MESH_URL || 'http://localhost:8080';

  // 1. Health check
  const healthRes = await fetch(`${coordinatorUrl}/healthz`);
  assert.strictEqual(healthRes.status, 200, 'Coordinator is healthy');
  const healthData = await healthRes.json();
  assert.strictEqual(healthData.status, 'ok');

  // 2. Initialize GentleMeshClient
  const receivedEvents: RpcEventBase[] = [];
  const statusChanges: any[] = [];

  const client = new GentleMeshClient({
    onEvent: (event) => {
      receivedEvents.push(event);
      if (event.type === 'message_update') {
        const update = event as any;
        if (update.assistantMessageEvent?.type === 'thinking_delta') {
          process.stdout.write(`[Thinking] ${update.assistantMessageEvent.delta} `);
        } else if (update.assistantMessageEvent?.type === 'text_delta') {
          process.stdout.write(`\n[Completion Delta] ${update.assistantMessageEvent.delta}\n`);
        }
      } else {
        console.log(`[Live SSE Event] Type: ${event.type}`);
      }
    },
    onStatusChange: (status) => {
      statusChanges.push(status);
      console.log(`[Status Change] State: ${status.state} (${status.label || ''})`);
    },
    onError: (err) => console.error('[Mesh Client Error]', err),
  });

  // 3. Connect to live cluster
  const connectResult = await client.connect({
    nodePath: 'node',
    piEntrypoint: '',
    workingDirectory: '.',
    connectionType: 'mesh',
    meshCoordinatorUrl: coordinatorUrl,
  });

  assert.strictEqual(connectResult.connected, true, 'Connected to live coordinator');
  assert.strictEqual(connectResult.model?.provider, 'gentle-mesh');

  // 4. Remote Workspace Exploration
  console.log('\n--- Testing Remote Workspace Exploration ---');
  const entries = await client.listWorkspaceDir();
  console.log(`Found ${entries.length} workspace entries in live container:`);
  for (const entry of entries.slice(0, 8)) {
    console.log(`  - [${entry.isDir ? 'DIR' : 'FILE'}] ${entry.relativePath} (${entry.size ?? 0} bytes)`);
  }
  assert.ok(entries.length > 0, 'Workspace contains entries');
  assert.ok(entries.some((e) => e.relativePath === 'README.md'), 'README.md exists in workspace');

  const file = await client.readWorkspaceFile('README.md');
  console.log(`Read README.md: ${file.size} bytes, first line: "${file.content.split('\n')[0]}"`);
  assert.strictEqual(file.relativePath, 'README.md');
  assert.ok(file.content.length > 0, 'README content is not empty');
  assert.ok(file.content.includes('# '), 'README contains markdown heading');

  // 5. Live Task Dispatch & SSE Streaming
  console.log('\n--- Testing Live Task Dispatch & SSE Streaming ---');
  const promptId = `prompt-live-${Date.now()}`;
  const promptText = 'Hola desde Open Pi Viewer en vivo sobre Docker Gentle Mesh!';

  const promptResult = await client.sendPrompt(promptId, promptText);
  assert.strictEqual(promptResult.accepted, true, 'Prompt accepted by coordinator');
  assert.strictEqual(promptResult.id, promptId);

  // 6. Wait for task execution & completion across the mesh
  console.log('Waiting for live SSE events from Docker worker...');
  let loops = 0;
  while (!receivedEvents.some((e) => e.type === 'agent_settled') && loops < 200) {
    await new Promise((r) => setTimeout(r, 100));
    loops++;
  }

  const settled = receivedEvents.find((e) => e.type === 'agent_settled');
  assert.ok(settled, 'Agent settled event received');

  const messageEnd = receivedEvents.find((e) => e.type === 'message_end') as any;
  assert.ok(messageEnd, 'message_end event received');
  console.log(`[Agent Completed] Result text: "${messageEnd.message.content}"`);

  // Disconnect cleanly
  await client.disconnect();
  console.log('Disconnected cleanly from Gentle Mesh cluster.');
});
