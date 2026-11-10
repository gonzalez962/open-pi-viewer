import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const root = process.cwd();
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-home-download-browser-'));
const home = path.join(fixture, 'home');
const project = path.join(fixture, 'project');
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(home, { recursive: true });
const files = { 'binary.bin': Buffer.from([0, 255, 1, 2]), 'empty.bin': Buffer.alloc(0), 'large.bin': Buffer.alloc(25 * 1024 * 1024 + 1, 0xa5) };
for (const [name, bytes] of Object.entries(files)) { fs.writeFileSync(path.join(project, name), bytes); fs.writeFileSync(path.join(home, name), bytes); }
fs.writeFileSync(path.join(fixture, 'outside.bin'), 'outside');
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
  const login = await context.request.post(`${base}/api/auth/login`, { headers: { origin: base }, data: { key: 'fixture-key' } });
  assert.equal(login.status(), 200);
  await context.addInitScript(({ registry, config }) => {
    localStorage.setItem('pi_viewer_projects', JSON.stringify(registry));
    localStorage.setItem('pi_viewer_connect_config', JSON.stringify(config));
  }, { registry: { projects: [{ id: 'download-fixture', path: project, customName: 'Download Fixture', createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString() }], activeProjectId: 'download-fixture' }, config: { nodePath: process.execPath, piEntrypoint: path.join(root, 'dist-server/start.js'), workingDirectory: project, fileTreeRefreshInterval: 15 } });
  const page = await context.newPage();
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('.sidebar-tabs button[role="tab"]').nth(1).click();
  async function download(action, name) {
    const [result] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), action()]);
    assert.equal(result.suggestedFilename(), name);
    const stream = await result.createReadStream(); const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), files[name]);
    console.log(`PASS download ${name}`);
  }
  const trigger = page.locator('.btn-tree-download');
  assert.equal(await page.locator('.workspace-download-form').count(), 0);
  assert.equal(await page.locator('.btn-tree-refresh + .btn-tree-download').count(), 1);
  async function icon(button) {
    assert.equal(await button.innerText(), '');
    const svg = button.locator('svg.download-icon');
    assert.equal(await svg.count(), 1);
    assert.equal(await svg.locator('path').count(), 3);
    assert.equal(await svg.evaluate(el => getComputedStyle(el).maskImage), 'none');
  }
  await icon(trigger);
  const styles = el => { const s = getComputedStyle(el); return ['width', 'height', 'borderWidth', 'borderStyle', 'borderColor', 'backgroundColor', 'borderRadius'].map(k => s[k]); };
  assert.deepEqual(await trigger.evaluate(styles), await page.locator('.btn-tree-refresh:not(.btn-tree-download)').evaluate(styles));
  const row = page.locator('.tree-node-row').filter({ hasText: 'binary.bin' });
  await icon(row.getByRole('button'));
  await download(() => row.getByRole('button').click(), 'binary.bin');
  assert.equal(await page.locator('.file-viewer-modal').count(), 0);
  await page.locator('.file-tree-controls .sidebar-search-input').fill('binary.bin');
  const result = page.locator('.search-result-item').filter({ hasText: 'binary.bin' });
  await icon(result.getByRole('button'));
  await download(() => result.getByRole('button').click(), 'binary.bin');
  assert.equal(await page.locator('.file-viewer-modal').count(), 0);
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'File path within home' });
  const form = dialog.locator('.modal-form');
  await dialog.waitFor();
  assert.equal(await dialog.locator('.modal-container.ext-modal').count(), 1);
  assert.equal(await dialog.locator('.field-group label.field-label').count(), 1);
  assert.equal(await dialog.getByLabel('File path within home').count(), 1);
  assert.equal(await form.locator('input.field-input').count(), 1);
  assert.equal(await form.locator('.btn.btn-primary').count(), 1);
  assert.equal(await form.locator('.btn.btn-secondary').count(), 1);
  assert.equal(await form.locator('input').evaluate(el => document.activeElement === el), true);
  await page.keyboard.press('Escape');
  assert.equal(await dialog.count(), 0);
  assert.equal(await trigger.evaluate(el => document.activeElement === el), true);
  await trigger.click();
  await dialog.getByRole('button', { name: 'Close' }).click();
  assert.equal(await trigger.evaluate(el => document.activeElement === el), true);
  await trigger.click();
  await dialog.click({ position: { x: 2, y: 2 } });
  assert.equal(await dialog.count(), 0);
  assert.equal(await trigger.evaluate(el => document.activeElement === el), true);
  await trigger.click();
  for (const [input, name] of [[path.join(home, 'binary.bin'), 'binary.bin'], ['~/empty.bin', 'empty.bin'], ['large.bin', 'large.bin']]) {
    await form.locator('input').fill(input);
    await download(() => form.locator('button[type=submit]').click(), name);
  }
  for (const input of ['missing.bin', path.join(fixture, 'outside.bin'), path.join(project, 'binary.bin')]) {
    await form.locator('input').fill(input); await form.locator('button[type=submit]').click();
    await form.locator('[role=alert]').waitFor({ state: 'visible' });
    assert.match(await form.locator('[role=alert]').innerText(), /error|denied|exist|ENOENT/i);
  }
  console.log('PASS tree, search, paths, errors, binary, empty, large');
  await context.close();
} finally {
  if (browser) await browser.close();
  if (server) { server.kill(); await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve); }); }
  fs.rmSync(fixture, { recursive: true, force: true });
}
