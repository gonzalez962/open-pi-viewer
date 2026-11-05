// Run against a separately started, freshly built web server: BASE_URL=http://127.0.0.1:5195 node tests/browser/file-editor.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const baseURL = process.env.BASE_URL;
if (!baseURL) throw new Error('Set BASE_URL to the isolated web server URL');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-editor-browser-'));
const target = path.join(dir, 'editor-fixture.txt');
let browser;
try {
  fs.writeFileSync(target, 'one\r\ntwo');
  const secondDir = path.join(dir, 'second');
  fs.mkdirSync(secondDir);
  fs.writeFileSync(path.join(secondDir, 'other.txt'), 'other');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const project = { id: 'editor-fixture', path: fs.realpathSync(dir), customName: 'Editor fixture', createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString() };
  const second = { ...project, id: 'editor-second', path: fs.realpathSync(secondDir), customName: 'Second fixture' };
  const config = { nodePath: process.execPath, piEntrypoint: fileURLToPath(new URL('../../dist-server/start.js', import.meta.url)), workingDirectory: project.path, fileTreeRefreshInterval: 0 };
  const registry = { projects: [project, second], activeProjectId: project.id };
  // Server synchronization otherwise overrides the fixture or persists it to user storage.
  await context.route('**/api/ipc', async route => {
    const { cmd } = route.request().postDataJSON();
    if (cmd === 'get_viewer_storage') return route.fulfill({ json: { result: { connectConfig: config, projects: registry } } });
    if (cmd === 'save_viewer_storage' || cmd === 'update_viewer_storage_key') return route.fulfill({ json: { result: {} } });
    return route.continue();
  });
  await context.addInitScript(({ registry, config }) => {
    localStorage.setItem('pi_viewer_projects', JSON.stringify(registry));
    localStorage.setItem('pi_viewer_connect_config', JSON.stringify(config));
  }, { registry, config });
  const page = await context.newPage();
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.locator('.sidebar-tabs button[role="tab"]').nth(1).click();
  await page.locator('.tree-node-row .tree-node-name').filter({ hasText: 'editor-fixture.txt' }).click();
  const modal = page.getByRole('dialog', { name: 'editor-fixture.txt' });
  await modal.getByRole('button', { name: 'Edit', exact: true }).click();
  const input = modal.getByRole('textbox', { name: 'File content' });
  await input.fill('one\nchanged');
  page.once('dialog', dialog => dialog.dismiss());
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await input.inputValue(), 'one\nchanged');
  page.once('dialog', dialog => dialog.dismiss());
  await modal.getByRole('button', { name: 'Close', exact: true }).click();
  assert.equal(await input.inputValue(), 'one\nchanged');
  const navigationDialog = page.waitForEvent('dialog');
  await page.locator('.project-dock-list .project-tile').nth(1).dispatchEvent('click');
  await (await navigationDialog).dismiss();
  assert.equal(await input.inputValue(), 'one\nchanged');
  // S2.2: a backend error is visible and does not discard the draft.
  const failSave = async route => {
    const request = route.request().postDataJSON();
    if (request.cmd !== 'save_workspace_file') return route.continue();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ error: 'fixture conflict' }) });
  };
  await page.route('**/api/ipc', failSave);
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
  await modal.getByRole('alert').filter({ hasText: 'fixture conflict' }).waitFor();
  assert.equal(await input.inputValue(), 'one\nchanged');
  assert.equal(fs.readFileSync(target, 'utf8'), 'one\r\ntwo');
  await page.unroute('**/api/ipc', failSave);

  // S2.3: let the first write complete only after a newer draft is entered.
  let release;
  let intercepted;
  const reached = new Promise(resolve => { intercepted = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const delaySave = async route => {
    if (route.request().postDataJSON().cmd !== 'save_workspace_file') return route.continue();
    intercepted();
    await gate;
    await route.continue();
  };
  await page.route('**/api/ipc', delaySave);
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
  await reached;
  await input.fill('one\nnewer');
  release();
  await modal.getByRole('button', { name: 'Save', exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('.file-viewer-actions button:disabled'));
  assert.equal(await input.inputValue(), 'one\nnewer');
  assert.equal(fs.readFileSync(target, 'utf8'), 'one\r\nchanged');
  await page.unroute('**/api/ipc', delaySave);
  await input.fill('one\nchanged');
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
  await input.waitFor({ state: 'hidden' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'one\r\nchanged');
  assert.match(await modal.locator('code').innerText(), /changed/);
  await context.close();
  console.log('S2.1 S2.2 S2.3 S2.4 browser smoke passed');
} finally {
  if (browser) await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
