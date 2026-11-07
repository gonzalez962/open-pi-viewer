// Run against a locally started web build via BASE_URL. Fixtures never touch a real project.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-worktrees-browser-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const primary = path.join(root, 'primary');
  const linked = path.join(root, 'linked');
  const unknown = path.join(root, 'unknown');
  fs.mkdirSync(primary); fs.mkdirSync(unknown);
  const git = (...args) => execFileSync('git', args, { cwd: primary, stdio: 'pipe' });
  git('init', '-b', 'not-main');
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('commit', '--allow-empty', '-m', 'fixture');
  git('worktree', 'add', '-b', 'linked-branch', linked);
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  t.after(() => context.close());
  const paths = [primary, linked, unknown].map(p => fs.realpathSync(p));
  const projects = paths.map((p, i) => ({ id: `fixture-${i}`, path: p, createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString() }));
  const registry = { projects, activeProjectId: projects[0].id };
  const config = { nodePath: process.execPath, piEntrypoint: path.resolve('dist-server/start.js'), workingDirectory: paths[0], fileTreeRefreshInterval: 15 };
  await context.addInitScript(({ registry, config }) => {
    localStorage.setItem('pi_viewer_projects', JSON.stringify(registry));
    localStorage.setItem('pi_viewer_connect_config', JSON.stringify(config));
  }, { registry, config });
  // Isolate storage sync; worktree IPC still reaches the real server and Git.
  let storage = { version: 1, projects: registry, connectConfig: config };
  await context.route('**/api/events', route => route.abort());
  await context.route('**/api/ipc', async route => {
    const { cmd, args } = route.request().postDataJSON();
    if (cmd === 'get_viewer_storage') return route.fulfill({ json: { result: storage } });
    if (cmd === 'save_viewer_storage') {
      storage = { ...storage, ...args.payload };
      return route.fulfill({ json: { result: storage } });
    }
    if (cmd === 'update_viewer_storage_key') {
      storage = { ...storage, [args.payload.key]: args.payload.value };
      return route.fulfill({ json: { result: storage } });
    }
    return route.continue();
  });
  const page = await context.newPage();
  await page.goto(process.env.BASE_URL || 'http://127.0.0.1:5195', { waitUntil: 'domcontentloaded', timeout: 10000 });
  return { page, paths, projects };
}

const button = page => page.locator('.sidebar-header').getByRole('button', { name: /worktrees/i });
const dock = page => page.locator('.project-dock-container');

test('S7.1: linked entries remain visible without inline panels or deleting identities', { timeout: 30000 }, async t => {
  const { page, projects } = await fixture(t);
  await dock(page).getByRole('button', { name: 'primary', exact: true }).waitFor({ timeout: 5000 });
  await dock(page).getByRole('button', { name: 'unknown', exact: true }).waitFor({ timeout: 5000 });
  await dock(page).getByRole('button', { name: 'linked', exact: true }).waitFor({ timeout: 5000 });
  assert.equal(await dock(page).getByRole('button', { name: 'primary', exact: true }).count(), 1);
  assert.equal(await dock(page).getByRole('button', { name: 'linked', exact: true }).count(), 1);
  assert.equal(await dock(page).getByRole('button', { name: 'linked', exact: true }).locator('svg').count(), 1);
  assert.equal(await dock(page).getByRole('button', { name: 'unknown', exact: true }).count(), 1);
  assert.equal(await dock(page).locator('.project-worktrees').count(), 0);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('pi_viewer_projects')));
  assert.deepEqual(stored.projects.map(p => p.id).sort(), projects.map(p => p.id).sort());
});

test('S4.2: SVG trigger opens loaded management dialog and close/Escape return focus', { timeout: 30000 }, async t => {
  const { page, paths } = await fixture(t);
  const trigger = button(page);
  await trigger.waitFor({ timeout: 5000 });
  assert.equal(await trigger.locator('svg').count(), 1);
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: /worktrees/i });
  await dialog.waitFor({ timeout: 5000 });
  assert.equal(await dialog.getAttribute('aria-modal'), 'true');
  await dialog.getByText(paths[1].replace(/\\/g, '/'), { exact: true }).waitFor({ timeout: 5000 });
  await dialog.getByText('linked-branch', { exact: true }).waitFor({ timeout: 5000 });
  assert.equal(await dialog.getByRole('button', { name: /create/i }).count(), 1);
  await dialog.getByRole('button', { name: /close/i }).click();
  assert.equal(await trigger.evaluate(el => document.activeElement === el), true);
  await trigger.click(); await dialog.waitFor(); await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await trigger.evaluate(el => document.activeElement === el), true);
});

test('S4.3: secondary is highlighted while non-main primary is neutral', { timeout: 30000 }, async t => {
  const { page, paths } = await fixture(t);
  const trigger = button(page);
  await trigger.waitFor({ timeout: 5000 });
  const appearance = () => trigger.evaluate(el => { const s = getComputedStyle(el); return [s.color, s.backgroundColor, s.borderColor]; });
  const primaryAppearance = await appearance();
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: /worktrees/i });
  await dialog.getByText(paths[1].replace(/\\/g, '/'), { exact: true }).click({ timeout: 5000 });
  await page.waitForFunction(id => JSON.parse(localStorage.getItem('pi_viewer_projects')).activeProjectId === id, 'fixture-1', { timeout: 5000 });
  await dialog.waitFor({ state: 'hidden', timeout: 5000 });
  await page.waitForFunction(({ selector, expected }) => {
    const el = document.querySelector(selector);
    if (!el) return false;
    const s = getComputedStyle(el);
    return JSON.stringify([s.color, s.backgroundColor, s.borderColor]) !== JSON.stringify(expected);
  }, { selector: '.sidebar-header button[aria-label*="Worktrees"]', expected: primaryAppearance }, { timeout: 5000 });
  assert.notDeepEqual(await appearance(), primaryAppearance);
});
