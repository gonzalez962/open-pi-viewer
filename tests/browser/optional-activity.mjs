import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
async function withFixture({ port = 0, touch = false }, run) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-browser-activity-'));
  let context, server;
  try {
    server = await createServer({ configFile: false, root, envDir: scratch, cacheDir: path.join(scratch, 'vite-cache'), plugins: [react()], resolve: { alias: Object.fromEntries(['core', 'shared', 'infra', 'features', 'app'].map(name => [`@${name}`, path.join(root, 'src', name)])) }, server: { host: '127.0.0.1', port, strictPort: true } });
    await server.listen();
    const boundPort = server.httpServer.address().port;
    const viewport = touch ? { width: 390, height: 700 } : { width: 1280, height: 900 };
    context = await chromium.launchPersistentContext(path.join(scratch, 'profile'), { headless: true, viewport, hasTouch: touch, env: { ...process.env, TEMP: scratch, TMP: scratch, TMPDIR: scratch } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const callbacks = new Map(), listeners = new Map(); let next = 1;
      window.isTauri = true;
      window.abortCount = 0;
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
          if (cmd === 'abort') { window.abortCount++; return null; }
          return [];
        },
      };
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
      window.emitFixture = payload => { const ids = listeners.get('pi://event'); if (!ids?.size) throw new Error('bridge listener not registered'); for (const id of ids) callbacks.get(id)?.({ event: 'pi://event', id, payload }); };
      localStorage.setItem('pi_viewer_projects', JSON.stringify({ projects: [{ id: 'p1', path: '/fixture', customName: 'Fixture', createdAt: '2024-01-01', lastOpenedAt: '2024-01-01' }], activeProjectId: 'p1' }));
      localStorage.setItem('pi_viewer_connect_config', JSON.stringify({ nodePath: '/node', piEntrypoint: '/pi.js', workingDirectory: '/fixture' }));
    });
    await page.goto(`http://127.0.0.1:${boundPort}`, { waitUntil: 'domcontentloaded' });
    await page.locator('#prompt-input').waitFor({ timeout: 15000 });
    await run(page);
    assert.deepEqual(errors, []);
  } finally {
    try {
      await context?.close();
    } finally {
      try {
        await server?.close();
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    }
  }
}

const waitForBridge = page => page.waitForFunction(() => { try { window.emitFixture({ type: 'runtime_snapshot', sessionId: 's1', sessionFile: '/fixture/s1', messages: [], activity: 'idle' }); return true; } catch { return false; } }, null, { timeout: 5000 });
const startBusyTurn = page => page.evaluate(() => window.emitFixture({ type: 'runtime_snapshot', sessionId: 's1', sessionFile: '/fixture/s1', messages: [], activity: 'busy' }));
const publishTasks = (page, tasks) => page.evaluate(tasks => window.emitFixture({ type: 'extension_ui_request', sessionId: 's1', method: 'setWidget', widgetKey: 'gentle-agents', widgetLines: [JSON.stringify({ schema: 'gentle-agents.activity/v1', tasks })] }), tasks);

async function prepareTrigger(page) {
  await waitForBridge(page);
  await startBusyTurn(page);
  await publishTasks(page, [
    { summary: { id: 'first', agent: 'worker', label: 'First task', status: 'running' } },
    { summary: { id: 'target', agent: 'reviewer', label: 'Tapped task', status: 'running' }, thread: { version: 1, dropped: 0, items: [{ kind: 'text', text: 'Target task activity' }] } },
  ]);
  const entry = page.locator('.working-subagent-trigger').and(page.getByRole('button', { name: 'Reviewer', exact: true }));
  await entry.waitFor({ timeout: 5000 });
  const modal = page.getByRole('dialog', { name: 'Subagent process' });
  assert.equal(await modal.count(), 0);
  return { entry, modal };
}

async function assertTargetTask(modal, action) {
  assert.equal(await modal.isVisible(), true, `Subagent dialog did not open after ${action}`);
  await modal.getByRole('heading', { name: 'Tapped task', exact: true }).waitFor({ timeout: 5000 });
  assert.equal(await modal.getByRole('button', { name: /Tapped task/, pressed: true }).count(), 1);
  await modal.getByText('Target task activity', { exact: true }).waitFor({ timeout: 5000 });
}

