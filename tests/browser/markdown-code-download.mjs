import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const root = process.cwd();
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-code-download-'));
const home = path.join(fixture, 'home');
const project = path.join(fixture, 'project');
fs.mkdirSync(home); fs.mkdirSync(project);
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
  const long = 'x'.repeat(500);
  const code = `  indented ${long}\n\n  last`;
  const content = `Surrounding prose\n\n\`\`\`markdown\n${code}\n\`\`\`\n\nmore prose\n\n\`\`\`python\nprint('second')\n\`\`\``;
  await context.addInitScript(({ project, content }) => {
    const callbacks = new Map(), listeners = new Map(); let next = 1;
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = {
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
  const blocks = page.locator('.markdown-code-block');
  await blocks.nth(1).waitFor();
  assert.equal(await blocks.count(), 2);
  for (const [index, name, expected] of [[0, 'code.md', code], [1, 'code.py', "print('second')"]]) {
    const [download] = await Promise.all([page.waitForEvent('download'), blocks.nth(index).locator('.markdown-code-download-btn').click()]);
    assert.equal(download.suggestedFilename(), name);
    const chunks = []; for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString('utf8'), expected);
  }
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 700 }]) {
    await page.setViewportSize(viewport);
    const result = await blocks.first().locator('pre').evaluate(pre => {
      const style = getComputedStyle(pre), line = pre.querySelector('.markdown-code-line');
      return { whitespace: style.whiteSpace, wrap: style.overflowWrap, width: pre.clientWidth, scroll: pre.scrollWidth, lineHeight: parseFloat(style.lineHeight), height: line.getBoundingClientRect().height, text: line.textContent };
    });
    assert.equal(result.whitespace, 'pre-wrap'); assert.equal(result.wrap, 'anywhere');
    assert.ok(result.scroll <= result.width + 1); assert.ok(result.height > result.lineHeight * 2);
    assert.equal(result.text, `  indented ${long}`);
    assert.equal(await blocks.first().locator('.markdown-code-line').count(), 3);
  }
  assert.equal(await blocks.locator('.markdown-code-copy-btn').count(), 2);
  assert.equal(await blocks.locator('.markdown-code-insert-btn').count(), 2);
  await blocks.nth(1).locator('.markdown-code-insert-btn').click();
  assert.match(await page.locator('#prompt-input').inputValue(), /print\('second'\)/);
  await context.close();
  console.log('PASS selected downloads, wrapping, copy and insert controls');
} finally {
  if (browser) await browser.close();
  if (server) { server.kill(); await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve); }); }
  fs.rmSync(fixture, { recursive: true, force: true });
}
