import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const root = process.cwd();
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-inline-download-'));
const home = path.join(fixture, 'home');
const project = path.join(fixture, 'project');
const project2 = path.join(fixture, 'project2');
fs.mkdirSync(home); fs.mkdirSync(project); fs.mkdirSync(project2);
const file = path.join(home, 'binary file.bin');
const projectFile = path.join(project, 'project file.bin');
const outside = path.join(fixture, 'outside.bin');
const missing = path.join(home, 'missing.bin');
const directory = path.join(home, 'directory');
fs.mkdirSync(directory);
const bytes = Buffer.from([0, 255, 1, 2, 128]);
fs.writeFileSync(file, bytes); fs.writeFileSync(projectFile, bytes); fs.writeFileSync(outside, bytes);
let server, browser;
try {
  const port = await new Promise((resolve, reject) => {
    const listener = net.createServer(); listener.on('error', reject);
    listener.listen(0, '127.0.0.1', () => { const port = listener.address().port; listener.close(() => resolve(port)); });
  });
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(root, 'dist-server/start.js')], { cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home, HOST: '127.0.0.1', PORT: String(port), PI_VIEWER_AUTH_ENABLED: 'true', PI_VIEWER_AUTH_KEY: 'fixture-key' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(new Error(`Server startup timeout: ${output}`)), 15000);
    const data = chunk => { output += chunk; if (output.includes('Pi Viewer listening on http://')) { clearTimeout(timer); resolve(); } };
    server.stdout.on('data', data); server.stderr.on('data', data); server.on('error', reject); server.on('exit', code => reject(new Error(`Server exit ${code}: ${output}`)));
  });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  assert.equal((await context.request.post(`${base}/api/auth/login`, { headers: { origin: base }, data: { key: 'fixture-key' } })).status(), 200);
  // Reproduce the old inline payload against the same backend before exercising the UI.
  const oldRouting = await context.request.post(`${base}/api/download`, { headers: { origin: base }, data: { sourcePath: projectFile } });
  assert.equal(oldRouting.status(), 400);
  assert.deepEqual(await oldRouting.json(), { error: 'Access denied: outside download root' });
  const content = `File: \`${file}\`\n\n- Project: \`${projectFile}\`\n\n| File |\n| --- |\n| \`${projectFile}\` |\n\nOutside: \`${outside}\`\n\nMissing: \`${missing}\`\n\nDirectory: \`${directory}\`\n\n\`https://example.com/file\`\n\n\`\`\`text\n${file}\n\`\`\``;
  await context.addInitScript(({ project, project2, content }) => {
    const callbacks = new Map(), listeners = new Map(); let next = 1;
    window.isTauri = true; window.__IS_WEB_IPC__ = true;
    window.__TAURI_INTERNALS__ = {
      __isWebIpc: true,
      transformCallback(fn) { const id = next++; callbacks.set(id, fn); return id; },
      unregisterCallback(id) { callbacks.delete(id); },
      async invoke(cmd, args) {
        if (cmd === 'plugin:event|listen') { if (!listeners.has(args.event)) listeners.set(args.event, new Set()); listeners.get(args.event).add(args.handler); return args.handler; }
        if (cmd === 'plugin:event|unlisten') { listeners.get(args.event)?.delete(args.eventId); return null; }
        if (cmd === 'connect') return { sessionId: 's1', sessionFile: '/fixture/s1', canonicalCwd: args?.payload?.workingDirectory || project, messages: [], activity: 'idle', model: null };
        if (cmd === 'get_custom_providers') return { providers: {} };
        if (cmd === 'get_mcp_servers') return { servers: [] };
        if (cmd === 'get_sdd_profiles') return { profiles: [] };
        return [];
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.emitFixture = (text = content) => { const ids = listeners.get('pi://event'); if (!ids?.size) throw new Error('not ready'); for (const id of ids) callbacks.get(id)?.({ event: 'pi://event', id, payload: { type: 'runtime_snapshot', sessionId: 's1', sessionFile: '/fixture/s1', messages: [{ id: 'message1', role: 'assistant', content: text, timestamp: new Date().toISOString() }], activity: 'idle' } }); };
    localStorage.setItem('pi_viewer_projects', JSON.stringify({ projects: [{ id: 'p1', path: project, customName: 'Fixture', createdAt: '2024-01-01', lastOpenedAt: '2024-01-01' }, { id: 'p2', path: project2, customName: 'Second Fixture', createdAt: '2024-01-01', lastOpenedAt: '2024-01-01' }], activeProjectId: 'p1' }));
    localStorage.setItem('pi_viewer_connect_config', JSON.stringify({ nodePath: '/node', piEntrypoint: '/pi.js', workingDirectory: project }));
  }, { project, project2, content });
  const page = await context.newPage();
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('#prompt-input').waitFor({ timeout: 15000 });
  await page.waitForFunction(() => { try { window.emitFixture('ready'); return true; } catch { return false; } });
  // S2.1: rejected route-like references and URIs remain visible without a probe.
  const probes = [];
  const collectProbe = request => { if (request.url().endsWith('/api/download/availability')) probes.push(request); };
  page.on('request', collectProbe);
  await page.evaluate(() => window.emitFixture('`/admin/settings` `https://example.com/file` `file:///tmp/a`'));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(probes.length, 0, 'S2.1 rejected candidates must not request availability');
  for (const text of ['/admin/settings', 'https://example.com/file', 'file:///tmp/a']) assert.match(await page.locator('.markdown-body').innerText(), new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  page.off('request', collectProbe);

  // S2.2: hold confirmation and verify that probe and click use identical project payloads.
  let confirmProbe;
  const pendingProbe = new Promise(resolve => { confirmProbe = resolve; });
  await page.route('**/api/download/availability', route => confirmProbe(route), { times: 1 });
  await page.evaluate(() => window.emitFixture('`/frontend/src/components/menu.ts`'));
  const projectProbe = await pendingProbe;
  const payload = { workingDirectory: project, relativePath: 'frontend/src/components/menu.ts' };
  assert.deepEqual(projectProbe.request().postDataJSON(), payload);
  assert.equal(await page.locator('.markdown-file-download-btn').count(), 0);
  await projectProbe.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ available: true }) });
  await page.locator('.markdown-file-download-btn').waitFor({ state: 'visible' });
  const projectRequest = page.waitForRequest(req => req.url().endsWith('/api/download') && req.method() === 'POST');
  await page.locator('.markdown-file-download-btn').click();
  assert.deepEqual((await projectRequest).postDataJSON(), payload);
  await page.evaluate(() => window.emitFixture());
  const actions = page.locator('.markdown-file-download-btn');
  await page.waitForFunction(() => document.querySelectorAll('.markdown-file-download-btn').length === 3);
  assert.equal(await actions.count(), 3);
  for (const rejected of [outside, missing, directory]) {
    const reference = page.locator('.markdown-file-reference').filter({ hasText: rejected });
    assert.equal(await reference.locator('code').innerText(), rejected);
    assert.equal(await reference.locator('.markdown-file-download-btn').count(), 0);
  }
  assert.equal(await actions.first().innerText(), '');
  const icon = actions.first().locator('svg[aria-hidden=true][stroke=currentColor]');
  assert.equal(await icon.count(), 1);
  assert.equal(await icon.locator('path').count(), 3);
  assert.equal(await icon.evaluate(el => getComputedStyle(el).stroke), await actions.first().evaluate(el => getComputedStyle(el).color));
  assert.equal(await actions.first().locator('..').locator('code').innerText(), file);
  const [download] = await Promise.all([page.waitForEvent('download'), actions.first().click()]);
  assert.equal(download.suggestedFilename(), 'binary file.bin');
  const chunks = []; for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), bytes);
  for (const index of [1, 2]) {
    const [request, projectDownload] = await Promise.all([
      page.waitForRequest(req => req.url().endsWith('/api/download') && req.method() === 'POST'),
      page.waitForEvent('download'), actions.nth(index).click(),
    ]);
    assert.deepEqual(request.postDataJSON(), { workingDirectory: project, relativePath: 'project file.bin' });
    assert.equal(projectDownload.suggestedFilename(), 'project file.bin');
    const projectChunks = []; for await (const chunk of await projectDownload.createReadStream()) projectChunks.push(chunk);
    assert.deepEqual(Buffer.concat(projectChunks), bytes);
  }
  // Availability is not an authorization grant: deletion after confirmation must fail on download.
  fs.unlinkSync(file);
  const [response] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/download') && response.request().method() === 'POST'),
    actions.first().click(),
  ]);
  assert.equal(response.status(), 400);
  await actions.first().locator('..').getByRole('status').waitFor({ state: 'visible' });
  const block = page.locator('.markdown-code-block');
  assert.equal(await block.locator('.markdown-file-download-btn').count(), 0);
  assert.equal(await block.locator('.markdown-code-copy-btn').count(), 1);
  assert.equal(await block.locator('.markdown-code-insert-btn').count(), 1);
  assert.equal(await block.locator('.markdown-code-download-btn').count(), 1);
  // Hold both checks while the same reference changes path, then resolve the old one first.
  let resolveCheck;
  const nextCheck = () => new Promise(resolve => { resolveCheck = resolve; });
  await page.route('**/api/download/availability', route => resolveCheck(route));
  const oldPath = path.join(home, 'stale-old.bin');
  const newPath = path.join(home, 'stale-new.bin');
  let check = nextCheck();
  await page.evaluate(text => window.emitFixture(text), `\`${oldPath}\``);
  const oldRoute = await check;
  assert.equal(await actions.count(), 0);
  check = nextCheck();
  await page.evaluate(text => window.emitFixture(text), `\`${newPath}\``);
  const newRoute = await check;
  assert.equal(await page.locator('.markdown-file-reference code').innerText(), newPath);
  assert.equal(await actions.count(), 0);
  const oldFinished = page.waitForEvent('requestfinished', request => request === oldRoute.request());
  await oldRoute.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ available: true }) });
  await oldFinished;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await actions.count(), 0);
  const newFinished = page.waitForEvent('requestfinished', request => request === newRoute.request());
  await newRoute.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'unavailable' }) });
  await newFinished;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await actions.count(), 0);
  assert.equal(await page.locator('.markdown-file-reference code').innerText(), newPath);
  // Keep the same path while switching the actual active project and hold both checks.
  check = nextCheck();
  await page.evaluate(text => window.emitFixture(text), `\`${projectFile}\``);
  const oldWorkspaceRoute = await check;
  assert.deepEqual(oldWorkspaceRoute.request().postDataJSON(), { workingDirectory: project, relativePath: 'project file.bin' });
  check = nextCheck();
  await page.getByRole('button', { name: 'Second Fixture', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Second Fixture"][aria-current="true"]'));
  await page.waitForFunction(text => { try { window.emitFixture(text); return true; } catch { return false; } }, `\`${projectFile}\``);
  const newWorkspaceRoute = await check;
  assert.deepEqual(newWorkspaceRoute.request().postDataJSON(), { sourcePath: projectFile });
  assert.equal(await page.locator('.markdown-file-reference code').innerText(), projectFile);
  assert.equal(await actions.count(), 0);
  const oldWorkspaceFinished = page.waitForEvent('requestfinished', request => request === oldWorkspaceRoute.request());
  await oldWorkspaceRoute.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ available: true }) });
  await oldWorkspaceFinished;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await actions.count(), 0);
  const newWorkspaceFinished = page.waitForEvent('requestfinished', request => request === newWorkspaceRoute.request());
  await newWorkspaceRoute.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'unavailable' }) });
  await newWorkspaceFinished;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await actions.count(), 0);
  assert.equal(await page.locator('.markdown-file-reference code').innerText(), projectFile);
  await context.close();
  console.log('PASS inline binary download, outside-home failure, fenced controls, stale path and workspace');
} finally {
  if (browser) await browser.close();
  if (server) { server.kill(); await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve); }); }
  fs.rmSync(fixture, { recursive: true, force: true });
}
