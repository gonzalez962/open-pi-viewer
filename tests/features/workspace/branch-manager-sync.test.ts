import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import * as playwright from 'playwright';
import { BranchManagerModal } from '@features/workspace/components/BranchManagerModal';

test('branch manager offers a localized sync icon immediately after New Branch', () => {
  for (const [locale, label] of [['en', 'Sync branches'], ['es', 'Sincronizar ramas']] as const) {
    const markup = renderToStaticMarkup(React.createElement(BranchManagerModal, {
      isOpen: true, onClose: () => {}, workingDirectory: 'C:/project', locale,
    }));
    const buttons = [...markup.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]);
    const syncIndex = buttons.findIndex((button) => button.includes(`aria-label="${label}"`));
    assert.ok(syncIndex > 0, 'sync must have a localized accessible name');
    assert.match(buttons[syncIndex], new RegExp(`title="${label}"`));
    assert.match(buttons[syncIndex], /<svg[^>]*aria-hidden="true"/);
    assert.doesNotMatch(buttons[syncIndex], new RegExp(`>${label}<`));
    assert.match(buttons[syncIndex - 1], /class="btn-branch-new /, 'New Branch immediately precedes sync');
  }
});

test('manual sync refreshes branches and bases, prevents duplicates, and permits retry after errors', { timeout: 45000 }, async () => {
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { BranchManagerModal } from './src/features/workspace/components/BranchManagerModal';
      createRoot(document.getElementById('root')).render(React.createElement(BranchManagerModal, {
        isOpen: true, onClose: () => {}, workingDirectory: 'C:/project', currentBranch: 'main', locale: 'en',
        onError: message => window.errors.push(message)
      }));
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife', tsconfig: 'tsconfig.app.json',
    plugins: [{
      name: 'branch-sync-fixture',
      setup(builder) {
        builder.onResolve({ filter: /^@infra\/bridge$/ }, () => ({ path: 'bridge', namespace: 'fixture' }));
        builder.onLoad({ filter: /^bridge$/, namespace: 'fixture' }, () => ({ loader: 'js', contents: `
            const initial = { current: 'main', defaultBranch: 'main', branches: [
              {name:'main', isCurrent:true}, {name:'local', isCurrent:false}
            ], allBases: ['main', 'local'] };
            window.calls = []; window.errors = [];
            export function listWorkspaceBranchesPi(...args) {
              window.calls.push(args);
              if (!args[1]?.sync) return Promise.resolve(initial);
              return new Promise((resolve, reject) => { window.resolveSync = resolve; window.rejectSync = reject; });
            }
            export const switchWorkspaceBranchPi = () => Promise.resolve();
            export const cloneWorkspaceBranchPi = () => Promise.resolve();
            export const createWorkspaceBranchPi = () => Promise.resolve();
            export const deleteWorkspaceBranchPi = () => Promise.resolve();
            export const publishWorkspaceBranchPi = () => Promise.resolve();
            export const listWorkspaceBranchCommitsPi = () => Promise.resolve({commits:[]});
        ` }));
      },
    }],
  });
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
      console.error('Fixture page error:', error);
    });
    page.on('console', (message) => { if (message.type() === 'error') console.error('Fixture console error:', message.text()); });
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.locator('.branch-item-name', { hasText: 'local' }).waitFor();
    const initialCalls = await page.evaluate('window.calls') as unknown[][];
    assert.ok(initialCalls.length > 0);
    assert.ok(initialCalls.every((call) => JSON.stringify(call) === JSON.stringify(['C:/project'])));
    assert.equal(await page.locator('.branch-item.is-active .branch-item-name').innerText(), 'main');
    assert.equal(await page.locator('.branch-item').filter({ hasText: 'main' }).locator('.badge-branch-default').count(), 1);
    const filter = page.locator('.branch-filter-input');
    await filter.fill('LOCAL');
    assert.deepEqual(await page.locator('.branch-item-name').allTextContents(), ['local']);
    await filter.fill('');
    await page.getByRole('button', { name: 'Sync branches', exact: true }).click();
    const pending = page.getByRole('button', { name: 'Syncing branches...', exact: true });
    await pending.waitFor();
    assert.equal(await pending.isDisabled(), true);
    await pending.evaluate((button: HTMLButtonElement) => button.click());
    assert.deepEqual(await page.evaluate('window.calls'), [...initialCalls, ['C:/project', { sync: true }]]);
    await page.evaluate(`window.resolveSync({current:'main', defaultBranch:'local', branches:[{name:'main',isCurrent:true},{name:'local',isCurrent:false},{name:'origin/remote-new',isRemote:true,isCurrent:false}], allBases:['main','local','origin/remote-new']})`);
    await page.locator('.branch-item-name', { hasText: 'origin/remote-new' }).waitFor();
    assert.equal(await page.locator('.branch-item').filter({ hasText: 'local' }).locator('.badge-branch-default').count(), 1);
    await filter.fill('REMOTE-NEW');
    assert.deepEqual(await page.locator('.branch-item-name').allTextContents(), ['origin/remote-new']);
    await filter.fill('');
    await page.getByRole('button', { name: '+ New Branch' }).click();
    assert.equal(await page.locator('#base-branch-select option[value="origin/remote-new"]').count(), 1);
    await page.getByRole('button', { name: 'Sync branches', exact: true }).click();
    await page.getByRole('button', { name: 'Syncing branches...', exact: true }).waitFor();
    await page.evaluate(`window.rejectSync(new Error('bridge failed'))`);
    await page.getByRole('alert').getByText('bridge failed').waitFor();
    assert.deepEqual(await page.evaluate('window.errors'), ['bridge failed']);
    assert.equal(await page.getByRole('button', { name: 'Sync branches', exact: true }).isEnabled(), true);
    assert.equal(await page.locator('.branch-item-name', { hasText: 'origin/remote-new' }).count(), 1);
    await page.getByRole('button', { name: 'Sync branches', exact: true }).click();
    await page.getByRole('button', { name: 'Syncing branches...', exact: true }).waitFor();
    assert.deepEqual(await page.evaluate('window.calls'), [...initialCalls, ['C:/project', { sync: true }], ['C:/project', { sync: true }], ['C:/project', { sync: true }]]);
    await page.evaluate(`window.resolveSync({current:'main', defaultBranch:'local', branches:[], allBases:[]})`);
    await page.getByRole('button', { name: 'Sync branches', exact: true }).waitFor();
    assert.equal(await page.getByRole('alert').count(), 0);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});
