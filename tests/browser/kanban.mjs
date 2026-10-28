import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = fs.mkdtempSync(path.join(root, '.workspace-kanban-browser-'));
const projects = ['Project A', 'Project B'].map((customName, i) => {
  const directory = path.join(fixture, `project-${i}`);
  fs.mkdirSync(directory);
  execFileSync('git', ['init', directory], { stdio: 'ignore' });
  return { id: `kanban-${i}`, path: directory, customName, createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString() };
});
const storage = path.join(fixture, 'viewer.json');
fs.writeFileSync(storage, JSON.stringify({ version: 1,
  projects: { projects, activeProjectId: projects[0].id },
  connectConfig: { nodePath: '', piEntrypoint: '', workingDirectory: projects[0].path },
  uiPreferences: { language: 'en', defaultProjectsDirectory: fixture },
}));
const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
});
let output = '';
const server = spawn(process.execPath, [path.join(root, 'dist-server/start.js')], { cwd: root,
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), PI_VIEWER_AUTH_ENABLED: 'false', PI_VIEWER_CONFIG_PATH: storage },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let browser;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startup timeout: ${output}`)), 15000);
    const receive = (chunk) => {
      output += chunk.toString();
      if (output.includes('Pi Viewer listening on http://')) { clearTimeout(timer); resolve(); }
    };
    server.stdout.on('data', receive); server.stderr.on('data', receive);
    server.on('error', (error) => { clearTimeout(timer); reject(error); });
    server.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' });
  const open = async () => {
    await page.getByRole('button', { name: 'Kanban', exact: true }).click();
    await page.locator('.kanban-dialog').waitFor();
    await page.waitForFunction(() => !document.querySelector('.kanban-form fieldset')?.disabled);
  };
  const openAddForm = async () => {
    const details = page.locator('.kanban-form-details');
    if (!(await details.evaluate((el) => el.open))) {
      await details.locator('summary').click();
    }
    await page.locator('#kanban-card-title').waitFor();
  };
  const close = () => page.getByRole('button', { name: 'Close', exact: true }).click();
  const card = () => page.locator('.kanban-card');
  await open();
  assert.equal(await card().count(), 0);
  assert.equal(await page.locator('.kanban-form-details').evaluate((el) => el.open), false);
  await openAddForm();
  assert.equal(await page.locator('#kanban-card-title').getAttribute('autocomplete'), 'off');
  await page.getByLabel('Card title', { exact: true }).fill('Browser task');
  await page.getByLabel('Description', { exact: true }).fill('Original description');
  await page.getByRole('button', { name: 'Add card', exact: true }).click();
  await page.getByRole('heading', { name: 'Browser task', exact: true }).waitFor();
  assert.equal(await page.locator('[data-column="pending"] .kanban-card').count(), 1);
  await close(); await page.reload(); await open();
  assert.match(await card().innerText(), /Original description/);
  assert.equal(await card().locator('details').evaluate((el) => el.open), false);
  console.log('PASS S2.1 create and reload');

  await card().locator('summary').click();
  await card().getByRole('button', { name: 'Edit', exact: true }).click();
  assert.equal(await page.locator('.kanban-form-details').evaluate((el) => el.open), true);
  await page.getByLabel('Card title', { exact: true }).fill('Edited task');
  await page.getByLabel('Description', { exact: true }).fill('Edited description');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByRole('heading', { name: 'Edited task', exact: true }).waitFor();
  await close(); await page.reload(); await open();
  assert.match(await card().innerText(), /Edited description/);
  console.log('PASS S2.2 edit and reload');

  for (const column of ['in_progress', 'done']) {
    await card().locator('summary').click();
    await card().getByRole('combobox').selectOption(column);
    await page.locator(`[data-column="${column}"] .kanban-card`).waitFor();
    await close(); await page.reload(); await open();
    assert.equal(await page.locator(`[data-column="${column}"] .kanban-card`).count(), 1);
  }
  console.log('PASS S2.3 move and reload');

  await close();
  await page.getByRole('button', { name: 'Project B', exact: true }).click();
  await open();
  assert.equal(await card().count(), 0);
  await openAddForm();
  await page.getByLabel('Card title', { exact: true }).fill('Project B task');
  await page.getByRole('button', { name: 'Add card', exact: true }).click();
  await page.getByRole('heading', { name: 'Project B task', exact: true }).waitFor();
  await close();
  await page.getByRole('button', { name: 'Project A', exact: true }).click();
  await open();
  assert.equal(await card().count(), 1);
  assert.match(await card().innerText(), /Edited task/);
  console.log('PASS S1.1 project switch isolation');

  await card().locator('summary').click();
  await card().getByRole('button', { name: 'Delete', exact: true }).click();
  await card().getByRole('button', { name: 'Cancel', exact: true }).waitFor();
  await card().getByRole('button', { name: 'Confirm', exact: true }).waitFor();
  await card().getByRole('button', { name: 'Cancel', exact: true }).click();
  await card().getByRole('button', { name: 'Edit', exact: true }).waitFor();
  await card().getByRole('button', { name: 'Delete', exact: true }).waitFor();
  assert.equal(await card().count(), 1);

  await card().getByRole('button', { name: 'Delete', exact: true }).click();
  await card().getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.kanban-card').length === 0);
  await close(); await page.reload(); await open();
  assert.equal(await card().count(), 0);
  console.log('PASS S2.4 delete and reload');

  for (const project of projects) {
    const ignored = execFileSync('git', ['-C', project.path, 'check-ignore', '--', '.pi/kanban.json'], { encoding: 'utf8' });
    assert.equal(ignored.trim(), '.pi/kanban.json');
  }
  console.log('PASS S1.2 real Git exclusion');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('.kanban-dialog').evaluate((el) => el.scrollWidth <= el.clientWidth), true);
  const isCentered = await page.locator('.kanban-dialog').evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const expectedLeft = (window.innerWidth - rect.width) / 2;
    const expectedTop = (window.innerHeight - rect.height) / 2;
    return Math.abs(rect.left - expectedLeft) <= 2 && Math.abs(rect.top - expectedTop) <= 2;
  });
  assert.equal(isCentered, true, 'Kanban dialog must be centered in the viewport');
  await page.keyboard.press('Escape');
  await page.locator('.kanban-dialog').waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
  console.log('PASS responsive board, Escape close and no page errors');
} finally {
  if (browser) await browser.close();
  const exited = new Promise((resolve) => server.once('exit', resolve));
  if (server.exitCode === null) { server.kill(); await exited; }
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
