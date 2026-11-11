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
fs.mkdirSync(home); fs.mkdirSync(project);
const file = path.join(home, 'binary file.bin');
const projectFile = path.join(project, 'project file.bin');
const outside = path.join(fixture, 'outside.bin');
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
  const content = `File: \`${file}\`\n\n- Project: \`${projectFile}\`\n\n| File |\n| --- |\n| \`${projectFile}\` |\n\nOutside: \`${outside}\`\n\n\`https://example.com/file\`\n\n\`\`\`text\n${file}\n\`\`\``;
  await context.addInitScript(({ project, content }) => {
    const callbacks = new Map(), listeners = new Map(); let next = 1;
    window.isTauri = true; window.__IS_WEB_IPC__ = true;
    window.__TAURI_INTERNALS__ = {
      __isWebIpc: true,
      transformCallback(fn) { const id = next++; callbacks.set(id, fn); return id; },
      unregisterCallback(id) { callbacks.delete(id); },
      async invoke(cmd, args) {
        if (cmd === 'plugin:event|listen') { if (!listeners.has(args.event)) listeners.set(args.event, new Set()); listeners.get(args.event).add(args.handler); return args.handler; }
        if (cmd === 'plugin:event|unlisten') { listeners.get(args.event)?.delete(args.eventId); return null; }
        if (cmd === 'connect') return { sessionId: 's1', sessionFile: '/fixture/s1', canonicalCwd: project, messages: [], activity: 'idle', model: null };
        if (cmd === 'get_custom_providers') return { providers: {} };
        if (cmd === 'get_mcp_servers') return { servers: [] };
        if (cmd === 'get_sdd_profiles') return { profiles: [] };
        return [];
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.emitFixture = () => { const ids = listeners.get('pi://event'); if (!ids?.size) throw new Error('not ready'); for (const id of ids) callbacks.get(id)?.({ event: 'pi://event', id, payload: { type: 'runtime_snapshot', sessionId: 's1', sessionFile: '/fixture/s1', messages: [{ id: 'message1', role: 'assistant', content, timestamp: new Date().toISOString() }], activity: 'idle' } }); };
    localStorage.setItem('pi_viewer_projects', JSON.stringify({ projects: [{ id: 'p1', path: project, customName: 'Fixture', createdAt: '2024-01-01', lastOpenedAt: '2024-01-01' }], activeProjectId: 'p1' }));
    localStorage.setItem('pi_viewer_connect_config', JSON.stringify({ nodePath: '/node', piEntrypoint: '/pi.js', workingDirectory: project }));
  }, { project, content });
  const page = await context.newPage();
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('#prompt-input').waitFor({ timeout: 15000 });
  await page.waitForFunction(() => { try { window.emitFixture(); return true; } catch { return false; } });
  const actions = page.locator('.markdown-file-download-btn');
  await actions.first().waitFor();
  assert.equal(await actions.count(), 4);
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
  let unexpectedDownloads = 0;
  const onUnexpectedDownload = () => { unexpectedDownloads++; };
  page.on('download', onUnexpectedDownload);
  const [outsideRequest, outsideResponse] = await Promise.all([
    page.waitForRequest(req => req.url().endsWith('/api/download') && req.method() === 'POST'),
    page.waitForResponse(response => response.url().endsWith('/api/download') && response.request().method() === 'POST'),
    actions.nth(3).click(),
  ]);
  assert.deepEqual(outsideRequest.postDataJSON(), { sourcePath: outside });
  assert.equal(outsideResponse.status(), 400);
  assert.deepEqual(await outsideResponse.json(), { error: 'Access denied: outside download root' });
  await actions.nth(3).locator('..').getByRole('status').waitFor({ state: 'visible' });
  assert.equal(unexpectedDownloads, 0);
  page.off('download', onUnexpectedDownload);
  const block = page.locator('.markdown-code-block');
  assert.equal(await block.locator('.markdown-file-download-btn').count(), 0);
  assert.equal(await block.locator('.markdown-code-copy-btn').count(), 1);
  assert.equal(await block.locator('.markdown-code-insert-btn').count(), 1);
  assert.equal(await block.locator('.markdown-code-download-btn').count(), 1);
  await context.close();
  console.log('PASS inline binary download, outside-home failure, fenced controls');
} finally {
  if (browser) await browser.close();
  if (server) { server.kill(); await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve); }); }
  fs.rmSync(fixture, { recursive: true, force: true });
}
