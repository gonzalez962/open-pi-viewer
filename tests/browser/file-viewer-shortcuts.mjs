// Run from the repository root: npx tsx --tsconfig tsconfig.app.json --test tests/browser/file-viewer-shortcuts.mjs
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const original = 'one\r\ntwo';
const filename = 'example.txt';
let root;
let browser;
let server;
let url;
let saveFile;

before(async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'pi-viewer-shortcuts-')));
  const { setBridgeConfig } = await import('../../server/config.ts');
  setBridgeConfig({ baseWorkspace: root });
  ({ handleSaveWorkspaceFile: saveFile } = await import('../../server/bridge/paths.ts'));
  const { outputFiles: [bundle] } = await build({
    bundle: true,
    write: false,
    tsconfig: 'tsconfig.app.json',
    define: { 'process.env.NODE_ENV': '"production"' },
    stdin: {
      loader: 'tsx',
      resolveDir: process.cwd(),
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import './src/infra/web-ipc-client';
        import { FileViewerModal } from '@features/workspace/FileViewerModal';
        const root = createRoot(document.getElementById('root'));
        window.showFile = (workingDirectory, name, content) => root.render(
          <FileViewerModal locale="en" onClose={() => {}} workingDirectory={workingDirectory}
            file={{ name, relativePath: name, content, isBinary: false, kind: 'text', size: content.length }} />
        );
      `,
    },
  });
  server = createServer((req, res) => {
    if (req.url === '/viewer.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' }).end(bundle.contents);
    } else if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<div id="root"></div><script src="/viewer.js"></script>');
    } else {
      res.writeHead(404).end();
    }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  try {
    await browser?.close();
  } finally {
    if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

async function openViewer(t, onSave = () => assert.fail('unexpected save')) {
  const page = await browser.newPage();
  t.after(() => page.close());
  page.setDefaultTimeout(5000);
  await page.route('**/api/ipc', async route => {
    const { cmd, args } = route.request().postDataJSON();
    if (cmd === 'get_workspace_file_diff') {
      return route.fulfill({ json: { result: {
        relativePath: args.payload.relativePath, hasDiff: true, diff: '@@ -1 +1 @@\n-old\n+one',
      } } });
    }
    if (cmd === 'save_workspace_file') return onSave(route, args);
    assert.fail(`unexpected IPC command: ${cmd}`);
  });
  await page.goto(url);
  const show = (workingDirectory = root, name = filename) => page.evaluate(
    ({ workingDirectory, name, original }) => window.showFile(workingDirectory, name, original),
    { workingDirectory, name, original },
  );
  await show();
  const modal = page.getByRole('dialog');
  return {
    page, show, modal,
    content: modal.getByRole('tab', { name: 'Content', exact: true }),
    diff: modal.getByRole('tab', { name: 'Diff', exact: true }),
    input: modal.getByRole('textbox', { name: 'File content' }),
    save: modal.getByRole('button', { name: 'Save', exact: true }),
    edit: () => modal.getByRole('button', { name: 'Edit', exact: true }).click(),
  };
}

const expectContent = async ({ content, modal }) => {
  assert.deepEqual({ selected: await content.getAttribute('aria-selected'), diffVisible: await modal.locator('.file-viewer-diff-container').isVisible() },
    { selected: 'true', diffVisible: false });
};

const pressSave = (target, repeat = false) => target.evaluate((element, repeat) => !element.dispatchEvent(new KeyboardEvent('keydown', {
  key: 's', ctrlKey: true, bubbles: true, cancelable: true, repeat,
})), repeat);

test('a changed file stays on Content until Diff is explicitly selected', async t => {
  const viewer = await openViewer(t);
  await viewer.diff.locator('.diff-indicator-dot').waitFor({ state: 'attached' });
  await expectContent(viewer);
  await viewer.diff.click();
  assert.equal(await viewer.diff.getAttribute('aria-selected'), 'true');
  await viewer.modal.locator('.diff-line-add .diff-line-text').filter({ hasText: /^one$/ }).waitFor();
});

for (const [scenario, destination] of [
  ['changing files', () => [root, 'other.txt']],
  ['switching workspaces at the same relative path', () => [path.join(root, 'second'), filename]],
]) {
  test(`${scenario} resets Diff to Content`, async t => {
    const [directory, name] = destination();
    const viewer = await openViewer(t);
    await viewer.diff.locator('.diff-indicator-dot').waitFor({ state: 'attached' });
    await viewer.diff.click();
    assert.equal(await viewer.diff.getAttribute('aria-selected'), 'true');
    const fetched = viewer.page.waitForResponse(response => {
      if (!response.url().endsWith('/api/ipc')) return false;
      const { cmd, args } = response.request().postDataJSON();
      return cmd === 'get_workspace_file_diff' && args.payload.workingDirectory === directory && args.payload.relativePath === name;
    });
    await viewer.show(directory, name);
    await fetched;
    await viewer.page.waitForFunction(() => !document.querySelector('.file-viewer-diff-container .sidebar-loading'));
    assert.equal(await viewer.modal.getAttribute('aria-label'), name);
    await expectContent(viewer);
  });
}

test('Ctrl+S cancels browser Save, writes the draft once, and ignores repeats and pending saves', async t => {
  const target = path.join(root, filename);
  writeFileSync(target, original);
  const submitted = [];
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const viewer = await openViewer(t, async (route, args) => {
    submitted.push(args.payload);
    await pending;
    saveFile(args);
    await route.fulfill({ json: {} });
  });
  const expected = 'one\r\nkeyboard';
  try {
    await viewer.diff.locator('.diff-indicator-dot').waitFor({ state: 'attached' });
    await viewer.content.click();
    assert.equal(await pressSave(viewer.content), false);
    await viewer.edit();
    await viewer.input.fill('one\nkeyboard');
    const repeatPrevented = await pressSave(viewer.input, true);
    assert.equal(await viewer.save.isEnabled(), true);
    assert.deepEqual(submitted, []);
    assert.equal(readFileSync(target, 'utf8'), original);
    const browserSavePrevented = await pressSave(viewer.input);
    assert.deepEqual({ repeatPrevented, browserSavePrevented }, { repeatPrevented: true, browserSavePrevented: true });
    await viewer.page.waitForFunction(() => document.querySelector('.btn-file-editor-save:disabled'));
    assert.equal(await pressSave(viewer.input), true, 'a second keypress still cancels the browser action while saving');
    assert.equal(await pressSave(viewer.input, true), true);
    assert.equal(readFileSync(target, 'utf8'), original, 'save is still in flight');
    release();
    await viewer.input.waitFor({ state: 'hidden' });
    assert.equal(await viewer.modal.locator('code').textContent(), expected);
    assert.equal(readFileSync(target, 'utf8'), expected);
    assert.deepEqual(submitted, [{ workingDirectory: root, relativePath: filename, originalContent: original, content: expected }]);
  } finally {
    release();
  }
});

test('the Save button still saves and exits editing', async t => {
  const target = path.join(root, filename);
  writeFileSync(target, original);
  const viewer = await openViewer(t, async (route, args) => {
    saveFile(args);
    await route.fulfill({ json: {} });
  });
  await viewer.diff.locator('.diff-indicator-dot').waitFor({ state: 'attached' });
  await viewer.content.click();
  await viewer.edit();
  await viewer.input.fill('one\nbutton');
  await viewer.save.click();
  await viewer.input.waitFor({ state: 'hidden' });
  assert.equal(await viewer.modal.locator('code').textContent(), 'one\r\nbutton');
  assert.equal(readFileSync(target, 'utf8'), 'one\r\nbutton');
});