// Run just this spec with: node --test-reporter=junit tests/browser/optional-activity.mjs --subagent-trigger
function registerTriggerTests() {
  test('S1.1 mobile tap opens the tapped task with drawer closed', () => withFixture({ port: 5195, touch: true }, async page => {
    const { entry, modal } = await prepareTrigger(page);
    const drawer = page.locator('#mobile-navigation-drawer[role="dialog"][aria-hidden="true"][inert]');
    await drawer.waitFor({ state: 'attached', timeout: 5000 });
    assert.equal(await page.getByRole('dialog').count(), 0);
    await entry.tap({ timeout: 5000 });
    await assertTargetTask(modal, 'a normal tap with the mobile drawer closed (aria-hidden and inert)');
  }));

  test('S4.1 desktop click opens the clicked task', () => withFixture({ port: 5195 }, async page => {
    const { entry, modal } = await prepareTrigger(page);
    await entry.click({ timeout: 5000 });
    await assertTargetTask(modal, 'a desktop click');
  }));

  test('S4.2 subagent activity defers to a competing active dialog', () => withFixture({ port: 5195 }, async page => {
    const { modal } = await prepareTrigger(page);
    await page.getByRole('button', { name: 'Add project folder', exact: true }).click({ timeout: 5000 });
    const competing = page.getByRole('dialog', { name: /default.*directory/i });
    await competing.waitFor({ timeout: 5000 });
    await page.keyboard.press('Alt+a');
    assert.equal(await competing.isVisible(), true);
    assert.equal(await modal.count(), 0);
    assert.equal(await page.evaluate(() => window.abortCount), 0);
    await competing.getByRole('button', { name: 'Cancel', exact: true }).last().click({ timeout: 5000 });
    await competing.waitFor({ state: 'hidden', timeout: 5000 });
    assert.equal(await modal.count(), 0, 'blocked shortcut must not open activity after dismissal');
    await page.keyboard.press('Alt+a');
    await modal.waitFor({ timeout: 5000 });
  }));
}

const threadSelector = '.subagent-modal .subagent-thread';
const bottomTolerance = 1;

function readThreadGeometry(thread) {
  return thread.evaluate(async el => {
    // Let layout, scroll events and render-scheduled scrolling settle.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const { scrollTop, scrollHeight, clientHeight } = el;
    return { scrollTop, bottomGap: scrollHeight - clientHeight - scrollTop, scrollRange: scrollHeight - clientHeight };
  });
}

async function scrollThread(page, thread, atBottom) {
  await thread.hover({ timeout: 5000 });
  await page.mouse.wheel(0, atBottom ? 10000 : -400);
  await page.waitForFunction(({ selector, atBottom, tolerance }) => {
    const el = document.querySelector(selector);
    if (!el) return false;
    const gap = el.scrollHeight - el.clientHeight - el.scrollTop;
    return atBottom ? gap <= tolerance : gap > 100 && el.scrollTop > 100;
  }, { selector: threadSelector, atBottom, tolerance: bottomTolerance }, { timeout: 5000 });
  return readThreadGeometry(thread);
}

async function prepareScrollThread(page) {
  await waitForBridge(page);
  await startBusyTurn(page);
  const thread = page.locator(threadSelector);
  const items = [];
  let version = 0;
  const append = async count => {
    for (let i = 0; i < count; i++) items.push({ kind: 'text', text: `Scroll fixture action ${items.length + 1}` });
    await publishTasks(page, [{ summary: { id: 'scroll', agent: 'worker', label: 'Scroll task', status: 'running' }, thread: { version: ++version, dropped: 0, items } }]);
  };
  const waitForLatest = () => thread.getByText(items.at(-1).text, { exact: true }).waitFor({ timeout: 5000 });
  await append(24);
  await page.locator('.working-subagent-trigger').and(page.getByRole('button', { name: 'Worker', exact: true })).click({ timeout: 5000 });
  await waitForLatest();
  assert.ok((await readThreadGeometry(thread)).scrollRange > 500, 'fixture needs enough overflow to scroll up without reaching the top');
  await scrollThread(page, thread, true);

  return {
    scroll: atBottom => scrollThread(page, thread, atBottom),
    async update(t, phase) {
      const before = await readThreadGeometry(thread);
      await append(4);
      await waitForLatest();
      const after = await readThreadGeometry(thread);
      t.diagnostic(`${phase}: ${JSON.stringify({ before, after })}`);
      assert.ok(after.scrollRange > before.scrollRange, 'rendered actions must increase scrollable height');
      return { before, after };
    },
  };
}

function assertFollowed({ before, after }) {
  assert.ok(before.bottomGap <= bottomTolerance, 'must start at the bottom');
  assert.ok(after.scrollTop > before.scrollTop, 'scrollTop must advance as new actions render');
  assert.ok(after.bottomGap <= bottomTolerance, 'must follow new actions to the bottom');
}

// Run just this spec with: node --test-reporter=junit tests/browser/optional-activity.mjs --subagent-scroll
function registerScrollTests() {
  test('S2.1 overflowing activity follows new actions at the bottom', t => withFixture({ port: 5195 }, async page => {
    const activity = await prepareScrollThread(page);
    assertFollowed(await activity.update(t, 'append at bottom'));
  }));

  test('S5.1 scrolling up preserves the paused position when new actions render', t => withFixture({ port: 5195 }, async page => {
    const activity = await prepareScrollThread(page);
    await activity.scroll(false);
    const { before, after } = await activity.update(t, 'append while paused');
    assert.ok(before.bottomGap > 100, 'must start away from the bottom');
    assert.ok(Math.abs(after.scrollTop - before.scrollTop) <= bottomTolerance, 'new actions must preserve the paused scrollTop');
    assert.ok(after.bottomGap > before.bottomGap, 'new actions must grow the gap while paused');
  }));

  test('S2.3 returning to the bottom resumes following new actions', t => withFixture({ port: 5195 }, async page => {
    const activity = await prepareScrollThread(page);
    await activity.scroll(false);
    const paused = await activity.update(t, 'append while paused before returning');
    assert.ok(paused.before.bottomGap > 100 && paused.after.bottomGap > bottomTolerance, 'must be away from the bottom before returning');
    const returned = await activity.scroll(true);
    assert.ok(returned.scrollTop > paused.after.scrollTop, 'returning must advance scrollTop');
    assertFollowed(await activity.update(t, 'append after returning'));
  }));
}

