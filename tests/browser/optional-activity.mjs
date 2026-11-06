import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scratch = path.join(root, '.verification/browser-activity');
fs.mkdirSync(scratch, { recursive: true });
process.env.TEMP = process.env.TMP = process.env.TMPDIR = scratch;
const server = await createServer({ configFile: false, root, envDir: scratch, cacheDir: path.join(scratch, 'vite-cache'), plugins: [react()], resolve: { alias: Object.fromEntries(['core', 'shared', 'infra', 'features', 'app'].map(name => [`@${name}`, path.join(root, 'src', name)])) }, server: { host: '127.0.0.1', port: 0, strictPort: true } });
let context;
try {
  await server.listen();
  const port = server.httpServer.address().port;
  context = await chromium.launchPersistentContext(path.join(scratch, 'profile'), { headless: true, viewport: { width: 1280, height: 900 }, env: { ...process.env, TEMP: scratch, TMP: scratch, TMPDIR: scratch } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const callbacks = new Map(), listeners = new Map(); let next = 1;
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = {
      transformCallback(fn) { const id = next++; callbacks.set(id, fn); return id; },
      unregisterCallback(id) { callbacks.delete(id); },
      async invoke(cmd, args) {
        if (cmd === 'plugin:event|listen') { if (!listeners.has(args.event)) listeners.set(args.event, new Set()); listeners.get(args.event).add(args.handler); return args.handler; }
        if (cmd === 'plugin:event|unlisten') { listeners.get(args.event)?.delete(args.eventId); return null; }
        if (cmd === 'connect') return { sessionId: 's1', sessionFile: '/fixture/s1', canonicalCwd: '/fixture', messages: [], activity: 'idle', model: null };
        if (cmd === 'get_custom_providers') return { providers: {} };
        if (cmd === 'get_mcp_servers') return { servers: [] };
        if (cmd === 'get_sdd_profiles') return { profiles: [] };
        return [];
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.emitFixture = payload => { const ids = listeners.get('pi://event'); if (!ids?.size) throw new Error('bridge listener not registered'); for (const id of ids) callbacks.get(id)?.({ event: 'pi://event', id, payload }); };
    localStorage.setItem('pi_viewer_projects', JSON.stringify({ projects: [{ id: 'p1', path: '/fixture', customName: 'Fixture', createdAt: '2024-01-01', lastOpenedAt: '2024-01-01' }], activeProjectId: 'p1' }));
    localStorage.setItem('pi_viewer_connect_config', JSON.stringify({ nodePath: '/node', piEntrypoint: '/pi.js', workingDirectory: '/fixture' }));
  });
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' });
  await page.locator('#prompt-input').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('.todo-panel, .subagent-entry').count(), 0);
  await page.keyboard.press('Alt+a');
  assert.equal(await page.locator('.subagent-modal').count(), 0);
  console.log('PASS S2.1/S2.3 absent hooks hidden; Alt+A no-op');
  await page.waitForFunction(() => { try { window.emitFixture({ type: 'runtime_snapshot', sessionId: 's1', sessionFile: '/fixture/s1', messages: [], activity: 'idle' }); return true; } catch { return false; } });
  await page.evaluate(() => window.emitFixture({ type: 'tool_execution_end', sessionId: 's1', toolCallId: 'todo1', toolName: 'todo', result: { content: [], details: { gentleTodo: { tasks: [{ id: 1, title: 'Browser task', status: 'pending' }], nextId: 2, updatedTurn: 1 } } } }));
  const todoToggle = page.locator('.todo-toggle');
  await todoToggle.waitFor({ timeout: 5000 });
  assert.equal(await todoToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.getByText('Browser task').count(), 0);
  await todoToggle.click();
  await page.getByText('Browser task').waitFor({ timeout: 5000 });
  assert.equal(await todoToggle.getAttribute('aria-expanded'), 'true');
  await todoToggle.click();
  assert.equal(await todoToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.getByText('Browser task').count(), 0);
  console.log('PASS todo collapsed by default; manual expansion and collapse preserved');
  const placement = await page.evaluate(() => ({ todo: document.querySelector('.todo-panel').getBoundingClientRect().bottom, prompt: document.querySelector('#prompt-input').getBoundingClientRect().top }));
  assert.ok(placement.todo <= placement.prompt);
  console.log('PASS S1.1/S4.1 todo above composer');
  const publish = async (text) => page.evaluate(text => window.emitFixture({ type: 'extension_ui_request', sessionId: 's1', method: 'setWidget', widgetKey: 'gentle-agents', widgetLines: [JSON.stringify({ schema: 'gentle-agents.activity/v1', tasks: [{ summary: { id: 'child', agent: 'worker', label: 'Child task', status: 'running' }, thread: { version: 1, dropped: 0, items: [{ kind: 'text', text }] } }] })] }), text);
  await publish('Real child activity');
  const entry = page.getByRole('button', { name: /Subagent process.*1/ });
  await entry.waitFor({ timeout: 5000 });
  await entry.click();
  const modal = page.getByRole('dialog', { name: 'Subagent process' });
  await modal.waitFor();
  assert.match(await modal.innerText(), /Real child activity/);
  assert.equal(await modal.evaluate(el => el.contains(document.activeElement)), true);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await modal.evaluate(el => el.contains(document.activeElement)), true);
  await page.keyboard.press('Tab');
  assert.equal(await modal.evaluate(el => el.contains(document.activeElement)), true);
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden' });
  assert.equal(await entry.evaluate(el => document.activeElement === el), true);
  await entry.focus(); await page.keyboard.press('Alt+a'); await modal.waitFor();
  await publish('Updated child activity');
  await modal.getByText('Updated child activity').waitFor();
  await page.evaluate(() => window.emitFixture({ type: 'extension_ui_request', sessionId: 's1', method: 'setWidget', widgetKey: 'gentle-agents', widgetLines: [JSON.stringify({ schema: 'gentle-agents.activity/v1', tasks: [{ summary: { id: 'child', agent: 'worker', label: 'Child task', status: 'running' }, thread: { version: 2, dropped: 1, items: [{ kind: 'thinking', text: 'Actual reasoning' }, { kind: 'tool', name: 'read', args: '{"path":"fixture.txt"}', running: false, isError: false, output: 'Actual tool output' }] } }, { summary: { id: 'other', agent: 'reviewer', label: 'Other task', status: 'waiting' }, thread: { version: 1, dropped: 0, items: [{ kind: 'note', text: 'Other note' }] } }] })] }));
  const tool = modal.locator('.tool-card-header');
  await tool.waitFor();
  assert.equal(await tool.getAttribute('aria-expanded'), 'false');
  await tool.click();
  assert.equal(await tool.getAttribute('aria-expanded'), 'true');
  assert.match(await modal.innerText(), /Actual tool output/);
  const thinking = modal.locator('.thinking-header');
  await thinking.click();
  assert.match(await modal.innerText(), /Actual reasoning/);
  await modal.getByRole('button', { name: /Other task/ }).click();
  assert.match(await modal.innerText(), /Other note/);
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 700 }]) {
    await page.setViewportSize(viewport);
    const geometry = await modal.evaluate(el => { const r = el.getBoundingClientRect(); return { width: r.width, height: r.height, left: r.left, right: r.right, bottom: r.bottom, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }; });
    assert.ok(geometry.width > viewport.width * 0.85 && geometry.height > viewport.height * 0.85);
    assert.ok(geometry.left >= 0 && geometry.right <= viewport.width && geometry.bottom <= viewport.height && geometry.scrollWidth <= geometry.clientWidth);
  }
  await page.keyboard.press('Escape'); await modal.waitFor({ state: 'hidden' });
  console.log('PASS S5/S3.1/S3.2 responsive geometry, card expansion, selection, live content, focus and Escape');
  await page.evaluate(() => { const other = document.createElement('div'); other.setAttribute('role', 'dialog'); other.id = 'fixture-other-dialog'; document.body.appendChild(other); });
  await page.keyboard.press('Alt+a');
  assert.equal(await modal.count(), 0);
  assert.equal(await page.locator('#fixture-other-dialog').count(), 1);
  console.log('PASS S3.2 existing dialog blocks shortcut (synthetic competing dialog)');
  assert.deepEqual(errors, []);
} finally {
  if (context) await context.close();
  await server.close();
}
