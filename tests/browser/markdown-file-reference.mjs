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
const file = path.join(project, 'binary file.bin');
const projectFile = path.join(project, 'project file.bin');
const outside = path.join(fixture, 'outside.bin');
const missing = path.join(home, 'missing.bin');
const directory = path.join(home, 'directory.bin');
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
  const downloadRequests = [];
  page.on('request', request => {
    const { pathname } = new URL(request.url());
    if (pathname === '/api/download/availability' || pathname === '/api/download') {
      downloadRequests.push(request.method() + ' ' + pathname);
    }
  });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('#prompt-input').waitFor({ timeout: 15000 });
  await page.waitForFunction(() => { try { window.emitFixture(); return true; } catch { return false; } });

  const inlineCode = page.locator('.markdown-body .markdown-inline-code');
  const assertNoFileActionsOrRequests = async () => {
    // Give client-side effects and their request events time to run after rendering.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('.markdown-file-reference, .markdown-file-download-btn').count(), 0);
    assert.deepEqual(downloadRequests, [], 'chat file paths must not send availability or download requests');
  };
  const block = page.locator('.markdown-code-block');
  await block.waitFor({ state: 'visible' });
  assert.deepEqual(await inlineCode.allTextContents(), [file, projectFile, projectFile, outside, missing, directory, 'https://example.com/file']);
  await assertNoFileActionsOrRequests();
  assert.equal(await block.locator('.markdown-code-copy-btn').count(), 1);
  assert.equal(await block.locator('.markdown-code-insert-btn').count(), 1);
  assert.equal(await block.locator('.markdown-code-download-btn').count(), 1);

  await page.getByRole('button', { name: 'Second Fixture', exact: true }).click();
  await page.locator('[aria-label="Second Fixture"][aria-current="true"]').waitFor();
  await page.locator('#prompt-input').waitFor({ timeout: 15000 });
  await page.waitForFunction(text => { try { window.emitFixture(text); return true; } catch { return false; } }, `After switching: \`${projectFile}\``);
  await page.locator('.markdown-body').getByText('After switching:', { exact: false }).waitFor();
  assert.deepEqual(await inlineCode.allTextContents(), [projectFile]);
  await assertNoFileActionsOrRequests();

  await context.close();
  console.log('PASS plain inline file paths, zero download requests, fenced controls, and workspace switch');
} finally {
  if (browser) await browser.close();
  if (server) { server.kill(); await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve); }); }
  fs.rmSync(fixture, { recursive: true, force: true });
}