async function runLegacyChecks(page) {
  assert.equal(await page.locator('.todo-panel, .working-text button[aria-haspopup="dialog"], .subagent-entry').count(), 0);
  await page.keyboard.press('Alt+a');
  assert.equal(await page.locator('.subagent-modal').count(), 0);
  console.log('PASS S2.1/S2.3 absent hooks hidden; Alt+A no-op');
  await waitForBridge(page);
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
  await startBusyTurn(page);
  const cancel = page.locator('.btn-cancel');
  await cancel.waitFor({ timeout: 5000 });
  const aborts = () => page.evaluate(() => window.abortCount);
  const publish = text => publishTasks(page, [{ summary: { id: 'child', agent: 'worker', label: 'Child task', status: 'running', lastStep: 'Reading a/b' }, thread: { version: 1, dropped: 0, items: [{ kind: 'text', text }] } }]);
  await publish('Real child activity');
  const working = page.locator('.working-text');
  const entry = working.getByRole('button', { name: /^worker$/i });
  await entry.waitFor({ timeout: 5000 });
  assert.equal(await page.locator('.subagent-entry').count(), 0);
  assert.equal(await page.getByRole('button', { name: /Subagent process.*1/ }).count(), 0);
  assert.equal(await entry.getAttribute('type'), 'button');
  assert.equal(await entry.getAttribute('aria-haspopup'), 'dialog');
  assert.ok(await entry.evaluate(el => Number(getComputedStyle(el).fontWeight) >= 700));
  assert.match(await working.textContent(), /^Working - Worker: Reading a\/b$/);
  await entry.click();
  const modal = page.getByRole('dialog', { name: 'Subagent process' });
  await modal.waitFor();
  assert.match(await modal.innerText(), /Real child activity/);
  assert.equal(await modal.evaluate(el => el.contains(document.activeElement)), true);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await modal.evaluate(el => el.contains(document.activeElement)), true);
  await page.keyboard.press('Tab');
  assert.equal(await modal.evaluate(el => el.contains(document.activeElement)), true);
  await cancel.focus();
  assert.equal(await modal.evaluate(el => el.contains(document.activeElement)), false);
  await page.keyboard.down('Escape');
  await modal.waitFor({ state: 'hidden' });
  await page.keyboard.down('Escape'); // Repeat after the modal has gone.
  await page.keyboard.up('Escape');
  assert.equal(await entry.evaluate(el => document.activeElement === el), true);
  assert.equal(await page.locator('.btn-cancel.btn-confirming').count(), 0);
  assert.equal(await aborts(), 0);
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
  await modal.getByRole('button', { name: /Child task/ }).click();
  await page.keyboard.press('Escape'); await modal.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.btn-cancel.btn-confirming').count(), 0);
  assert.equal(await aborts(), 0);
  const reviewer = working.getByRole('button', { name: /^reviewer$/i });
  await reviewer.click();
  await modal.waitFor();
  assert.equal(await modal.getByRole('heading', { name: 'Other task' }).count(), 1);
  await page.keyboard.press('Escape'); await modal.waitFor({ state: 'hidden' });
  assert.equal(await reviewer.evaluate(el => document.activeElement === el), true);
  console.log('PASS Working triggers, responsive modal, live content, selection and focus');
  await page.keyboard.press('Escape');
  await page.locator('.btn-cancel.btn-confirming').waitFor();
  assert.equal(await aborts(), 0);
  await page.keyboard.press('Alt+a'); await modal.waitFor();
  await page.keyboard.press('Escape'); await modal.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.btn-cancel.btn-confirming').count(), 1);
  assert.equal(await aborts(), 0);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.abortCount === 1);
  console.log('PASS modal Escape (including outside focus and repeat) does not arm or abort; ordinary double Escape still aborts');
  await page.evaluate(() => { const other = document.createElement('div'); other.setAttribute('role', 'dialog'); other.id = 'fixture-other-dialog'; document.body.appendChild(other); });
  await page.keyboard.press('Alt+a');
  assert.equal(await modal.count(), 0);
  assert.equal(await page.locator('#fixture-other-dialog').count(), 1);
  console.log('PASS S3.2 existing dialog blocks shortcut (synthetic competing dialog)');
}

if (process.argv.includes('--subagent-trigger')) registerTriggerTests();
else if (process.argv.includes('--subagent-scroll')) registerScrollTests();
else await withFixture({}, runLegacyChecks);
